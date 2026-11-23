import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

// Ownership recovery: a group/channel whose my_chat_member update was
// missed stays ownerless (stored, but in no one's digest). Pairing
// sweeps the unowned sources and claims any chat where Telegram
// reports the pairing user as creator or administrator.

const SECRET = "test-webhook-secret";
const GROUP_ID = -1001;
const CHANNEL_ID = -1002;
const USER_ID = 42;
const OTHER_ID = 77;

function makeEnv({ roles = {} } = {}) {
  const state = { t: 1_700_000_000_000 };
  const store = new MemoryStore();
  const tg = {
    sent: [],
    async sendMessage(chatId, text, opts) {
      this.sent.push({ chatId, text, opts });
      return { message_id: 4242 };
    },
    // roles maps `${chatId}:${userId}` to a Telegram member status;
    // anything unlisted behaves like Telegram's "user not found" error.
    async getChatMember(chatId, userId) {
      const status = roles[`${chatId}:${userId}`];
      if (!status) throw new Error("Bad Request: user not found");
      return { status, user: { id: userId } };
    },
  };
  const ai = {
    draftReply: async () => null,
    transcribe: async () => null,
  };
  const app = createApp({ store, tg, ai, now: () => state.t, webhookSecret: SECRET });
  return { state, store, tg, ai, app };
}

function req(path, { method = "GET", token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h["content-type"] = "application/json";
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

function dmStart(userId, messageId) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      from: { id: userId, first_name: "Sam" },
      chat: { id: userId, type: "private" },
      text: "/start",
    },
  };
}

function groupUpdate(text, { messageId, date = 1_700_000_100, fromId = 2001 } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: fromId, first_name: "Member" },
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
      text,
    },
  };
}

function channelPost(text, { messageId, date = 1_700_000_100 } = {}) {
  return {
    update_id: messageId,
    channel_post: {
      message_id: messageId,
      date,
      chat: { id: CHANNEL_ID, type: "channel", title: "Announcements" },
      sender_chat: { id: CHANNEL_ID, type: "channel", title: "Announcements" },
      text,
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
  const res = await webhook(env.app, dmStart(userId, 900 + userId));
  assert.equal(res.status, 200);
  const code = lastCode(env.tg);
  const pairRes = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code } }));
  assert.equal(pairRes.status, 200);
  return (await pairRes.json()).token;
}

async function digestSources(env, token) {
  const res = await env.app.fetch(req("/v1/digest", { token }));
  assert.equal(res.status, 200);
  return (await res.json()).sources;
}

test("group messages stored before any my_chat_member become visible when the chat's creator pairs", async () => {
  const env = makeEnv({ roles: { [`${GROUP_ID}:${USER_ID}`]: "creator" } });
  // The bot was added while the webhook was down: the membership update
  // never arrived, but messages flow once the webhook is back.
  await webhook(env.app, groupUpdate("early one", { messageId: 10 }));
  await webhook(env.app, groupUpdate("early two", { messageId: 11, date: 1_700_000_200 }));

  const before = await env.store.getSource(GROUP_ID);
  assert.equal(before.userId, null);

  const token = await pairToken(env);
  const sources = await digestSources(env, token);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, GROUP_ID);
  assert.equal(sources[0].unread, 2);

  const detail = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  assert.equal(detail.status, 200);
  assert.equal((await env.store.getSource(GROUP_ID)).userId, USER_ID);
});

test("channel posts stored before any my_chat_member are claimed when an administrator pairs", async () => {
  const env = makeEnv({ roles: { [`${CHANNEL_ID}:${USER_ID}`]: "administrator" } });
  await webhook(env.app, channelPost("post one", { messageId: 20 }));
  assert.equal((await env.store.getSource(CHANNEL_ID)).userId, null);

  const token = await pairToken(env);
  const sources = await digestSources(env, token);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, CHANNEL_ID);
  assert.equal(sources[0].type, "channel");
  assert.equal(sources[0].unread, 1);
});

test("pairing does not claim a chat where the user is only a plain member", async () => {
  const env = makeEnv({ roles: { [`${GROUP_ID}:${USER_ID}`]: "member" } });
  await webhook(env.app, groupUpdate("not yours", { messageId: 10 }));

  const token = await pairToken(env);
  assert.deepEqual(await digestSources(env, token), []);
  assert.equal((await env.store.getSource(GROUP_ID)).userId, null);

  const detail = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  assert.equal(detail.status, 404);
});

test("a second user cannot see or take over a source the first user claimed", async () => {
  const env = makeEnv({
    roles: {
      [`${GROUP_ID}:${USER_ID}`]: "creator",
      [`${GROUP_ID}:${OTHER_ID}`]: "administrator",
    },
  });
  await webhook(env.app, groupUpdate("claimed at pairing", { messageId: 10 }));

  const ownerToken = await pairToken(env, USER_ID);
  assert.equal((await env.store.getSource(GROUP_ID)).userId, USER_ID);

  // The second user is also an admin of the chat and pairs afterwards:
  // the source is no longer unowned, so the sweep cannot move it.
  const otherToken = await pairToken(env, OTHER_ID);
  assert.equal((await env.store.getSource(GROUP_ID)).userId, USER_ID);
  assert.deepEqual(await digestSources(env, otherToken), []);

  const detail = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token: otherToken }));
  assert.equal(detail.status, 404);
  const reply = await env.app.fetch(
    req("/v1/reply", { method: "POST", token: otherToken, body: { sourceId: GROUP_ID, text: "intrusion" } })
  );
  assert.equal(reply.status, 404);
  assert.equal(env.tg.sent.filter((m) => m.chatId === GROUP_ID).length, 0);

  const ownerSources = await digestSources(env, ownerToken);
  assert.equal(ownerSources.length, 1);
  assert.equal(ownerSources[0].unread, 1);
});

test("pairing still succeeds when every membership check fails", async () => {
  const env = makeEnv(); // no roles: getChatMember always throws
  await webhook(env.app, groupUpdate("unclaimable", { messageId: 10 }));

  const token = await pairToken(env);
  assert.ok(token);
  assert.deepEqual(await digestSources(env, token), []);
  assert.equal((await env.store.getSource(GROUP_ID)).userId, null);
});
