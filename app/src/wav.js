export function concatFrames(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}
export function pcmToWav(frames, sampleRate = 16000) {
  const pcm = concatFrames(frames);
  const dataSize = pcm.length;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  writeStr(36, 'data'); v.setUint32(40, dataSize, true);
  out.set(pcm, 44);
  return out;
}
