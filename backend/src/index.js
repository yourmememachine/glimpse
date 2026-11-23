import { D1Store } from "./store.js";
import { createTelegram } from "./telegram.js";
import { createAi } from "./ai.js";

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const STT_MAX_BYTES = 2 * 1024 * 1024;
const DIGEST_LINE_BUDGET = 52;
const DM_SOURCE_TITLE = "Forwarded & DMs";

const FALLBACK_QUESTION = "Thanks for flagging — let me check and get back to you shortly.";
const FALLBACK_DEFAULT = "Thanks for the update!";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status, code) {
  return json({ error: code }, status);
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return toHex(new Uint8Array(digest));
}

function randomTokenHex() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function randomPairCode() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
}

export function truncateLine(text, budget = DIGEST_LINE_BUDGET) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= budget) return clean;
  const cut = clean.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head}…`;
}

function displayName(person) {
  if (!person) return "Unknown";
  const parts = [person.first_name, person.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (person.title) return person.title;
  if (person.username) return person.username;
  return "Unknown";
}

function sourceTypeForChat(chat) {
  if (!chat) return "group";
  if (chat.type === "channel") return "channel";
  if (chat.type === "private") return "dm";
  return "group";
}

function ownsSource(user, source) {
  return source && (source.userId === user.id || source.userId == null);
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function createApp({ store, tg, ai, now, webhookSecret } = {}) {
  const nowMs = typeof now === "function" ? now : () => Date.now();

  async function authenticate(req) {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    const tokenHash = await sha256Hex(match[1].trim());
    return store.userForToken(tokenHash);
  }

  async function handlePair(req) {
    const body = await readJson(req);
    const code = body?.code != null ? String(body.code).trim() : "";
    if (!/^\d{6}$/.test(code)) return error(401, "invalid_code");
    const user = await store.redeemPairCode(code, nowMs());
    if (!user) return error(401, "invalid_code");
    const token = randomTokenHex();
    const tokenHash = await sha256Hex(token);
    await store.createSession(tokenHash, user.id, nowMs());
    return json({ token, user: { id: user.id, firstName: user.firstName } });
  }

  async function handleDigest(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const rows = await store.listSourcesWithUnread(user.id);
    const sources = rows.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      unread: s.unread,
      topLines: (s.topTexts ?? []).slice(0, 3).map((t) => truncateLine(t)),
      lastAt: s.lastAt,
    }));
    return json({ sources });
  }

  async function handleSource(req, sourceId, url) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const source = await store.getSource(sourceId);
    if (!ownsSource(user, source)) return error(404, "not_found");
    let limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    limit = Math.min(limit, 100);
    const messages = await store.messagesFor(sourceId, limit);
    return json({
      source: { id: source.id, type: source.type, title: source.title },
      messages: messages.map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at })),
    });
  }

  async function handleRead(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const body = await readJson(req);
    if (!body) return error(400, "invalid_json");
    const sourceId = Number(body.sourceId);
    const upToMessageId = Number(body.upToMessageId);
    if (!Number.isFinite(sourceId) || !Number.isFinite(upToMessageId)) {
      return error(400, "invalid_request");
    }
    const source = await store.getSource(sourceId);
    if (!ownsSource(user, source)) return error(404, "not_found");
    await store.markRead(user.id, sourceId, upToMessageId);
    return json({ ok: true });
  }

  async function handleReply(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const body = await readJson(req);
    if (!body) return error(400, "invalid_json");
    const sourceId = Number(body.sourceId);
    if (!Number.isFinite(sourceId)) return error(400, "invalid_request");
    const source = await store.getSource(sourceId);
    if (!ownsSource(user, source)) return error(404, "not_found");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 1 || text.length > 1000) return error(400, "invalid_text");
    let result;
    try {
      result = await tg.sendMessage(source.chatId ?? source.id, text, {
        replyToMessageId: body.replyToMessageId ?? undefined,
      });
    } catch {
      return error(502, "send_failed");
    }
    const messageId =
      typeof result === "number"
        ? result
        : result?.message_id ?? result?.messageId ?? null;
    return json({ ok: true, messageId });
  }

  async function handleDraft(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const body = await readJson(req);
    if (!body) return error(400, "invalid_json");
    const sourceId = Number(body.sourceId);
    const messageId = Number(body.messageId);
    if (!Number.isFinite(sourceId) || !Number.isFinite(messageId)) {
      return error(400, "invalid_request");
    }
    const source = await store.getSource(sourceId);
    if (!ownsSource(user, source)) return error(404, "not_found");
    const message = await store.getMessage(sourceId, messageId);
    if (!message) return error(404, "not_found");
    let draft = null;
    if (ai && typeof ai.draftReply === "function") {
      try {
        draft = await ai.draftReply({ source, message });
      } catch {
        draft = null;
      }
    }
    if (typeof draft === "string" && draft.trim()) {
      return json({ draft: draft.trim(), source: "llm" });
    }
    const fallback = String(message.text ?? "").includes("?")
      ? FALLBACK_QUESTION
      : FALLBACK_DEFAULT;
    return json({ draft: fallback, source: "fallback" });
  }

  async function handleStt(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const buf = await req.arrayBuffer();
    if (buf.byteLength > STT_MAX_BYTES) return error(413, "too_large");
    let text = null;
    if (ai && typeof ai.transcribe === "function") {
      try {
        text = await ai.transcribe(new Uint8Array(buf));
      } catch {
        text = null;
      }
    }
    if (typeof text !== "string" || !text.trim()) {
      return error(503, "stt_unavailable");
    }
    return json({ text });
  }

  async function storeIncoming(msg, { isChannelPost = false } = {}) {
    const chat = msg?.chat;
    if (!chat || chat.id == null) return;
    const at = msg.date ? msg.date * 1000 : nowMs();
    const text = msg.text ?? msg.caption ?? "";
    const type = isChannelPost ? "channel" : sourceTypeForChat(chat);

    if (type === "dm") {
      const sender = msg.from;
      if (!sender || sender.id == null) return;
      await store.upsertUser(sender.id, displayName(sender), nowMs());
      if (typeof text === "string" && text.trim().startsWith("/start")) {
        const code = randomPairCode();
        await store.createPairCode({
          code,
          userId: sender.id,
          expiresAt: nowMs() + PAIR_CODE_TTL_MS,
        });
        try {
          await tg.sendMessage(
            chat.id,
            `Your Glimpse pairing code is ${code}. ` +
              `Enter it in the app within 10 minutes to link this chat. ` +
              `The code works once; send /start again for a fresh one.`
          );
        } catch (err) {
          console.error("pairing code send failed", err?.message ?? "unknown");
        }
        return;
      }
      if (!text) return;
      await store.upsertSource({
        chatId: chat.id,
        userId: sender.id,
        type: "dm",
        title: DM_SOURCE_TITLE,
        createdAt: nowMs(),
      });
      await store.addMessage({
        sourceId: chat.id,
        tgMessageId: msg.message_id,
        fromName: displayName(sender),
        text,
        at,
      });
      return;
    }

    let ownerId = null;
    if (msg.from && msg.from.id != null && !msg.from.is_bot) {
      ownerId = msg.from.id;
      await store.upsertUser(ownerId, displayName(msg.from), nowMs());
    }
    await store.upsertSource({
      chatId: chat.id,
      userId: ownerId,
      type,
      title: chat.title ?? displayName(chat),
      createdAt: nowMs(),
    });
    if (!text) return;
    const fromName = isChannelPost
      ? displayName(msg.sender_chat ?? chat)
      : displayName(msg.from ?? msg.sender_chat ?? chat);
    await store.addMessage({
      sourceId: chat.id,
      tgMessageId: msg.message_id,
      fromName,
      text,
      at,
    });
  }

  async function handleMyChatMember(update) {
    const member = update?.my_chat_member;
    const chat = member?.chat;
    if (!chat || chat.id == null) return;
    const from = member.from;
    let ownerId = null;
    if (from && from.id != null) {
      ownerId = from.id;
      await store.upsertUser(ownerId, displayName(from), nowMs());
    }
    await store.upsertSource({
      chatId: chat.id,
      userId: ownerId,
      type: sourceTypeForChat(chat),
      title: chat.title ?? displayName(chat),
      createdAt: nowMs(),
    });
  }

  async function handleWebhook(req) {
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!webhookSecret || !secret || secret !== webhookSecret) {
      return error(401, "unauthorized");
    }
    try {
      const update = await readJson(req);
      if (update) {
        if (update.message) {
          await storeIncoming(update.message);
        } else if (update.channel_post) {
          await storeIncoming(update.channel_post, { isChannelPost: true });
        } else if (update.my_chat_member) {
          await handleMyChatMember(update);
        }
        // edited_message and anything else: intentionally ignored.
      }
    } catch (err) {
      console.error("webhook handler failed", err?.message ?? "unknown");
    }
    return json({ ok: true });
  }

  async function fetchHandler(req) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method.toUpperCase();

      if (method === "GET" && path === "/health") return json({ ok: true });
      if (method === "POST" && path === "/telegram/webhook") return handleWebhook(req);
      if (method === "POST" && path === "/v1/pair") return handlePair(req);
      if (method === "GET" && path === "/v1/digest") return handleDigest(req);

      const sourceMatch = /^\/v1\/source\/(-?\d+)$/.exec(path);
      if (method === "GET" && sourceMatch) {
        return handleSource(req, Number(sourceMatch[1]), url);
      }
      if (method === "POST" && path === "/v1/read") return handleRead(req);
      if (method === "POST" && path === "/v1/reply") return handleReply(req);
      if (method === "POST" && path === "/v1/draft") return handleDraft(req);
      if (method === "POST" && path === "/v1/stt") return handleStt(req);

      if (path.startsWith("/v1/")) {
        const user = await authenticate(req);
        if (!user) return error(401, "unauthorized");
        return error(404, "not_found");
      }
      return error(404, "not_found");
    } catch (err) {
      console.error("request failed", err?.message ?? "unknown");
      return error(500, "internal");
    }
  }

  return { fetch: fetchHandler };
}

export default {
  async fetch(req, env) {
    const app = createApp({
      store: new D1Store(env.DB),
      tg: createTelegram({ token: env.BOT_TOKEN }),
      ai: createAi({ groqKey: env.GROQ_API_KEY }),
      webhookSecret: env.WEBHOOK_SECRET,
      now: () => Date.now(),
    });
    return app.fetch(req);
  },
};
