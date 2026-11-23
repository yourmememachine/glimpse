import { truncateLine } from './format.js';

export const QUICK_REPLIES = ['Thanks!', 'On it 👍', 'Will check tonight', 'Sounds good'];
export const RECORDING_CAP_MS = 30000;

export function createScreenMachine({ api, now = () => Date.now(), onStartRecording = null, onStopRecording = null } = {}) {
  if (!api) throw new Error('api required');
  let state = 'HOME';
  let loading = false;
  let errorLine = null;
  let retryFn = null;
  let sources = [];
  let messages = [];
  let source = null;
  let message = null;
  let selected = 0;
  let draftText = '';
  let transcriptText = '';
  let recordStartedAt = 0;
  let sentNote = 'Sent';

  function fail(fn) { errorLine = "Couldn't load — tap to retry"; retryFn = fn || null; loading = false; }
  async function run(fn) { loading = true; errorLine = null; try { await fn(); } catch { fail(fn); } finally { loading = false; } }

  async function loadDigest() { await run(async () => { const d = await api.digest(); sources = d.sources || []; selected = 0; state = 'HOME'; }); }
  async function loadSource(id) { await run(async () => { const d = await api.source(id); source = d.source; messages = d.messages || []; selected = 0; state = 'SOURCE'; }); }
  async function loadDraft() { await run(async () => { const d = await api.draft(source.id, message.id); draftText = d.draft; selected = 0; state = 'DRAFT'; }); }

  async function sendText(text) {
    await run(async () => {
      await api.reply(source.id, text, message?.id);
      if (message?.id && api.markRead) { try { await api.markRead(source.id, message.id); } catch { /* reply already sent */ } }
      sentNote = 'Sent'; state = 'SENT';
    });
  }

  function startRecording() {
    state = 'RECORDING'; recordStartedAt = now(); errorLine = null;
    if (onStartRecording) { try { onStartRecording(); } catch { /* surfaced via noFrames */ } }
  }
  async function stopRecording() {
    let wav = null;
    if (onStopRecording) { try { wav = await onStopRecording(); } catch { wav = null; } }
    if (!wav || wav.length === 0) { errorLine = 'Mic unavailable'; state = 'DETAIL'; return; }
    await run(async () => { const d = await api.stt(wav); transcriptText = d.text || ''; selected = 0; state = 'TRANSCRIPT'; });
    if (state !== 'TRANSCRIPT' && !errorLine) errorLine = 'Mic unavailable';
  }

  const detailActions = ['Reply by voice', 'Quick reply', 'Draft a reply', 'Back'];

  function currentListLength() {
    if (state === 'HOME') return sources.length;
    if (state === 'SOURCE') return messages.length;
    if (state === 'DETAIL') return detailActions.length;
    if (state === 'QUICK_REPLIES') return QUICK_REPLIES.length + 1;
    if (state === 'DRAFT' || state === 'TRANSCRIPT') return 2;
    return 0;
  }
  function move(delta) { const n = currentListLength(); if (n > 0) selected = Math.min(n - 1, Math.max(0, selected + delta)); }

  async function activate() {
    if (errorLine && retryFn) { const fn = retryFn; retryFn = null; errorLine = null; await run(fn); return; }
    if (state === 'HOME') { const s = sources[selected]; if (s) await loadSource(s.id); }
    else if (state === 'SOURCE') { const m = messages[selected]; if (m) { message = m; selected = 0; state = 'DETAIL'; } }
    else if (state === 'DETAIL') {
      const a = detailActions[selected];
      if (a === 'Reply by voice') startRecording();
      else if (a === 'Quick reply') { selected = 0; state = 'QUICK_REPLIES'; }
      else if (a === 'Draft a reply') await loadDraft();
      else if (a === 'Back') { selected = 0; state = 'SOURCE'; }
    }
    else if (state === 'QUICK_REPLIES') {
      if (selected < QUICK_REPLIES.length) await sendText(QUICK_REPLIES[selected]);
      else { selected = 0; state = 'DETAIL'; }
    }
    else if (state === 'DRAFT') { if (selected === 0) await sendText(draftText); else { selected = 0; state = 'DETAIL'; } }
    else if (state === 'RECORDING') await stopRecording();
    else if (state === 'TRANSCRIPT') {
      if (selected === 0) await sendText(transcriptText);
      else startRecording();
    }
    else if (state === 'SENT') { selected = 0; state = source ? 'SOURCE' : 'HOME'; if (!source) await loadDigest(); }
    else if (state === 'PAIRING') { /* pairing happens in the phone/browser panel */ }
  }

  function back() {
    if (state === 'SOURCE') { state = 'HOME'; selected = 0; }
    else if (state === 'DETAIL') { state = 'SOURCE'; selected = 0; }
    else if (state === 'QUICK_REPLIES' || state === 'DRAFT' || state === 'TRANSCRIPT') { state = 'DETAIL'; selected = 0; }
    else if (state === 'RECORDING') { if (onStopRecording) { try { onStopRecording(); } catch { /* ignore */ } } state = 'DETAIL'; }
    else if (state === 'SENT') { state = 'HOME'; }
  }

  return {
    get state() { return state; },
    async init() {
      if (api.hasToken && !(await api.hasToken())) { state = 'PAIRING'; return; }
      await loadDigest();
    },
    async pair(code) {
      await run(async () => { await api.pair(code); await (async () => { const d = await api.digest(); sources = d.sources || []; })(); state = 'HOME'; selected = 0; });
    },
    async refresh() { await loadDigest(); },
    noFrames() { if (state === 'RECORDING') { errorLine = 'Mic unavailable'; state = 'DETAIL'; selected = 0; } },
    checkRecordingTimeout() { if (state === 'RECORDING' && now() - recordStartedAt >= RECORDING_CAP_MS) return stopRecording(); },
    recordingElapsedMs() { return state === 'RECORDING' ? now() - recordStartedAt : 0; },
    async handleEvent(gesture) {
      if (loading) return;
      if (state === 'RECORDING') await this.checkRecordingTimeout();
      switch (gesture) {
        case 'scrollTop': move(-1); break;
        case 'scrollBottom': move(1); break;
        case 'click': await activate(); break;
        case 'doubleClick': back(); break;
        case 'longPress': if (state !== 'HOME' && state !== 'PAIRING') { back(); } break;
        default: break;
      }
    },
    view() {
      if (loading) return { title: 'Glimpse', lines: ['Loading…'], capture: 'text' };
      if (errorLine && state !== 'RECORDING') {
        // Error is shown alongside the current screen; on retryable loads it is the only line.
        if (retryFn) return { title: 'Glimpse', lines: [errorLine], capture: 'text' };
      }
      const mark = (i, text) => (i === selected ? '> ' : '  ') + truncateLine(text, 50);
      switch (state) {
        case 'PAIRING': return { title: 'Glimpse — Pair', lines: ['Open Glimpse on your phone', 'and enter the 6-digit code', 'from the Telegram bot.'], capture: 'text' };
        case 'HOME': return { title: 'Glimpse', lines: sources.length ? sources.map((s, i) => mark(i, `${s.title} (${s.unread})`)) : ['No new messages'], capture: 'list' };
        case 'SOURCE': return { title: truncateLine(source?.title || 'Messages', 52), lines: messages.length ? messages.map((m, i) => mark(i, `${m.from}: ${m.text}`)) : ['No messages'], capture: 'list' };
        case 'DETAIL': return { title: truncateLine(message?.from || 'Message', 52), lines: [truncateLine(message?.text || ''), '', ...detailActions.map((a, i) => mark(i, a))], capture: 'list' };
        case 'QUICK_REPLIES': return { title: 'Quick reply', lines: [...QUICK_REPLIES.map((q, i) => mark(i, q)), mark(QUICK_REPLIES.length, 'Back')], capture: 'list' };
        case 'DRAFT': return { title: 'Draft reply', lines: [truncateLine(draftText), '', mark(0, 'Approve & send'), mark(1, 'Discard')], capture: 'list' };
        case 'RECORDING': return { title: 'Recording', lines: ['Listening… tap to stop', `${Math.floor((now() - recordStartedAt) / 1000)}s / 30s`], capture: 'text' };
        case 'TRANSCRIPT': return { title: 'You said', lines: [truncateLine(transcriptText), '', mark(0, 'Send'), mark(1, 'Re-record')], capture: 'list' };
        case 'SENT': return { title: 'Glimpse', lines: [sentNote, 'Tap to continue'], capture: 'text' };
        default: return { title: 'Glimpse', lines: [], capture: 'text' };
      }
    },
    // Exposed for renderers/tests
    _debug: () => ({ state, sources, messages, source, message, selected, draftText, transcriptText, errorLine }),
  };
}
