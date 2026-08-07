const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH дозволяє винести файл бази на Railway Volume, наприклад:
// DB_PATH=/data/data.db
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    last_seen_at TEXT,
    show_last_seen INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user1_id, user2_id),
    FOREIGN KEY(user1_id) REFERENCES users(id),
    FOREIGN KEY(user2_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    audio_url TEXT,
    video_url TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(chat_id) REFERENCES chats(id),
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

  CREATE TABLE IF NOT EXISTS message_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_deletions_message ON message_deletions(message_id);
  CREATE INDEX IF NOT EXISTS idx_deletions_user ON message_deletions(user_id);
`);

// Міграція для баз, створених до появи картинок/аудіо у чаті
const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!messageColumns.includes('image_url')) {
  db.exec('ALTER TABLE messages ADD COLUMN image_url TEXT');
}
if (!messageColumns.includes('audio_url')) {
  db.exec('ALTER TABLE messages ADD COLUMN audio_url TEXT');
}
if (!messageColumns.includes('video_url')) {
  db.exec('ALTER TABLE messages ADD COLUMN video_url TEXT');
}
if (!messageColumns.includes('read_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
}

// Міграція для баз, створених до появи аватарок
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('avatar_url')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
}
if (!userColumns.includes('last_seen_at')) {
  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
}
if (!userColumns.includes('show_last_seen')) {
  db.exec('ALTER TABLE users ADD COLUMN show_last_seen INTEGER NOT NULL DEFAULT 1');
}

module.exports = db;
