import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

const SECRET = "test-webhook-secret";
const GROUP_ID = -1001;
const USER_ID = 42;

function makeEnv({ aiImpl } = {}) {
  const state = { t: 1_700_000_000_000 };
  const store = new MemoryStore();
  const tg = {
    sent: [],
    async sendMessage(chatId, text, opts) {
      this.sent.push({ chatId, text, opts });
      return { message_id: 4242 };
    },
  };
  const ai = aiImpl ?? {
    draftReply: async () => null,
    transcribe: async () => null,
  };
  const app = createApp({
    store,
    tg,
    ai,
    now: () => state.t,
    webhookSecret: SECRET,
  });
  return { state, store, tg, ai, app };
}

function req(path, { method = "GET", token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      h["content-type"] = "application/json";
    }
  }
  return new Request(`http://test${path}`, { method, headers: h, body: payload });
}

async function webhook(app, update, secret = SECRET) {
  const headers = { "content-type": "application/json" };
  if (secret != null) headers["x-telegram-bot-api-secret-token"] = secret;
  const res = await app.fetch(
    new Request("http://test/telegram/webhook", {
      method: "POST",
      headers,
      body: JSON.stringify(update),
    })
  );
  return res;
}

function dmUpdate(text, { messageId = 1, date = 1_700_000_000 } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: USER_ID, first_name: "Sam" },
      chat: { id: USER_ID, type: "private" },
      text,
    },
  };
}

function groupUpdate(text, { messageId = 1, date = 1_700_000_000 } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: USER_ID, first_name: "Sam" },
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
      text,
    },
  };
}


function memberUpdate(chatId, type, title, status = "member") {
  return {
    update_id: 9000 + chatId,
    my_chat_member: {
      chat: { id: chatId, type, title },
      from: { id: USER_ID, first_name: "Sam" },
      date: 1_700_000_000,
      old_chat_member: { user: { id: 9999, is_bot: true, first_name: "Glimpse" }, status: "left" },
      new_chat_member: { user: { id: 9999, is_bot: true, first_name: "Glimpse" }, status },
    },
  };
}

async function addBotToGroup(env) {
  const res = await webhook(env.app, memberUpdate(GROUP_ID, "supergroup", "Team Chat"));
  assert.equal(res.status, 200);
}

function lastCode(tg) {
  const text = tg.sent[tg.sent.length - 1].text;
  const match = /\b(\d{6})\b/.exec(text);
  assert.ok(match, `expected a 6-digit code in: ${text}`);
  return match[1];
}

async function pairToken(env) {
  const res = await webhook(env.app, dmUpdate("/start"));
  assert.equal(res.status, 200);
  const code = lastCode(env.tg);
  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(pairRes.status, 200);
  const data = await pairRes.json();
  return data.token;
}

test("health endpoint", async () => {
  const env = makeEnv();
  const res = await env.app.fetch(req("/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("pairing happy path", async () => {
  const env = makeEnv();
  const res = await webhook(env.app, dmUpdate("/start"));
  assert.equal(res.status, 200);
  assert.equal(env.tg.sent.length, 1);
  assert.equal(env.tg.sent[0].chatId, USER_ID);
  const code = lastCode(env.tg);

  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(pairRes.status, 200);
  const data = await pairRes.json();
  assert.match(data.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(data.user, { id: USER_ID, firstName: "Sam" });

  const digest = await env.app.fetch(req("/v1/digest", { token: data.token }));
  assert.equal(digest.status, 200);
});

test("expired pairing code is rejected", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start"));
  const code = lastCode(env.tg);
  env.state.t += 10 * 60 * 1000 + 1;
  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(pairRes.status, 401);
  assert.equal((await pairRes.json()).error, "invalid_code");
});

test("pairing code is single-use", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start"));
  const code = lastCode(env.tg);
  const first = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(first.status, 200);
  const second = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(second.status, 401);
});

test("/start re-sends the live code instead of minting a new one", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start", { messageId: 1 }));
  const first = lastCode(env.tg);
  await webhook(env.app, dmUpdate("/start", { messageId: 2 }));
  const second = lastCode(env.tg);
  assert.equal(second, first);
  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code: first } }));
  assert.equal(pairRes.status, 200);
  // Once used, the next /start mints a fresh code.
  await webhook(env.app, dmUpdate("/start", { messageId: 3 }));
  const third = lastCode(env.tg);
  const pair2 = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code: third } }));
  assert.equal(pair2.status, 200);
});

test("webhook rejects a wrong or missing secret", async () => {
  const env = makeEnv();
  const wrong = await webhook(env.app, dmUpdate("/start"), "nope");
  assert.equal(wrong.status, 401);
  const missing = await webhook(env.app, dmUpdate("/start"), null);
  assert.equal(missing.status, 401);
  assert.equal(env.tg.sent.length, 0);
});

test("webhook stays 200 when handling fails", async () => {
  const env = makeEnv();
  env.tg.sendMessage = async () => {
    throw new Error("boom");
  };
  const res = await webhook(env.app, dmUpdate("/start"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("digest requires auth", async () => {
  const env = makeEnv();
  const noToken = await env.app.fetch(req("/v1/digest"));
  assert.equal(noToken.status, 401);
  const badToken = await env.app.fetch(req("/v1/digest", { token: "f".repeat(64) }));
  assert.equal(badToken.status, 401);
});

test("group messages land in the digest with unread counts and truncated lines", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await addBotToGroup(env);
  const long =
    "The deployment window moved to Friday evening because the staging checks took much longer than anyone expected this week";
  await webhook(env.app, groupUpdate("standup in five", { messageId: 10, date: 1_700_000_100 }));
  await webhook(env.app, groupUpdate(long, { messageId: 11, date: 1_700_000_200 }));

  const res = await env.app.fetch(req("/v1/digest", { token }));
  assert.equal(res.status, 200);
  const { sources } = await res.json();
  const group = sources.find((s) => s.id === GROUP_ID);
  assert.ok(group, "group source present");
  assert.equal(group.type, "group");
  assert.equal(group.title, "Team Chat");
  assert.equal(group.unread, 2);
  assert.equal(group.lastAt, 1_700_000_200_000);
  assert.equal(group.topLines.length, 2);
  assert.equal(group.topLines[1], "standup in five");
  const line = group.topLines[0];
  assert.ok(line.length <= 52, `line within budget: ${line.length}`);
  assert.ok(line.endsWith("…"));
  const head = line.slice(0, -1);
  assert.ok(long.startsWith(head), "truncation keeps a prefix");
  assert.equal(long[head.length], " ", "truncation happens at a word boundary");
});

test("plain DMs are stored under the forwarded & DMs source", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, dmUpdate("a forwarded note", { messageId: 7, date: 1_700_000_050 }));
  const res = await env.app.fetch(req("/v1/digest", { token }));
  const { sources } = await res.json();
  const dm = sources.find((s) => s.type === "dm");
  assert.ok(dm);
  assert.equal(dm.title, "Forwarded & DMs");
  assert.equal(dm.unread, 1);
  assert.deepEqual(dm.topLines, ["a forwarded note"]);
});

test("channel posts are stored under a channel source", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate(-1002, "channel", "Announcements", "administrator"));
  await webhook(env.app, {
    update_id: 1,
    channel_post: {
      message_id: 5,
      date: 1_700_000_300,
      chat: { id: -1002, type: "channel", title: "Announcements" },
      text: "v2 ships Monday",
    },
  });
  const res = await env.app.fetch(req("/v1/digest", { token }));
  const { sources } = await res.json();
  const channel = sources.find((s) => s.id === -1002);
  assert.ok(channel);
  assert.equal(channel.type, "channel");
  assert.equal(channel.unread, 1);
  assert.deepEqual(channel.topLines, ["v2 ships Monday"]);
});

test("source endpoint returns messages newest first", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await addBotToGroup(env);
  await webhook(env.app, groupUpdate("first", { messageId: 1, date: 1_700_000_100 }));
  await webhook(env.app, groupUpdate("second", { messageId: 2, date: 1_700_000_200 }));
  const res = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.source, { id: GROUP_ID, type: "group", title: "Team Chat" });
  assert.deepEqual(
    data.messages.map((m) => m.text),
    ["second", "first"]
  );
  assert.equal(data.messages[0].from, "Sam");
});

test("markRead reduces unread and never moves backwards", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await addBotToGroup(env);
  await webhook(env.app, groupUpdate("one", { messageId: 1, date: 1_700_000_100 }));
  await webhook(env.app, groupUpdate("two", { messageId: 2, date: 1_700_000_200 }));

  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();
  const newestId = messages[0].id;
  const oldestId = messages[messages.length - 1].id;

  const readRes = await env.app.fetch(
    req("/v1/read", { method: "POST", token, body: { sourceId: GROUP_ID, upToMessageId: newestId } })
  );
  assert.equal(readRes.status, 200);

  let digest = await (await env.app.fetch(req("/v1/digest", { token }))).json();
  assert.equal(digest.sources.find((s) => s.id === GROUP_ID).unread, 0);

  await webhook(env.app, groupUpdate("three", { messageId: 3, date: 1_700_000_300 }));
  digest = await (await env.app.fetch(req("/v1/digest", { token }))).json();
  assert.equal(digest.sources.find((s) => s.id === GROUP_ID).unread, 1);

  await env.app.fetch(
    req("/v1/read", { method: "POST", token, body: { sourceId: GROUP_ID, upToMessageId: oldestId } })
  );
  digest = await (await env.app.fetch(req("/v1/digest", { token }))).json();
  assert.equal(digest.sources.find((s) => s.id === GROUP_ID).unread, 1);
});

test("reply posts through the bot to the source chat", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await addBotToGroup(env);
  await webhook(env.app, groupUpdate("ping", { messageId: 1, date: 1_700_000_100 }));
  const sentBefore = env.tg.sent.length;
  const res = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "  hello there  " } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, messageId: 4242 });
  assert.equal(env.tg.sent.length, sentBefore + 1);
  const sent = env.tg.sent[env.tg.sent.length - 1];
  assert.equal(sent.chatId, GROUP_ID);
  assert.equal(sent.text, "hello there");
});

test("reply rejects empty and overlong text", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await addBotToGroup(env);
  await webhook(env.app, groupUpdate("ping", { messageId: 1, date: 1_700_000_100 }));
  for (const text of ["", "   ", "x".repeat(1001)]) {
    const res = await env.app.fetch(
      req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text } })
    );
    assert.equal(res.status, 400, `text length ${text.length} rejected`);
    assert.equal((await res.json()).error, "invalid_text");
  }
  const ok = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "x".repeat(1000) } })
  );
  assert.equal(ok.status, 200);
});

async function draftSetup(env, text) {
  const token = await pairToken(env);
  await addBotToGroup(env);
  await webhook(env.app, groupUpdate(text, { messageId: 1, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();
  return { token, messageId: messages[0].id };
}

test("draft uses the model reply when one is available", async () => {
  const env = makeEnv({
    aiImpl: {
      draftReply: async () => "Sounds great, count me in!",
      transcribe: async () => null,
    },
  });
  const { token, messageId } = await draftSetup(env, "Want to join the call?");
  const res = await env.app.fetch(
    req("/v1/draft", { method: "POST", token, body: { sourceId: GROUP_ID, messageId } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { draft: "Sounds great, count me in!", source: "llm" });
});

test("draft falls back for a question when the model is unavailable", async () => {
  const env = makeEnv();
  const { token, messageId } = await draftSetup(env, "Can you send the report?");
  const res = await env.app.fetch(
    req("/v1/draft", { method: "POST", token, body: { sourceId: GROUP_ID, messageId } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    draft: "Thanks for flagging — let me check and get back to you shortly.",
    source: "fallback",
  });
});

test("draft falls back with thanks for an announcement", async () => {
  const env = makeEnv();
  const { token, messageId } = await draftSetup(env, "The release ships on Friday");
  const res = await env.app.fetch(
    req("/v1/draft", { method: "POST", token, body: { sourceId: GROUP_ID, messageId } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { draft: "Thanks for the update!", source: "fallback" });
});

test("stt returns the transcription", async () => {
  let seenBytes = null;
  const env = makeEnv({
    aiImpl: {
      draftReply: async () => null,
      transcribe: async (bytes) => {
        seenBytes = bytes;
        return "hello world";
      },
    },
  });
  const token = await pairToken(env);
  const res = await env.app.fetch(
    req("/v1/stt", { method: "POST", token, body: new Uint8Array([1, 2, 3, 4]) })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "hello world" });
  assert.equal(seenBytes.length, 4);
});

test("stt reports unavailable when transcription fails", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  const res = await env.app.fetch(
    req("/v1/stt", { method: "POST", token, body: new Uint8Array([1, 2, 3]) })
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "stt_unavailable" });
});

test("stt rejects bodies over 2 MB", async () => {
  const env = makeEnv({
    aiImpl: {
      draftReply: async () => null,
      transcribe: async () => "should not be reached",
    },
  });
  const token = await pairToken(env);
  const res = await env.app.fetch(
    req("/v1/stt", { method: "POST", token, body: new Uint8Array(2 * 1024 * 1024 + 1) })
  );
  assert.equal(res.status, 413);
});

test("edited messages are ignored", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  const res = await webhook(env.app, {
    update_id: 9,
    edited_message: {
      message_id: 3,
      date: 1_700_000_100,
      from: { id: USER_ID, first_name: "Sam" },
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
      text: "edited text",
    },
  });
  assert.equal(res.status, 200);
  const digest = await (await env.app.fetch(req("/v1/digest", { token }))).json();
  assert.deepEqual(digest.sources, []);
});
