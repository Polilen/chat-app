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
    audioVolume: Number(localStorage.getItem('audioVolume') || '1'),
  };

  const el = (id) => document.getElementById(id);

  // ---------- Аватарки ----------

  const AVATAR_COLORS = ['#e5697a', '#e0a83a', '#33d6b0', '#3aa0e0', '#8a6fe0', '#e05fb8', '#5fbf6b', '#e0863a'];

  function colorForUsername(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function renderAvatarInto(container, username, avatarUrl) {
    container.innerHTML = '';
    if (avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = avatarUrl;
      img.alt = username || '';
      container.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'avatar-fallback';
      fallback.style.background = colorForUsername(username || '?');
      fallback.textContent = (username || '?').charAt(0);
      container.appendChild(fallback);
    }
  }

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
    renderAvatarInto(el('meAvatar'), state.user.username, state.user.avatarUrl);
    connectSocket();
    loadChats();
  }

  function isPageVisible() {
    return document.visibilityState === 'visible';
  }

  function markActiveChatReadIfVisible() {
    if (!state.activeChatId || !state.socket || !isPageVisible()) return;
    state.socket.emit('messages:read', { chatId: state.activeChatId });
  }

  function sendPresenceUpdate() {
    if (!state.socket || !state.socket.connected) return;
    state.socket.emit('presence:update', { visible: isPageVisible() });
  }

  function sendChatActiveUpdate() {
    if (!state.socket || !state.socket.connected) return;
    const chatId = isPageVisible() ? state.activeChatId : null;
    state.socket.emit('chat:active', { chatId });
  }

  document.addEventListener('visibilitychange', () => {
    if (isPageVisible()) markActiveChatReadIfVisible();
    sendPresenceUpdate();
    sendChatActiveUpdate();
  });

  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('connect', () => {
      sendPresenceUpdate();
      sendChatActiveUpdate();
    });
    state.socket.on('message:new', (msg) => {
      // Оновлюємо список чатів (щоб з'явився новий/піднявся вгору)
      loadChats();
      // Якщо це відкритий зараз чат — одразу малюємо повідомлення
      if (state.activeChatId === msg.chatId) {
        appendMessage(msg);
        scrollMessagesToBottom();
        // Позначаємо прочитаним лише якщо вкладка справді видима (не згорнутий браузер/інша вкладка)
        if (msg.senderId !== state.user.id) {
          markActiveChatReadIfVisible();
        }
      }
    });
    state.socket.on('messages:read', ({ chatId, messageIds }) => {
      if (state.activeChatId !== chatId) return;
      messageIds.forEach((id) => {
        const node = messagesEl.querySelector(`[data-id="${id}"] .msg-status`);
        if (node) {
          node.textContent = '✓✓';
          node.classList.add('read');
        }
      });
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
    state.socket.on('avatar:updated', ({ userId, avatarUrl }) => {
      let changed = false;
      state.chats.forEach((chat) => {
        if (chat.withUser.id === userId) {
          chat.withUser.avatarUrl = avatarUrl;
          changed = true;
        }
      });
      if (changed) renderChatList();
      if (state.activeChatWith && state.activeChatWith.id === userId) {
        state.activeChatWith.avatarUrl = avatarUrl;
        renderAvatarInto(el('chatHeaderAvatar'), state.activeChatWith.username, avatarUrl);
      }
    });
    state.socket.on('presence:updated', ({ userId, online, lastSeenAt, vague }) => {
      const presence = { online, lastSeenAt, vague };
      let changed = false;
      state.chats.forEach((chat) => {
        if (chat.withUser.id === userId) {
          chat.withUser.presence = presence;
          changed = true;
        }
      });
      if (changed) renderChatList();
      if (state.activeChatWith && state.activeChatWith.id === userId) {
        state.activeChatWith.presence = presence;
        renderChatHeaderStatus(presence);
      }
    });
    state.socket.on('reaction:updated', ({ chatId, messageId, reactions }) => {
      if (state.activeChatId !== chatId) return;
      const node = messagesEl.querySelector(`[data-id="${messageId}"]`);
      if (node) renderReactions(node, reactions);
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
        let contentPreview;
        if (chat.lastMessage.image_url) contentPreview = '📷 Фото';
        else if (chat.lastMessage.video_url) contentPreview = '🎬 Відео';
        else if (chat.lastMessage.audio_url) contentPreview = '🎵 Аудіо';
        else contentPreview = chat.lastMessage.text;
        previewText = prefix + contentPreview;
      }
      const preview = previewText;
      item.innerHTML = `
        <div class="avatar-slot"></div>
        <div class="chat-list-text">
          <span class="chat-list-username">${escapeHtml(chat.withUser.username)}</span>
          <span class="chat-list-preview">${escapeHtml(preview)}</span>
        </div>
      `;
      renderAvatarInto(item.querySelector('.avatar-slot'), chat.withUser.username, chat.withUser.avatarUrl);
      if (chat.withUser.presence && chat.withUser.presence.online) {
        const dot = document.createElement('div');
        dot.className = 'avatar-online-dot';
        item.querySelector('.avatar-slot').appendChild(dot);
      }
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

  function setPendingImage(file) {
    if (file.size > 8 * 1024 * 1024) {
      alert('Файл занадто великий (максимум 8 МБ)');
      return false;
    }
    pendingAudioFile = null;
    audioInput.value = '';
    audioPreview.classList.add('hidden');
    pendingVideoFile = null;
    videoInput.value = '';
    videoPreview.classList.add('hidden');
    pendingImageFile = file;
    imagePreviewImg.src = URL.createObjectURL(file);
    imagePreview.classList.remove('hidden');
    return true;
  }

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    if (!setPendingImage(file)) imageInput.value = '';
  });

  cancelImageBtn.addEventListener('click', () => {
    pendingImageFile = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
  });

  // ---------- Вставка картинки з буфера обміну (Ctrl+V) ----------

  const PASTE_IGNORE_IDS = new Set(['searchInput', 'loginUsername', 'loginPassword', 'registerUsername', 'registerPassword']);

  document.addEventListener('paste', (e) => {
    if (!state.activeChatId) return;
    const active = document.activeElement;
    if (active && PASTE_IGNORE_IDS.has(active.id)) return;
    if (!imageModal.classList.contains('hidden') || !forwardModal.classList.contains('hidden') || !settingsModal.classList.contains('hidden')) return;
    if (!e.clipboardData || !e.clipboardData.items) return;

    const imageItem = [...e.clipboardData.items].find((item) => item.type && item.type.startsWith('image/'));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    e.preventDefault();
    setPendingImage(file);
  });

  // ---------- Прикріплення аудіо ----------

  const attachAudioBtn = el('attachAudioBtn');
  const audioInput = el('audioInput');
  const audioPreview = el('audioPreview');
  const audioPreviewName = el('audioPreviewName');
  const cancelAudioBtn = el('cancelAudioBtn');
  let pendingAudioFile = null;

  attachAudioBtn.addEventListener('click', () => audioInput.click());

  audioInput.addEventListener('change', () => {
    const file = audioInput.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      alert('Файл занадто великий (максимум 20 МБ)');
      audioInput.value = '';
      return;
    }
    pendingImageFile = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
    pendingVideoFile = null;
    videoInput.value = '';
    videoPreview.classList.add('hidden');
    pendingAudioFile = file;
    audioPreviewName.textContent = '🎵 ' + file.name;
    audioPreview.classList.remove('hidden');
  });

  cancelAudioBtn.addEventListener('click', () => {
    pendingAudioFile = null;
    audioInput.value = '';
    audioPreview.classList.add('hidden');
  });

  // ---------- Прикріплення відео ----------

  const attachVideoBtn = el('attachVideoBtn');
  const videoInput = el('videoInput');
  const videoPreview = el('videoPreview');
  const videoPreviewEl = el('videoPreviewEl');
  const cancelVideoBtn = el('cancelVideoBtn');
  const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
  let pendingVideoFile = null;

  attachVideoBtn.addEventListener('click', () => videoInput.click());

  videoInput.addEventListener('change', () => {
    const file = videoInput.files[0];
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) {
      alert('Файл занадто великий (максимум 500 МБ)');
      videoInput.value = '';
      return;
    }
    pendingImageFile = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
    pendingAudioFile = null;
    audioInput.value = '';
    audioPreview.classList.add('hidden');
    pendingVideoFile = file;
    videoPreviewEl.src = URL.createObjectURL(file);
    videoPreview.classList.remove('hidden');
  });

  cancelVideoBtn.addEventListener('click', () => {
    pendingVideoFile = null;
    videoInput.value = '';
    videoPreviewEl.pause();
    videoPreviewEl.removeAttribute('src');
    videoPreview.classList.add('hidden');
  });

  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не вдалося завантажити файл');
    return data;
  }

  // ---------- Запис голосового ----------

  const recordBtn = el('recordBtn');
  const recordingBar = el('recordingBar');
  const recordingTime = el('recordingTime');
  const recordCancelBtn = el('recordCancelBtn');
  const recordSendBtn = el('recordSendBtn');
  const messageFormEl = el('messageForm');

  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let recordingStartedAt = 0;
  let recordingTimerId = null;
  let recordingCancelled = false;

  function extFromMime(mimeType) {
    const base = (mimeType || '').split(';')[0].split('/')[1] || 'webm';
    return base.replace('x-', '');
  }

  function updateRecordingTime() {
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    recordingTime.textContent = formatDuration(elapsed);
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      alert('Цей браузер не підтримує запис аудіо');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Не вдалося отримати доступ до мікрофона');
      return;
    }

    // Ховаємо звичайну форму й будь-які прикріплені файли, показуємо індикатор запису
    pendingImageFile = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
    pendingAudioFile = null;
    audioInput.value = '';
    audioPreview.classList.add('hidden');
    pendingVideoFile = null;
    videoInput.value = '';
    videoPreview.classList.add('hidden');

    recordedChunks = [];
    recordingCancelled = false;
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      mediaStream.getTracks().forEach((t) => t.stop());
      clearInterval(recordingTimerId);
      messageFormEl.classList.remove('hidden');
      recordingBar.classList.add('hidden');

      if (recordingCancelled || !recordedChunks.length) return;

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const ext = extFromMime(blob.type);
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
      sendVoiceMessage(file);
    };

    mediaRecorder.start();
    recordingStartedAt = Date.now();
    recordingTime.textContent = '0:00';
    updateRecordingTime();
    recordingTimerId = setInterval(updateRecordingTime, 500);

    messageFormEl.classList.add('hidden');
    recordingBar.classList.remove('hidden');
  }

  function stopRecording(cancel) {
    recordingCancelled = !!cancel;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  async function sendVoiceMessage(file) {
    if (!state.activeChatId) return;
    try {
      const uploaded = await uploadFile(file);
      state.socket.emit('message:send', { chatId: state.activeChatId, text: '', audioUrl: uploaded.url }, (ack) => {
        if (ack && ack.error) console.error(ack.error);
      });
    } catch (err) {
      alert(err.message);
    }
  }

  recordBtn.addEventListener('click', () => {
    if (!state.activeChatId) return;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording(false);
    } else {
      startRecording();
    }
  });

  recordSendBtn.addEventListener('click', () => stopRecording(false));
  recordCancelBtn.addEventListener('click', () => stopRecording(true));

  async function openChat(chatId, withUser) {
    pauseAllAudio();
    state.activeChatId = chatId;
    state.activeChatWith = withUser;
    exitSelectMode();
    emptyState.classList.add('hidden');
    activeChatEl.classList.remove('hidden');
    el('chatWithUsername').textContent = withUser.username;
    renderAvatarInto(el('chatHeaderAvatar'), withUser.username, withUser.avatarUrl);
    renderChatHeaderStatus(withUser.presence);
    sendChatActiveUpdate();
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
        audioUrl: m.audioUrl,
        videoUrl: m.videoUrl,
        readAt: m.readAt,
        reactions: m.reactions,
        createdAt: m.createdAt,
      }));
      scrollMessagesToBottom();
      markActiveChatReadIfVisible();
    } catch (err) {
      console.error(err);
    }
  }

  function appendMessage(msg) {
    if (msg.chatId !== state.activeChatId) return;
    const mine = msg.senderId === state.user.id || msg.sender_id === state.user.id;
    const messageId = msg.id;
    const div = document.createElement('div');
    const imageUrl = msg.imageUrl || msg.image_url;
    const audioUrl = msg.audioUrl || msg.audio_url;
    const videoUrl = msg.videoUrl || msg.video_url;
    const text = msg.text || '';
    const isSticker = STICKERS.includes(text.trim()) && !imageUrl && !audioUrl && !videoUrl;

    div.className = 'msg ' + (mine ? 'mine' : 'theirs') + (isSticker ? ' msg-sticker' : '');
    if (messageId != null) {
      div.dataset.id = messageId;
      div.dataset.senderId = msg.senderId ?? msg.sender_id ?? '';
    }
    const time = formatTime(msg.createdAt || msg.created_at);

    let inner = '<div class="msg-checkbox"></div>';
    if (imageUrl) {
      inner += `<img class="msg-image" src="${escapeAttr(imageUrl)}" alt="Фото">`;
    }
    if (videoUrl) {
      inner += '<div class="msg-video-slot"></div>';
    }
    if (audioUrl) {
      inner += '<div class="msg-audio-slot"></div>';
    }
    if (text) {
      inner += `<span class="msg-text">${escapeHtml(text)}</span>`;
    }
    inner += '<span class="msg-time-row">';
    inner += `<span class="msg-time">${time}</span>`;
    if (mine) {
      const isRead = !!(msg.readAt || msg.read_at);
      inner += `<span class="msg-status${isRead ? ' read' : ''}">${isRead ? '✓✓' : '✓'}</span>`;
    }
    inner += '</span>';
    inner += '<div class="msg-reactions"></div>';
    inner += '<div class="msg-actions"></div>';

    div.innerHTML = inner;

    if (imageUrl) {
      div.querySelector('.msg-image').addEventListener('click', (e) => {
        if (state.selectionMode) return;
        e.stopPropagation();
        openMediaModal(imageUrl, 'image');
      });
      div.dataset.imageUrl = imageUrl;
    }

    if (videoUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-video-wrap';
      const videoEl = document.createElement('video');
      videoEl.className = 'msg-video';
      videoEl.src = videoUrl;
      videoEl.muted = true;
      videoEl.preload = 'metadata';
      const playIcon = document.createElement('div');
      playIcon.className = 'msg-video-play';
      playIcon.textContent = '▶';
      wrap.append(videoEl, playIcon);
      wrap.addEventListener('click', (e) => {
        if (state.selectionMode) return;
        e.stopPropagation();
        openMediaModal(videoUrl, 'video');
      });
      div.querySelector('.msg-video-slot').replaceWith(wrap);
      div.dataset.videoUrl = videoUrl;
    }

    if (audioUrl) {
      div.querySelector('.msg-audio-slot').replaceWith(buildAudioPlayer(audioUrl));
      div.dataset.audioUrl = audioUrl;
    }

    const actions = div.querySelector('.msg-actions');
    const forwardIcon = document.createElement('button');
    forwardIcon.type = 'button';
    forwardIcon.className = 'msg-action-icon';
    forwardIcon.title = 'Переслати';
    forwardIcon.textContent = '↪';
    forwardIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      openForwardModal([{ text, imageUrl: imageUrl || null, audioUrl: audioUrl || null, videoUrl: videoUrl || null }]);
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

    if (messageId != null) {
      div.addEventListener('contextmenu', (e) => {
        if (state.selectionMode) return;
        e.preventDefault();
        openReactionPopover(e.clientX, e.clientY, messageId);
      });
      renderReactions(div, msg.reactions || []);
    }

    messagesEl.appendChild(div);
  }

  // ---------- Реакції на повідомлення ----------

  const REACTIONS = ['❤️', '👍', '🔥'];
  const reactionPopover = el('reactionPopover');

  function renderReactions(div, reactions) {
    const box = div.querySelector('.msg-reactions');
    if (!box) return;
    box.innerHTML = '';
    reactions.forEach((r) => {
      const mine = r.userIds && r.userIds.includes(state.user.id);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'msg-reaction-pill' + (mine ? ' mine' : '');
      pill.textContent = `${r.emoji} ${r.userIds.length}`;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectionMode) return;
        sendReaction(div.dataset.id, r.emoji);
      });
      box.appendChild(pill);
    });
  }

  function sendReaction(messageId, emoji) {
    state.socket.emit('reaction:set', { messageId: Number(messageId), emoji }, (ack) => {
      if (ack && ack.error) console.error(ack.error);
    });
  }

  function openReactionPopover(x, y, messageId) {
    reactionPopover.innerHTML = '';
    REACTIONS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-popover-item';
      btn.textContent = emoji;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendReaction(messageId, emoji);
        closeReactionPopover();
      });
      reactionPopover.appendChild(btn);
    });
    reactionPopover.classList.remove('hidden');
    // Спочатку показуємо, щоб дізнатись реальні розміри, потім позиціонуємо в межах екрана
    const rect = reactionPopover.getBoundingClientRect();
    let left = x - rect.width / 2;
    let top = y - rect.height - 12;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    if (top < 8) top = y + 12;
    reactionPopover.style.left = `${left}px`;
    reactionPopover.style.top = `${top}px`;
  }

  function closeReactionPopover() {
    reactionPopover.classList.add('hidden');
  }

  document.addEventListener('click', (e) => {
    if (!reactionPopover.classList.contains('hidden') && !reactionPopover.contains(e.target)) {
      closeReactionPopover();
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.msg')) closeReactionPopover();
  });

  // ---------- Стікери ----------

  const STICKERS = ['😀', '😂', '😍', '🥰', '😭', '😡', '😱', '😴', '🤔', '🥳', '👍', '👎', '👏', '🙏', '💯', '🎉', '🔥', '❤️', '💔', '👀'];

  const stickerBtn = el('stickerBtn');
  const stickerPopover = el('stickerPopover');

  STICKERS.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-item';
    btn.textContent = s;
    btn.addEventListener('click', () => {
      if (!state.activeChatId) return;
      insertTextAtCursor(el('messageInput'), s);
    });
    stickerPopover.appendChild(btn);
  });

  function insertTextAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const cursor = start + text.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }

  stickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stickerPopover.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!stickerPopover.classList.contains('hidden') && !stickerPopover.contains(e.target) && e.target !== stickerBtn) {
      stickerPopover.classList.add('hidden');
    }
  });

  // ---------- Кастомний аудіоплеєр (один активний одночасно) ----------

  const audioInstances = new Set();
  let currentlyPlayingAudio = null;

  function pauseAllAudio() {
    audioInstances.forEach((a) => a.pause());
    currentlyPlayingAudio = null;
  }

  function buildAudioPlayer(url) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-audio';

    const audio = new Audio(url);
    audio.preload = 'metadata';
    audio.volume = state.audioVolume;
    audioInstances.add(audio);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'audio-play-btn';
    playBtn.textContent = '▶';

    const controls = document.createElement('div');
    controls.className = 'msg-audio-controls';

    const seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'audio-seek';
    seek.min = '0';
    seek.max = '100';
    seek.value = '0';

    const timeRow = document.createElement('div');
    timeRow.className = 'audio-time-row';
    const curTimeEl = document.createElement('span');
    curTimeEl.textContent = '0:00';
    const durTimeEl = document.createElement('span');
    durTimeEl.textContent = '0:00';
    timeRow.append(curTimeEl, durTimeEl);

    controls.append(seek, timeRow);

    const downloadBtn = document.createElement('a');
    downloadBtn.className = 'audio-download-btn';
    downloadBtn.title = 'Завантажити';
    downloadBtn.href = url;
    downloadBtn.setAttribute('download', url.split('/').pop());
    downloadBtn.textContent = '⬇';
    downloadBtn.addEventListener('click', (e) => e.stopPropagation());

    wrap.append(playBtn, controls, downloadBtn);

    let seeking = false;

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selectionMode) return;
      if (audio.paused) {
        // Гарантовано зупиняємо будь-яке інше голосове, що зараз грає — лише одне звучить одночасно
        if (currentlyPlayingAudio && currentlyPlayingAudio !== audio) {
          currentlyPlayingAudio.pause();
        }
        audio.play();
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', () => {
      currentlyPlayingAudio = audio;
      playBtn.textContent = '⏸';
    });
    audio.addEventListener('pause', () => {
      if (currentlyPlayingAudio === audio) currentlyPlayingAudio = null;
      playBtn.textContent = '▶';
    });
    audio.addEventListener('ended', () => { playBtn.textContent = '▶'; seek.value = '0'; });

    audio.addEventListener('loadedmetadata', () => {
      durTimeEl.textContent = formatDuration(audio.duration);
    });

    audio.addEventListener('timeupdate', () => {
      if (seeking || !audio.duration) return;
      seek.value = String((audio.currentTime / audio.duration) * 100);
      curTimeEl.textContent = formatDuration(audio.currentTime);
    });

    seek.addEventListener('input', () => { seeking = true; });
    seek.addEventListener('change', () => {
      if (audio.duration) {
        audio.currentTime = (Number(seek.value) / 100) * audio.duration;
      }
      seeking = false;
    });
    seek.addEventListener('click', (e) => e.stopPropagation());

    return wrap;
  }

  // ---------- Загальний регулятор гучності голосових (у шапці чату) ----------

  const volumeBtn = el('volumeBtn');
  const volumePopover = el('volumePopover');
  const globalVolumeSlider = el('globalVolumeSlider');

  globalVolumeSlider.value = String(Math.round(state.audioVolume * 100));

  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    volumePopover.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!volumePopover.classList.contains('hidden') && !volumePopover.contains(e.target) && e.target !== volumeBtn) {
      volumePopover.classList.add('hidden');
    }
  });

  globalVolumeSlider.addEventListener('input', () => {
    const v = Number(globalVolumeSlider.value) / 100;
    state.audioVolume = v;
    localStorage.setItem('audioVolume', String(v));
    audioInstances.forEach((a) => { a.volume = v; });
    volumeBtn.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
  });

  function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
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
        imageUrl: node.dataset.imageUrl || null,
        audioUrl: node.dataset.audioUrl || null,
        videoUrl: node.dataset.videoUrl || null,
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

  // ---------- Модалка перегляду фото/відео ----------

  const imageModal = el('imageModal');
  const imageModalImg = el('imageModalImg');
  const imageModalVideo = el('imageModalVideo');
  const imageModalDownload = el('imageModalDownload');
  const imageModalForward = el('imageModalForward');
  let previewMediaUrl = null;
  let previewMediaType = 'image';

  function openMediaModal(url, type) {
    previewMediaUrl = url;
    previewMediaType = type;
    if (type === 'video') {
      imageModalImg.classList.add('hidden');
      imageModalImg.src = '';
      imageModalVideo.classList.remove('hidden');
      imageModalVideo.src = url;
    } else {
      imageModalVideo.classList.add('hidden');
      imageModalVideo.pause();
      imageModalVideo.removeAttribute('src');
      imageModalImg.classList.remove('hidden');
      imageModalImg.src = url;
    }
    const filename = url.split('/').pop();
    imageModalDownload.href = url;
    imageModalDownload.setAttribute('download', filename);
    imageModal.classList.remove('hidden');
  }

  function closeImageModal() {
    imageModal.classList.add('hidden');
    imageModalImg.src = '';
    imageModalVideo.pause();
    imageModalVideo.removeAttribute('src');
  }

  imageModalForward.addEventListener('click', () => {
    const item = { text: '', imageUrl: null, audioUrl: null, videoUrl: null };
    if (previewMediaType === 'video') item.videoUrl = previewMediaUrl;
    else item.imageUrl = previewMediaUrl;
    openForwardModal([item]);
  });

  // ---------- Модалка пересилання ----------

  const forwardModal = el('forwardModal');
  const forwardChatList = el('forwardChatList');
  const forwardStatus = el('forwardStatus');
  let pendingForwardItems = [];

  function openForwardModal(items) {
    pendingForwardItems = items.filter((it) => it.text || it.imageUrl || it.audioUrl || it.videoUrl);
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
      state.socket.emit('message:send', { chatId, text: item.text || '', imageUrl: item.imageUrl || null, audioUrl: item.audioUrl || null, videoUrl: item.videoUrl || null }, (ack) => {
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
  document.querySelectorAll('[data-close="settings"]').forEach((btn) => btn.addEventListener('click', closeSettingsModal));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!settingsModal.classList.contains('hidden')) closeSettingsModal();
    else if (!forwardModal.classList.contains('hidden')) closeForwardModal();
    else if (!imageModal.classList.contains('hidden')) closeImageModal();
  });

  // ---------- Налаштування профілю (аватарка) ----------

  const meProfileBtn = el('meProfileBtn');
  const settingsModal = el('settingsModal');
  const settingsAvatar = el('settingsAvatar');
  const settingsUsername = el('settingsUsername');
  const settingsStatus = el('settingsStatus');
  const avatarInput = el('avatarInput');
  const changeAvatarBtn = el('changeAvatarBtn');
  const removeAvatarBtn = el('removeAvatarBtn');
  const showLastSeenToggle = el('showLastSeenToggle');

  function openSettingsModal() {
    settingsStatus.classList.add('hidden');
    settingsUsername.textContent = state.user.username;
    renderAvatarInto(settingsAvatar, state.user.username, state.user.avatarUrl);
    showLastSeenToggle.checked = state.user.showLastSeen !== false;
    settingsModal.classList.remove('hidden');
  }

  showLastSeenToggle.addEventListener('change', async () => {
    const value = showLastSeenToggle.checked;
    try {
      const res = await fetch('/api/me/privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: JSON.stringify({ showLastSeen: value }),
      });
      if (!res.ok) throw new Error('Не вдалося зберегти налаштування');
      state.user.showLastSeen = value;
      localStorage.setItem('user', JSON.stringify(state.user));
      showSettingsStatus(value ? 'Активність видима іншим' : 'Активність прихована від інших');
    } catch (err) {
      showLastSeenToggle.checked = !value;
      showSettingsStatus(err.message);
    }
  });

  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
  }

  function showSettingsStatus(msg) {
    settingsStatus.textContent = msg;
    settingsStatus.classList.remove('hidden');
  }

  function persistUser() {
    localStorage.setItem('user', JSON.stringify(state.user));
    renderAvatarInto(el('meAvatar'), state.user.username, state.user.avatarUrl);
    renderAvatarInto(settingsAvatar, state.user.username, state.user.avatarUrl);
    if (state.activeChatWith && state.activeChatWith.id === state.user.id) {
      renderAvatarInto(el('chatHeaderAvatar'), state.user.username, state.user.avatarUrl);
    }
  }

  meProfileBtn.addEventListener('click', openSettingsModal);

  changeAvatarBtn.addEventListener('click', () => avatarInput.click());

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showSettingsStatus('Файл занадто великий (максимум 5 МБ)');
      avatarInput.value = '';
      return;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    changeAvatarBtn.disabled = true;
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не вдалося оновити аватарку');
      state.user.avatarUrl = data.avatarUrl;
      persistUser();
      showSettingsStatus('Аватарку оновлено');
    } catch (err) {
      showSettingsStatus(err.message);
    } finally {
      avatarInput.value = '';
      changeAvatarBtn.disabled = false;
    }
  });

  removeAvatarBtn.addEventListener('click', async () => {
    if (!state.user.avatarUrl) {
      showSettingsStatus('Аватарки ще немає');
      return;
    }
    if (!confirm('Видалити аватарку?')) return;
    removeAvatarBtn.disabled = true;
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + state.token },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Не вдалося видалити аватарку');
      }
      state.user.avatarUrl = null;
      persistUser();
      showSettingsStatus('Аватарку видалено');
    } catch (err) {
      showSettingsStatus(err.message);
    } finally {
      removeAvatarBtn.disabled = false;
    }
  });

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  el('messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('messageInput');
    const text = input.value.trim();
    if ((!text && !pendingImageFile && !pendingAudioFile && !pendingVideoFile) || !state.activeChatId) return;
    stickerPopover.classList.add('hidden');

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      let imageUrl = null;
      let audioUrl = null;
      let videoUrl = null;
      if (pendingImageFile) {
        const uploaded = await uploadFile(pendingImageFile);
        imageUrl = uploaded.url;
      }
      if (pendingAudioFile) {
        const uploaded = await uploadFile(pendingAudioFile);
        audioUrl = uploaded.url;
      }
      if (pendingVideoFile) {
        const uploaded = await uploadFile(pendingVideoFile);
        videoUrl = uploaded.url;
      }
      state.socket.emit('message:send', { chatId: state.activeChatId, text, imageUrl, audioUrl, videoUrl }, (ack) => {
        if (ack && ack.error) console.error(ack.error);
      });
      input.value = '';
      pendingImageFile = null;
      imageInput.value = '';
      imagePreview.classList.add('hidden');
      pendingAudioFile = null;
      audioInput.value = '';
      audioPreview.classList.add('hidden');
      pendingVideoFile = null;
      videoInput.value = '';
      videoPreviewEl.pause();
      videoPreviewEl.removeAttribute('src');
      videoPreview.classList.add('hidden');
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

  function parseServerDate(iso) {
    if (!iso) return null;
    return new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  }

  // ---------- Присутність (онлайн / був(ла) недавно) ----------

  function formatPresence(presence) {
    if (!presence) return null;
    if (presence.online) return { text: 'у мережі', online: true };
    if (presence.vague) return { text: 'був(ла) недавно', online: false };
    if (!presence.lastSeenAt) return null;

    const seenDate = parseServerDate(presence.lastSeenAt);
    if (!seenDate) return null;
    const now = new Date();

    const time = seenDate.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const isSameDay = seenDate.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = seenDate.toDateString() === yesterday.toDateString();

    if (isSameDay) {
      return { text: `був(ла) сьогодні о ${time}`, online: false };
    }
    if (isYesterday) {
      return { text: `був(ла) вчора о ${time}`, online: false };
    }
    const dateStr = seenDate.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return { text: `був(ла) ${dateStr} о ${time}`, online: false };
  }

  function renderChatHeaderStatus(presence) {
    const el2 = el('chatHeaderStatus');
    const formatted = formatPresence(presence);
    if (!formatted) {
      el2.textContent = '';
      el2.classList.remove('online');
      return;
    }
    el2.textContent = formatted.text;
    el2.classList.toggle('online', formatted.online);
  }

  // ---------- Init ----------

  if (state.token && state.user) {
    startApp();
  }
})();
