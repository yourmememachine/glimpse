import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

const SECRET = "test-webhook-secret";
const GROUP_ID = -1001;
const CHANNEL_ID = -1002;
const USER_ID = 42;
const OTHER_ID = 77;

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
  const app = createApp({ store, tg, ai, now: () => state.t, webhookSecret: SECRET });
  return { state, store, tg, ai, app };
}

function req(path, { method = "GET", token, rawAuth, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (rawAuth != null) h.authorization = rawAuth;
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

async function webhook(app, update) {
  return app.fetch(
    new Request("http://test/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify(update),
    })
  );
}

function dmUpdate(text, { userId = USER_ID, messageId = 1, date = 1_700_000_000 } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: userId, first_name: "Sam" },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

function groupUpdate(text, { messageId = 1, date = 1_700_000_000, extra = {} } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: USER_ID, first_name: "Sam" },
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
      text,
      ...extra,
    },
  };
}

function memberUpdate(status = "member", { fromId = USER_ID, chatId = GROUP_ID, type = "supergroup" } = {}) {
  return {
    update_id: 5000,
    my_chat_member: {
      chat: { id: chatId, type, title: "Team Chat" },
      from: { id: fromId, first_name: "Sam" },
      date: 1_700_000_000,
      old_chat_member: { user: { id: 9999, is_bot: true, first_name: "Glimpse" }, status: "left" },
      new_chat_member: { user: { id: 9999, is_bot: true, first_name: "Glimpse" }, status },
    },
  };
}

function lastCode(tg) {
  const text = tg.sent[tg.sent.length - 1].text;
  const match = /\b(\d{6})\b/.exec(text);
  assert.ok(match, `expected a 6-digit code in: ${text}`);
  return match[1];
}

async function pairToken(env, userId = USER_ID) {
  const res = await webhook(env.app, dmUpdate("/start", { userId }));
  assert.equal(res.status, 200);
  const code = lastCode(env.tg);
  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(pairRes.status, 200);
  return (await pairRes.json()).token;
}

async function ownedGroupWithMessage(env) {
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("private to the owner", { messageId: 10, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();
  return { token, messageId: messages[0].id };
}

test("a second user cannot read, mark, draft or reply on another user's source", async () => {
  const env = makeEnv();
  const { messageId } = await ownedGroupWithMessage(env);
  const other = await pairToken(env, OTHER_ID);

  const digest = await env.app.fetch(req("/v1/digest", { token: other }));
  assert.equal(digest.status, 200);
  assert.deepEqual((await digest.json()).sources, []);

  const detail = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token: other }));
  assert.equal(detail.status, 404);

  const read = await env.app.fetch(
    req("/v1/read", { method: "POST", token: other, body: { sourceId: GROUP_ID, upToMessageId: messageId } })
  );
  assert.equal(read.status, 404);

  const draft = await env.app.fetch(
    req("/v1/draft", { method: "POST", token: other, body: { sourceId: GROUP_ID, messageId } })
  );
  assert.equal(draft.status, 404);

  const reply = await env.app.fetch(
    req("/v1/reply", { method: "POST", token: other, body: { sourceId: GROUP_ID, text: "intrusion" } })
  );
  assert.equal(reply.status, 404);
  assert.equal(env.tg.sent.filter((m) => m.chatId === GROUP_ID).length, 0);

  // The owner's read marker is untouched by the attempts: still 1 unread.
  const ownerToken = await pairToken(env);
  const ownerDigest = await env.app.fetch(req("/v1/digest", { token: ownerToken }));
  assert.equal(ownerDigest.status, 200);
  const ownerSources = (await ownerDigest.json()).sources;
  assert.equal(ownerSources.length, 1);
  assert.equal(ownerSources[0].unread, 1);
});

test("malformed or missing authorization headers are rejected cleanly", async () => {
  const env = makeEnv();
  await pairToken(env);
  for (const rawAuth of ["Token abc", "Bearer", "Bearer ", "basic dXNlcjpwYXNz", ""]) {
    const res = await env.app.fetch(req("/v1/digest", { rawAuth }));
    assert.equal(res.status, 401, `header ${JSON.stringify(rawAuth)} rejected`);
    assert.equal((await res.json()).error, "unauthorized");
  }
  const noHeader = await env.app.fetch(req("/v1/digest"));
  assert.equal(noHeader.status, 401);
});

test("a media message with a caption stores the caption text", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  const update = groupUpdate(undefined, { messageId: 30, date: 1_700_000_100 });
  delete update.message.text;
  update.message.photo = [{ file_id: "p" }];
  update.message.caption = "chart from this morning";
  await webhook(env.app, update);
  const msgs = await env.store.messagesFor(GROUP_ID, 20);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "chart from this morning");
});

test("the same webhook update delivered twice is stored once", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  const update = groupUpdate("delivered twice", { messageId: 40, date: 1_700_000_100 });
  await webhook(env.app, update);
  await webhook(env.app, update);
  const msgs = await env.store.messagesFor(GROUP_ID, 20);
  assert.equal(msgs.length, 1);
  const digest = await env.app.fetch(req("/v1/digest", { token }));
  const group = (await digest.json()).sources.find((s) => s.id === GROUP_ID);
  assert.equal(group.unread, 1);
});

test("edited channel posts are ignored, like edited messages", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate("administrator", { chatId: CHANNEL_ID, type: "channel" }));
  const res = await webhook(env.app, {
    update_id: 61,
    edited_channel_post: {
      message_id: 5,
      date: 1_700_000_100,
      chat: { id: CHANNEL_ID, type: "channel", title: "Announcements" },
      text: "rewritten after the fact",
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await env.store.messagesFor(CHANNEL_ID, 20), []);
  const digest = await env.app.fetch(req("/v1/digest", { token }));
  assert.deepEqual((await digest.json()).sources, []);
});

test("stt with an empty body reports unavailable instead of hanging or succeeding", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  const res = await env.app.fetch(
    req("/v1/stt", { method: "POST", token, body: new Uint8Array(0) })
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "stt_unavailable" });
});
