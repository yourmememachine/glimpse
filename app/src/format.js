export const LINE_BUDGET = 52;
export function truncateLine(text, max = 52) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const limit = max - 1;
  let cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut + '…';
}
export function wrapText(text, width = 52) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const lines = [];
  let line = '';
  const push = () => { if (line) { lines.push(line); line = ''; } };
  for (let word of clean.split(' ')) {
    while (word.length > width) {
      push();
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { push(); line = word; }
  }
  push();
  return lines;
}
export function digestSourceLines(source) {
  const lines = [truncateLine(`${source.title} (${source.unread})`)];
  for (const l of (source.topLines || []).slice(0, 3)) lines.push('  ' + truncateLine(l, 50));
  return lines;
}
export function messageLine(msg) {
  return truncateLine(`${msg.from}: ${msg.text}`);
}
