import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, TOKEN_KEY } from '../src/api.js';

function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.get(k) || ''; },
    async set(k, v) { map.set(k, v); return true; },
    async remove(k) { map.delete(k); return true; },
  };
}
function jsonRes(ok, status, data) {
  return { ok, status, async json() { return data; } };
}

test('requests carry an abort timeout signal', async () => {
  let seen = null;
  const api = createApi({ storage: fakeStorage(), fetchFn: async (url, opts) => { seen = opts; return jsonRes(true, 200, { sources: [] }); } });
  await api.digest();
  assert.ok(seen.signal instanceof AbortSignal);
});

test('pair stores the token; clearToken removes it', async () => {
  const storage = fakeStorage();
  const api = createApi({ storage, fetchFn: async () => jsonRes(true, 200, { token: 'abc', user: { id: 1, firstName: 'A' } }) });
  await api.pair('123456');
  assert.equal(storage.map.get(TOKEN_KEY), 'abc');
  assert.equal(await api.hasToken(), true);
  await api.clearToken();
  assert.equal(await api.hasToken(), false);
});

test('HTTP errors surface their status (401 detectable)', async () => {
  const api = createApi({ storage: fakeStorage(), fetchFn: async () => jsonRes(false, 401, { error: 'unauthorized' }) });
  await assert.rejects(() => api.digest(), (e) => e.status === 401);
});
