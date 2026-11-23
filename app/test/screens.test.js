import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenMachine, QUICK_REPLIES } from '../src/screens.js';

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    _token: true,
    async hasToken() { return this._token; },
    async pair(code) { calls.push(['pair', code]); this._token = true; return { token: 't', user: { id: 1, firstName: 'A' } }; },
    async digest() { calls.push(['digest']); return { sources: [{ id: 7, type: 'group', title: 'Team', unread: 2, topLines: ['hi'], lastAt: 1 }] }; },
    async source(id) { calls.push(['source', id]); return { source: { id, type: 'group', title: 'Team' }, messages: [{ id: 11, from: 'Sam', text: 'Are we shipping today?', at: 1 }] }; },
    async markRead(s, m) { calls.push(['markRead', s, m]); return { ok: true }; },
    async reply(s, text, replyTo) { calls.push(['reply', s, text, replyTo]); return { ok: true, messageId: 99 }; },
    async draft(s, m) { calls.push(['draft', s, m]); return { draft: 'Yes, shipping today.', source: 'fallback' }; },
    async stt(wav) { calls.push(['stt', wav.length]); return { text: 'hello there' }; },
    ...overrides,
  };
  return api;
}
async function toDetail(m) {
  await m.init();
  await m.handleEvent('click'); // HOME -> SOURCE
  await m.handleEvent('click'); // SOURCE -> DETAIL
}

test('pairing gate when no token, pair() unlocks home', async () => {
  const api = fakeApi(); api._token = false;
  const m = createScreenMachine({ api });
  await m.init();
  assert.equal(m.state, 'PAIRING');
  await m.pair('123456');
  assert.equal(m.state, 'HOME');
  assert.deepEqual(api.calls[0], ['pair', '123456']);
});

test('home -> source -> detail navigation', async () => {
  const m = createScreenMachine({ api: fakeApi() });
  await toDetail(m);
  assert.equal(m.state, 'DETAIL');
  const v = m.view();
  assert.equal(v.title, 'Sam');
  assert.ok(v.lines.some((l) => l.includes('shipping')));
  await m.handleEvent('doubleClick');
  assert.equal(m.state, 'SOURCE');
});

test('scroll moves selection on home', async () => {
  const api = fakeApi({ async digest() { return { sources: [
    { id: 1, type: 'group', title: 'A', unread: 1, topLines: [], lastAt: 2 },
    { id: 2, type: 'group', title: 'B', unread: 1, topLines: [], lastAt: 1 },
  ] }; } });
  const m = createScreenMachine({ api });
  await m.init();
  await m.handleEvent('scrollBottom');
  assert.ok(m.view().lines[1].startsWith('>'));
  await m.handleEvent('click');
  assert.equal(m.state, 'SOURCE');
});

test('quick reply send path', async () => {
  const api = fakeApi();
  const m = createScreenMachine({ api });
  await toDetail(m);
  await m.handleEvent('scrollBottom'); // -> Quick reply action
  await m.handleEvent('click');
  assert.equal(m.state, 'QUICK_REPLIES');
  await m.handleEvent('click'); // first quick reply
  assert.equal(m.state, 'SENT');
  const reply = api.calls.find((c) => c[0] === 'reply');
  assert.equal(reply[2], QUICK_REPLIES[0]);
});

test('draft approve path', async () => {
  const api = fakeApi();
  const m = createScreenMachine({ api });
  await toDetail(m);
  await m.handleEvent('scrollBottom'); await m.handleEvent('scrollBottom'); // -> Draft a reply
  await m.handleEvent('click');
  assert.equal(m.state, 'DRAFT');
  assert.ok(m.view().lines.some((l) => l.includes('shipping today')));
  await m.handleEvent('click'); // Approve & send
  assert.equal(m.state, 'SENT');
  const reply = api.calls.find((c) => c[0] === 'reply');
  assert.equal(reply[2], 'Yes, shipping today.');
});

test('draft discard returns to detail without sending', async () => {
  const api = fakeApi();
  const m = createScreenMachine({ api });
  await toDetail(m);
  await m.handleEvent('scrollBottom'); await m.handleEvent('scrollBottom');
  await m.handleEvent('click');
  await m.handleEvent('scrollBottom'); // Discard
  await m.handleEvent('click');
  assert.equal(m.state, 'DETAIL');
  assert.ok(!api.calls.some((c) => c[0] === 'reply'));
});

test('recording -> transcript -> send path', async () => {
  const api = fakeApi();
  let started = false;
  const m = createScreenMachine({ api, onStartRecording: () => { started = true; }, onStopRecording: async () => new Uint8Array(100) });
  await toDetail(m);
  await m.handleEvent('click'); // Reply by voice (first action)
  assert.equal(m.state, 'RECORDING');
  assert.ok(started);
  await m.handleEvent('click'); // stop -> STT
  assert.equal(m.state, 'TRANSCRIPT');
  assert.ok(m.view().lines.some((l) => l.includes('hello there')));
  await m.handleEvent('click'); // Send
  assert.equal(m.state, 'SENT');
  const reply = api.calls.find((c) => c[0] === 'reply');
  assert.equal(reply[2], 'hello there');
});

test('noFrames hook surfaces Mic unavailable', async () => {
  const m = createScreenMachine({ api: fakeApi(), onStartRecording: () => {}, onStopRecording: async () => null });
  await toDetail(m);
  await m.handleEvent('click');
  assert.equal(m.state, 'RECORDING');
  m.noFrames();
  assert.equal(m.state, 'DETAIL');
  assert.equal(m._debug().errorLine, 'Mic unavailable');
});

test('recording cap: timeout auto-stops at 30s', async () => {
  let t = 1000;
  const api = fakeApi();
  const m = createScreenMachine({ api, now: () => t, onStartRecording: () => {}, onStopRecording: async () => new Uint8Array(10) });
  await toDetail(m);
  await m.handleEvent('click');
  assert.equal(m.state, 'RECORDING');
  t += 30000;
  await m.checkRecordingTimeout();
  assert.equal(m.state, 'TRANSCRIPT');
});

test('api failure shows retry line, click retries', async () => {
  let fail = true;
  const api = fakeApi({ async digest() { if (fail) throw new Error('network'); return { sources: [] }; } });
  const m = createScreenMachine({ api });
  await m.init();
  assert.ok(m.view().lines.some((l) => l.includes("Couldn't load — tap to retry")));
  fail = false;
  await m.handleEvent('click');
  assert.equal(m.state, 'HOME');
  assert.ok(m.view().lines.some((l) => l.includes('No new messages')));
});
