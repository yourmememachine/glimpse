// The only module that imports the Even Hub SDK.
// Exposes a runtime with the same surface in SDK mode and in the
// browser dev-preview fallback: storage, render(view), audio capture.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';
import { resampleFloat32, float32ToPcm16 } from './wav.js';

export function mapEventType(t) {
  if (t === undefined || t === null || t === OsEventTypeList.CLICK_EVENT) return 'click';
  if (t === OsEventTypeList.SCROLL_TOP_EVENT) return 'scrollTop';
  if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'scrollBottom';
  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'doubleClick';
  if (t === OsEventTypeList.LONG_PRESS_EVENT) return 'longPress';
  return null;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('bridge_timeout')), ms)),
  ]);
}

export async function connectRuntime({ onGesture, onNoFrames, urlSearch } = {}) {
  // SDK detection: ?preview forces the fallback. Otherwise wait for the
  // bridge, then probe it with a benign storage read raced against 1.5s —
  // the wait alone can resolve in plain browsers, so only a probe that
  // actually answers counts as SDK mode; failure or timeout = fallback.
  const search = urlSearch ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.search : '');
  if (new URLSearchParams(search || '').has('preview')) {
    return createFallbackRuntime({ onGesture, onNoFrames });
  }
  let bridge = null;
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), 2500);
  } catch { bridge = null; }
  if (!bridge) return createFallbackRuntime({ onGesture, onNoFrames });
  try {
    await withTimeout(Promise.resolve(bridge.getLocalStorage('glimpse_probe')), 1500);
  } catch {
    return createFallbackRuntime({ onGesture, onNoFrames });
  }
  return createSdkRuntime(bridge, { onGesture, onNoFrames });
}

function captureContainerProps(content) {
  return {
    containerID: 1, containerName: 'main',
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    // An event-capture container only takes focus with a visible border.
    borderWidth: 2, borderColor: 1,
    isEventCapture: 1, content,
  };
}

function createSdkRuntime(bridge, { onGesture, onNoFrames }) {
  let frames = [];
  let collecting = false;
  let noFramesTimer = null;
  let gestureHandler = onGesture;
  let stopPromise = null;

  const runtime = {
    mode: 'sdk',
    lastRenderError: null,
    storage: {
      get: (k) => bridge.getLocalStorage(k),
      set: (k, v) => bridge.setLocalStorage(k, v),
      remove: (k) => bridge.setLocalStorage(k, ''),
    },
    setGestureHandler(fn) { gestureHandler = fn; },
    async init() {
      const container = new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty(captureContainerProps('Glimpse'))],
      });
      const result = await bridge.createStartUpPageContainer(container);
      const code = typeof result === 'number' ? result : Number(result);
      if (code !== 0) {
        // Fall back to a page rebuild; only a dead rebuild is fatal.
        const rebuilt = await runtime._rebuild('Glimpse', 'Could not start Glimpse');
        if (!rebuilt) throw new Error('container_create_failed');
        runtime.lastRenderError = 'container_create_failed';
      }
      bridge.onEvenHubEvent((event) => {
        if (event.audioEvent?.audioPcm && collecting) { frames.push(new Uint8Array(event.audioEvent.audioPcm)); return; }
        const item = event.textEvent || event.listEvent || event.sysEvent;
        if (!item) return;
        // Long press is reported on sysEvent in some firmware builds.
        if (event.sysEvent && (item.eventType === OsEventTypeList.LONG_PRESS_EVENT)) { gestureHandler?.('longPress'); return; }
        const gesture = mapEventType(item.eventType);
        if (gesture) gestureHandler?.(gesture);
      });
    },
    async _rebuild(title, line) {
      try {
        return await bridge.rebuildPageContainer(new RebuildPageContainer({
          containerTotalNum: 1,
          textObject: [new TextContainerProperty(captureContainerProps(`${title}\n${line}`))],
        }));
      } catch { return false; }
    },
    async render(view) {
      const content = `${view.title}\n${view.lines.join('\n')}`;
      let ok = false;
      try {
        // Full updates only: partial-update fields (contentOffset /
        // contentLength) are omitted, they corrupt long-to-short changes.
        ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'main', content,
        }));
      } catch { ok = false; }
      if (ok !== true) {
        runtime.lastRenderError = 'render_failed';
        await runtime._rebuild(view.title, 'Could not display this screen');
      }
    },
    async startAudio() {
      frames = []; collecting = true;
      try { await bridge.audioControl(true, AudioInputSource.Glasses); } catch { /* noFrames check reports it */ }
      clearTimeout(noFramesTimer);
      noFramesTimer = setTimeout(() => { if (collecting && frames.length === 0) onNoFrames?.(); }, 1000);
    },
    stopAudio() {
      // Race guard: a stop already in flight is shared, never re-entered.
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        collecting = false; clearTimeout(noFramesTimer);
        try { await bridge.audioControl(false); } catch { /* ignore */ }
        const out = frames; frames = []; return out;
      })();
      stopPromise.finally(() => { stopPromise = null; }).catch(() => {});
      return stopPromise;
    },
    exit() { bridge.shutDownPageContainer(1).catch(() => {}); },
  };
  return runtime;
}

function createFallbackRuntime({ onGesture, onNoFrames }) {
  // Dev preview only: renders into #preview in index.html (576x288, green on black).
  let gestureHandler = onGesture;
  let stream = null; let audioCtx = null; let processor = null; let frames = [];
  let noFramesTimer = null;
  let stopPromise = null;

  const runtime = {
    mode: 'fallback',
    storage: {
      async get(k) { try { return window.localStorage.getItem(k) || ''; } catch { return ''; } },
      async set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } return true; },
      async remove(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } return true; },
    },
    setGestureHandler(fn) { gestureHandler = fn; },
    async init() {
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        if (e.key === 'ArrowUp') gestureHandler?.('scrollTop');
        else if (e.key === 'ArrowDown') gestureHandler?.('scrollBottom');
        else if (e.key === 'Enter') gestureHandler?.('click');
        else if (e.key === 'Escape') gestureHandler?.('doubleClick');
        else if (e.key.toLowerCase() === 'l') gestureHandler?.('longPress');
      });
    },
    render(view) {
      const titleEl = document.querySelector('#preview .title');
      const linesEl = document.getElementById('preview-lines');
      if (titleEl) titleEl.textContent = view.title;
      if (linesEl) linesEl.textContent = view.lines.join('\n');
    },
    async startAudio() {
      frames = [];
      clearTimeout(noFramesTimer);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch { onNoFrames?.(); return; }
      // The no-frames clock starts only once capture is actually open,
      // so a slow permission prompt is not mistaken for a dead mic.
      noFramesTimer = setTimeout(() => { if (frames.length === 0) onNoFrames?.(); }, 1000);
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const sourceRate = audioCtx.sampleRate;
        const source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          const f32 = e.inputBuffer.getChannelData(0);
          // Capture runs at the device rate; the backend wants 16 kHz.
          const resampled = resampleFloat32(f32, sourceRate, 16000);
          frames.push(float32ToPcm16(resampled));
        };
        source.connect(processor); processor.connect(audioCtx.destination);
      } catch { onNoFrames?.(); }
    },
    stopAudio() {
      // Race guard: a stop already in flight is shared, never re-entered.
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        clearTimeout(noFramesTimer);
        try { processor?.disconnect(); } catch { /* ignore */ }
        try { await audioCtx?.close(); } catch { /* ignore */ }
        stream?.getTracks().forEach((t) => t.stop());
        stream = null; audioCtx = null; processor = null;
        const out = frames; frames = []; return out;
      })();
      stopPromise.finally(() => { stopPromise = null; }).catch(() => {});
      return stopPromise;
    },
    exit() { /* nothing to exit in the browser preview */ },
  };
  return runtime;
}
