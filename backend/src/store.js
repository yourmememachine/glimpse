// Data layer for Glimpse.
// Two implementations with identical async semantics:
//   D1Store     - SQL against the schema in ../schema.sql
//   MemoryStore - in-memory Maps, used by the unit tests
//
// Conventions:
//   - A source is identified by its Telegram chat id (sources.chat_id).
//   - Message ids are the internal autoincrement ids from the messages table.
//   - Timestamps are integer milliseconds since the epoch.
//   - redeemPairCode returns the user ({id, firstName}) or null when the code
//     is unknown, already used, or expired; a successful redeem marks it used.
//     Pairing codes are never stored in plaintext: only their SHA-256 hash
//     is kept (pair_codes.code_hash), so a database leak does not expose a
//     live code. The plaintext exists only in the bot DM sent at mint time.
//   - A source with a null owner belongs to nobody: it is never listed for
//     any user. Ownership is only ever set when a caller passes an explicit
//     owner for a brand-new source or fills a still-null owner; an existing
//     owner is never overwritten. A still-unowned source can also be
//     claimed at pairing time: pairing sweeps the unowned sources and
//     attributes any chat where Telegram reports the pairing user as the
//     chat's creator or an administrator (recovery for a my_chat_member
//     update that was missed, e.g. the bot was added while the webhook
//     was down).

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sourceRow(row) {
  if (!row) return null;
  return {
    id: row.chat_id,
    chatId: row.chat_id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    createdAt: row.created_at,
  };
}

function messageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    tgMessageId: row.tg_message_id,
    tg_message_id: row.tg_message_id,
    from: row.from_name,
    text: row.text,
    at: row.at,
  };
}

function byNewest(a, b) {
  if (b.at !== a.at) return b.at - a.at;
  return b.id - a.id;
}

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  async upsertUser(telegramId, firstName, createdAt) {
    await this.db
      .prepare(
        `INSERT INTO users (telegram_id, first_name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, users.first_name)`
      )
      .bind(telegramId, firstName ?? null, createdAt)
      .run();
    return { id: telegramId, firstName };
  }

  async createPairCode({ code, userId, expiresAt }) {
    const codeHash = await sha256Hex(code);
    const existing = await this.db
      .prepare(`SELECT code_hash, user_id, used FROM pair_codes WHERE code_hash = ?`)
      .bind(codeHash)
      .first();
    if (existing && existing.user_id !== userId && !existing.used) {
      return false;
    }
    await this.db
      .prepare(`DELETE FROM pair_codes WHERE user_id = ? AND used = 0`)
      .bind(userId)
      .run();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO pair_codes (code_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)`
      )
      .bind(codeHash, userId, expiresAt)
      .run();
    return true;
  }

  async hasLivePairCode(userId, nowMs) {
    const row = await this.db
      .prepare(
        `SELECT code_hash FROM pair_codes WHERE user_id = ? AND used = 0 AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 1`
      )
      .bind(userId, nowMs)
      .first();
    return Boolean(row);
  }

  async redeemPairCode(code, nowMs) {
    const codeHash = await sha256Hex(code);
    const row = await this.db
      .prepare(`SELECT code_hash, user_id, expires_at, used FROM pair_codes WHERE code_hash = ?`)
      .bind(codeHash)
      .first();
    if (!row || row.used || row.expires_at <= nowMs) return null;
    const claim = await this.db
      .prepare(`UPDATE pair_codes SET used = 1 WHERE code_hash = ? AND used = 0`)
      .bind(codeHash)
      .run();
    if (!claim?.meta?.changes) return null;
    const user = await this.db
      .prepare(`SELECT telegram_id, first_name FROM users WHERE telegram_id = ?`)
      .bind(row.user_id)
      .first();
    if (!user) return null;
    return { id: user.telegram_id, firstName: user.first_name };
  }

  async recordPairFailure(at, client, pruneBeforeMs) {
    if (pruneBeforeMs != null) {
      await this.db
        .prepare(`DELETE FROM pair_failures WHERE at <= ?`)
        .bind(pruneBeforeMs)
        .run();
    }
    await this.db
      .prepare(`INSERT INTO pair_failures (at, client) VALUES (?, ?)`)
      .bind(at, client ?? null)
      .run();
  }

  async pairFailuresInWindow(nowMs, windowMs, client = null) {
    const sql =
      client == null
        ? `SELECT COUNT(*) AS n FROM pair_failures WHERE at > ?`
        : `SELECT COUNT(*) AS n FROM pair_failures WHERE at > ? AND client = ?`;
    const stmt = this.db.prepare(sql);
    const row = await (client == null
      ? stmt.bind(nowMs - windowMs)
      : stmt.bind(nowMs - windowMs, client)
    ).first();
    return row ? Number(row.n) : 0;
  }

  async createSession(tokenHash, userId, createdAt) {
    await this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)`)
      .bind(tokenHash, userId, createdAt)
      .run();
  }

  async userForToken(tokenHash, nowMs) {
    let sql = `SELECT u.telegram_id AS telegram_id, u.first_name AS first_name
               FROM sessions s JOIN users u ON u.telegram_id = s.user_id
               WHERE s.token_hash = ?`;
    const binds = [tokenHash];
    if (nowMs != null) {
      sql += ` AND s.created_at > ?`;
      binds.push(nowMs - SESSION_TTL_MS);
    }
    const stmt = this.db.prepare(sql);
    const row = await (binds.length > 1 ? stmt.bind(...binds) : stmt.bind(binds[0])).first();
    if (!row) return null;
    return { id: row.telegram_id, firstName: row.first_name };
  }

  async upsertSource({ chatId, userId, type, title, createdAt }) {
    await this.db
      .prepare(
        `INSERT INTO sources (chat_id, user_id, type, title, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           title = COALESCE(excluded.title, sources.title),
           type = COALESCE(excluded.type, sources.type),
           user_id = COALESCE(sources.user_id, excluded.user_id)`
      )
      .bind(chatId, userId ?? null, type ?? null, title ?? null, createdAt)
      .run();
    return this.getSource(chatId);
  }

  async listUnownedSources() {
    const { results } = await this.db
      .prepare(`SELECT * FROM sources WHERE user_id IS NULL`)
      .all();
    return results.map(sourceRow);
  }

  async deleteSource(sourceId) {
    await this.db
      .prepare(`DELETE FROM messages WHERE source_id = ?`)
      .bind(sourceId)
      .run();
    await this.db
      .prepare(`DELETE FROM read_markers WHERE source_id = ?`)
      .bind(sourceId)
      .run();
    await this.db
      .prepare(`DELETE FROM sources WHERE chat_id = ?`)
      .bind(sourceId)
      .run();
  }

  async addMessage({ sourceId, tgMessageId, fromName, text, at }) {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (source_id, tg_message_id, from_name, text, at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(sourceId, tgMessageId, fromName ?? null, text ?? "", at)
      .run();
    const inserted = (res?.meta?.changes ?? 0) > 0;
    const row = await this.db
      .prepare(`SELECT id FROM messages WHERE source_id = ? AND tg_message_id = ?`)
      .bind(sourceId, tgMessageId)
      .first();
    return { id: row ? row.id : null, inserted };
  }

  async listSourcesWithUnread(userId) {
    const { results: sources } = await this.db
      .prepare(`SELECT * FROM sources WHERE user_id = ?`)
      .bind(userId)
      .all();
    const out = [];
    for (const s of sources) {
      const marker = await this.db
        .prepare(`SELECT last_read_id FROM read_markers WHERE user_id = ? AND source_id = ?`)
        .bind(userId, s.chat_id)
        .first();
      const lastRead = marker ? marker.last_read_id : 0;
      // Unread is a SQL COUNT over the marker, and the digest preview is a
      // LIMIT 3 query — the full message history is never loaded.
      const countRow = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE source_id = ? AND id > ?`)
        .bind(s.chat_id, lastRead)
        .first();
      const { results: newest } = await this.db
        .prepare(
          `SELECT text, at FROM messages WHERE source_id = ? ORDER BY at DESC, id DESC LIMIT 3`
        )
        .bind(s.chat_id)
        .all();
      if (!newest.length) continue;
      out.push({
        id: s.chat_id,
        chatId: s.chat_id,
        userId: s.user_id,
        type: s.type,
        title: s.title,
        unread: countRow ? Number(countRow.n) : 0,
        lastAt: newest[0].at,
        topTexts: newest.map((m) => m.text),
      });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out;
  }

  async messagesFor(sourceId, limit = 20) {
    const { results } = await this.db
      .prepare(`SELECT * FROM messages WHERE source_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
      .bind(sourceId, limit)
      .all();
    return results.map(messageRow);
  }

  async markRead(userId, sourceId, upToMessageId) {
    await this.db
      .prepare(
        `INSERT INTO read_markers (user_id, source_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
           last_read_id = MAX(last_read_id, excluded.last_read_id)`
      )
      .bind(userId, sourceId, upToMessageId)
      .run();
  }

  async getSource(sourceId) {
    const row = await this.db
      .prepare(`SELECT * FROM sources WHERE chat_id = ?`)
      .bind(sourceId)
      .first();
    return sourceRow(row);
  }

  async getMessage(sourceId, messageId) {
    const row = await this.db
      .prepare(`SELECT * FROM messages WHERE source_id = ? AND id = ?`)
      .bind(sourceId, messageId)
      .first();
    return messageRow(row);
  }

  async findRecentSend({ userId, sourceId, text, sinceMs }) {
    const row = await this.db
      .prepare(
        `SELECT message_id FROM recent_sends
         WHERE user_id = ? AND source_id = ? AND text = ? AND at > ?
         ORDER BY at DESC LIMIT 1`
      )
      .bind(userId, sourceId, text, sinceMs)
      .first();
    return row ? row.message_id : null;
  }

  async recordSend({ userId, sourceId, text, messageId, at }) {
    await this.db
      .prepare(
        `INSERT INTO recent_sends (user_id, source_id, text, message_id, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id, text) DO UPDATE SET
           message_id = excluded.message_id, at = excluded.at`
      )
      .bind(userId, sourceId, text, messageId, at)
      .run();
  }
}

export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.pairCodes = new Map();
    this.sessions = new Map();
    this.sources = new Map();
    this.messages = [];
    this.messageKeys = new Set();
    this.readMarkers = new Map();
    this.pairFailures = [];
    this.recentSends = [];
    this.nextMessageId = 1;
  }

  async upsertUser(telegramId, firstName, createdAt) {
    const existing = this.users.get(telegramId);
    if (existing) {
      if (firstName != null) existing.firstName = firstName;
      return { id: telegramId, firstName: existing.firstName };
    }
    const user = { id: telegramId, firstName, createdAt };
    this.users.set(telegramId, user);
    return { id: telegramId, firstName };
  }

  async createPairCode({ code, userId, expiresAt }) {
    const codeHash = await sha256Hex(code);
    const existing = this.pairCodes.get(codeHash);
    if (existing && existing.userId !== userId && !existing.used) {
      return false;
    }
    for (const [key, entry] of this.pairCodes) {
      if (entry.userId === userId && !entry.used) this.pairCodes.delete(key);
    }
    this.pairCodes.set(codeHash, { userId, expiresAt, used: false });
    return true;
  }

  async hasLivePairCode(userId, nowMs) {
    for (const entry of this.pairCodes.values()) {
      if (entry.userId !== userId || entry.used) continue;
      if (entry.expiresAt > nowMs) return true;
    }
    return false;
  }

  async redeemPairCode(code, nowMs) {
    const codeHash = await sha256Hex(code);
    const entry = this.pairCodes.get(codeHash);
    if (!entry || entry.used || entry.expiresAt <= nowMs) return null;
    entry.used = true;
    const user = this.users.get(entry.userId);
    if (!user) return null;
    return { id: user.id, firstName: user.firstName };
  }

  async recordPairFailure(at, client, pruneBeforeMs) {
    if (pruneBeforeMs != null) {
      this.pairFailures = this.pairFailures.filter((f) => f.at > pruneBeforeMs);
    }
    this.pairFailures.push({ at, client: client ?? null });
  }

  async pairFailuresInWindow(nowMs, windowMs, client = null) {
    const cutoff = nowMs - windowMs;
    return this.pairFailures.filter(
      (f) => f.at > cutoff && (client == null || f.client === client)
    ).length;
  }

  async createSession(tokenHash, userId, createdAt) {
    this.sessions.set(tokenHash, { userId, createdAt });
  }

  async userForToken(tokenHash, nowMs) {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (nowMs != null && session.createdAt <= nowMs - SESSION_TTL_MS) return null;
    const user = this.users.get(session.userId);
    if (!user) return null;
    return { id: user.id, firstName: user.firstName };
  }

  async upsertSource({ chatId, userId, type, title, createdAt }) {
    const existing = this.sources.get(chatId);
    if (existing) {
      existing.title = title ?? existing.title;
      existing.type = type ?? existing.type;
      if (existing.userId == null && userId != null) existing.userId = userId;
      return { ...existing };
    }
    const source = {
      id: chatId,
      chatId,
      userId: userId ?? null,
      type,
      title: title ?? null,
      createdAt,
    };
    this.sources.set(chatId, source);
    return { ...source };
  }

  async listUnownedSources() {
    const out = [];
    for (const s of this.sources.values()) {
      if (s.userId == null) out.push({ ...s });
    }
    return out;
  }

  async deleteSource(sourceId) {
    this.sources.delete(sourceId);
    this.messages = this.messages.filter((m) => m.sourceId !== sourceId);
    this.messageKeys = new Set(
      this.messages.map((m) => `${m.sourceId}:${m.tgMessageId}`)
    );
    for (const key of [...this.readMarkers.keys()]) {
      if (key.endsWith(`:${sourceId}`)) this.readMarkers.delete(key);
    }
    this.recentSends = this.recentSends.filter((s) => s.sourceId !== sourceId);
  }

  async addMessage({ sourceId, tgMessageId, fromName, text, at }) {
    const key = `${sourceId}:${tgMessageId}`;
    if (this.messageKeys.has(key)) {
      const existing = this.messages.find(
        (m) => m.sourceId === sourceId && m.tgMessageId === tgMessageId
      );
      return { id: existing ? existing.id : null, inserted: false };
    }
    const message = {
      id: this.nextMessageId++,
      sourceId,
      tgMessageId,
      tg_message_id: tgMessageId,
      from: fromName ?? null,
      text: text ?? "",
      at,
    };
    this.messageKeys.add(key);
    this.messages.push(message);
    return { id: message.id, inserted: true };
  }

  async listSourcesWithUnread(userId) {
    const out = [];
    for (const s of this.sources.values()) {
      if (s.userId !== userId) continue;
      const lastRead = this.readMarkers.get(`${userId}:${s.chatId}`) ?? 0;
      // Single pass: count unread and keep references to the three newest
      // messages instead of copying and sorting the source's whole history.
      let unread = 0;
      const newest = [];
      for (const m of this.messages) {
        if (m.sourceId !== s.chatId) continue;
        if (m.id > lastRead) unread++;
        newest.push(m);
      }
      if (!newest.length) continue;
      newest.sort(byNewest);
      out.push({
        id: s.chatId,
        chatId: s.chatId,
        userId: s.userId,
        type: s.type,
        title: s.title,
        unread,
        lastAt: newest[0].at,
        topTexts: newest.slice(0, 3).map((m) => m.text),
      });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out;
  }

  async messagesFor(sourceId, limit = 20) {
    return this.messages
      .filter((m) => m.sourceId === sourceId)
      .sort(byNewest)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  async markRead(userId, sourceId, upToMessageId) {
    const key = `${userId}:${sourceId}`;
    const current = this.readMarkers.get(key) ?? 0;
    if (upToMessageId > current) this.readMarkers.set(key, upToMessageId);
  }

  async getSource(sourceId) {
    const s = this.sources.get(sourceId);
    return s ? { ...s } : null;
  }

  async getMessage(sourceId, messageId) {
    const m = this.messages.find((x) => x.sourceId === sourceId && x.id === messageId);
    return m ? { ...m } : null;
  }

  async findRecentSend({ userId, sourceId, text, sinceMs }) {
    let best = null;
    for (const s of this.recentSends) {
      if (s.userId !== userId || s.sourceId !== sourceId || s.text !== text) continue;
      if (s.at <= sinceMs) continue;
      if (!best || s.at > best.at) best = s;
    }
    return best ? best.messageId : null;
  }

  async recordSend({ userId, sourceId, text, messageId, at }) {
    const existing = this.recentSends.find(
      (s) => s.userId === userId && s.sourceId === sourceId && s.text === text
    );
    if (existing) {
      existing.messageId = messageId;
      existing.at = at;
      return;
    }
    this.recentSends.push({ userId, sourceId, text, messageId, at });
  }
}
