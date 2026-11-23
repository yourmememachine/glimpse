// Glimpse — end-to-end integration tests.
//
// Drives the full product story over HTTP-level fetch calls against the
// backend app factory, using an in-memory store, a fake Telegram client
// that records every sendMessage call, and a fake AI provider.
//
// Run from the repo root:  npm test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as backendModule from '../backend/src/index.js';
import * as storeModule from '../backend/src/store.js';

const createApp =
  backendModule.createApp ||
  backendModule.default?.createApp ||
  (typeof backendModule.default === 'function' ? backendModule.default : null);
const MemoryStore = storeModule.MemoryStore || storeModule.default?.MemoryStore;

assert.ok(typeof createApp === 'function', 'backend/src/index.js must export createApp');
assert.ok(typeof MemoryStore === 'function', 'backend/src/store.js must export MemoryStore');

const WEBHOOK_SECRET = 'test-webhook-secret';
const BASE = 'http://glimpse.test';

const FAKE_DRAFT = 'Fake draft: thanks, I will check and reply shortly.';
const FAKE_TRANSCRIPT = 'fake transcript from voice note';

// --- Fakes -----------------------------------------------------------------

function makeFakeTg() {
  const outbox = [];
  let nextId = 9000;
  return {
    outbox,
    async sendMessage(chatId, text, opts = {}) {
      const messageId = ++nextId;
      outbox.push({ chatId, text: String(text), opts, messageId });
      // Mirror backend/src/telegram.js: sendMessage returns the unwrapped
      // Telegram result object, i.e. { message_id, ... }.
      return { message_id: messageId };
    },
  };
}

const fakeAi = {
  async draftReply(_ctx) {
    return FAKE_DRAFT;
  },
  async transcribe(_wavBytes) {
    return FAKE_TRANSCRIPT;
  },
};

// --- App under test ----------------------------------------------------------

const tg = makeFakeTg();
const store = new MemoryStore();
let clock = 1_763_000_000_000; // fixed-ish base, ms since epoch
const now = () => (clock += 1000);

const app = createApp({
  store,
  tg,
  ai: fakeAi,
  now,
  webhookSecret: WEBHOOK_SECRET,
  // Extra shapes, harmless if ignored, in case the factory reads env-style:
  WEBHOOK_SECRET,
  env: { WEBHOOK_SECRET },
});

const fetchApp = typeof app === 'function' ? app : app.fetch.bind(app);

// --- HTTP helpers ------------------------------------------------------------

async function call(path, { method = 'GET', token, json, body, headers = {} } = {}) {
  const h = { ...headers };
  let payload = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetchApp(new Request(BASE + path, { method, headers: h, body: payload }));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, data, text };
}

let updateId = 0;
async function webhook(update, secret = WEBHOOK_SECRET) {
  return call('/telegram/webhook', {
    method: 'POST',
    json: { update_id: ++updateId, ...update },
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
  });
}

function tgMessage({ chatId, chatType, title, fromId, fromName, text, messageId, date, extra = {} }) {
  const chat = { id: chatId, type: chatType };
  if (title) chat.title = title;
  return {
    message: {
      message_id: messageId,
      date,
      chat,
      from: { id: fromId, first_name: fromName, is_bot: false },
      text,
      ...extra,
    },
  };
}

function smallWav() {
  // Minimal valid 44-byte WAV header (16 kHz mono PCM16) + a little silence.
  const bytes = new Uint8Array(44 + 32);
  const view = new DataView(bytes.buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + 32, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, 32, true);
  return bytes;
}

// --- Shared story state --------------------------------------------------------

const USER_ID = 1001;
const GROUP_ID = -1002001;
const CHANNEL_ID = -1003001;
const GROUP_TITLE = 'Solana Builders Chat';
const CHANNEL_TITLE = 'Crypto Signals Daily';

let token;
let groupSource;
let channelSource;
let dmSource;
let groupMessages; // newest-first, as returned by GET /v1/source/:id

test('full product story', async (t) => {
  await t.test('(10a) webhook with a bad secret is rejected with 401', async () => {
    const res = await webhook(
      tgMessage({
        chatId: USER_ID, chatType: 'private', fromId: USER_ID, fromName: 'Demo',
        text: '/start', messageId: 1, date: 1763000000,
      }),
      'wrong-secret',
    );
    assert.equal(res.status, 401);
  });

  await t.test('(10b) unauthenticated GET /v1/digest is rejected with 401', async () => {
    const res = await call('/v1/digest');
    assert.equal(res.status, 401);
  });

  await t.test('(1) webhook /start in a DM issues a pairing code via the bot', async () => {
    const before = tg.outbox.length;
    const res = await webhook(tgMessage({
      chatId: USER_ID, chatType: 'private', fromId: USER_ID, fromName: 'Demo',
      text: '/start', messageId: 2, date: 1763000010,
    }));
    assert.equal(res.status, 200);
    const sent = tg.outbox.slice(before).filter((m) => m.chatId === USER_ID);
    assert.ok(sent.length >= 1, 'bot should DM the user after /start');
    const match = sent.map((m) => m.text).join('\n').match(/\b(\d{6})\b/);
    assert.ok(match, `pairing code (6 digits) not found in bot DM: ${JSON.stringify(sent)}`);
    t.diagnostic(`pairing code issued: ${match[1]}`);
    // Stash on the shared context for the next step.
    story.code = match[1];
  });

  await t.test('(2) POST /v1/pair with the code returns a session token', async () => {
    assert.ok(story.code, 'previous step must have captured a pairing code');
    const res = await call('/v1/pair', { method: 'POST', json: { code: story.code } });
    assert.equal(res.status, 200, `pair failed: ${res.text}`);
    assert.ok(typeof res.data.token === 'string' && res.data.token.length >= 32);
    assert.equal(String(res.data.user.id), String(USER_ID));
    token = res.data.token;
  });

  await t.test('(3) webhook delivers 3 group messages, 2 channel posts, 1 forwarded DM', async () => {
    // The paired user adds the bot to the group first (my_chat_member):
    // a source belongs to the user whose bot membership surfaced it, so
    // this is what attaches the group to the paired user before other
    // members post in it.
    const added = await webhook({
      my_chat_member: {
        chat: { id: GROUP_ID, type: 'supergroup', title: GROUP_TITLE },
        from: { id: USER_ID, first_name: 'Demo', is_bot: false },
        date: 1763000050,
        old_chat_member: { user: { id: 9999, first_name: 'Glimpse', is_bot: true }, status: 'left' },
        new_chat_member: { user: { id: 9999, first_name: 'Glimpse', is_bot: true }, status: 'member' },
      },
    });
    assert.equal(added.status, 200, `my_chat_member: ${added.text}`);

    const base = 1763000100;
    const groupTexts = [
      'Morning all — standup notes are in the doc',
      'Can someone review the new landing page copy?',
      'Demo question for you: are we shipping the update on Friday?',
    ];
    for (let i = 0; i < groupTexts.length; i++) {
      const res = await webhook(tgMessage({
        chatId: GROUP_ID, chatType: 'supergroup', title: GROUP_TITLE,
        fromId: 2001 + i, fromName: ['Maya', 'Leo', 'Priya'][i],
        text: groupTexts[i], messageId: 101 + i, date: base + i * 60,
      }));
      assert.equal(res.status, 200, `group message ${i}: ${res.text}`);
    }

    // Same attribution for the channel: the paired user promotes the bot
    // to channel administrator (my_chat_member) before any posts arrive,
    // so the channel source is owned by the paired user.
    const promoted = await webhook({
      my_chat_member: {
        chat: { id: CHANNEL_ID, type: 'channel', title: CHANNEL_TITLE },
        from: { id: USER_ID, first_name: 'Demo', is_bot: false },
        date: 1763000060,
        old_chat_member: { user: { id: 9999, first_name: 'Glimpse', is_bot: true }, status: 'left' },
        new_chat_member: {
          user: { id: 9999, first_name: 'Glimpse', is_bot: true },
          status: 'administrator',
          can_post_messages: true,
        },
      },
    });
    assert.equal(promoted.status, 200, `channel my_chat_member: ${promoted.text}`);

    const channelTexts = [
      'Market update: majors are range-bound this morning, volume is thin.',
      'Reminder: community call starts in one hour, agenda is pinned above.',
    ];
    for (let i = 0; i < channelTexts.length; i++) {
      const res = await webhook({
        channel_post: {
          message_id: 201 + i,
          date: base + 1000 + i * 60,
          chat: { id: CHANNEL_ID, type: 'channel', title: CHANNEL_TITLE },
          sender_chat: { id: CHANNEL_ID, type: 'channel', title: CHANNEL_TITLE },
          text: channelTexts[i],
        },
      });
      assert.equal(res.status, 200, `channel post ${i}: ${res.text}`);
    }

    // A message in a chat the bot was never attributed to the paired user
    // for (no my_chat_member from the paired user) must stay ownerless
    // with respect to the paired user and never surface in their digest.
    const stray = await webhook(tgMessage({
      chatId: -1004001, chatType: 'supergroup', title: 'Unowned Corner',
      fromId: 2009, fromName: 'Stranger',
      text: 'This chat was never added by the paired user.',
      messageId: 401, date: base + 3000,
    }));
    assert.equal(stray.status, 200, `ownerless message: ${stray.text}`);

    const fwd = await webhook(tgMessage({
      chatId: USER_ID, chatType: 'private', fromId: USER_ID, fromName: 'Demo',
      text: 'Forwarded tip: the workshop recording is now available to watch.',
      messageId: 301, date: base + 2000,
      extra: {
        forward_from: { id: 3001, first_name: 'Nina' },
        forward_date: base + 1900,
      },
    }));
    assert.equal(fwd.status, 200, `forwarded DM: ${fwd.text}`);
  });

  await t.test('(4) GET /v1/digest shows 3 sources with unread 3/2/1 and lines <= 52 chars', async () => {
    const res = await call('/v1/digest', { token });
    assert.equal(res.status, 200, res.text);
    const sources = res.data.sources;
    assert.equal(sources.length, 3, `expected 3 sources, got: ${JSON.stringify(sources)}`);

    groupSource = sources.find((s) => s.type === 'group');
    channelSource = sources.find((s) => s.type === 'channel');
    dmSource = sources.find((s) => s.type === 'dm');
    assert.ok(groupSource, 'group source missing');
    assert.ok(channelSource, 'channel source missing');
    assert.ok(dmSource, 'dm (forwarded inbox) source missing');
    assert.ok(
      !sources.some((s) => String(s.id) === '-1004001' || s.title === 'Unowned Corner'),
      'an ownerless source (no my_chat_member from the paired user) must not appear in the digest',
    );

    assert.equal(groupSource.unread, 3);
    assert.equal(channelSource.unread, 2);
    assert.equal(dmSource.unread, 1);
    assert.equal(groupSource.title, GROUP_TITLE);
    assert.equal(channelSource.title, CHANNEL_TITLE);

    for (const s of sources) {
      assert.ok(Array.isArray(s.topLines) && s.topLines.length >= 1, `topLines for ${s.type}`);
      assert.ok(s.topLines.length <= 3, 'topLines capped at 3');
      for (const line of s.topLines) {
        assert.ok(line.length <= 52, `digest line over 52 chars (${line.length}): ${line}`);
      }
    }
    // Sources ordered by lastAt desc.
    const lasts = sources.map((s) => s.lastAt);
    assert.deepEqual(lasts, [...lasts].sort((a, b) => b - a), 'sources must be newest first');
  });

  await t.test('(5) GET /v1/source for the group returns messages newest-first', async () => {
    const res = await call(`/v1/source/${encodeURIComponent(groupSource.id)}`, { token });
    assert.equal(res.status, 200, res.text);
    assert.equal(String(res.data.source.id), String(groupSource.id));
    groupMessages = res.data.messages;
    assert.equal(groupMessages.length, 3);
    assert.match(groupMessages[0].text, /shipping the update on Friday/);
    assert.match(groupMessages[2].text, /standup notes/);
    const ats = groupMessages.map((m) => m.at);
    assert.deepEqual(ats, [...ats].sort((a, b) => b - a), 'messages must be newest first');
  });

  await t.test('(6) POST /v1/read clears that source unread count', async () => {
    const newest = groupMessages[0];
    const res = await call('/v1/read', {
      method: 'POST', token,
      json: { sourceId: groupSource.id, upToMessageId: newest.id },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.ok, true);

    const digest = await call('/v1/digest', { token });
    const group = digest.data.sources.find((s) => String(s.id) === String(groupSource.id));
    // A fully-read source either disappears or reports zero unread.
    assert.ok(!group || group.unread === 0, `group unread should be 0, got ${group?.unread}`);
    const channel = digest.data.sources.find((s) => s.type === 'channel');
    assert.equal(channel.unread, 2, 'other sources must be unaffected');
  });

  await t.test('(7) POST /v1/reply lands in the Telegram outbox addressed to the group chat', async () => {
    const before = tg.outbox.length;
    const res = await call('/v1/reply', {
      method: 'POST', token,
      json: { sourceId: groupSource.id, text: 'Yes — shipping Friday, final checks Thursday.' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.ok, true);
    const sent = tg.outbox.slice(before);
    assert.equal(sent.length, 1, 'exactly one bot message should be sent');
    assert.equal(String(sent[0].chatId), String(GROUP_ID), 'reply must go to the group chat id');
    assert.match(sent[0].text, /shipping Friday/);
  });

  await t.test('(8) POST /v1/draft returns the AI draft', async () => {
    const res = await call('/v1/draft', {
      method: 'POST', token,
      json: { sourceId: groupSource.id, messageId: groupMessages[0].id },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.draft, FAKE_DRAFT);
  });

  await t.test('(9) POST /v1/stt with small WAV bytes returns the transcript', async () => {
    const res = await call('/v1/stt', {
      method: 'POST', token,
      body: smallWav(),
      headers: { 'Content-Type': 'audio/wav' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.text, FAKE_TRANSCRIPT);
  });
});

// Mutable bag shared between sequential subtests above.
const story = {};
