import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateLine } from '../src/format.js';

test('short text unchanged', () => assert.equal(truncateLine('hello'), 'hello'));
test('exactly 52 chars unchanged', () => { const s = 'a'.repeat(52); assert.equal(truncateLine(s), s); });
test('long text truncated at word boundary with ellipsis', () => {
  const out = truncateLine('word '.repeat(30).trim());
  assert.ok(out.length <= 52);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.slice(0, -1).endsWith(' '));
});
test('single long word hard-truncated', () => {
  const out = truncateLine('x'.repeat(100));
  assert.equal(out.length, 52);
  assert.ok(out.endsWith('…'));
});
test('whitespace collapsed', () => assert.equal(truncateLine('a\n\n  b\tc'), 'a b c'));
test('custom max respected', () => assert.ok(truncateLine('one two three four', 10).length <= 10));

import { wrapText } from '../src/format.js';

test('wrapText keeps every line within the width and loses no words', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
  const lines = wrapText(text, 52);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.length <= 52);
  assert.equal(lines.join(' '), text);
});

test('wrapText hard-splits a single over-long word', () => {
  const lines = wrapText('x'.repeat(120), 52);
  assert.deepEqual(lines.map((l) => l.length), [52, 52, 16]);
});

test('wrapText of empty text is empty', () => assert.deepEqual(wrapText(''), []));
