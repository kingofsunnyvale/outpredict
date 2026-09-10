-- User-owned application data. Epoch milliseconds align with the Worker clock.
CREATE TABLE chat (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  generation_id TEXT,
  lease_expires_at INTEGER,
  deleting_at INTEGER
);
CREATE INDEX chat_user_updated_idx ON chat(user_id, updated_at DESC);

CREATE TABLE message (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'cancelled', 'failed')),
  client_request_id TEXT,
  reply_to_id TEXT UNIQUE REFERENCES message(id) ON DELETE CASCADE,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, client_request_id)
);
CREATE INDEX message_chat_created_idx ON message(chat_id, created_at, role DESC);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chat(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 8388608),
  r2_key TEXT NOT NULL UNIQUE,
  extracted_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('processing', 'ready', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachment_user_idx ON attachment(user_id);
CREATE INDEX attachment_chat_idx ON attachment(chat_id);
CREATE INDEX attachment_message_idx ON attachment(message_id);

-- This survives individual chat deletion so deletion cannot reset daily limits.
CREATE TABLE daily_usage (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY(user_id, day)
);

-- Upload attempts survive file/chat deletion, including failed conversions.
-- Day is the UTC epoch day, matching the application's daily request limits.
CREATE TABLE daily_file_usage (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests >= 0),
  PRIMARY KEY(user_id, day)
);
