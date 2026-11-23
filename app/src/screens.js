import { truncateLine, wrapText, digestSourceLines } from './format.js';

export const QUICK_REPLIES = ['Thanks!', 'On it, thanks', 'Will check tonight', 'Sounds good'];
export const RECORDING_CAP_MS = 30000;
export const EMPTY_HOME_HINT = 'Add the bot to a chat, or forward a message to it';
const SESSION_EXPIRED_LINE = 'Session expired — pair again';
const VISIBLE_ROWS = 7;

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
  let pageOffset = 0;
  let pairStep = null;

  const isAuthError = (e) => !!e && (e.status === 401 || e.code === 'unauthorized');

  async function handleAuthExpired() {
    try { if (api.clearToken) await api.clearToken(); } catch { /* best effort */ }
    state = 'PAIRING';
    errorLine = SESSION_EXPIRED_LINE;
    retryFn = null;
    loading = false;
    selected = 0;
    pageOffset = 0;
  }

  function fail(fn) { errorLine = "Couldn't load — tap to retry"; retryFn = fn || null; loading = false; }
  async function run(fn) {
    loading = true; errorLine = null;
    try { await fn(); }
    catch (e) { if (isAuthError(e)) await handleAuthExpired(); else fail(fn); }
    finally { loading = false; }
  }

  async function applyDigest() {
    const d = await api.digest();
    sources = d.sources || [];
    selected = 0; pageOffset = 0; state = 'HOME';
  }
  async function loadDigest() { await run(applyDigest); }

  async function loadSource(id) {
    await run(async () => {
      const d = await api.source(id);
      source = d.source; messages = d.messages || [];
      selected = 0; pageOffset = 0; state = 'SOURCE';
      // Opening a source marks it read up to its newest message.
      if (messages.length && api.markRead) {
        try { await api.markRead(source?.id ?? id, messages[0].id); } catch { /* best effort */ }
      }
    });
  }

  async function loadDraft() {
    await run(async () => {
      const d = await api.draft(source.id, message.id);
      draftText = d.draft; selected = 0; pageOffset = 0; state = 'DRAFT';
    });
  }

  async function sendText(text) {
    await run(async () => {
      await api.reply(source.id, text, message?.id);
      if (message?.id && api.markRead) { try { await api.markRead(source.id, message.id); } catch { /* reply already sent */ } }
      sentNote = 'Sent'; state = 'SENT';
    });
  }

  function startRecording() {
    state = 'RECORDING'; recordStartedAt = now(); errorLine = null; retryFn = null; pageOffset = 0;
    if (onStartRecording) { try { onStartRecording(); } catch { /* surfaced via noFrames */ } }
  }

  async function stopRecording() {
    let wav = null;
    if (onStopRecording) { try { wav = await onStopRecording(); } catch { wav = null; } }
    if (!wav || wav.length === 0) {
      errorLine = 'Mic unavailable'; retryFn = null; state = 'DETAIL'; selected = 0; pageOffset = 0;
      return;
    }
    // Leave RECORDING before the request so a failure lands on the
    // standard error view instead of being hidden behind "Listening…".
    state = 'DETAIL';
    await run(async () => {
      const d = await api.stt(wav);
      transcriptText = d.text || ''; selected = 0; pageOffset = 0; state = 'TRANSCRIPT';
    });
  }

  const detailActions = ['Reply by voice', 'Quick reply', 'Draft a reply', 'Back'];
  const transcriptActions = ['Send', 'Re-record', 'Discard'];

  function currentListLength() {
    if (state === 'HOME') return sources.length;
    if (state === 'SOURCE') return messages.length;
    if (state === 'DETAIL') return detailActions.length;
    if (state === 'QUICK_REPLIES') return QUICK_REPLIES.length + 1;
    if (state === 'DRAFT') return 2;
    if (state === 'TRANSCRIPT') return transcriptActions.length;
    return 0;
  }
  function move(delta) { const n = currentListLength(); if (n > 0) selected = Math.min(n - 1, Math.max(0, selected + delta)); }

  // Full-text paging for DETAIL / DRAFT / TRANSCRIPT.
  function currentText() {
    if (state === 'DETAIL') return message?.text || '';
    if (state === 'DRAFT') return draftText;
    if (state === 'TRANSCRIPT') return transcriptText;
    return '';
  }
  function textPageSize() { return state === 'DETAIL' ? 2 : state === 'TRANSCRIPT' ? 3 : 4; }
  function wrappedCurrent() { return wrapText(currentText(), 52); }
  function pageCount() { return Math.max(1, Math.ceil(wrappedCurrent().length / textPageSize())); }
  function pagedLines() {
    const all = wrappedCurrent();
    const size = textPageSize();
    const slice = all.slice(pageOffset * size, pageOffset * size + size);
    const cue = pageCount() > 1 ? [`Page ${pageOffset + 1}/${pageCount()}`] : [''];
    return [...slice, ...cue];
  }
  function scrollPaged(delta) {
    if (delta > 0) {
      if (pageOffset < pageCount() - 1) pageOffset += 1;
      else move(1);
    } else if (selected > 0) move(-1);
    else if (pageOffset > 0) pageOffset -= 1;
  }

  async function activate() {
    if (errorLine && retryFn) { const fn = retryFn; retryFn = null; errorLine = null; await run(fn); return; }
    if (state === 'HOME') { const s = sources[selected]; if (s) await loadSource(s.id); }
    else if (state === 'SOURCE') { const m = messages[selected]; if (m) { message = m; selected = 0; pageOffset = 0; state = 'DETAIL'; } }
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
    else if (state === 'DRAFT') { if (selected === 0) await sendText(draftText); else { selected = 0; pageOffset = 0; state = 'DETAIL'; } }
    else if (state === 'RECORDING') await stopRecording();
    else if (state === 'TRANSCRIPT') {
      if (selected === 0) await sendText(transcriptText);
      else if (selected === 1) startRecording();
      else { selected = 0; pageOffset = 0; state = 'DETAIL'; }
    }
    else if (state === 'SENT') { selected = 0; state = source ? 'SOURCE' : 'HOME'; if (!source) await loadDigest(); }
    else if (state === 'PAIRING') { /* pairing happens in the phone/browser panel */ }
  }

  function back() {
    errorLine = null; retryFn = null; pageOffset = 0;
    if (state === 'SOURCE') { state = 'HOME'; selected = 0; }
    else if (state === 'DETAIL') { state = 'SOURCE'; selected = 0; }
    else if (state === 'QUICK_REPLIES' || state === 'DRAFT' || state === 'TRANSCRIPT') { state = 'DETAIL'; selected = 0; }
    else if (state === 'RECORDING') { if (onStopRecording) { try { onStopRecording(); } catch { /* ignore */ } } state = 'DETAIL'; }
    else if (state === 'SENT') { state = 'HOME'; }
  }

  function homeViewLines(mark) {
    if (!sources.length) return ['No new messages', EMPTY_HOME_HINT];
    const blocks = sources.map((s, i) => {
      const lines = digestSourceLines(s);
      lines[0] = mark(i, `${s.title} (${s.unread})`);
      return lines;
    });
    // Window the blocks so the selected one is visible within the row budget.
    let start = 0;
    const rowsFrom = (a, b) => blocks.slice(a, b + 1).reduce((n, bl) => n + bl.length, 0);
    while (start < selected && rowsFrom(start, selected) > VISIBLE_ROWS) start += 1;
    let end = start;
    let rows = 0;
    while (end < blocks.length && rows + blocks[end].length <= VISIBLE_ROWS) { rows += blocks[end].length; end += 1; }
    if (end === start) end = start + 1; // always show at least the first block
    const lines = [];
    if (start > 0) lines.push(`▲ more ${selected + 1}/${sources.length}`);
    for (let i = start; i < end; i++) lines.push(...blocks[i]);
    if (end < blocks.length) lines.push(`▼ more ${selected + 1}/${sources.length}`);
    return lines;
  }

  function windowedListLines(items, renderItem) {
    if (!items.length) return null;
    const size = VISIBLE_ROWS;
    let start = 0;
    if (items.length > size) start = Math.min(Math.max(0, selected - size + 1), items.length - size);
    const lines = items.slice(start, start + size).map((it, k) => renderItem(it, start + k));
    if (start > 0) lines.unshift(`▲ more ${selected + 1}/${items.length}`);
    if (start + size < items.length) lines.push(`▼ more ${selected + 1}/${items.length}`);
    return lines;
  }

  return {
    get state() { return state; },
    async init() {
      if (api.hasToken && !(await api.hasToken())) { state = 'PAIRING'; return; }
      await loadDigest();
    },
    async pair(code) {
      // Redeem is its own step: a retry after a failed digest load
      // reloads the digest only and never re-posts the consumed code.
      pairStep = { code, redeemed: false };
      const step = async () => {
        if (!pairStep.redeemed) { await api.pair(pairStep.code); pairStep.redeemed = true; }
        await applyDigest();
      };
      await run(step);
    },
    async refresh() { await loadDigest(); },
    noFrames() {
      if (state !== 'RECORDING') return;
      // Stop the capture before leaving RECORDING so nothing keeps recording.
      if (onStopRecording) {
        try { const p = onStopRecording(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* ignore */ }
      }
      errorLine = 'Mic unavailable'; retryFn = null; state = 'DETAIL'; selected = 0; pageOffset = 0;
    },
    async checkRecordingTimeout() {
      if (state === 'RECORDING' && now() - recordStartedAt >= RECORDING_CAP_MS) { await stopRecording(); return true; }
      return false;
    },
    recordingElapsedMs() { return state === 'RECORDING' ? now() - recordStartedAt : 0; },
    async handleEvent(gesture) {
      if (loading) return;
      if (state === 'RECORDING') {
        // A gesture that arrives past the cap only stops the recording;
        // it is swallowed and never acted on by the next screen.
        const stopped = await this.checkRecordingTimeout();
        if (stopped) return;
      }
      switch (gesture) {
        case 'scrollTop':
          if (state === 'DETAIL' || state === 'DRAFT' || state === 'TRANSCRIPT') scrollPaged(-1); else move(-1);
          break;
        case 'scrollBottom':
          if (state === 'DETAIL' || state === 'DRAFT' || state === 'TRANSCRIPT') scrollPaged(1); else move(1);
          break;
        case 'click': await activate(); break;
        case 'doubleClick': back(); break;
        case 'longPress': if (state !== 'HOME' && state !== 'PAIRING') { back(); } break;
        default: break;
      }
    },
    view() {
      if (loading) return { title: 'Glimpse', lines: ['Loading…'], capture: 'text' };
      if (errorLine && retryFn) return { title: 'Glimpse', lines: [errorLine], capture: 'text' };
      const mark = (i, text) => (i === selected ? '> ' : '  ') + truncateLine(text, 50);
      const withNote = (lines) => (errorLine ? [errorLine, ...lines] : lines);
      switch (state) {
        case 'PAIRING': return { title: 'Glimpse — Pair', lines: withNote(['Open Glimpse on your phone', 'and enter the 6-digit code', 'from the Telegram bot.']), capture: 'text' };
        case 'HOME': return { title: 'Glimpse', lines: withNote(homeViewLines(mark)), capture: 'list' };
        case 'SOURCE': return { title: truncateLine(source?.title || 'Messages', 52), lines: withNote(windowedListLines(messages, (m, i) => mark(i, `${m.from}: ${m.text}`)) || ['No messages']), capture: 'list' };
        case 'DETAIL': return { title: truncateLine(message?.from || 'Message', 52), lines: withNote([...pagedLines(), ...detailActions.map((a, i) => mark(i, a))]), capture: 'list' };
        case 'QUICK_REPLIES': return { title: 'Quick reply', lines: [...QUICK_REPLIES.map((q, i) => mark(i, q)), mark(QUICK_REPLIES.length, 'Back')], capture: 'list' };
        case 'DRAFT': return { title: 'Draft reply', lines: withNote([...pagedLines(), mark(0, 'Approve & send'), mark(1, 'Discard')]), capture: 'list' };
        case 'RECORDING': return { title: 'Recording', lines: ['Listening… tap to stop', `${Math.floor((now() - recordStartedAt) / 1000)}s / 30s`], capture: 'text' };
        case 'TRANSCRIPT': return { title: 'You said', lines: withNote([...pagedLines(), ...transcriptActions.map((a, i) => mark(i, a))]), capture: 'list' };
        case 'SENT': return { title: 'Glimpse', lines: [sentNote, 'Tap to continue'], capture: 'text' };
        default: return { title: 'Glimpse', lines: [], capture: 'text' };
      }
    },
    // Exposed for renderers/tests
    _debug: () => ({ state, sources, messages, source, message, selected, draftText, transcriptText, errorLine, pageOffset }),
  };
}
