import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, truncateLine } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

const SECRET = "test-webhook-secret";
const GROUP_ID = -1001;
const USER_ID = 42;
const OTHER_ID = 77;

function makeEnv({ aiImpl, tgImpl } = {}) {
  const state = { t: 1_700_000_000_000 };
  const store = new MemoryStore();
  const tg = tgImpl ?? {
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

function dmUpdate(text, { userId = USER_ID, messageId = 1, date = 1_700_000_000, extra = {} } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: userId, first_name: "Sam" },
      chat: { id: userId, type: "private" },
      text,
      ...extra,
    },
  };
}

function groupUpdate(text, { messageId = 1, date = 1_700_000_000, fromId = USER_ID, extra = {} } = {}) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      from: { id: fromId, first_name: "Sam" },
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
      text,
      ...extra,
    },
  };
}

function memberUpdate(status = "member", { fromId = USER_ID } = {}) {
  return {
    update_id: 5000,
    my_chat_member: {
      chat: { id: GROUP_ID, type: "supergroup", title: "Team Chat" },
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

async function digestSources(env, token) {
  const res = await env.app.fetch(req("/v1/digest", { token }));
  assert.equal(res.status, 200);
  return (await res.json()).sources;
}

test("null-owned source is invisible and unreplyable", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, groupUpdate("leaked?", { messageId: 10, date: 1_700_000_100 }));

  assert.deepEqual(await digestSources(env, token), []);

  const src = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  assert.equal(src.status, 404);

  const reply = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "hi" } })
  );
  assert.equal(reply.status, 404);
  assert.equal(env.tg.sent.filter((m) => m.chatId === GROUP_ID).length, 0);

  const stored = await env.store.listSourcesWithUnread(USER_ID);
  assert.deepEqual(stored, []);
});

test("my_chat_member attributes the source to the user who added the bot", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, groupUpdate("before add", { messageId: 10, date: 1_700_000_100 }));
  assert.deepEqual(await digestSources(env, token), []);

  await webhook(env.app, memberUpdate("member", { fromId: USER_ID }));
  const source = await env.store.getSource(GROUP_ID);
  assert.equal(source.userId, USER_ID);

  await webhook(
    env.app,
    groupUpdate("from someone else", { messageId: 11, date: 1_700_000_200, fromId: 2001 })
  );
  const sources = await digestSources(env, token);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].unread, 2);
});

test("bot removal deletes the source, its messages and markers", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("hello", { messageId: 10, date: 1_700_000_100 }));
  assert.equal((await digestSources(env, token)).length, 1);

  await webhook(env.app, memberUpdate("left"));
  assert.equal(await env.store.getSource(GROUP_ID), null);
  assert.deepEqual(await env.store.messagesFor(GROUP_ID, 20), []);
  assert.deepEqual(await digestSources(env, token), []);
  const src = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  assert.equal(src.status, 404);
});

test("pair code collision across users never overwrites a live code", async () => {
  const store = new MemoryStore();
  await store.upsertUser(1, "A", 1000);
  await store.upsertUser(2, "B", 1000);
  assert.equal(await store.createPairCode({ code: "123456", userId: 1, expiresAt: 99999 }), true);
  assert.equal(await store.createPairCode({ code: "123456", userId: 2, expiresAt: 99999 }), false);
  assert.deepEqual(await store.redeemPairCode("123456", 2000), { id: 1, firstName: "A" });
  assert.equal(await store.createPairCode({ code: "654321", userId: 2, expiresAt: 99999 }), true);
  assert.deepEqual(await store.redeemPairCode("654321", 2000), { id: 2, firstName: "B" });
});

test("pair endpoint locks out after 10 failures within 10 minutes", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start"));
  const good = lastCode(env.tg);
  const wrong = good === "000000" ? "000001" : "000000";
  for (let i = 0; i < 10; i++) {
    const res = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code: wrong } }));
    assert.equal(res.status, 401, `failure ${i + 1}`);
  }
  const locked = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code: good } }));
  assert.equal(locked.status, 429);
  env.state.t += 10 * 60 * 1000 + 1;
  const after = await env.app.fetch(req("/v1/pair", { method: "POST", body: { code: wrong } }));
  assert.equal(after.status, 401);
});

test("reply translates the internal id to the telegram message id", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("target", { messageId: 777, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();
  const internalId = messages[0].id;
  assert.notEqual(internalId, 777);

  const sentBefore = env.tg.sent.length;
  const res = await env.app.fetch(
    req("/v1/reply", {
      method: "POST",
      token,
      body: { sourceId: GROUP_ID, text: "replying", replyToMessageId: internalId },
    })
  );
  assert.equal(res.status, 200);
  const sent = env.tg.sent[env.tg.sent.length - 1];
  assert.equal(env.tg.sent.length, sentBefore + 1);
  assert.equal(sent.opts.replyToMessageId, 777);

  const bad = await env.app.fetch(
    req("/v1/reply", {
      method: "POST",
      token,
      body: { sourceId: GROUP_ID, text: "replying again", replyToMessageId: 999999 },
    })
  );
  assert.equal(bad.status, 400);
});

test("reply retries once without the target when telegram says the reply target is gone", async () => {
  const calls = [];
  const tg = {
    sent: calls,
    async sendMessage(chatId, text, opts) {
      calls.push({ chatId, text, opts });
      if (opts && opts.replyToMessageId != null) {
        const err = new Error("telegram_send_failed:400");
        err.description = "Bad Request: message to be replied not found";
        throw err;
      }
      return { message_id: 555 };
    },
  };
  const env = makeEnv({ tgImpl: tg });
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("target", { messageId: 777, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();

  const before = calls.length;
  const res = await env.app.fetch(
    req("/v1/reply", {
      method: "POST",
      token,
      body: { sourceId: GROUP_ID, text: "still sends", replyToMessageId: messages[0].id },
    })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, messageId: 555 });
  assert.equal(calls.length, before + 2);
  assert.equal(calls[before].opts.replyToMessageId, 777);
  assert.equal(calls[before + 1].opts.replyToMessageId, undefined);
});

test("media-only messages are stored with typed placeholders", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  const cases = [
    [{ photo: [{ file_id: "p" }] }, "[Photo]"],
    [{ voice: { file_id: "v" } }, "[Voice message]"],
    [{ sticker: { file_id: "s" } }, "[Sticker]"],
    [{ video: { file_id: "vd" } }, "[Video]"],
    [{ document: { file_id: "d" } }, "[File]"],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [extra] = cases[i];
    const update = groupUpdate(undefined, { messageId: 20 + i, date: 1_700_000_100 + i });
    delete update.message.text;
    Object.assign(update.message, extra);
    await webhook(env.app, update);
  }
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}?limit=10`, { token }));
  const { messages } = await srcRes.json();
  assert.deepEqual(
    messages.map((m) => m.text).sort(),
    cases.map((c) => c[1]).sort()
  );
});

test("read marker is clamped to the newest stored message", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("one", { messageId: 1, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();

  const readRes = await env.app.fetch(
    req("/v1/read", {
      method: "POST",
      token,
      body: { sourceId: GROUP_ID, upToMessageId: messages[0].id + 100000 },
    })
  );
  assert.equal(readRes.status, 200);
  assert.equal((await digestSources(env, token))[0].unread, 0);

  await webhook(env.app, groupUpdate("two", { messageId: 2, date: 1_700_000_200 }));
  assert.equal((await digestSources(env, token))[0].unread, 1);
});

test("sessions expire 30 days after creation", async () => {
  const store = new MemoryStore();
  await store.upsertUser(7, "Jo", 1000);
  await store.createSession("hash", 7, 10_000);
  assert.deepEqual(await store.userForToken("hash", 10_000 + 29 * 24 * 3600 * 1000), {
    id: 7,
    firstName: "Jo",
  });
  assert.equal(await store.userForToken("hash", 10_000 + 31 * 24 * 3600 * 1000), null);

  const env = makeEnv();
  const token = await pairToken(env);
  const ok = await env.app.fetch(req("/v1/digest", { token }));
  assert.equal(ok.status, 200);
  env.state.t += 31 * 24 * 3600 * 1000;
  const expired = await env.app.fetch(req("/v1/digest", { token }));
  assert.equal(expired.status, 401);
});

test("identical replies within 120 seconds are deduped", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("ping", { messageId: 1, date: 1_700_000_100 }));
  const groupSends = () => env.tg.sent.filter((m) => m.chatId === GROUP_ID).length;

  const first = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "same words" } })
  );
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, messageId: 4242 });
  assert.equal(groupSends(), 1);

  const second = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "same words" } })
  );
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, messageId: 4242, deduped: true });
  assert.equal(groupSends(), 1);

  const otherUser = await pairToken(env, OTHER_ID);
  const third = await env.app.fetch(
    req("/v1/reply", { method: "POST", token: otherUser, body: { sourceId: GROUP_ID, text: "same words" } })
  );
  assert.equal(third.status, 404);

  env.state.t += 121 * 1000;
  const fourth = await env.app.fetch(
    req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "same words" } })
  );
  assert.equal(fourth.status, 200);
  assert.equal((await fourth.json()).deduped, undefined);
  assert.equal(groupSends(), 2);
});

test("/start with a payload still pairs, /startxyz is a normal message", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start ref42", { messageId: 1 }));
  assert.equal(env.tg.sent.length, 1);
  const token = await pairToken(env);
  await webhook(env.app, dmUpdate("/startxyz", { messageId: 9, date: 1_700_000_050 }));
  const sources = await digestSources(env, token);
  const dm = sources.find((s) => s.type === "dm");
  assert.ok(dm);
  assert.deepEqual(dm.topLines, ["/startxyz"]);
});

test("oversized content-length is rejected before the body is read", async () => {
  const env = makeEnv();
  const res = await env.app.fetch(
    new Request("http://test/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: JSON.stringify({ code: "123456" }),
    })
  );
  assert.equal(res.status, 413);
  const stt = await env.app.fetch(
    new Request("http://test/v1/stt", {
      method: "POST",
      headers: { "content-length": String(3 * 1024 * 1024) },
      body: new Uint8Array([1, 2, 3]),
    })
  );
  assert.equal(stt.status, 413);
});

test("truncateLine never emits a lone surrogate", () => {
  const out = truncateLine("😀".repeat(60));
  assert.equal(Array.from(out).length, 52);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
    "no lone surrogates"
  );
});

test("draft output is stripped of fences and quotes and capped at 300 chars", async () => {
  const env = makeEnv({
    aiImpl: {
      draftReply: async () => "```\n\"" + "x".repeat(400) + "\"\n```",
      transcribe: async () => null,
    },
  });
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("hello?", { messageId: 1, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();
  const res = await env.app.fetch(
    req("/v1/draft", { method: "POST", token, body: { sourceId: GROUP_ID, messageId: messages[0].id } })
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, "llm");
  assert.equal(data.draft.length, 300);
  assert.ok(!data.draft.includes("`"));
  assert.ok(!data.draft.startsWith('"'));
});

test("stored text is capped at 4000 chars and automatic forwards are skipped", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("y".repeat(5000), { messageId: 1, date: 1_700_000_100 }));
  const fwd = groupUpdate("auto forwarded", { messageId: 2, date: 1_700_000_200 });
  fwd.message.is_automatic_forward = true;
  await webhook(env.app, fwd);
  const noId = groupUpdate("no id", { messageId: 3, date: 1_700_000_300 });
  delete noId.message.message_id;
  await webhook(env.app, noId);

  const msgs = await env.store.messagesFor(GROUP_ID, 20);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text.length, 4000);
  assert.equal((await digestSources(env, token))[0].unread, 1);
});

test("anonymous admin posts prefer the sender chat name", async () => {
  const env = makeEnv();
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  const update = groupUpdate("anon post", { messageId: 5, date: 1_700_000_100, fromId: 2001 });
  update.message.sender_chat = { id: GROUP_ID, type: "supergroup", title: "Team Chat" };
  update.message.from = { id: 2001, first_name: "Hidden Admin" };
  await webhook(env.app, update);
  const msgs = await env.store.messagesFor(GROUP_ID, 20);
  assert.equal(msgs[0].from, "Team Chat");
});

test("reply does not fall back unthreaded on a rate-limit error", async () => {
  const calls = [];
  const tg = {
    sent: calls,
    async sendMessage(chatId, text, opts) {
      calls.push({ chatId, text, opts });
      if (opts && opts.replyToMessageId != null) {
        const err = new Error("telegram_send_failed:429");
        err.description = "Too Many Requests: retry after 3";
        throw err;
      }
      return { message_id: 556 };
    },
  };
  const env = makeEnv({ tgImpl: tg });
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("target", { messageId: 777, date: 1_700_000_100 }));
  const srcRes = await env.app.fetch(req(`/v1/source/${GROUP_ID}`, { token }));
  const { messages } = await srcRes.json();

  const before = calls.length;
  const res = await env.app.fetch(
    req("/v1/reply", {
      method: "POST",
      token,
      body: { sourceId: GROUP_ID, text: "rate limited", replyToMessageId: messages[0].id },
    })
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "send_failed");
  // Exactly one send attempt: no silent unthreaded retry went out.
  assert.equal(calls.length, before + 1);
  assert.equal(calls[before].opts.replyToMessageId, 777);
});

test("pair lockout is per client: one attacker cannot lock out another client", async () => {
  const env = makeEnv();
  await webhook(env.app, dmUpdate("/start"));
  const good = lastCode(env.tg);
  const wrong = good === "000000" ? "000001" : "000000";
  const attacker = { "cf-connecting-ip": "203.0.113.9" };
  const victim = { "cf-connecting-ip": "198.51.100.7" };
  for (let i = 0; i < 10; i++) {
    const res = await env.app.fetch(
      req("/v1/pair", { method: "POST", body: { code: wrong }, headers: attacker })
    );
    assert.equal(res.status, 401, `attacker failure ${i + 1}`);
  }
  // The attacker is locked out, even with the genuine code.
  const locked = await env.app.fetch(
    req("/v1/pair", { method: "POST", body: { code: good }, headers: attacker })
  );
  assert.equal(locked.status, 429);
  // A different client is unaffected and pairs with the same code.
  const ok = await env.app.fetch(
    req("/v1/pair", { method: "POST", body: { code: good }, headers: victim })
  );
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
});

test("webhook answers non-200 on a store failure and the redelivery is stored once", async () => {
  const env = makeEnv();
  await webhook(env.app, memberUpdate());
  const update = groupUpdate("important", { messageId: 31, date: 1_700_000_100 });

  const original = env.store.addMessage.bind(env.store);
  env.store.addMessage = async () => {
    throw new Error("store unavailable");
  };
  const failed = await webhook(env.app, update);
  assert.notEqual(failed.status, 200);
  assert.equal(failed.status, 500);
  assert.deepEqual(await env.store.messagesFor(GROUP_ID, 20), []);

  // Telegram redelivers the same update; it is stored exactly once, and a
  // further duplicate delivery still stores nothing new.
  env.store.addMessage = original;
  const retry = await webhook(env.app, update);
  assert.equal(retry.status, 200);
  const again = await webhook(env.app, update);
  assert.equal(again.status, 200);
  const msgs = await env.store.messagesFor(GROUP_ID, 20);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "important");
});

test("two simultaneous identical replies produce a single send", async () => {
  const calls = [];
  const tg = {
    sent: calls,
    async sendMessage(chatId, text, opts) {
      calls.push({ chatId, text, opts });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { message_id: 900 };
    },
  };
  const env = makeEnv({ tgImpl: tg });
  const token = await pairToken(env);
  await webhook(env.app, memberUpdate());
  await webhook(env.app, groupUpdate("ping", { messageId: 1, date: 1_700_000_100 }));
  const groupSends = () => calls.filter((m) => m.chatId === GROUP_ID).length;
  const before = groupSends();

  const send = () =>
    env.app.fetch(
      req("/v1/reply", { method: "POST", token, body: { sourceId: GROUP_ID, text: "same words" } })
    );
  const [r1, r2] = await Promise.all([send(), send()]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const bodies = [await r1.json(), await r2.json()];
  assert.equal(groupSends(), before + 1);
  assert.ok(bodies.every((b) => b.ok && b.messageId === 900));
  assert.equal(bodies.filter((b) => b.deduped === true).length, 1);
});
