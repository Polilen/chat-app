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

function groupReactions(rows) {
  const byEmoji = {};
  rows.forEach((r) => {
    if (!byEmoji[r.emoji]) byEmoji[r.emoji] = [];
    byEmoji[r.emoji].push(r.userId);
  });
  return Object.entries(byEmoji).map(([emoji, userIds]) => ({ emoji, userIds }));
}

// ---------- Присутність (онлайн / був(ла) нещодавно) ----------
// userId -> Set(socketId), лише сокети з реально видимою (не згорнутою/неактивною) вкладкою
const visibleSocketsByUser = new Map();

function isUserOnline(userId) {
  const set = visibleSocketsByUser.get(userId);
  return !!set && set.size > 0;
}

function getPresence(userId) {
  const row = db.prepare('SELECT last_seen_at as lastSeenAt, show_last_seen as showLastSeen FROM users WHERE id = ?').get(userId);
  if (!row) return { online: false, lastSeenAt: null, hidden: false };
  if (!row.showLastSeen) return { online: false, lastSeenAt: null, hidden: true };
  return { online: isUserOnline(userId), lastSeenAt: row.lastSeenAt, hidden: false };
}

function notifyChatPartnersPresence(userId) {
  const presence = getPresence(userId);
  const partners = db.prepare(`
    SELECT DISTINCT CASE WHEN user1_id = ? THEN user2_id ELSE user1_id END as otherId
    FROM chats WHERE user1_id = ? OR user2_id = ?
  `).all(userId, userId, userId);
  partners.forEach((p) => {
    io.to(`user:${p.otherId}`).emit('presence:updated', { userId, ...presence });
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
  res.json({ user });
});

app.post('/api/me/privacy', authMiddleware, (req, res) => {
  const { showLastSeen } = req.body || {};
  db.prepare('UPDATE users SET show_last_seen = ? WHERE id = ?').run(showLastSeen ? 1 : 0, req.user.id);
  notifyChatPartnersPresence(req.user.id);
  res.json({ ok: true, showLastSeen: !!showLastSeen });
});

app.post('/api/me/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не передано' });

    const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    const avatarUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);

    if (old && old.avatar_url) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(old.avatar_url));
      fs.unlink(oldPath, () => {});
    }

    notifyChatPartnersAvatarChanged(req.user.id, avatarUrl);
    res.json({ avatarUrl });
  });
});

app.delete('/api/me/avatar', authMiddleware, (req, res) => {
  const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
  if (old && old.avatar_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.avatar_url));
    fs.unlink(oldPath, () => {});
  }
  notifyChatPartnersAvatarChanged(req.user.id, null);
  res.json({ ok: true });
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
  users.forEach((u) => { u.presence = getPresence(u.id); });
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
  res.json({
    chat: {
      id: chat.id,
      withUser: { id: target.id, username: target.username, avatarUrl: target.avatar_url, presence: getPresence(target.id) },
    },
  });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id as chatId,
           CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END as otherId
    FROM chats c
    WHERE c.user1_id = ? OR c.user2_id = ?
  `).all(req.user.id, req.user.id, req.user.id);

  const result = chats.map(row => {
    const other = db.prepare('SELECT id, username, avatar_url as avatarUrl FROM users WHERE id = ?').get(row.otherId);
    if (other) other.presence = getPresence(other.id);
    const lastMsg = db.prepare(
      'SELECT text, image_url, audio_url, video_url, sender_id, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
    ).get(row.chatId);
    return {
      chatId: row.chatId,
      withUser: other,
      lastMessage: lastMsg || null
    };
  }).sort((a, b) => {
    const at = a.lastMessage ? a.lastMessage.created_at : '';
    const bt = b.lastMessage ? b.lastMessage.created_at : '';
    return bt.localeCompare(at);
  });

  res.json({ chats: result });
});

app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || (chat.user1_id !== req.user.id && chat.user2_id !== req.user.id)) {
    return res.status(403).json({ error: 'Немає доступу до цього чату' });
  }
  const messages = db.prepare(
    'SELECT id, sender_id as senderId, text, image_url as imageUrl, audio_url as audioUrl, video_url as videoUrl, read_at as readAt, created_at as createdAt FROM messages WHERE chat_id = ? ORDER BY id ASC'
  ).all(chatId);

  const reactionRows = db.prepare(`
    SELECT message_id as messageId, emoji, user_id as userId
    FROM reactions
    WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)
  `).all(chatId);
  const reactionsByMessage = {};
  reactionRows.forEach((r) => {
    if (!reactionsByMessage[r.messageId]) reactionsByMessage[r.messageId] = [];
    reactionsByMessage[r.messageId].push({ emoji: r.emoji, userId: r.userId });
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
      notifyChatPartnersPresence(uid);
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.user.id;
    const set = visibleSocketsByUser.get(uid);
    if (!set) return;
    const wasOnline = set.size > 0;
    set.delete(socket.id);
    const nowOnline = set.size > 0;
    if (wasOnline && !nowOnline) {
      db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
      notifyChatPartnersPresence(uid);
    }
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
      if (!chat || (chat.user1_id !== socket.user.id && chat.user2_id !== socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const info = db.prepare(
        'INSERT INTO messages (chat_id, sender_id, text, image_url, audio_url, video_url) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(chatId, socket.user.id, cleanText, cleanImageUrl, cleanAudioUrl, cleanVideoUrl);
      const message = db.prepare(
        'SELECT id, chat_id as chatId, sender_id as senderId, text, image_url as imageUrl, audio_url as audioUrl, video_url as videoUrl, read_at as readAt, created_at as createdAt FROM messages WHERE id = ?'
      ).get(info.lastInsertRowid);

      const otherId = otherUserId(chat, socket.user.id);
      const senderRow = db.prepare('SELECT id, username, avatar_url as avatarUrl FROM users WHERE id = ?').get(socket.user.id);
      const senderInfo = senderRow || { id: socket.user.id, username: socket.user.username };

      // Надсилаємо обом учасникам: відправнику (інша вкладка/пристрій) та отримувачу
      io.to(`user:${socket.user.id}`).emit('message:new', { ...message, withUser: { id: otherId } , from: senderInfo});
      io.to(`user:${otherId}`).emit('message:new', { ...message, withUser: senderInfo, from: senderInfo });

      if (ack) ack({ ok: true, message });
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
      if (!chat || (chat.user1_id !== socket.user.id && chat.user2_id !== socket.user.id)) {
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

      const rows = db.prepare(
        'SELECT emoji, user_id as userId FROM reactions WHERE message_id = ?'
      ).all(messageId);
      const reactions = groupReactions(rows);

      const otherId = otherUserId(chat, socket.user.id);
      const out = { chatId: chat.id, messageId, reactions };
      io.to(`user:${socket.user.id}`).emit('reaction:updated', out);
      io.to(`user:${otherId}`).emit('reaction:updated', out);

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
      if (!chat || (chat.user1_id !== socket.user.id && chat.user2_id !== socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const unread = db.prepare(
        'SELECT id FROM messages WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL'
      ).all(chatId, socket.user.id);

      if (unread.length) {
        const ids = unread.map((m) => m.id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
        const readAt = db.prepare('SELECT read_at FROM messages WHERE id = ?').get(ids[0]).read_at;

        const otherId = otherUserId(chat, socket.user.id);
        io.to(`user:${otherId}`).emit('messages:read', { chatId, messageIds: ids, readAt });
      }

      if (ack) ack({ ok: true, count: unread.length });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });

  socket.on('message:delete', (payload, ack) => {
    try {
      const { chatId, messageIds } = payload || {};
      const ids = Array.isArray(messageIds) ? messageIds.filter((id) => Number.isInteger(id)) : [];
      if (!chatId || !ids.length) {
        if (ack) ack({ error: 'Немає що видаляти' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || (chat.user1_id !== socket.user.id && chat.user2_id !== socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const placeholders = ids.map(() => '?').join(',');
      // Видаляти можна лише власні повідомлення
      const ownMessages = db.prepare(
        `SELECT id FROM messages WHERE chat_id = ? AND sender_id = ? AND id IN (${placeholders})`
      ).all(chatId, socket.user.id, ...ids);
      const deletableIds = ownMessages.map((m) => m.id);
      if (!deletableIds.length) {
        if (ack) ack({ error: 'Можна видаляти лише власні повідомлення' });
        return;
      }
      const delPlaceholders = deletableIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE id IN (${delPlaceholders})`).run(...deletableIds);

      const otherId = otherUserId(chat, socket.user.id);
      const payloadOut = { chatId, messageIds: deletableIds };
      io.to(`user:${socket.user.id}`).emit('message:deleted', payloadOut);
      io.to(`user:${otherId}`).emit('message:deleted', payloadOut);

      if (ack) ack({ ok: true, deletedIds: deletableIds });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
