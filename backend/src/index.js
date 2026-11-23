import { D1Store } from "./store.js";
import { createTelegram } from "./telegram.js";
import { createAi, cleanDraft } from "./ai.js";

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;
// Failed pairing attempts are limited per client identity, so one attacker
// burning their own budget cannot lock anyone else out. A much higher
// global backstop still bounds the total guessing rate across many clients.
const PAIR_FAILURE_LIMIT_PER_CLIENT = 10;
const PAIR_FAILURE_LIMIT_GLOBAL = 100;
const STT_MAX_BYTES = 2 * 1024 * 1024;
const JSON_MAX_BYTES = 64 * 1024;
const DIGEST_LINE_BUDGET = 52;
const DM_SOURCE_TITLE = "Forwarded & DMs";
const MAX_STORED_TEXT = 4000;
const SEND_DEDUPE_WINDOW_MS = 120 * 1000;

const FALLBACK_QUESTION = "Thanks for flagging — let me check and get back to you shortly.";
const FALLBACK_DEFAULT = "Thanks for the update!";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
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

function secretsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export function truncateLine(text, budget = DIGEST_LINE_BUDGET) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= budget) return clean;
  const cut = chars.slice(0, budget - 1).join("");
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
  return Boolean(source) && source.userId != null && source.userId === user.id;
}

function mediaPlaceholder(msg) {
  if (msg.photo) return "[Photo]";
  if (msg.voice) return "[Voice message]";
  if (msg.sticker) return "[Sticker]";
  if (msg.video) return "[Video]";
  if (msg.document || msg.animation) return "[File]";
  return "";
}

function isStartCommand(text) {
  return text === "/start" || text.startsWith("/start ");
}

// True only when Telegram's error says the reply target itself is the
// problem (the message being answered is gone). Rate limits, network
// errors and everything else must surface as failures, not silently
// degrade to an unthreaded send.
function isReplyTargetError(err) {
  const text = `${err?.description ?? ""} ${err?.message ?? ""}`;
  return /message to be replied not found/i.test(text);
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
  // Identical sends already in flight, keyed like the send-dedupe window
  // (user, source, text): a concurrent duplicate awaits the first send
  // instead of posting twice.
  const inFlightSends = new Map();

  async function authenticate(req) {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    const tokenHash = await sha256Hex(match[1].trim());
    return store.userForToken(tokenHash, nowMs());
  }

  function clientKeyFor(req) {
    const cfIp = req.headers.get("cf-connecting-ip");
    if (cfIp && cfIp.trim()) return `ip:${cfIp.trim()}`;
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded && forwarded.trim()) return `ip:${forwarded.split(",")[0].trim()}`;
    return "ip:unknown";
  }

  async function pairLockedOut(clientKey) {
    if (typeof store.pairFailuresInWindow !== "function") return false;
    const perClient = await store.pairFailuresInWindow(
      nowMs(),
      PAIR_FAILURE_WINDOW_MS,
      clientKey
    );
    if (perClient >= PAIR_FAILURE_LIMIT_PER_CLIENT) return true;
    const global = await store.pairFailuresInWindow(nowMs(), PAIR_FAILURE_WINDOW_MS);
    return global >= PAIR_FAILURE_LIMIT_GLOBAL;
  }

  async function notePairFailure(clientKey) {
    if (typeof store.recordPairFailure === "function") {
      // The prune cutoff travels with the write so expired failure records
      // are deleted as new ones arrive and the table stays bounded.
      await store.recordPairFailure(
        nowMs(),
        clientKey,
        nowMs() - PAIR_FAILURE_WINDOW_MS
      );
    }
  }

  async function handlePair(req) {
    const clientKey = clientKeyFor(req);
    if (await pairLockedOut(clientKey)) return error(429, "too_many_attempts");
    const body = await readJson(req);
    const code = body?.code != null ? String(body.code).trim() : "";
    if (!/^\d{6}$/.test(code)) {
      await notePairFailure(clientKey);
      return error(401, "invalid_code");
    }
    const user = await store.redeemPairCode(code, nowMs());
    if (!user) {
      await notePairFailure(clientKey);
      return error(401, "invalid_code");
    }
    const token = randomTokenHex();
    const tokenHash = await sha256Hex(token);
    await store.createSession(tokenHash, user.id, nowMs());
    return json({ token, user: { id: user.id, firstName: user.firstName } });
  }

  async function handleDigest(req) {
    const user = await authenticate(req);
    if (!user) return error(401, "unauthorized");
    const rows = await store.listSourcesWithUnread(user.id);
    const sources = rows
      .filter((s) => s.userId === user.id)
      .map((s) => ({
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
    const newest = await store.messagesFor(sourceId, 1);
    const clamped = newest.length ? Math.min(upToMessageId, newest[0].id) : 0;
    await store.markRead(user.id, sourceId, clamped);
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

    let replyToTgId;
    if (body.replyToMessageId != null) {
      const internalId = Number(body.replyToMessageId);
      if (!Number.isFinite(internalId) || !Number.isInteger(internalId)) {
        return error(400, "invalid_request");
      }
      const target = await store.getMessage(sourceId, internalId);
      const tgId = target ? target.tgMessageId ?? target.tg_message_id : null;
      if (tgId == null || !Number.isFinite(Number(tgId)) || !Number.isInteger(Number(tgId))) {
        return error(400, "invalid_request");
      }
      replyToTgId = Number(tgId);
    }

    if (typeof store.findRecentSend === "function") {
      const prior = await store.findRecentSend({
        userId: user.id,
        sourceId,
        text,
        sinceMs: nowMs() - SEND_DEDUPE_WINDOW_MS,
      });
      if (prior != null) {
        return json({ ok: true, messageId: prior, deduped: true });
      }
    }

    const sendOnce = async () => {
      let result;
      try {
        result = await tg.sendMessage(source.chatId ?? source.id, text, {
          replyToMessageId: replyToTgId,
        });
      } catch (err) {
        if (replyToTgId == null || !isReplyTargetError(err)) throw err;
        // Only a missing reply target earns the unthreaded retry; any
        // other failure (rate limit, network, permissions) propagates.
        result = await tg.sendMessage(source.chatId ?? source.id, text, {});
      }
      const messageId =
        typeof result === "number"
          ? result
          : result?.message_id ?? result?.messageId ?? null;
      if (typeof store.recordSend === "function" && messageId != null) {
        await store.recordSend({
          userId: user.id,
          sourceId,
          text,
          messageId,
          at: nowMs(),
        });
      }
      return messageId;
    };

    // No await between the map lookup and the set, so two concurrent
    // identical sends cannot both slip through: the second awaits the
    // first one's outcome and reports as deduped.
    const flightKey = `${user.id}:${sourceId}:${text}`;
    const inFlight = inFlightSends.get(flightKey);
    if (inFlight) {
      try {
        const messageId = await inFlight;
        return json({ ok: true, messageId, deduped: true });
      } catch {
        return error(502, "send_failed");
      }
    }
    const flight = sendOnce();
    inFlightSends.set(flightKey, flight);
    try {
      const messageId = await flight;
      return json({ ok: true, messageId });
    } catch {
      return error(502, "send_failed");
    } finally {
      inFlightSends.delete(flightKey);
    }
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
    const cleaned = typeof draft === "string" ? cleanDraft(draft) : null;
    if (cleaned) {
      return json({ draft: cleaned, source: "llm" });
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

  async function issuePairCode(sender, chatId) {
    // Codes are stored only as hashes, so a still-live code cannot be
    // re-sent — its plaintext exists nowhere after the first DM. Every
    // /start therefore mints a fresh code; minting replaces the user's
    // previous unused code, so only the newest DM's code redeems.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomPairCode();
      const created = await store.createPairCode({
        code,
        userId: sender.id,
        expiresAt: nowMs() + PAIR_CODE_TTL_MS,
      });
      if (created !== false) return code;
    }
    return null;
  }

  async function storeIncoming(msg, { isChannelPost = false } = {}) {
    const chat = msg?.chat;
    if (!chat || chat.id == null) return;
    if (msg.message_id == null) return;
    if (msg.is_automatic_forward === true) return;
    const at = msg.date ? msg.date * 1000 : nowMs();
    let text = msg.text ?? msg.caption ?? "";
    if (typeof text !== "string") text = String(text ?? "");
    if (!text) text = mediaPlaceholder(msg);
    text = Array.from(text).slice(0, MAX_STORED_TEXT).join("");
    const type = isChannelPost ? "channel" : sourceTypeForChat(chat);

    if (type === "dm") {
      const sender = msg.from;
      if (!sender || sender.id == null) return;
      await store.upsertUser(sender.id, displayName(sender), nowMs());
      if (isStartCommand(text.trim())) {
        const code = await issuePairCode(sender, chat.id);
        if (code == null) return;
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

    await store.upsertSource({
      chatId: chat.id,
      userId: null,
      type,
      title: chat.title ?? displayName(chat),
      createdAt: nowMs(),
    });
    if (!text) return;
    const fromName = displayName(msg.sender_chat ?? msg.from ?? chat);
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
    const newStatus = member.new_chat_member?.status;
    if (newStatus === "left" || newStatus === "kicked") {
      if (typeof store.deleteSource === "function") {
        await store.deleteSource(chat.id);
      }
      return;
    }
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
    if (!webhookSecret || !secret || !secretsEqual(secret, webhookSecret)) {
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
      }
    } catch (err) {
      // A processing failure (e.g. the store is briefly unavailable) must
      // NOT be acknowledged: a non-2xx answer makes Telegram redeliver the
      // update. Ingestion is idempotent, so redelivery cannot duplicate a
      // stored message. Ignorable updates (unparseable body, update types
      // we do not handle) still fall through to the 200 below.
      console.error("webhook handler failed", err?.message ?? "unknown");
      return error(500, "webhook_failed");
    }
    return json({ ok: true });
  }

  async function fetchHandler(req) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method.toUpperCase();

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (method === "POST" && path.startsWith("/v1/")) {
        const lengthHeader = req.headers.get("content-length");
        if (lengthHeader != null) {
          const length = Number(lengthHeader);
          if (Number.isFinite(length)) {
            const limit = path === "/v1/stt" ? STT_MAX_BYTES : JSON_MAX_BYTES;
            if (length > limit) return error(413, "too_large");
          }
        }
      }

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
      tg: createTelegram({ token: env.TELEGRAM_BOT_TOKEN ?? env.BOT_TOKEN }),
      ai: createAi({ groqKey: env.GROQ_API_KEY }),
      webhookSecret: env.WEBHOOK_SECRET,
      now: () => Date.now(),
    });
    return app.fetch(req);
  },
};
