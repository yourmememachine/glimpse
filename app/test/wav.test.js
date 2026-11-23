import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav, concatFrames } from '../src/wav.js';

test('wav header correctness', () => {
  const frame = new Uint8Array(320); // 10ms of silence at 16kHz s16le
  const wav = pcmToWav([frame, frame]);
  assert.equal(wav.length, 44 + 640);
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 640);
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 16000); // sample rate
  assert.equal(v.getUint32(28, true), 32000); // byte rate
  assert.equal(v.getUint16(34, true), 16); // bits
  assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data');
  assert.equal(v.getUint32(40, true), 640);
});
test('wav custom sample rate and empty input', () => {
  const wav = pcmToWav([], 8000);
  assert.equal(wav.length, 44);
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 8000);
});
test('concatFrames joins in order', () => {
  assert.deepEqual([...concatFrames([new Uint8Array([1, 2]), new Uint8Array([3])])], [1, 2, 3]);
});

import { resampleFloat32 } from '../src/wav.js';

test('resampleFloat32 halves the length going 32k -> 16k', () => {
  const input = new Float32Array(3200).map((_, i) => Math.sin(i / 10));
  const out = resampleFloat32(input, 32000, 16000);
  assert.equal(out.length, 1600);
});

test('resampleFloat32 is a copy at the target rate', () => {
  const input = new Float32Array([0.1, -0.2, 0.3]);
  const out = resampleFloat32(input, 16000, 16000);
  assert.deepEqual([...out], [...input]);
});
