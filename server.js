require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const user = { id: info.lastInsertRowid, username: cleanUsername };
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
  res.json({ token: createToken(user), user: { id: user.id, username: user.username } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/search', authMiddleware, (req, res) => {
  const q = String(req.query.username || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = db.prepare(
    'SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 20'
  ).all(`%${q}%`, req.user.id);
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
  res.json({ chat: { id: chat.id, withUser: { id: target.id, username: target.username } } });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id as chatId,
           CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END as otherId
    FROM chats c
    WHERE c.user1_id = ? OR c.user2_id = ?
  `).all(req.user.id, req.user.id, req.user.id);

  const result = chats.map(row => {
    const other = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.otherId);
    const lastMsg = db.prepare(
      'SELECT text, sender_id, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
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
    'SELECT id, sender_id as senderId, text, created_at as createdAt FROM messages WHERE chat_id = ? ORDER BY id ASC'
  ).all(chatId);
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

  socket.on('message:send', (payload, ack) => {
    try {
      const { chatId, text } = payload || {};
      const cleanText = String(text || '').trim();
      if (!chatId || !cleanText) {
        if (ack) ack({ error: 'Порожнє повідомлення' });
        return;
      }
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || (chat.user1_id !== socket.user.id && chat.user2_id !== socket.user.id)) {
        if (ack) ack({ error: 'Немає доступу до цього чату' });
        return;
      }
      const info = db.prepare(
        'INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)'
      ).run(chatId, socket.user.id, cleanText);
      const message = db.prepare(
        'SELECT id, chat_id as chatId, sender_id as senderId, text, created_at as createdAt FROM messages WHERE id = ?'
      ).get(info.lastInsertRowid);

      const otherId = otherUserId(chat, socket.user.id);
      const senderInfo = { id: socket.user.id, username: socket.user.username };

      // Надсилаємо обом учасникам: відправнику (інша вкладка/пристрій) та отримувачу
      io.to(`user:${socket.user.id}`).emit('message:new', { ...message, withUser: { id: otherId } , from: senderInfo});
      io.to(`user:${otherId}`).emit('message:new', { ...message, withUser: senderInfo, from: senderInfo });

      if (ack) ack({ ok: true, message });
    } catch (err) {
      console.error(err);
      if (ack) ack({ error: 'Помилка сервера' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
