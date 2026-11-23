export const BASE_URL = 'https://glimpse-backend.example.workers.dev';
export const TOKEN_KEY = 'glimpse_token';
export function createApi({ baseUrl = BASE_URL, storage, fetchFn = fetch } = {}) {
  if (!storage) throw new Error('storage required');
  async function req(path, opts = {}) {
    const token = await storage.get(TOKEN_KEY);
    const headers = { ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof Uint8Array)) {
      headers['Content-Type'] = 'application/json';
      opts = { ...opts, body: JSON.stringify(opts.body) };
    }
    const res = await fetchFn(baseUrl + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `http_${res.status}`); e.status = res.status; e.code = data.error; throw e; }
    return data;
  }
  return {
    async pair(code) { const d = await req('/v1/pair', { method: 'POST', body: { code } }); await storage.set(TOKEN_KEY, d.token); return d; },
    async hasToken() { return !!(await storage.get(TOKEN_KEY)); },
    digest: () => req('/v1/digest'),
    source: (id) => req(`/v1/source/${encodeURIComponent(id)}?limit=20`),
    markRead: (sourceId, upToMessageId) => req('/v1/read', { method: 'POST', body: { sourceId, upToMessageId } }),
    reply: (sourceId, text, replyToMessageId) => req('/v1/reply', { method: 'POST', body: { sourceId, text, ...(replyToMessageId ? { replyToMessageId } : {}) } }),
    draft: (sourceId, messageId) => req('/v1/draft', { method: 'POST', body: { sourceId, messageId } }),
    stt: async (wavBytes) => req('/v1/stt', { method: 'POST', body: wavBytes, headers: { 'Content-Type': 'audio/wav' } }),
  };
}
