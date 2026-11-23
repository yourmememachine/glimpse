import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { routeHubEvent } from '../src/bridge.js';

function hooks({ collecting = true } = {}) {
  const calls = [];
  return {
    calls,
    isCollecting: () => collecting,
    onAudioFrame: (pcm) => calls.push(['audio', pcm]),
    onGesture: (g) => calls.push(['gesture', g]),
  };
}

test('routeHubEvent never throws on malformed events', () => {
  const h = hooks();
  const malformed = [
    null, undefined, 42, 'event', true,
    {}, { audioEvent: null }, { audioEvent: {} }, { audioEvent: { audioPcm: null } },
    { textEvent: null }, { listEvent: undefined }, { sysEvent: null },
    { textEvent: {} }, // no eventType: maps to click, exercised below
  ];
  for (const bad of malformed.slice(0, -1)) {
    assert.doesNotThrow(() => routeHubEvent(bad, h), `event: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(h.calls, []);
});

test('routeHubEvent routes audio frames only while collecting', () => {
  const pcm = new Uint8Array([1, 2, 3]);
  const live = hooks({ collecting: true });
  routeHubEvent({ audioEvent: { audioPcm: pcm } }, live);
  assert.deepEqual(live.calls, [['audio', pcm]]);

  const idle = hooks({ collecting: false });
  routeHubEvent({ audioEvent: { audioPcm: pcm } }, idle);
  assert.deepEqual(idle.calls, []);
});

test('routeHubEvent maps gestures, including sysEvent long press', () => {
  const h = hooks();
  routeHubEvent({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } }, h);
  routeHubEvent({ listEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }, h);
  routeHubEvent({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } }, h);
  assert.deepEqual(h.calls, [
    ['gesture', 'click'],
    ['gesture', 'scrollBottom'],
    ['gesture', 'longPress'],
  ]);
});
