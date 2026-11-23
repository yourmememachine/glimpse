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
         ON CONFLICT(telegram_id) DO UPDATE SET first_name = excluded.first_name`
      )
      .bind(telegramId, firstName ?? null, createdAt)
      .run();
    return { id: telegramId, firstName };
  }

  async createPairCode({ code, userId, expiresAt }) {
    await this.db
      .prepare(`DELETE FROM pair_codes WHERE user_id = ? AND used = 0`)
      .bind(userId)
      .run();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO pair_codes (code, user_id, expires_at, used) VALUES (?, ?, ?, 0)`
      )
      .bind(code, userId, expiresAt)
      .run();
  }

  async redeemPairCode(code, nowMs) {
    const row = await this.db
      .prepare(`SELECT code, user_id, expires_at, used FROM pair_codes WHERE code = ?`)
      .bind(code)
      .first();
    if (!row || row.used || row.expires_at <= nowMs) return null;
    const claim = await this.db
      .prepare(`UPDATE pair_codes SET used = 1 WHERE code = ? AND used = 0`)
      .bind(code)
      .run();
    if (!claim?.meta?.changes) return null;
    const user = await this.db
      .prepare(`SELECT telegram_id, first_name FROM users WHERE telegram_id = ?`)
      .bind(row.user_id)
      .first();
    if (!user) return null;
    return { id: user.telegram_id, firstName: user.first_name };
  }

  async createSession(tokenHash, userId, createdAt) {
    await this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)`)
      .bind(tokenHash, userId, createdAt)
      .run();
  }

  async userForToken(tokenHash) {
    const row = await this.db
      .prepare(
        `SELECT u.telegram_id AS telegram_id, u.first_name AS first_name
         FROM sessions s JOIN users u ON u.telegram_id = s.user_id
         WHERE s.token_hash = ?`
      )
      .bind(tokenHash)
      .first();
    if (!row) return null;
    return { id: row.telegram_id, firstName: row.first_name };
  }

  async upsertSource({ chatId, userId, type, title, createdAt }) {
    await this.db
      .prepare(
        `INSERT INTO sources (chat_id, user_id, type, title, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           title = excluded.title,
           type = excluded.type,
           user_id = COALESCE(sources.user_id, excluded.user_id)`
      )
      .bind(chatId, userId ?? null, type, title ?? null, createdAt)
      .run();
    return this.getSource(chatId);
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
      .prepare(`SELECT * FROM sources WHERE user_id = ? OR user_id IS NULL`)
      .bind(userId)
      .all();
    const out = [];
    for (const s of sources) {
      const { results: msgs } = await this.db
        .prepare(`SELECT * FROM messages WHERE source_id = ? ORDER BY at DESC, id DESC`)
        .bind(s.chat_id)
        .all();
      if (!msgs.length) continue;
      const marker = await this.db
        .prepare(`SELECT last_read_id FROM read_markers WHERE user_id = ? AND source_id = ?`)
        .bind(userId, s.chat_id)
        .first();
      const lastRead = marker ? marker.last_read_id : 0;
      const unread = msgs.filter((m) => m.id > lastRead).length;
      out.push({
        id: s.chat_id,
        chatId: s.chat_id,
        userId: s.user_id,
        type: s.type,
        title: s.title,
        unread,
        lastAt: msgs[0].at,
        topTexts: msgs.slice(0, 3).map((m) => m.text),
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
    for (const [key, entry] of this.pairCodes) {
      if (entry.userId === userId && !entry.used) this.pairCodes.delete(key);
    }
    this.pairCodes.set(code, { code, userId, expiresAt, used: false });
  }

  async redeemPairCode(code, nowMs) {
    const entry = this.pairCodes.get(code);
    if (!entry || entry.used || entry.expiresAt <= nowMs) return null;
    entry.used = true;
    const user = this.users.get(entry.userId);
    if (!user) return null;
    return { id: user.id, firstName: user.firstName };
  }

  async createSession(tokenHash, userId, createdAt) {
    this.sessions.set(tokenHash, { userId, createdAt });
  }

  async userForToken(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
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
      if (s.userId !== userId && s.userId != null) continue;
      const msgs = this.messages.filter((m) => m.sourceId === s.chatId).sort(byNewest);
      if (!msgs.length) continue;
      const lastRead = this.readMarkers.get(`${userId}:${s.chatId}`) ?? 0;
      const unread = msgs.filter((m) => m.id > lastRead).length;
      out.push({
        id: s.chatId,
        chatId: s.chatId,
        userId: s.userId,
        type: s.type,
        title: s.title,
        unread,
        lastAt: msgs[0].at,
        topTexts: msgs.slice(0, 3).map((m) => m.text),
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
}
