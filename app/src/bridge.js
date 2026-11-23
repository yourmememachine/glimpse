// The only module that imports the Even Hub SDK.
// Exposes a runtime with the same surface in SDK mode and in the
// browser dev-preview fallback: storage, render(view), audio capture.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';

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

export async function connectRuntime({ onGesture, onNoFrames }) {
  let bridge = null;
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), 2500);
  } catch { bridge = null; }
  if (bridge) return createSdkRuntime(bridge, { onGesture, onNoFrames });
  return createFallbackRuntime({ onGesture, onNoFrames });
}

function createSdkRuntime(bridge, { onGesture, onNoFrames }) {
  let frames = [];
  let collecting = false;
  let noFramesTimer = null;
  let gestureHandler = onGesture;

  const runtime = {
    mode: 'sdk',
    storage: {
      get: (k) => bridge.getLocalStorage(k),
      set: (k, v) => bridge.setLocalStorage(k, v),
    },
    setGestureHandler(fn) { gestureHandler = fn; },
    async init() {
      const container = new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          containerID: 1, containerName: 'main',
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          isEventCapture: 1, content: 'Glimpse',
        })],
      });
      await bridge.createStartUpPageContainer(container);
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
    render(view) {
      const content = `${view.title}\n${view.lines.join('\n')}`;
      bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 1, containerName: 'main',
        contentOffset: 0, contentLength: content.length, content,
      })).catch(() => {});
    },
    async startAudio() {
      frames = []; collecting = true;
      try { await bridge.audioControl(true, AudioInputSource.Glasses); } catch { /* noFrames check reports it */ }
      clearTimeout(noFramesTimer);
      noFramesTimer = setTimeout(() => { if (collecting && frames.length === 0) onNoFrames?.(); }, 1000);
    },
    async stopAudio() {
      collecting = false; clearTimeout(noFramesTimer);
      try { await bridge.audioControl(false); } catch { /* ignore */ }
      const out = frames; frames = []; return out;
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

  const runtime = {
    mode: 'fallback',
    storage: {
      async get(k) { try { return window.localStorage.getItem(k) || ''; } catch { return ''; } },
      async set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } return true; },
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
      noFramesTimer = setTimeout(() => { if (frames.length === 0) onNoFrames?.(); }, 1000);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(160, 1, 1); // ~10ms at 16kHz
        processor.onaudioprocess = (e) => {
          const f32 = e.inputBuffer.getChannelData(0);
          const pcm = new Uint8Array(f32.length * 2);
          const v = new DataView(pcm.buffer);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            v.setInt16(i * 2, s * 0x7fff, true);
          }
          frames.push(pcm);
        };
        source.connect(processor); processor.connect(audioCtx.destination);
      } catch { /* noFrames timer reports it */ }
    },
    async stopAudio() {
      clearTimeout(noFramesTimer);
      try { processor?.disconnect(); } catch { /* ignore */ }
      try { await audioCtx?.close(); } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
      stream = null; audioCtx = null; processor = null;
      const out = frames; frames = []; return out;
    },
    exit() { /* nothing to exit in the browser preview */ },
  };
  return runtime;
}
