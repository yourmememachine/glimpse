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

test('HOME renders topLines under each source title', async () => {
  const m = createScreenMachine({ api: fakeApi() });
  await m.init();
  const lines = m.view().lines;
  assert.ok(lines.some((l) => l.includes('Team (2)')));
  assert.ok(lines.some((l) => l.trim() === 'hi'));
  const joined = lines.join('\n');
  assert.ok(joined.length <= 2000);
});

test('HOME windows long source lists with a position cue', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, type: 'group', title: `S${i + 1}`, unread: 1,
    topLines: ['a', 'b', 'c'], lastAt: 5 - i,
  }));
  const api = fakeApi({ async digest() { return { sources: many }; } });
  const m = createScreenMachine({ api });
  await m.init();
  const v = m.view();
  assert.ok(v.lines.length <= 9);
  assert.ok(v.lines.some((l) => l.includes('▼ more') && l.includes('1/5')));
});

test('empty HOME shows the next-step hint', async () => {
  const api = fakeApi({ async digest() { return { sources: [] }; } });
  const m = createScreenMachine({ api });
  await m.init();
  assert.ok(m.view().lines.some((l) => l.includes('Add the bot to a chat, or forward a message to it')));
});

test('opening a source marks it read up to the newest message', async () => {
  const api = fakeApi();
  const m = createScreenMachine({ api });
  await m.init();
  await m.handleEvent('click'); // HOME -> SOURCE
  assert.equal(m.state, 'SOURCE');
  const mr = api.calls.find((c) => c[0] === 'markRead');
  assert.deepEqual(mr, ['markRead', 7, 11]);
});

const LONG_TEXT = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';

async function toDetailWithText(text) {
  const api = fakeApi({
    async source(id) { return { source: { id, type: 'group', title: 'Team' }, messages: [{ id: 11, from: 'Sam', text, at: 1 }] }; },
  });
  const m = createScreenMachine({ api });
  await m.init();
  await m.handleEvent('click');
  await m.handleEvent('click');
  assert.equal(m.state, 'DETAIL');
  return m;
}

test('DETAIL pages the full message text in <=52-char lines', async () => {
  const m = await toDetailWithText(LONG_TEXT);
  const seen = [];
  for (let p = 0; p < 6; p++) {
    const v = m.view();
    for (const l of v.lines) assert.ok(l.length <= 54, `line too long: ${l}`);
    seen.push(...v.lines);
    await m.handleEvent('scrollBottom');
  }
  const joined = seen.join(' ');
  for (const w of ['alpha', 'november', 'zulu']) assert.ok(joined.includes(w), `missing ${w}`);
  assert.ok(seen.some((l) => /^Page \d+\/\d+$/.test(l)));
});

test('DRAFT pages the full draft text before approval', async () => {
  const api = fakeApi({ async draft() { return { draft: LONG_TEXT, source: 'fallback' }; } });
  const m = createScreenMachine({ api });
  await toDetail(m);
  await m.handleEvent('scrollBottom'); await m.handleEvent('scrollBottom');
  await m.handleEvent('click');
  assert.equal(m.state, 'DRAFT');
  const seen = [];
  for (let p = 0; p < 5; p++) { seen.push(...m.view().lines); await m.handleEvent('scrollBottom'); }
  const joined = seen.join(' ');
  for (const w of ['alpha', 'zulu']) assert.ok(joined.includes(w), `missing ${w}`);
});

test('TRANSCRIPT pages the full text and offers a labelled Discard', async () => {
  const api = fakeApi({ async stt() { return { text: LONG_TEXT }; } });
  const m = createScreenMachine({ api, onStartRecording: () => {}, onStopRecording: async () => new Uint8Array(10) });
  await toDetail(m);
  await m.handleEvent('click'); // start recording
  await m.handleEvent('click'); // stop -> transcript
  assert.equal(m.state, 'TRANSCRIPT');
  const seen = [];
  for (let p = 0; p < 5; p++) { seen.push(...m.view().lines); await m.handleEvent('scrollBottom'); }
  const joined = seen.join(' ');
  for (const w of ['alpha', 'zulu']) assert.ok(joined.includes(w), `missing ${w}`);
  assert.ok(m.view().lines.some((l) => l.includes('Discard')));
  // Selection is now on the last action (Discard): activating sends nothing.
  await m.handleEvent('click');
  assert.equal(m.state, 'DETAIL');
  assert.ok(!api.calls.some((c) => c[0] === 'reply'));
});

test('401 clears the token and returns to PAIRING with the expired line', async () => {
  let cleared = 0;
  const err = new Error('unauthorized'); err.status = 401;
  const api = fakeApi({
    async digest() { throw err; },
    async clearToken() { cleared += 1; this._token = false; },
  });
  const m = createScreenMachine({ api });
  await m.init();
  assert.equal(m.state, 'PAIRING');
  assert.equal(cleared, 1);
  assert.equal(api._token, false);
  assert.ok(m.view().lines.some((l) => l.includes('Session expired — pair again')));
});

test('cap auto-stop swallows the triggering gesture (tap does not send)', async () => {
  let t = 1000;
  const api = fakeApi();
  const m = createScreenMachine({ api, now: () => t, onStartRecording: () => {}, onStopRecording: async () => new Uint8Array(10) });
  await toDetail(m);
  await m.handleEvent('click'); // start recording
  assert.equal(m.state, 'RECORDING');
  t += 30000;
  await m.handleEvent('click'); // this tap only stops the recording
  assert.equal(m.state, 'TRANSCRIPT');
  assert.ok(!api.calls.some((c) => c[0] === 'reply'));
});

test('pair retry after a failed digest load does not re-redeem the code', async () => {
  let digestAttempts = 0;
  const api = fakeApi({
    async digest() { digestAttempts += 1; if (digestAttempts === 1) throw new Error('network'); return { sources: [] }; },
  });
  const m = createScreenMachine({ api });
  api._token = false;
  await m.init();
  await m.pair('123456');
  assert.ok(m.view().lines.some((l) => l.includes("Couldn't load")));
  await m.handleEvent('click'); // retry
  assert.equal(m.state, 'HOME');
  assert.equal(api.calls.filter((c) => c[0] === 'pair').length, 1);
  assert.equal(digestAttempts, 2);
});

test('STT failure from RECORDING reaches the error view and retries', async () => {
  let sttAttempts = 0;
  const api = fakeApi({
    async stt() { sttAttempts += 1; if (sttAttempts === 1) throw new Error('network'); return { text: 'recovered words' }; },
  });
  const m = createScreenMachine({ api, onStartRecording: () => {}, onStopRecording: async () => new Uint8Array(10) });
  await toDetail(m);
  await m.handleEvent('click'); // start recording
  assert.equal(m.state, 'RECORDING');
  await m.handleEvent('click'); // stop -> STT fails
  assert.notEqual(m.state, 'RECORDING');
  assert.ok(m.view().lines.some((l) => l.includes("Couldn't load — tap to retry")));
  await m.handleEvent('click'); // retry
  assert.equal(m.state, 'TRANSCRIPT');
  assert.ok(m.view().lines.some((l) => l.includes('recovered words')));
});

test('noFrames stops the capture before leaving RECORDING', async () => {
  let stops = 0;
  const m = createScreenMachine({ api: fakeApi(), onStartRecording: () => {}, onStopRecording: async () => { stops += 1; return null; } });
  await toDetail(m);
  await m.handleEvent('click');
  assert.equal(m.state, 'RECORDING');
  m.noFrames();
  assert.equal(stops, 1);
  assert.equal(m.state, 'DETAIL');
  assert.ok(m.view().lines.some((l) => l.includes('Mic unavailable')));
});

test('back clears the error line', async () => {
  const m = createScreenMachine({ api: fakeApi(), onStartRecording: () => {}, onStopRecording: async () => null });
  await toDetail(m);
  await m.handleEvent('click'); // recording
  m.noFrames();
  assert.equal(m._debug().errorLine, 'Mic unavailable');
  await m.handleEvent('doubleClick'); // back to SOURCE
  assert.equal(m.state, 'SOURCE');
  assert.equal(m._debug().errorLine, null);
});

test('quick replies use the plain-text wording', () => {
  assert.ok(QUICK_REPLIES.includes('On it, thanks'));
  assert.ok(!QUICK_REPLIES.some((q) => q.includes('👍')));
});
