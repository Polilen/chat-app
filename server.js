require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;

// UPLOAD_DIR дозволяє винести завантажені картинки на Railway Volume, наприклад:
// UPLOAD_DIR=/data/uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Завантаження файлів (картинки + аудіо) ----------

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_SIZE = 8 * 1024 * 1024; // 8 MB
const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500 MB

function isAllowedAudioMime(mimetype) {
  const base = (mimetype || '').split(';')[0].trim().toLowerCase();
  return base.startsWith('audio/');
}

function isAllowedVideoMime(mimetype) {
  const base = (mimetype || '').split(';')[0].trim().toLowerCase();
  return base.startsWith('video/');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_VIDEO_SIZE }, // спільний верхній ліміт, точні ліміти по типах — нижче
  fileFilter: (req, file, cb) => {
    const baseMime = (file.mimetype || '').split(';')[0].trim();
    if (!ALLOWED_IMAGE_MIME.has(baseMime) && !isAllowedAudioMime(file.mimetype) && !isAllowedVideoMime(file.mimetype)) {
      return cb(new Error('Дозволені лише зображення, аудіо або відео файли'));
    }
    cb(null, true);
  },
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '';
      cb(null, `avatar-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const baseMime = (file.mimetype || '').split(';')[0].trim();
    if (!ALLOWED_IMAGE_MIME.has(baseMime)) {
      return cb(new Error('Аватарка має бути зображенням (jpeg, png, gif, webp)'));
    }
    cb(null, true);
  },
});

// ---------- Допоміжні функції ----------

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Немає токена авторизації' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Недійсний токен' });
  }
}

function getOrCreateChat(userAId, userBId) {
  const [u1, u2] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  let chat = db.prepare('SELECT * FROM chats WHERE user1_id = ? AND user2_id = ?').get(u1, u2);
  if (!chat) {
    const info = db.prepare('INSERT INTO chats (user1_id, user2_id) VALUES (?, ?)').run(u1, u2);
    chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  }
  return chat;
}

function otherUserId(chat, myId) {
  return chat.user1_id === myId ? chat.user2_id : chat.user1_id;
}

function isParticipant(chat, userId) {
  if (chat.is_group) {
    const row = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat.id, userId);
    return !!row;
  }
  return chat.user1_id === userId || chat.user2_id === userId;
}

function getParticipantIds(chat, excludeUserId) {
  if (chat.is_group) {
    const rows = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chat.id);
    return rows.map((r) => r.user_id).filter((id) => id !== excludeUserId);
  }
  // Для 1:1 чату: excludeUserId === null/undefined означає "всі учасники" (обидва),
  // а не "виключити нікого, кому дорівнює null" — раніше тут була помилка,
  // через яку otherUserId(chat, null) завжди повертав user1_id замість обох сторін
  const ids = [chat.user1_id, chat.user2_id];
  return excludeUserId == null ? ids : ids.filter((id) => id !== excludeUserId);
}

function getMemberCount(chatId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM chat_members WHERE chat_id = ?').get(chatId);
  return row ? row.cnt : 0;
}

function isGroupAdmin(chatId, userId) {
  const row = db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? AND role = 'admin'").get(chatId, userId);
  return !!row;
}

function groupReactions(rows) {
  const byEmoji = {};
  rows.forEach((r) => {
    if (!byEmoji[r.emoji]) byEmoji[r.emoji] = [];
    byEmoji[r.emoji].push({ id: r.userId, username: r.username });
  });
  return Object.entries(byEmoji).map(([emoji, users]) => ({
    emoji,
    users,
    userIds: users.map((u) => u.id), // для сумісності зі старим форматом на клієнті
  }));
}

// ---------- Дзвінки (WebRTC-сигналінг, лише relay — медіа йде напряму між браузерами) ----------

const activeCalls = new Map(); // callId -> { chatId, callerId, calleeId, status }
const userActiveCallId = new Map(); // userId -> callId

function cleanupCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  userActiveCallId.delete(call.callerId);
  userActiveCallId.delete(call.calleeId);
  activeCalls.delete(callId);
}

// chatId -> { startedAt } — активні сеанси спільного перегляду (лише після прийняття запрошення)
const activeWatchSessions = new Map();

function formatDurationText(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) return `${mins} хв ${secs} с`;
  return `${secs} с`;
}

// Системні повідомлення в чат про дзвінки/спільний перегляд — sender_id є формальністю
// (для NOT NULL-обмеження), клієнт рендерить їх окремо від звичайних бульбашок за event_type
function insertSystemMessage(chatId, senderId, text, eventType) {
  try {
    const info = db.prepare(
      'INSERT INTO messages (chat_id, sender_id, text, event_type) VALUES (?, ?, ?, ?)'
    ).run(chatId, senderId, text, eventType);
    const message = db.prepare(`
      SELECT m.id, m.chat_id as chatId, m.sender_id as senderId, u.username as senderUsername,
             u.avatar_url as senderAvatarUrl, m.text, m.event_type as eventType, m.created_at as createdAt
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `).get(info.lastInsertRowid);
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (chat) {
      getParticipantIds(chat, null).forEach((uid) => {
        io.to(`user:${uid}`).emit('message:new', { ...message, isGroup: false });
      });
    }
  } catch (err) {
    console.error('insertSystemMessage error:', err);
  }
}

// ---------- Присутність (онлайн / був(ла) нещодавно) ----------

// userId -> Set(socketId) — сокети із реально видимою (не згорнутою/фоновою) вкладкою будь-де на сайті
const visibleSocketsByUser = new Map();
// chatId -> Map<userId, Set<socketId>> — хто зараз дивиться саме цей чат (відкритий і видимий)
const chatViewers = new Map();

function isUserOnline(userId) {
  const set = visibleSocketsByUser.get(userId);
  return !!set && set.size > 0;
}

function isUserViewingChat(userId, chatId) {
  const m = chatViewers.get(chatId);
  if (!m) return false;
  const set = m.get(userId);
  return !!set && set.size > 0;
}

function addChatViewer(chatId, userId, socketId) {
  let m = chatViewers.get(chatId);
  if (!m) { m = new Map(); chatViewers.set(chatId, m); }
  let set = m.get(userId);
  if (!set) { set = new Set(); m.set(userId, set); }
  set.add(socketId);
}

function removeChatViewer(chatId, userId, socketId) {
  const m = chatViewers.get(chatId);
  if (!m) return;
  const set = m.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) m.delete(userId);
  if (m.size === 0) chatViewers.delete(chatId);
}

// Присутність userId очима конкретного viewerId (chatId — їхній спільний чат, якщо є)
function getPresenceForViewer(userId, chatId, viewerId) {
  const row = db.prepare('SELECT last_seen_at as lastSeenAt, show_last_seen as showLastSeen FROM users WHERE id = ?').get(userId);
  if (!row) return { online: false, lastSeenAt: null, vague: false, justNow: false };

  // Якщо людина прямо зараз дивиться відкритий чат саме з viewerId — показуємо "онлайн" завжди,
  // незалежно від налаштувань приватності (аналогічно до галочок прочитання)
  if (chatId && isUserViewingChat(userId, chatId)) {
    return { online: true, lastSeenAt: null, vague: false, justNow: false };
  }

  const secondsSinceSeen = row.lastSeenAt
    ? (Date.now() - new Date(row.lastSeenAt.replace(' ', 'T') + 'Z').getTime()) / 1000
    : Infinity;
  const justNow = secondsSinceSeen < 60;

  if (!row.showLastSeen) {
    // Активність прихована — завжди розпливчасте "був(ла) недавно", без точного часу і без "щойно"
    return { online: false, lastSeenAt: null, vague: true, justNow: false };
  }

  return { online: isUserOnline(userId), lastSeenAt: row.lastSeenAt, vague: false, justNow };
}

function findChatId(userAId, userBId) {
  const [u1, u2] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const chat = db.prepare('SELECT id FROM chats WHERE user1_id = ? AND user2_id = ?').get(u1, u2);
  return chat ? chat.id : null;
}

function broadcastPresenceToPartners(userId) {
  // 1:1 чати
  const directPartners = db.prepare(`
    SELECT id as chatId, CASE WHEN user1_id = ? THEN user2_id ELSE user1_id END as otherId
    FROM chats WHERE is_group = 0 AND (user1_id = ? OR user2_id = ?)
  `).all(userId, userId, userId);
  directPartners.forEach((p) => {
    const presence = getPresenceForViewer(userId, p.chatId, p.otherId);
    io.to(`user:${p.otherId}`).emit('presence:updated', { userId, chatId: p.chatId, ...presence });
  });

  // Групові чати — раніше сюди взагалі не заглядали (user1_id/user2_id у групах завжди NULL),
  // тому статус учасників групи ніколи не оновлювався в реальному часі
  const groupChats = db.prepare('SELECT chat_id as chatId FROM chat_members WHERE user_id = ?').all(userId);
  groupChats.forEach((g) => {
    const presence = getPresenceForViewer(userId, g.chatId, null);
    const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(g.chatId, userId);
    const payload = { userId, chatId: g.chatId, ...presence };
    members.forEach((m) => {
      io.to(`user:${m.user_id}`).emit('presence:updated', payload);
    });
  });
}

function notifyChatPartnersAvatarChanged(userId, avatarUrl) {
  const partners = db.prepare(`
    SELECT DISTINCT CASE WHEN user1_id = ? THEN user2_id ELSE user1_id END as otherId
    FROM chats WHERE user1_id = ? OR user2_id = ?
  `).all(userId, userId, userId);
  partners.forEach((p) => {
    io.to(`user:${p.otherId}`).emit('avatar:updated', { userId, avatarUrl });
  });
}

// ---------- REST API ----------


app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Потрібні поля username та password" });
  }
  const cleanUsername = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Юзернейм: 3-20 символів, лише латиниця, цифри та "_"' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Пароль має містити мінімум 6 символів' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) {
    return res.status(409).json({ error: 'Такий юзернейм вже зайнятий' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(cleanUsername, hash);
  const user = { id: info.lastInsertRowid, username: cleanUsername, avatarUrl: null, showLastSeen: true };
  res.json({ token: createToken(user), user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Потрібні поля username та password' });
  }
  const cleanUsername = String(username).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Невірний юзернейм або пароль' });
  }
  res.json({ token: createToken(user), user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, showLastSeen: !!user.show_last_seen } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, avatar_url as avatarUrl, show_last_seen as showLastSeen FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  user.showLastSeen = !!user.showLastSeen;
  user.avatarHistory = db.prepare(
    'SELECT id, avatar_url as avatarUrl, created_at as createdAt FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ user });
});

app.delete('/api/me/avatar-history/:id', authMiddleware, (req, res) => {
  const historyId = Number(req.params.id);
  const row = db.prepare('SELECT * FROM avatar_history WHERE id = ? AND user_id = ?').get(historyId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Аватарку не знайдено' });

  db.prepare('DELETE FROM avatar_history WHERE id = ?').run(historyId);
  fs.unlink(path.join(UPLOAD_DIR, path.basename(row.avatar_url)), () => {});

  const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
  let newCurrentAvatarUrl = user.avatar_url;
  if (user.avatar_url === row.avatar_url) {
    // Видалили саме поточну аватарку — переключаємось на найновішу з тих, що лишились, або знімаємо зовсім
    const latest = db.prepare(
      'SELECT avatar_url FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(req.user.id);
    newCurrentAvatarUrl = latest ? latest.avatar_url : null;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(newCurrentAvatarUrl, req.user.id);
    notifyChatPartnersAvatarChanged(req.user.id, newCurrentAvatarUrl);
  }

  res.json({ ok: true, avatarUrl: newCurrentAvatarUrl });
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, username, avatar_url as avatarUrl FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  user.avatarHistory = db.prepare(
    'SELECT id, avatar_url as avatarUrl, created_at as createdAt FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC'
  ).all(id);
  res.json({ user });
});

app.post('/api/me/privacy', authMiddleware, (req, res) => {
  const { showLastSeen } = req.body || {};
  db.prepare('UPDATE users SET show_last_seen = ? WHERE id = ?').run(showLastSeen ? 1 : 0, req.user.id);
  broadcastPresenceToPartners(req.user.id);
  res.json({ ok: true, showLastSeen: !!showLastSeen });
});

app.post('/api/me/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не передано' });

    const avatarUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);
    // Стару аватарку більше не видаляємо з диска — зберігаємо в історії, щоб її можна було переглянути пізніше
    db.prepare('INSERT INTO avatar_history (user_id, avatar_url) VALUES (?, ?)').run(req.user.id, avatarUrl);

    notifyChatPartnersAvatarChanged(req.user.id, avatarUrl);
    res.json({ avatarUrl });
  });
});

app.delete('/api/me/avatar', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.avatar_url) {
    return res.json({ ok: true, avatarUrl: null });
  }

  // Видалення поточної аватарки тепер прибирає її й з історії остаточно —
  // і підставляє попередню (як і видалення конкретного фото в історії), а не просто скидає в "немає аватарки"
  const currentRow = db.prepare(
    'SELECT * FROM avatar_history WHERE user_id = ? AND avatar_url = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.user.id, user.avatar_url);

  if (currentRow) {
    db.prepare('DELETE FROM avatar_history WHERE id = ?').run(currentRow.id);
    fs.unlink(path.join(UPLOAD_DIR, path.basename(currentRow.avatar_url)), () => {});
  }

  const previous = db.prepare(
    'SELECT avatar_url FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.user.id);
  const newAvatarUrl = previous ? previous.avatar_url : null;

  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(newAvatarUrl, req.user.id);
  notifyChatPartnersAvatarChanged(req.user.id, newAvatarUrl);
  res.json({ ok: true, avatarUrl: newAvatarUrl });
});

app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Файл занадто великий (максимум 500 МБ)' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не передано' });

    let type = 'image';
    let maxSize = MAX_IMAGE_SIZE;
    if (isAllowedAudioMime(req.file.mimetype)) {
      type = 'audio';
      maxSize = MAX_AUDIO_SIZE;
    } else if (isAllowedVideoMime(req.file.mimetype)) {
      type = 'video';
      maxSize = MAX_VIDEO_SIZE;
    }

    if (req.file.size > maxSize) {
      fs.unlink(req.file.path, () => {});
      const mb = Math.round(maxSize / (1024 * 1024));
      return res.status(400).json({ error: `Файл занадто великий (максимум ${mb} МБ для цього типу)` });
    }

    res.json({ url: `/uploads/${req.file.filename}`, type });
  });
});

app.get('/api/search', authMiddleware, (req, res) => {
  const q = String(req.query.username || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = db.prepare(
    'SELECT id, username, avatar_url as avatarUrl FROM users WHERE username LIKE ? AND id != ? LIMIT 20'
  ).all(`%${q}%`, req.user.id);
  users.forEach((u) => {
    const chatId = findChatId(req.user.id, u.id);
    u.presence = getPresenceForViewer(u.id, chatId, req.user.id);
  });
  res.json({ users });
});

app.post('/api/chats/start', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(
    String(username || '').trim().toLowerCase()
  );
  if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Не можна писати самому собі' });
  const chat = getOrCreateChat(req.user.id, target.id);
  // Явне відкриття чату "повертає" його у список, навіть якщо раніше видалили "для мене"
  db.prepare('DELETE FROM chat_deletions WHERE chat_id = ? AND user_id = ?').run(chat.id, req.user.id);
  res.json({
    chat: {
      id: chat.id,
      withUser: {
        id: target.id,
        username: target.username,
        avatarUrl: target.avatar_url,
        presence: getPresenceForViewer(target.id, chat.id, req.user.id),
      },
    },
  });
});

// ---------- Групові чати ----------

function serializeGroup(chatId, viewerId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar_url as avatarUrl, cm.role
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
    ORDER BY cm.joined_at ASC
  `).all(chatId);
  members.forEach((m) => {
    // Активність — та сама механіка присутності, що й для особистих чатів
    // ("у мережі" завжди, якщо учасник саме зараз дивиться цю групу, попри приватність)
    m.presence = getPresenceForViewer(m.id, chatId, viewerId);
    m.isOwner = m.id === chat.creator_id;
  });
  return {
    id: chat.id,
    isGroup: true,
    groupName: chat.name,
    groupAvatarUrl: chat.avatar_url,
    creatorId: chat.creator_id,
    memberCount: members.length,
    members,
  };
}

function broadcastGroupUpdated(chatId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return;
  const group = serializeGroup(chatId);
  getParticipantIds(chat, null).forEach((uid) => {
    io.to(`user:${uid}`).emit('group:updated', group);
  });
}

app.post('/api/groups', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: "Вкажіть назву групи" });
  if (cleanName.length > 60) return res.status(400).json({ error: 'Назва занадто довга (максимум 60 символів)' });

  const info = db.prepare(
    'INSERT INTO chats (is_group, name, creator_id) VALUES (1, ?, ?)'
  ).run(cleanName, req.user.id);
  const chatId = info.lastInsertRowid;
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)').run(chatId, req.user.id, 'admin');

  res.json({ group: serializeGroup(chatId) });
});

app.post('/api/groups/:chatId/avatar', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Групу не знайдено' });
  if (!isGroupAdmin(chatId, req.user.id)) return res.status(403).json({ error: 'Лише адміністратор може змінити аватарку групи' });

  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не передано' });

    const old = chat.avatar_url;
    const avatarUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE chats SET avatar_url = ? WHERE id = ?').run(avatarUrl, chatId);
    if (old) {
      fs.unlink(path.join(UPLOAD_DIR, path.basename(old)), () => {});
    }
    broadcastGroupUpdated(chatId);
    res.json({ avatarUrl });
  });
});

app.post('/api/groups/:chatId/rename', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Групу не знайдено' });
  if (!isGroupAdmin(chatId, req.user.id)) return res.status(403).json({ error: 'Лише адміністратор може змінити назву групи' });

  const cleanName = String((req.body || {}).name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'Вкажіть назву групи' });
  if (cleanName.length > 60) return res.status(400).json({ error: 'Назва занадто довга (максимум 60 символів)' });

  db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(cleanName, chatId);
  broadcastGroupUpdated(chatId);
  res.json({ ok: true, name: cleanName });
});

app.post('/api/groups/:chatId/invite', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Групу не знайдено' });
  if (!isParticipant(chat, req.user.id)) return res.status(403).json({ error: 'Немає доступу до цієї групи' });

  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });

  const already = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, target.id);
  if (already) return res.status(409).json({ error: 'Користувач вже у групі' });

  db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)').run(chatId, target.id, 'member');
  db.prepare('DELETE FROM chat_deletions WHERE chat_id = ? AND user_id = ?').run(chatId, target.id);

  broadcastGroupUpdated(chatId);
  res.json({ ok: true, group: serializeGroup(chatId) });
});

app.get('/api/groups/:chatId', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Групу не знайдено' });
  if (!isParticipant(chat, req.user.id)) return res.status(403).json({ error: 'Немає доступу до цієї групи' });
  res.json({ group: serializeGroup(chatId) });
});

app.get('/api/messages/:messageId/reads', authMiddleware, (req, res) => {
  const messageId = Number(req.params.messageId);
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) return res.status(404).json({ error: 'Повідомлення не знайдено' });
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(message.chat_id);
  if (!chat || !isParticipant(chat, req.user.id)) {
    return res.status(403).json({ error: 'Немає доступу до цього чату' });
  }
  const reads = db.prepare(`
    SELECT u.id, u.username, u.avatar_url as avatarUrl, mr.read_at as readAt
    FROM message_reads mr JOIN users u ON u.id = mr.user_id
    WHERE mr.message_id = ?
    ORDER BY mr.read_at ASC
  `).all(messageId);
  res.json({ reads });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  const directChats = db.prepare(`
    SELECT c.id as chatId,
           CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END as otherId
    FROM chats c
    LEFT JOIN chat_deletions cd ON cd.chat_id = c.id AND cd.user_id = ?
    WHERE c.is_group = 0
      AND (c.user1_id = ? OR c.user2_id = ?)
      AND (
        cd.id IS NULL
        OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.id > cd.last_message_id)
      )
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);

  const directResult = directChats.map(row => {
    const other = db.prepare('SELECT id, username, avatar_url as avatarUrl FROM users WHERE id = ?').get(row.otherId);
    if (other) other.presence = getPresenceForViewer(other.id, row.chatId, req.user.id);
    const lastMsg = db.prepare(`
      SELECT text, image_url, audio_url, video_url, sender_id, created_at
      FROM messages
      WHERE chat_id = ?
        AND id NOT IN (SELECT message_id FROM message_deletions WHERE user_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(row.chatId, req.user.id);
    return {
      chatId: row.chatId,
      isGroup: false,
      withUser: other,
      lastMessage: lastMsg || null
    };
  });

  const groupChats = db.prepare(`
    SELECT c.id as chatId, c.name, c.avatar_url as avatarUrl
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
    LEFT JOIN chat_deletions cd ON cd.chat_id = c.id AND cd.user_id = ?
    WHERE c.is_group = 1
      AND (
        cd.id IS NULL
        OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.id > cd.last_message_id)
      )
  `).all(req.user.id, req.user.id);

  const groupResult = groupChats.map(row => {
    const lastMsg = db.prepare(`
      SELECT text, image_url, audio_url, video_url, sender_id, created_at
      FROM messages
      WHERE chat_id = ?
        AND id NOT IN (SELECT message_id FROM message_deletions WHERE user_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(row.chatId, req.user.id);
    return {
      chatId: row.chatId,
      isGroup: true,
      groupName: row.name,
      groupAvatarUrl: row.avatarUrl,
      memberCount: getMemberCount(row.chatId),
      lastMessage: lastMsg || null
    };
  });

  const result = [...directResult, ...groupResult].sort((a, b) => {
    const at = a.lastMessage ? a.lastMessage.created_at : '';
    const bt = b.lastMessage ? b.lastMessage.created_at : '';
    return bt.localeCompare(at);
  });

  res.json({ chats: result });
});

app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !isParticipant(chat, req.user.id)) {
    return res.status(403).json({ error: 'Немає доступу до цього чату' });
  }
  const clearedAt = db.prepare(
    'SELECT last_message_id as lastMessageId FROM chat_deletions WHERE chat_id = ? AND user_id = ?'
  ).get(chatId, req.user.id);
  const cutoffId = clearedAt ? clearedAt.lastMessageId : 0;

  const messages = db.prepare(`
    SELECT m.id, m.sender_id as senderId, u.username as senderUsername, u.avatar_url as senderAvatarUrl,
           m.text, m.image_url as imageUrl, m.audio_url as audioUrl,
           m.video_url as videoUrl, m.read_at as readAt, m.edited_at as editedAt, m.event_type as eventType, m.created_at as createdAt
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
      AND m.id > ?
      AND m.id NOT IN (SELECT message_id FROM message_deletions WHERE user_id = ?)
    ORDER BY m.id ASC
  `).all(chatId, cutoffId, req.user.id);

  const reactionRows = db.prepare(`
    SELECT r.message_id as messageId, r.emoji, r.user_id as userId, u.username
    FROM reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id IN (SELECT id FROM messages WHERE chat_id = ?)
  `).all(chatId);
  const reactionsByMessage = {};
  reactionRows.forEach((r) => {
    if (!reactionsByMessage[r.messageId]) reactionsByMessage[r.messageId] = [];
    reactionsByMessage[r.messageId].push({ emoji: r.emoji, userId: r.userId, username: r.username });
  });
  messages.forEach((m) => {
    m.reactions = groupReactions(reactionsByMessage[m.id] || []);
  });

  res.json({ messages });
});

// ---------- Socket.io (реальний час) ----------

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Немає токена'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Недійсний токен'));
  }
});

io.on('connection', (socket) => {
  const room = `user:${socket.user.id}`;
  socket.join(room);

  socket.on('presence:update', (payload) => {
    const uid = socket.user.id;
    let set = visibleSocketsByUser.get(uid);
    if (!set) {
      set = new Set();
      visibleSocketsByUser.set(uid, set);
    }
    const wasOnline = set.size > 0;
    if (payload && payload.visible) {
      set.add(socket.id);
    } else {
      set.delete(socket.id);
    }
    const nowOnline = set.size > 0;
    if (wasOnline !== nowOnline) {
      if (!nowOnline) {
        db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
      }
      broadcastPresenceToPartners(uid);
    }
  });

  socket.on('typing:update', (payload) => {
    // Ефемерний сигнал "друкує…" / "надсилає фото…" — нічого не зберігаємо в базі,
    // просто транслюємо іншим учасникам чату наживо
    try {
      const { chatId, action } = payload || {};
      if (!chatId) return;
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) return;
      const out = { chatId, userId: socket.user.id, username: socket.user.username, action: action || null };
      getParticipantIds(chat, socket.user.id).forEach((uid) => {
        io.to(`user:${uid}`).emit('typing:update', out);
      });
    } catch (err) {
      console.error(err);
    }
  });

  // ---------- Дзвінки (голосові, лише в особистих чатах) ----------

  socket.on('call:offer', (payload, ack) => {
    try {
      const { chatId, offer } = payload || {};
      if (!chatId || !offer) {
        if (ack) ack({ error: 'Некоректні дані дзвінка' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.is_group || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Дзвінки доступні лише в особистих чатах' });
        return;
      }
      const calleeId = otherUserId(chat, socket.user.id);

      if (userActiveCallId.has(socket.user.id)) {
        if (ack) ack({ error: 'У вас уже є активний дзвінок' });
        return;
      }
      if (userActiveCallId.has(calleeId)) {
        if (ack) ack({ error: 'Співрозмовник зараз на іншому дзвінку' });
        return;
      }

      const callId = `${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeCalls.set(callId, { chatId, callerId: socket.user.id, calleeId, status: 'ringing' });
      userActiveCallId.set(socket.user.id, callId);
      userActiveCallId.set(calleeId, callId);

      io.to(`user:${calleeId}`).emit('call:incoming', {
        callId,
        chatId,
        offer,
        fromUserId: socket.user.id,
        fromUsername: socket.user.username,
      });

      if (ack) ack({ ok: true, callId });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('call:answer', (payload) => {
    try {
      const { callId, answer } = payload || {};
      const call = activeCalls.get(callId);
      if (!call || call.calleeId !== socket.user.id) return;
      call.status = 'active';
      call.startedAt = Date.now();
      io.to(`user:${call.callerId}`).emit('call:answer', { callId, answer, fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('call:ice-candidate', (payload) => {
    try {
      const { callId, candidate } = payload || {};
      const call = activeCalls.get(callId);
      if (!call) return;
      if (call.callerId !== socket.user.id && call.calleeId !== socket.user.id) return;
      const targetId = call.callerId === socket.user.id ? call.calleeId : call.callerId;
      io.to(`user:${targetId}`).emit('call:ice-candidate', { callId, candidate, fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('call:decline', (payload) => {
    try {
      const { callId } = payload || {};
      const call = activeCalls.get(callId);
      if (!call) return;
      if (call.callerId !== socket.user.id && call.calleeId !== socket.user.id) return;
      const otherId = call.callerId === socket.user.id ? call.calleeId : call.callerId;
      io.to(`user:${otherId}`).emit('call:declined', { callId, fromUserId: socket.user.id });
      insertSystemMessage(call.chatId, socket.user.id, 'Дзвінок відхилено', 'call_declined');
      cleanupCall(callId);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('call:end', (payload) => {
    try {
      const { callId } = payload || {};
      const call = activeCalls.get(callId);
      if (!call) return;
      if (call.callerId !== socket.user.id && call.calleeId !== socket.user.id) return;
      const otherId = call.callerId === socket.user.id ? call.calleeId : call.callerId;
      io.to(`user:${otherId}`).emit('call:ended', { callId, fromUserId: socket.user.id });
      if (call.status === 'active' && call.startedAt) {
        insertSystemMessage(call.chatId, socket.user.id, `Дзвінок тривав ${formatDurationText(Date.now() - call.startedAt)}`, 'call_ended');
      } else {
        insertSystemMessage(call.chatId, socket.user.id, 'Пропущений дзвінок', 'call_missed');
      }
      cleanupCall(callId);
    } catch (err) {
      console.error(err);
    }
  });

  // Пересогласування (renegotiation) поверх уже встановленого дзвінка — потрібне,
  // коли додається/забирається трек демонстрації екрана посеред розмови. На відміну
  // від call:offer, тут НЕ створюється новий callId і немає перевірки "зайнято" —
  // це просто relay для вже існуючого дзвінка.
  socket.on('call:renegotiate-offer', (payload) => {
    try {
      const { callId, offer } = payload || {};
      const call = activeCalls.get(callId);
      if (!call || !offer) return;
      if (call.callerId !== socket.user.id && call.calleeId !== socket.user.id) return;
      const targetId = call.callerId === socket.user.id ? call.calleeId : call.callerId;
      io.to(`user:${targetId}`).emit('call:renegotiate-offer', { callId, offer, fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('call:renegotiate-answer', (payload) => {
    try {
      const { callId, answer } = payload || {};
      const call = activeCalls.get(callId);
      if (!call || !answer) return;
      if (call.callerId !== socket.user.id && call.calleeId !== socket.user.id) return;
      const targetId = call.callerId === socket.user.id ? call.calleeId : call.callerId;
      io.to(`user:${targetId}`).emit('call:renegotiate-answer', { callId, answer, fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  // ---------- Спільний перегляд відео (лише в особистих чатах) ----------
  // Це чистий relay без збереження стану на сервері — так само, як typing:update.

  function watchDirectPartner(chatId, myId) {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat || chat.is_group || !isParticipant(chat, myId)) return null;
    return otherUserId(chat, myId);
  }

  socket.on('watch:invite', (payload) => {
    try {
      const { chatId, source } = payload || {};
      if (!chatId || !source) return;
      const otherId = watchDirectPartner(chatId, socket.user.id);
      if (!otherId) return;
      io.to(`user:${otherId}`).emit('watch:invite', {
        chatId,
        source,
        fromUserId: socket.user.id,
        fromUsername: socket.user.username,
      });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('watch:accept', (payload) => {
    try {
      const { chatId } = payload || {};
      if (!chatId) return;
      const otherId = watchDirectPartner(chatId, socket.user.id);
      if (!otherId) return;
      activeWatchSessions.set(chatId, { startedAt: Date.now() });
      io.to(`user:${otherId}`).emit('watch:accepted', { chatId, fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('watch:decline', (payload) => {
    try {
      const { chatId } = payload || {};
      if (!chatId) return;
      const otherId = watchDirectPartner(chatId, socket.user.id);
      if (!otherId) return;
      io.to(`user:${otherId}`).emit('watch:declined', { chatId, fromUserId: socket.user.id });
      insertSystemMessage(
        chatId,
        socket.user.id,
        `${socket.user.username}: запрошення подивитись відео разом відхилено`,
        'watch_declined'
      );
    } catch (err) {
      console.error(err);
    }
  });


  socket.on('watch:state', (payload) => {
    try {
      const { chatId, action, time } = payload || {};
      if (!chatId || !action) return;
      const otherId = watchDirectPartner(chatId, socket.user.id);
      if (!otherId) return;
      io.to(`user:${otherId}`).emit('watch:state', { chatId, action, time, ts: Date.now(), fromUserId: socket.user.id });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('watch:end', (payload) => {
    try {
      const { chatId } = payload || {};
      if (!chatId) return;
      const otherId = watchDirectPartner(chatId, socket.user.id);
      if (!otherId) return;
      io.to(`user:${otherId}`).emit('watch:end', { chatId, fromUserId: socket.user.id });
      const session = activeWatchSessions.get(chatId);
      if (session) {
        insertSystemMessage(
          chatId,
          socket.user.id,
          `Спільний перегляд тривав ${formatDurationText(Date.now() - session.startedAt)}`,
          'watch_ended'
        );
        activeWatchSessions.delete(chatId);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('chat:active', (payload) => {
    const uid = socket.user.id;
    const chatId = payload && payload.chatId ? Number(payload.chatId) : null;
    const prevChatId = socket.data.activeChatId || null;

    if (prevChatId && prevChatId !== chatId) {
      removeChatViewer(prevChatId, uid, socket.id);
    }
    if (chatId && chatId !== prevChatId) {
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (chat && (chat.user1_id === uid || chat.user2_id === uid)) {
        addChatViewer(chatId, uid, socket.id);
      }
    }
    socket.data.activeChatId = chatId;

    if (prevChatId !== chatId) {
      broadcastPresenceToPartners(uid);
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.user.id;

    // Якщо був активний дзвінок — повідомляємо іншу сторону, що зв'язок обірвався
    const callId = userActiveCallId.get(uid);
    if (callId) {
      const call = activeCalls.get(callId);
      if (call) {
        const otherId = call.callerId === uid ? call.calleeId : call.callerId;
        io.to(`user:${otherId}`).emit('call:ended', { callId, fromUserId: uid });
        if (call.status === 'active' && call.startedAt) {
          insertSystemMessage(call.chatId, uid, `Дзвінок тривав ${formatDurationText(Date.now() - call.startedAt)}`, 'call_ended');
        } else {
          insertSystemMessage(call.chatId, uid, 'Пропущений дзвінок', 'call_missed');
        }
        cleanupCall(callId);
      }
    }

    // Якщо тривав спільний перегляд — так само фіксуємо його тривалість і повідомляємо іншу сторону
    for (const [chatId, session] of activeWatchSessions.entries()) {
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (chat && isParticipant(chat, uid)) {
        const otherWatchId = otherUserId(chat, uid);
        io.to(`user:${otherWatchId}`).emit('watch:end', { chatId, fromUserId: uid });
        insertSystemMessage(chatId, uid, `Спільний перегляд тривав ${formatDurationText(Date.now() - session.startedAt)}`, 'watch_ended');
        activeWatchSessions.delete(chatId);
      }
    }

    if (socket.data.activeChatId) {
      removeChatViewer(socket.data.activeChatId, uid, socket.id);
    }

    const set = visibleSocketsByUser.get(uid);
    if (set) {
      const wasOnline = set.size > 0;
      set.delete(socket.id);
      const nowOnline = set.size > 0;
      if (wasOnline && !nowOnline) {
        db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
      }
    }

    broadcastPresenceToPartners(uid);
  });

  socket.on('message:send', (payload, ack) => {
    try {
      const { chatId, text, imageUrl, audioUrl, videoUrl } = payload || {};
      const cleanText = String(text || '').trim();
      const cleanImageUrl = imageUrl && imageUrl.startsWith('/uploads/') ? imageUrl : null;
      const cleanAudioUrl = audioUrl && audioUrl.startsWith('/uploads/') ? audioUrl : null;
      const cleanVideoUrl = videoUrl && videoUrl.startsWith('/uploads/') ? videoUrl : null;
      if (!chatId || (!cleanText && !cleanImageUrl && !cleanAudioUrl && !cleanVideoUrl)) {
        if (ack) ack({ error: 'Порожнє повідомлення' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const info = db.prepare(
        'INSERT INTO messages (chat_id, sender_id, text, image_url, audio_url, video_url) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(chatId, socket.user.id, cleanText, cleanImageUrl, cleanAudioUrl, cleanVideoUrl);
      const message = db.prepare(
        'SELECT id, chat_id as chatId, sender_id as senderId, text, image_url as imageUrl, audio_url as audioUrl, video_url as videoUrl, read_at as readAt, edited_at as editedAt, event_type as eventType, created_at as createdAt FROM messages WHERE id = ?'
      ).get(info.lastInsertRowid);

      const senderRow = db.prepare('SELECT id, username, avatar_url as avatarUrl FROM users WHERE id = ?').get(socket.user.id);
      const senderInfo = senderRow || { id: socket.user.id, username: socket.user.username };
      const enrichedMessage = { ...message, senderUsername: senderInfo.username, senderAvatarUrl: senderInfo.avatarUrl };

      if (chat.is_group) {
        // Групові чати: розсилаємо всім учасникам (включно з відправником — для синхронізації інших вкладок)
        getParticipantIds(chat, null).forEach((uid) => {
          io.to(`user:${uid}`).emit('message:new', { ...enrichedMessage, isGroup: true, from: senderInfo });
        });
      } else {
        const otherId = otherUserId(chat, socket.user.id);
        // Надсилаємо обом учасникам: відправнику (інша вкладка/пристрій) та отримувачу
        io.to(`user:${socket.user.id}`).emit('message:new', { ...enrichedMessage, withUser: { id: otherId } , from: senderInfo});
        io.to(`user:${otherId}`).emit('message:new', { ...enrichedMessage, withUser: senderInfo, from: senderInfo });
      }

      if (ack) ack({ ok: true, message: enrichedMessage });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('reaction:set', (payload, ack) => {
    try {
      const { messageId, emoji } = payload || {};
      const ALLOWED_REACTIONS = new Set(['❤️', '👍', '🔥']);
      if (!messageId || !ALLOWED_REACTIONS.has(emoji)) {
        if (ack) ack({ error: 'Недопустима реакція' });
        return;
      }
      const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!message) {
        if (ack) ack({ error: 'Повідомлення не знайдено' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(message.chat_id);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }

      const existing = db.prepare(
        'SELECT * FROM reactions WHERE message_id = ? AND user_id = ?'
      ).get(messageId, socket.user.id);

      if (existing && existing.emoji === emoji) {
        // Той самий емодзі — знімаємо реакцію
        db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
      } else {
        db.prepare(`
          INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji
        `).run(messageId, socket.user.id, emoji);
      }

      const rows = db.prepare(`
        SELECT r.emoji, r.user_id as userId, u.username
        FROM reactions r JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ?
      `).all(messageId);
      const reactions = groupReactions(rows);

      const out = { chatId: chat.id, messageId, reactions };
      getParticipantIds(chat, null).forEach((uid) => {
        io.to(`user:${uid}`).emit('reaction:updated', out);
      });

      if (ack) ack({ ok: true, reactions });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('messages:read', (payload, ack) => {
    try {
      const { chatId } = payload || {};
      if (!chatId) {
        if (ack) ack({ error: 'Не вказано чат' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      // Усі повідомлення не від мене, які я особисто ще не позначав прочитаними
      // (важливо для груп: кожен читач фіксується окремо, а не лише перший)
      const toMark = db.prepare(`
        SELECT id FROM messages
        WHERE chat_id = ? AND sender_id != ?
          AND id NOT IN (SELECT message_id FROM message_reads WHERE user_id = ?)
      `).all(chatId, socket.user.id, socket.user.id);

      if (toMark.length) {
        const ids = toMark.map((m) => m.id);
        const insertRead = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
        ids.forEach((id) => insertRead.run(id, socket.user.id));

        const placeholders = ids.map(() => '?').join(',');
        // read_at на самому повідомленні виставляється лише один раз (першим читачем) —
        // це те, що керує однією/двома галочками; хто саме прочитав — тепер у message_reads
        db.prepare(`UPDATE messages SET read_at = COALESCE(read_at, datetime('now')) WHERE id IN (${placeholders})`).run(...ids);
        const readAt = db.prepare('SELECT read_at FROM messages WHERE id = ?').get(ids[0]).read_at;

        const out = { chatId, messageIds: ids, readAt, readerId: socket.user.id };
        getParticipantIds(chat, socket.user.id).forEach((uid) => {
          io.to(`user:${uid}`).emit('messages:read', out);
        });
      }

      if (ack) ack({ ok: true, count: toMark.length });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('message:edit', (payload, ack) => {
    try {
      const { messageId, text } = payload || {};
      const cleanText = String(text || '').trim();
      if (!messageId || !cleanText) {
        if (ack) ack({ error: 'Текст не може бути порожнім' });
        return;
      }
      const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!message) {
        if (ack) ack({ error: 'Повідомлення не знайдено' });
        return;
      }
      if (message.sender_id !== socket.user.id) {
        if (ack) ack({ error: 'Можна редагувати лише власні повідомлення' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(message.chat_id);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }

      db.prepare("UPDATE messages SET text = ?, edited_at = datetime('now') WHERE id = ?").run(cleanText, messageId);
      const editedAt = db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(messageId).edited_at;

      const out = { chatId: chat.id, messageId, text: cleanText, editedAt };
      getParticipantIds(chat, null).forEach((uid) => {
        io.to(`user:${uid}`).emit('message:edited', out);
      });

      if (ack) ack({ ok: true, text: cleanText, editedAt });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('message:delete', (payload, ack) => {
    try {
      const { chatId, messageIds, scope } = payload || {};
      const ids = Array.isArray(messageIds) ? messageIds.filter((id) => Number.isInteger(id)) : [];
      if (!chatId || !ids.length) {
        if (ack) ack({ error: 'Немає що видаляти' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const placeholders = ids.map(() => '?').join(',');

      if (scope === 'everyone') {
        // Видалити для всіх можна лише власні повідомлення — вони видаляються з бази остаточно
        const ownMessages = db.prepare(
          `SELECT id FROM messages WHERE chat_id = ? AND sender_id = ? AND id IN (${placeholders})`
        ).all(chatId, socket.user.id, ...ids);
        const deletableIds = ownMessages.map((m) => m.id);
        if (!deletableIds.length) {
          if (ack) ack({ error: 'Можна видаляти для всіх лише власні повідомлення' });
          return;
        }
        const delPlaceholders = deletableIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM message_deletions WHERE message_id IN (${delPlaceholders})`).run(...deletableIds);
        db.prepare(`DELETE FROM message_reads WHERE message_id IN (${delPlaceholders})`).run(...deletableIds);
        db.prepare(`DELETE FROM messages WHERE id IN (${delPlaceholders})`).run(...deletableIds);

        const payloadOut = { chatId, messageIds: deletableIds, scope: 'everyone' };
        getParticipantIds(chat, null).forEach((uid) => {
          io.to(`user:${uid}`).emit('message:deleted', payloadOut);
        });

        if (ack) ack({ ok: true, deletedIds: deletableIds, scope: 'everyone' });
        return;
      }

      // scope === 'me' (за замовчуванням) — ховаємо повідомлення лише для того, хто видаляє;
      // будь-хто (і власні, і чужі повідомлення в чаті) може видалити зі свого перегляду
      const ownedInChat = db.prepare(
        `SELECT id FROM messages WHERE chat_id = ? AND id IN (${placeholders})`
      ).all(chatId, ...ids);
      const visibleIds = ownedInChat.map((m) => m.id);
      if (!visibleIds.length) {
        if (ack) ack({ error: 'Повідомлення не знайдено' });
        return;
      }
      const insertDeletion = db.prepare(
        'INSERT OR IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)'
      );
      visibleIds.forEach((id) => insertDeletion.run(id, socket.user.id));

      // Синхронізуємо інші вкладки/пристрої того ж користувача; співрозмовника не чіпаємо
      io.to(`user:${socket.user.id}`).emit('message:deleted', { chatId, messageIds: visibleIds, scope: 'me' });

      if (ack) ack({ ok: true, deletedIds: visibleIds, scope: 'me' });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('chat:delete', (payload, ack) => {
    try {
      const { chatId, scope } = payload || {};
      if (!chatId) {
        if (ack) ack({ error: 'Не вказано чат' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      if (chat.is_group) {
        if (ack) ack({ error: 'Груповий чат можна лише покинути (вийти з групи)' });
        return;
      }

      if (scope === 'both') {
        const otherId = otherUserId(chat, socket.user.id);
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM message_deletions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chat_deletions WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);

        const payloadOut = { chatId, scope: 'both' };
        io.to(`user:${socket.user.id}`).emit('chat:deleted', payloadOut);
        io.to(`user:${otherId}`).emit('chat:deleted', payloadOut);

        if (ack) ack({ ok: true, scope: 'both' });
        return;
      }

      // scope === 'me' — ховаємо чат лише зі свого списку; якщо прийде нове повідомлення, чат з'явиться знову
      const maxMsg = db.prepare('SELECT COALESCE(MAX(id), 0) as maxId FROM messages WHERE chat_id = ?').get(chatId);
      db.prepare(`
        INSERT INTO chat_deletions (chat_id, user_id, deleted_at, last_message_id) VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET deleted_at = datetime('now'), last_message_id = excluded.last_message_id
      `).run(chatId, socket.user.id, maxMsg.maxId);

      io.to(`user:${socket.user.id}`).emit('chat:deleted', { chatId, scope: 'me' });
      if (ack) ack({ ok: true, scope: 'me' });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('group:leave', (payload, ack) => {
    try {
      const { chatId } = payload || {};
      if (!chatId) {
        if (ack) ack({ error: 'Не вказано групу' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
      if (!chat || !isParticipant(chat, socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цієї групи' });
        return;
      }

      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, socket.user.id);
      const remaining = db.prepare('SELECT user_id, role FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC').all(chatId);

      if (!remaining.length) {
        // Останній учасник вийшов — групу можна видалити повністю
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM message_deletions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chat_deletions WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
      } else if (!remaining.some((m) => m.role === 'admin')) {
        // Адмін пішов — призначаємо адміном того, хто приєднався найраніше
        db.prepare("UPDATE chat_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?").run(chatId, remaining[0].user_id);
      }

      io.to(`user:${socket.user.id}`).emit('chat:deleted', { chatId, scope: 'me' });
      remaining.forEach((m) => {
        io.to(`user:${m.user_id}`).emit('group:updated', serializeGroup(chatId));
      });

      if (ack) ack({ ok: true });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('group:kick', (payload, ack) => {
    try {
      const { chatId, userId } = payload || {};
      if (!chatId || !userId) {
        if (ack) ack({ error: 'Не вказано групу або учасника' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND is_group = 1').get(chatId);
      if (!chat) {
        if (ack) ack({ error: 'Групу не знайдено' });
        return;
      }
      if (!isGroupAdmin(chatId, socket.user.id)) {
        if (ack) ack({ error: 'Лише адміністратор може видаляти учасників' });
        return;
      }
      if (userId === chat.creator_id) {
        if (ack) ack({ error: 'Не можна видалити власника групи' });
        return;
      }
      if (userId === socket.user.id) {
        if (ack) ack({ error: 'Щоб покинути групу, скористайтесь "Покинути групу"' });
        return;
      }
      const target = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
      if (!target) {
        if (ack) ack({ error: 'Цього учасника вже немає в групі' });
        return;
      }

      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);

      // Видаленого повідомляємо окремо — для нього це виглядає як "чат видалено зі списку"
      io.to(`user:${userId}`).emit('chat:deleted', { chatId, scope: 'kicked' });

      const group = serializeGroup(chatId);
      getParticipantIds(chat, null).forEach((uid) => {
        if (uid === userId) return; // його вже видалено з учасників
        io.to(`user:${uid}`).emit('group:updated', group);
      });

      if (ack) ack({ ok: true });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
