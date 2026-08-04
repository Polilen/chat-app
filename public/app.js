(function () {
  const state = {
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    activeChatId: null,
    activeChatWith: null,
    chats: [],
    socket: null,
  };

  const el = (id) => document.getElementById(id);

  // ---------- API helper ----------

  async function api(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Помилка запиту');
    return data;
  }

  // ---------- Auth screen ----------

  const authScreen = el('authScreen');
  const appScreen = el('appScreen');
  const authError = el('authError');

  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      el('loginForm').classList.toggle('hidden', !isLogin);
      el('registerForm').classList.toggle('hidden', isLogin);
      authError.classList.add('hidden');
    });
  });

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.remove('hidden');
  }

  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: el('loginUsername').value,
          password: el('loginPassword').value,
        }),
      });
      onAuthSuccess(data);
    } catch (err) {
      showAuthError(err.message);
    }
  });

  el('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          username: el('registerUsername').value,
          password: el('registerPassword').value,
        }),
      });
      onAuthSuccess(data);
    } catch (err) {
      showAuthError(err.message);
    }
  });

  function onAuthSuccess(data) {
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('token', state.token);
    localStorage.setItem('user', JSON.stringify(state.user));
    startApp();
  }

  el('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (state.socket) state.socket.disconnect();
    location.reload();
  });

  // ---------- App screen ----------

  function startApp() {
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    el('meUsername').textContent = state.user.username;
    connectSocket();
    loadChats();
  }

  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('message:new', (msg) => {
      // Оновлюємо список чатів (щоб з'явився новий/піднявся вгору)
      loadChats();
      // Якщо це відкритий зараз чат — одразу малюємо повідомлення
      if (state.activeChatId === msg.chatId) {
        appendMessage(msg);
        scrollMessagesToBottom();
      }
    });
    state.socket.on('connect_error', (err) => {
      console.error('Помилка сокета:', err.message);
    });
  }

  // ---------- Chat list ----------

  async function loadChats() {
    try {
      const { chats } = await api('/api/chats');
      state.chats = chats;
      renderChatList();
    } catch (err) {
      console.error(err);
    }
  }

  function renderChatList() {
    const list = el('chatList');
    list.innerHTML = '';
    state.chats.forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'chat-list-item' + (chat.chatId === state.activeChatId ? ' active' : '');
      const preview = chat.lastMessage
        ? (chat.lastMessage.sender_id === state.user.id ? 'Ви: ' : '') + chat.lastMessage.text
        : 'Немає повідомлень';
      item.innerHTML = `
        <span class="chat-list-username">${escapeHtml(chat.withUser.username)}</span>
        <span class="chat-list-preview">${escapeHtml(preview)}</span>
      `;
      item.addEventListener('click', () => openChat(chat.chatId, chat.withUser));
      list.appendChild(item);
    });
  }

  // ---------- Search ----------

  const searchInput = el('searchInput');
  const searchResults = el('searchResults');
  let searchTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const { users } = await api('/api/search?username=' + encodeURIComponent(q));
        renderSearchResults(users);
      } catch (err) {
        console.error(err);
      }
    }, 250);
  });

  function renderSearchResults(users) {
    if (!users.length) {
      searchResults.innerHTML = '<div class="search-result-item" style="cursor:default;color:var(--text-dim)">Нікого не знайдено</div>';
      searchResults.classList.remove('hidden');
      return;
    }
    searchResults.innerHTML = '';
    users.forEach((u) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.textContent = u.username;
      item.addEventListener('click', async () => {
        try {
          const { chat } = await api('/api/chats/start', {
            method: 'POST',
            body: JSON.stringify({ username: u.username }),
          });
          searchInput.value = '';
          searchResults.classList.add('hidden');
          await loadChats();
          openChat(chat.id, chat.withUser);
        } catch (err) {
          console.error(err);
        }
      });
      searchResults.appendChild(item);
    });
    searchResults.classList.remove('hidden');
  }

  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) {
      searchResults.classList.add('hidden');
    }
  });

  // ---------- Active chat ----------

  const emptyState = el('emptyState');
  const activeChatEl = el('activeChat');
  const messagesEl = el('messages');

  async function openChat(chatId, withUser) {
    state.activeChatId = chatId;
    state.activeChatWith = withUser;
    emptyState.classList.add('hidden');
    activeChatEl.classList.remove('hidden');
    el('chatWithUsername').textContent = withUser.username;
    renderChatList();

    try {
      const { messages } = await api(`/api/chats/${chatId}/messages`);
      messagesEl.innerHTML = '';
      messages.forEach((m) => appendMessage({
        chatId,
        senderId: m.senderId,
        text: m.text,
        createdAt: m.createdAt,
      }));
      scrollMessagesToBottom();
    } catch (err) {
      console.error(err);
    }
  }

  function appendMessage(msg) {
    if (msg.chatId !== state.activeChatId) return;
    const mine = msg.senderId === state.user.id || msg.sender_id === state.user.id;
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'mine' : 'theirs');
    const time = formatTime(msg.createdAt || msg.created_at);
    div.innerHTML = `${escapeHtml(msg.text)}<span class="msg-time">${time}</span>`;
    messagesEl.appendChild(div);
  }

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  el('messageForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('messageInput');
    const text = input.value.trim();
    if (!text || !state.activeChatId) return;
    state.socket.emit('message:send', { chatId: state.activeChatId, text }, (ack) => {
      if (ack && ack.error) console.error(ack.error);
    });
    input.value = '';
  });

  // ---------- Utils ----------

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Init ----------

  if (state.token && state.user) {
    startApp();
  }
})();
