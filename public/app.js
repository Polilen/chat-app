(function () {
  const state = {
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    activeChatId: null,
    activeChatWith: null,
    chats: [],
    socket: null,
    selectionMode: false,
    selectedIds: new Set(),
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
    state.socket.on('message:deleted', ({ chatId, messageIds }) => {
      if (state.activeChatId === chatId) {
        messageIds.forEach((id) => {
          const node = messagesEl.querySelector(`[data-id="${id}"]`);
          if (node) node.remove();
          state.selectedIds.delete(id);
        });
        updateSelectionBar();
      }
      loadChats();
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
      let previewText = 'Немає повідомлень';
      if (chat.lastMessage) {
        const prefix = chat.lastMessage.sender_id === state.user.id ? 'Ви: ' : '';
        previewText = prefix + (chat.lastMessage.image_url ? '📷 Фото' : chat.lastMessage.text);
      }
      const preview = previewText;
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

  // ---------- Прикріплення картинки ----------

  const attachBtn = el('attachBtn');
  const imageInput = el('imageInput');
  const imagePreview = el('imagePreview');
  const imagePreviewImg = el('imagePreviewImg');
  const cancelImageBtn = el('cancelImageBtn');
  let pendingImageFile = null;

  attachBtn.addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert('Файл занадто великий (максимум 8 МБ)');
      imageInput.value = '';
      return;
    }
    pendingImageFile = file;
    imagePreviewImg.src = URL.createObjectURL(file);
    imagePreview.classList.remove('hidden');
  });

  cancelImageBtn.addEventListener('click', () => {
    pendingImageFile = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
  });

  async function uploadPendingImage() {
    if (!pendingImageFile) return null;
    const formData = new FormData();
    formData.append('image', pendingImageFile);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не вдалося завантажити фото');
    return data.url;
  }

  async function openChat(chatId, withUser) {
    state.activeChatId = chatId;
    state.activeChatWith = withUser;
    exitSelectMode();
    emptyState.classList.add('hidden');
    activeChatEl.classList.remove('hidden');
    el('chatWithUsername').textContent = withUser.username;
    renderChatList();

    try {
      const { messages } = await api(`/api/chats/${chatId}/messages`);
      messagesEl.innerHTML = '';
      messages.forEach((m) => appendMessage({
        id: m.id,
        chatId,
        senderId: m.senderId,
        text: m.text,
        imageUrl: m.imageUrl,
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
    const messageId = msg.id;
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'mine' : 'theirs');
    if (messageId != null) {
      div.dataset.id = messageId;
      div.dataset.senderId = msg.senderId ?? msg.sender_id ?? '';
    }
    const time = formatTime(msg.createdAt || msg.created_at);
    const imageUrl = msg.imageUrl || msg.image_url;
    const text = msg.text || '';

    let inner = '<div class="msg-checkbox"></div>';
    if (imageUrl) {
      inner += `<img class="msg-image" src="${escapeAttr(imageUrl)}" alt="Фото">`;
    }
    if (text) {
      inner += `<span class="msg-text">${escapeHtml(text)}</span>`;
    }
    inner += `<span class="msg-time">${time}</span>`;
    inner += '<div class="msg-actions"></div>';

    div.innerHTML = inner;

    if (imageUrl) {
      div.querySelector('.msg-image').addEventListener('click', (e) => {
        if (state.selectionMode) return;
        e.stopPropagation();
        openImageModal(imageUrl);
      });
    }

    const actions = div.querySelector('.msg-actions');
    const forwardIcon = document.createElement('button');
    forwardIcon.type = 'button';
    forwardIcon.className = 'msg-action-icon';
    forwardIcon.title = 'Переслати';
    forwardIcon.textContent = '↪';
    forwardIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      openForwardModal([{ text, imageUrl: imageUrl || null }]);
    });
    actions.appendChild(forwardIcon);

    if (mine && messageId != null) {
      const deleteIcon = document.createElement('button');
      deleteIcon.type = 'button';
      deleteIcon.className = 'msg-action-icon danger';
      deleteIcon.title = 'Видалити';
      deleteIcon.textContent = '🗑';
      deleteIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteMessages([messageId]);
      });
      actions.appendChild(deleteIcon);
    }

    div.addEventListener('click', () => {
      if (!state.selectionMode || messageId == null) return;
      toggleMessageSelect(messageId, div);
    });

    messagesEl.appendChild(div);
  }

  // ---------- Виділення повідомлень ----------

  const selectModeBtn = el('selectModeBtn');
  const selectionBar = el('selectionBar');
  const selectionCount = el('selectionCount');
  const selectionForwardBtn = el('selectionForwardBtn');
  const selectionDeleteBtn = el('selectionDeleteBtn');
  const selectionCancelBtn = el('selectionCancelBtn');

  function enterSelectMode() {
    state.selectionMode = true;
    state.selectedIds.clear();
    messagesEl.classList.add('selecting');
    selectModeBtn.classList.add('active');
    selectionBar.classList.remove('hidden');
    updateSelectionBar();
  }

  function exitSelectMode() {
    state.selectionMode = false;
    state.selectedIds.clear();
    messagesEl.classList.remove('selecting');
    selectModeBtn.classList.remove('active');
    selectionBar.classList.add('hidden');
    messagesEl.querySelectorAll('.msg.selected').forEach((n) => n.classList.remove('selected'));
  }

  function toggleMessageSelect(id, node) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      node.classList.remove('selected');
    } else {
      state.selectedIds.add(id);
      node.classList.add('selected');
    }
    updateSelectionBar();
  }

  function updateSelectionBar() {
    const count = state.selectedIds.size;
    selectionCount.textContent = `${count} обрано`;
    const allMine = count > 0 && [...state.selectedIds].every((id) => {
      const node = messagesEl.querySelector(`[data-id="${id}"]`);
      return node && String(node.dataset.senderId) === String(state.user.id);
    });
    selectionDeleteBtn.disabled = !allMine;
    selectionForwardBtn.disabled = count === 0;
  }

  selectModeBtn.addEventListener('click', () => {
    if (state.selectionMode) exitSelectMode();
    else enterSelectMode();
  });

  selectionCancelBtn.addEventListener('click', exitSelectMode);

  selectionForwardBtn.addEventListener('click', () => {
    if (!state.selectedIds.size) return;
    const items = [...state.selectedIds]
      .map((id) => messagesEl.querySelector(`[data-id="${id}"]`))
      .filter(Boolean)
      .sort((a, b) => Number(a.dataset.id) - Number(b.dataset.id))
      .map((node) => ({
        text: node.querySelector('.msg-text')?.textContent || '',
        imageUrl: node.querySelector('.msg-image')?.getAttribute('src') || null,
      }));
    openForwardModal(items);
  });

  selectionDeleteBtn.addEventListener('click', () => {
    if (!state.selectedIds.size || selectionDeleteBtn.disabled) return;
    if (!confirm(`Видалити ${state.selectedIds.size} повідомлень?`)) return;
    deleteMessages([...state.selectedIds]);
    exitSelectMode();
  });

  function deleteMessages(ids) {
    if (!state.activeChatId || !ids.length) return;
    state.socket.emit('message:delete', { chatId: state.activeChatId, messageIds: ids }, (ack) => {
      if (ack && ack.error) {
        alert(ack.error);
        return;
      }
      (ack.deletedIds || ids).forEach((id) => {
        const node = messagesEl.querySelector(`[data-id="${id}"]`);
        if (node) node.remove();
      });
      loadChats();
    });
  }

  // ---------- Модалка перегляду фото ---------- 

  const imageModal = el('imageModal');
  const imageModalImg = el('imageModalImg');
  const imageModalDownload = el('imageModalDownload');
  const imageModalForward = el('imageModalForward');
  let previewImageUrl = null;

  function openImageModal(url) {
    previewImageUrl = url;
    imageModalImg.src = url;
    const filename = url.split('/').pop();
    imageModalDownload.href = url;
    imageModalDownload.setAttribute('download', filename);
    imageModal.classList.remove('hidden');
  }

  function closeImageModal() {
    imageModal.classList.add('hidden');
    imageModalImg.src = '';
  }

  imageModalForward.addEventListener('click', () => openForwardModal([{ text: '', imageUrl: previewImageUrl }]));

  // ---------- Модалка пересилання ----------

  const forwardModal = el('forwardModal');
  const forwardChatList = el('forwardChatList');
  const forwardStatus = el('forwardStatus');
  let pendingForwardItems = [];

  function openForwardModal(items) {
    pendingForwardItems = items.filter((it) => it.text || it.imageUrl);
    if (!pendingForwardItems.length) return;
    forwardStatus.classList.add('hidden');
    forwardChatList.innerHTML = '';
    if (!state.chats.length) {
      forwardChatList.innerHTML = '<div class="forward-status" style="border:none">Немає чатів для пересилання</div>';
    }
    state.chats.forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'forward-chat-item';
      item.textContent = chat.withUser.username;
      item.addEventListener('click', () => forwardItemsTo(chat.chatId, chat.withUser.username));
      forwardChatList.appendChild(item);
    });
    forwardModal.classList.remove('hidden');
  }

  function closeForwardModal() {
    forwardModal.classList.add('hidden');
    pendingForwardItems = [];
  }

  function forwardItemsTo(chatId, username) {
    if (!pendingForwardItems.length) return;
    let remaining = pendingForwardItems.length;
    let hadError = false;
    pendingForwardItems.forEach((item) => {
      state.socket.emit('message:send', { chatId, text: item.text || '', imageUrl: item.imageUrl || null }, (ack) => {
        remaining -= 1;
        if (ack && ack.error) hadError = true;
        if (remaining === 0) {
          if (hadError) {
            forwardStatus.textContent = 'Не вдалося переслати деякі повідомлення';
          } else {
            forwardStatus.textContent = `Переслано до @${username}`;
          }
          forwardStatus.classList.remove('hidden');
          loadChats();
          setTimeout(() => {
            closeForwardModal();
            closeImageModal();
          }, 700);
        }
      });
    });
  }

  document.querySelectorAll('[data-close="image"]').forEach((btn) => btn.addEventListener('click', closeImageModal));
  document.querySelectorAll('[data-close="forward"]').forEach((btn) => btn.addEventListener('click', closeForwardModal));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!forwardModal.classList.contains('hidden')) closeForwardModal();
    else if (!imageModal.classList.contains('hidden')) closeImageModal();
  });

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  el('messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('messageInput');
    const text = input.value.trim();
    if ((!text && !pendingImageFile) || !state.activeChatId) return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      let imageUrl = null;
      if (pendingImageFile) {
        imageUrl = await uploadPendingImage();
      }
      state.socket.emit('message:send', { chatId: state.activeChatId, text, imageUrl }, (ack) => {
        if (ack && ack.error) console.error(ack.error);
      });
      input.value = '';
      pendingImageFile = null;
      imageInput.value = '';
      imagePreview.classList.add('hidden');
    } catch (err) {
      alert(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------- Utils ----------

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
