CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  first_name TEXT,
  created_at INTEGER
);

-- Only the SHA-256 hash of a pairing code is stored, never the code itself;
-- the plaintext code exists only in the bot DM sent to the user at mint time.
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER,
  expires_at INTEGER,
  used INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sources (
  chat_id INTEGER PRIMARY KEY,
  user_id INTEGER,
  type TEXT,
  title TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER,
  tg_message_id INTEGER,
  from_name TEXT,
  text TEXT,
  at INTEGER,
  UNIQUE(source_id, tg_message_id)
);

-- One row per failed pairing attempt, keyed by client identity so one
-- attacker cannot exhaust the limit for everyone; rows older than the
-- failure window are pruned on each new failure.
CREATE TABLE IF NOT EXISTS pair_failures (
  at INTEGER,
  client TEXT
);

CREATE TABLE IF NOT EXISTS recent_sends (
  user_id INTEGER,
  source_id INTEGER,
  text TEXT,
  message_id INTEGER,
  at INTEGER,
  PRIMARY KEY (user_id, source_id, text)
);

CREATE TABLE IF NOT EXISTS read_markers (
  user_id INTEGER,
  source_id INTEGER,
  last_read_id INTEGER,
  PRIMARY KEY (user_id, source_id)
);
