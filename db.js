const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH дозволяє винести файл бази на Railway Volume, наприклад:
// DB_PATH=/data/data.db
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Явно вимикаємо перевірку зовнішніх ключів: на деяких платформах (напр. Railway)
// зібраний better-sqlite3 має foreign_keys=ON за замовчуванням, що ламає міграції
// нижче на реальних даних. FK тут лише довідкові, ми ніколи не покладались на їх примусову перевірку.
db.pragma('foreign_keys = OFF');
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
    user1_id INTEGER,
    user2_id INTEGER,
    is_group INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    avatar_url TEXT,
    creator_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user1_id) REFERENCES users(id),
    FOREIGN KEY(user2_id) REFERENCES users(id),
    FOREIGN KEY(creator_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, user_id),
    FOREIGN KEY(chat_id) REFERENCES chats(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members(chat_id);
  CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    audio_url TEXT,
    video_url TEXT,
    read_at TEXT,
    edited_at TEXT,
    event_type TEXT,
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

  CREATE TABLE IF NOT EXISTS message_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reads_message ON message_reads(message_id);
  CREATE INDEX IF NOT EXISTS idx_message_reads_user ON message_reads(user_id);

  CREATE TABLE IF NOT EXISTS avatar_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    avatar_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_avatar_history_user ON avatar_history(user_id);

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

  CREATE TABLE IF NOT EXISTS chat_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, user_id),
    FOREIGN KEY(chat_id) REFERENCES chats(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_deletions_chat ON chat_deletions(chat_id);
  CREATE INDEX IF NOT EXISTS idx_chat_deletions_user ON chat_deletions(user_id);
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
if (!messageColumns.includes('edited_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
}
if (!messageColumns.includes('event_type')) {
  db.exec('ALTER TABLE messages ADD COLUMN event_type TEXT');
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

// Міграція для баз, створених до появи видалення чату "для мене"
const chatDeletionColumns = db.prepare('PRAGMA table_info(chat_deletions)').all().map((c) => c.name);
if (chatDeletionColumns.length && !chatDeletionColumns.includes('last_message_id')) {
  db.exec("ALTER TABLE chat_deletions ADD COLUMN last_message_id INTEGER NOT NULL DEFAULT 0");
}

// Міграція для баз, створених до появи групових чатів:
// у старій схемі user1_id/user2_id були NOT NULL — для групових чатів вони мають бути NULL,
// тож стару таблицю (якщо потрібно) перебудовуємо, зберігаючи всі існуючі 1:1-чати
const chatsInfo = db.prepare('PRAGMA table_info(chats)').all();
const user1Col = chatsInfo.find((c) => c.name === 'user1_id');
const hasGroupColumns = chatsInfo.some((c) => c.name === 'is_group');

if (user1Col && (user1Col.notnull === 1 || !hasGroupColumns)) {
  const migrateChatsTable = db.transaction(() => {
    // DROP TABLE IF EXISTS — на випадок, якщо попередня спроба міграції впала посередині
    db.exec('DROP TABLE IF EXISTS chats_new;');
    db.exec(`
      CREATE TABLE chats_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1_id INTEGER,
        user2_id INTEGER,
        is_group INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        avatar_url TEXT,
        creator_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO chats_new (id, user1_id, user2_id, created_at)
        SELECT id, user1_id, user2_id, created_at FROM chats;
    `);
    db.exec('DROP TABLE chats;');
    db.exec('ALTER TABLE chats_new RENAME TO chats;');
  });
  migrateChatsTable();
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_pair ON chats(user1_id, user2_id) WHERE is_group = 0;');

// Для аватарок, завантажених до появи історії — додаємо їх туди заднім числом,
// щоб вони теж були видні в профілі
const usersWithAvatarNoHistory = db.prepare(`
  SELECT id, avatar_url FROM users
  WHERE avatar_url IS NOT NULL
    AND id NOT IN (SELECT DISTINCT user_id FROM avatar_history)
`).all();
if (usersWithAvatarNoHistory.length) {
  const insertHistory = db.prepare('INSERT INTO avatar_history (user_id, avatar_url) VALUES (?, ?)');
  usersWithAvatarNoHistory.forEach((u) => insertHistory.run(u.id, u.avatar_url));
}

module.exports = db;
