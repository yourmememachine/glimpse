import { connectRuntime } from './bridge.js';
import { createApi } from './api.js';
import { createScreenMachine } from './screens.js';
import { pcmToWav } from './wav.js';

let runtime = null;
let machine = null;

async function boot() {
  runtime = await connectRuntime({
    onGesture: (g) => dispatch(g),
    onNoFrames: () => { machine?.noFrames(); render(); },
  });
  const api = createApi({ storage: runtime.storage });
  machine = createScreenMachine({
    api,
    onStartRecording: () => runtime.startAudio(),
    onStopRecording: async () => {
      const frames = await runtime.stopAudio();
      return frames && frames.length ? pcmToWav(frames, 16000) : null;
    },
  });
  runtime.setGestureHandler((g) => dispatch(g));
  await runtime.init();
  await machine.init();
  render();
  setInterval(() => { machine?.checkRecordingTimeout(); render(); }, 500);

  const pairBtn = document.getElementById('pair-btn');
  if (pairBtn) {
    pairBtn.addEventListener('click', async () => {
      const code = document.getElementById('pair-code')?.value.trim();
      const status = document.getElementById('pair-status');
      if (!/^\d{6}$/.test(code || '')) { if (status) status.textContent = 'Enter the 6-digit code'; return; }
      try {
        await machine.pair(code);
        if (status) status.textContent = 'Paired';
      } catch { if (status) status.textContent = 'Pairing failed — check the code'; }
      render();
    });
  }
}

async function dispatch(gesture) {
  if (!machine) return;
  const wasHome = machine.state === 'HOME';
  await machine.handleEvent(gesture);
  render();
  if (wasHome && gesture === 'doubleClick' && machine.state === 'HOME') runtime?.exit();
}

function render() { if (machine && runtime) runtime.render(machine.view()); }

boot().catch(() => {
  const el = document.getElementById('preview-lines');
  if (el) el.textContent = "Couldn't load — tap to retry";
});
