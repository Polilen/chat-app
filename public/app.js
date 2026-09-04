(function () {
  // Реальна висота вікна на мобільних — 100vh там враховує адресний рядок і залишає
  // порожній простір знизу. Рахуємо фактичну висоту й підставляємо через CSS-змінну.
  function setAppHeight() {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
  }
  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', setAppHeight);

  const state = {
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    activeChatId: null,
    activeChatWith: null,
    activeChatIsGroup: false,
    editingMessageId: null,
    typingByChat: new Map(),
    activeGroup: null,
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
    // document.visibilityState сам по собі не завжди надійно ловить саме згорнутий стан браузера
    // (залежить від браузера/ОС) — тому додатково перевіряємо фокус вікна, який при згортанні
    // втрачається гарантовано в будь-якому браузері
    return document.visibilityState === 'visible' && document.hasFocus();
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

  function handleVisibilityOrFocusChange() {
    if (isPageVisible()) markActiveChatReadIfVisible();
    sendPresenceUpdate();
    sendChatActiveUpdate();
  }

  document.addEventListener('visibilitychange', handleVisibilityOrFocusChange);
  // window.blur/focus — надійніший сигнал саме для згортання вікна браузера,
  // спрацьовує завжди, навіть якщо visibilitychange з якоїсь причини не викликався
  window.addEventListener('blur', handleVisibilityOrFocusChange);
  window.addEventListener('focus', handleVisibilityOrFocusChange);

  // ---------- "Друкує…" / "надсилає фото…" — ефемерний індикатор, нічого не зберігається ----------

  const TYPING_ACTION_LABELS = {
    typing: 'друкує',
    photo: 'надсилає фото',
    video: 'надсилає відео',
    audio: 'надсилає аудіофайл',
    voice: 'записує голосове',
  };

  let myTypingTimer = null;
  let amCurrentlyTyping = false;

  function sendTypingSignal(action) {
    if (!state.activeChatId || !state.socket || !state.socket.connected) return;
    state.socket.emit('typing:update', { chatId: state.activeChatId, action });
  }

  function notifyTyping() {
    if (!amCurrentlyTyping) {
      amCurrentlyTyping = true;
      sendTypingSignal('typing');
    }
    clearTimeout(myTypingTimer);
    myTypingTimer = setTimeout(() => {
      amCurrentlyTyping = false;
      sendTypingSignal(null);
    }, 3000);
  }

  function stopTypingSignal() {
    clearTimeout(myTypingTimer);
    if (amCurrentlyTyping) {
      amCurrentlyTyping = false;
      sendTypingSignal(null);
    }
  }

  function setRemoteTyping(chatId, userId, username, action) {
    let chatMap = state.typingByChat.get(chatId);
    if (!chatMap) {
      chatMap = new Map();
      state.typingByChat.set(chatId, chatMap);
    }
    const existing = chatMap.get(userId);
    if (existing) clearTimeout(existing.timer);

    if (!action) {
      chatMap.delete(userId);
    } else {
      // Захист від "зависання" індикатора, якщо подія про зупинку загубилась (напр. розрив з'єднання)
      const timer = setTimeout(() => {
        chatMap.delete(userId);
        refreshTypingUI(chatId);
      }, 6000);
      chatMap.set(userId, { username, action, timer });
    }
    refreshTypingUI(chatId);
  }

  function getTypingLabelForChat(chatId) {
    const chatMap = state.typingByChat.get(chatId);
    if (!chatMap || chatMap.size === 0) return null;
    const entries = [...chatMap.values()];
    if (entries.length > 1) return `${entries.length} осіб пишуть…`;
    const label = TYPING_ACTION_LABELS[entries[0].action] || 'друкує';
    const chat = state.chats.find((c) => c.chatId === chatId);
    if (chat && chat.isGroup) return `${entries[0].username} ${label}…`;
    return `${label}…`;
  }

  function refreshTypingUI(chatId) {
    if (chatId === state.activeChatId) updateChatHeaderStatusLine();
    renderChatList();
  }

  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('connect', () => {
      sendPresenceUpdate();
      sendChatActiveUpdate();
    });
    state.socket.on('message:new', (msg) => {
      // Підстраховка: щойно прийшло реальне повідомлення — гасимо індикатор "друкує" для цього відправника
      if (msg.senderId !== state.user.id) {
        setRemoteTyping(msg.chatId, msg.senderId, msg.senderUsername, null);
      }
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
    state.socket.on('message:edited', ({ chatId, messageId, text, editedAt }) => {
      if (state.activeChatId !== chatId) return;
      const node = messagesEl.querySelector(`[data-id="${messageId}"]`);
      if (node) applyEditedTextToNode(node, text, editedAt);
      loadChats();
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
    state.socket.on('chat:deleted', ({ chatId }) => {
      applyChatRemoved(chatId);
    });
    state.socket.on('group:updated', (group) => {
      // Найпростіше й найнадійніше — просто перезавантажити список чатів
      loadChats();
      if (state.activeChatId === group.id && state.activeChatIsGroup) {
        state.activeGroup = { id: group.id, name: group.groupName, avatarUrl: group.groupAvatarUrl, memberCount: group.memberCount };
        renderChatHeader();
      }
      if (openGroupInfoChatId === group.id) {
        openGroupInfoData = group;
        renderGroupInfoModal(group);
      }
    });
    state.socket.on('avatar:updated', ({ userId, avatarUrl }) => {
      let changed = false;
      state.chats.forEach((chat) => {
        if (chat.withUser && chat.withUser.id === userId) {
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
    state.socket.on('presence:updated', ({ userId, chatId, online, lastSeenAt, vague, justNow }) => {
      const presence = { online, lastSeenAt, vague, justNow };
      let changed = false;
      state.chats.forEach((chat) => {
        if (chat.withUser && chat.withUser.id === userId) {
          chat.withUser.presence = presence;
          changed = true;
        }
      });
      if (changed) renderChatList();
      if (state.activeChatWith && state.activeChatWith.id === userId) {
        state.activeChatWith.presence = presence;
        renderChatHeaderStatus(presence);
      }
      // Якщо зараз відкрита карточка групи і в ній є цей учасник — оновлюємо його статус наживо
      if (openGroupInfoData && (!chatId || chatId === openGroupInfoChatId)) {
        const member = openGroupInfoData.members.find((m) => m.id === userId);
        if (member) {
          member.presence = presence;
          renderGroupInfoModal(openGroupInfoData);
        }
      }
    });
    state.socket.on('typing:update', ({ chatId, userId, username, action }) => {
      setRemoteTyping(chatId, userId, username, action);
    });
    state.socket.on('call:incoming', ({ callId, chatId, offer, fromUserId, fromUsername }) => {
      if (currentCall) {
        // Вже є активний дзвінок — автоматично відхиляємо новий, як "зайнято"
        state.socket.emit('call:decline', { callId });
        return;
      }
      const chatEntry = state.chats.find((c) => c.chatId === chatId);
      const avatarUrl = chatEntry && !chatEntry.isGroup ? chatEntry.withUser.avatarUrl : null;
      currentCall = {
        callId,
        chatId,
        peerId: fromUserId,
        peerUsername: fromUsername,
        peerAvatarUrl: avatarUrl,
        pc: null,
        localStream: null,
        role: 'callee',
        pendingOffer: offer,
      };
      showCallUI('incoming', { username: fromUsername, avatarUrl });
    });
    state.socket.on('call:answer', async ({ callId, answer }) => {
      if (!currentCall || currentCall.callId !== callId || !currentCall.pc) return;
      clearTimeout(callRingTimeout);
      try {
        await currentCall.pc.setRemoteDescription(new RTCSessionDescription(answer));
        showCallUI('active');
        startCallTimer();
      } catch (err) {
        console.error(err);
      }
    });
    state.socket.on('call:ice-candidate', async ({ callId, candidate }) => {
      if (!currentCall || currentCall.callId !== callId || !currentCall.pc) return;
      try {
        await currentCall.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(err);
      }
    });
    state.socket.on('call:renegotiate-offer', async ({ callId, offer }) => {
      if (!currentCall || currentCall.callId !== callId || !currentCall.pc) return;
      try {
        await currentCall.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await currentCall.pc.createAnswer();
        await currentCall.pc.setLocalDescription(answer);
        state.socket.emit('call:renegotiate-answer', { callId, answer });
      } catch (err) {
        console.error(err);
      }
    });
    state.socket.on('call:renegotiate-answer', async ({ callId, answer }) => {
      if (!currentCall || currentCall.callId !== callId || !currentCall.pc) return;
      try {
        await currentCall.pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error(err);
      }
    });
    state.socket.on('call:declined', ({ callId }) => {
      if (!currentCall || currentCall.callId !== callId) return;
      cleanupCallResources();
      hideCallUI();
    });
    state.socket.on('call:ended', ({ callId }) => {
      if (!currentCall || currentCall.callId !== callId) return;
      cleanupCallResources();
      hideCallUI();
    });
    state.socket.on('watch:invite', ({ chatId, source, fromUserId, fromUsername }) => {
      // Раніше запрошення показувалось лише якщо саме цей чат був відкритий — тепер,
      // як і дзвінки, приходить незалежно від того, який чат зараз відкритий
      if (watchSession || incomingWatchInvite || pendingWatchInvite) {
        state.socket.emit('watch:decline', { chatId }); // зайнято — автоматично відхиляємо
        return;
      }
      incomingWatchInvite = { chatId, source, fromUserId, fromUsername };
      const chatEntry = state.chats.find((c) => c.chatId === chatId);
      const avatarUrl = chatEntry && !chatEntry.isGroup ? chatEntry.withUser.avatarUrl : null;
      showWatchInviteModal(fromUsername, avatarUrl);
    });
    state.socket.on('watch:accepted', ({ chatId }) => {
      if (!pendingWatchInvite || pendingWatchInvite.chatId !== chatId) return;
      const { source } = pendingWatchInvite;
      pendingWatchInvite = null;
      if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId);
      else if (source.type === 'file') beginFileSession(source.url, chatId);
    });
    state.socket.on('watch:declined', ({ chatId }) => {
      if (!pendingWatchInvite || pendingWatchInvite.chatId !== chatId) return;
      pendingWatchInvite = null;
      resetWatchUI();
      alert('Запрошення на спільний перегляд відхилено');
    });
    state.socket.on('watch:state', ({ chatId, action, time, ts }) => {
      if (!watchSession || watchSession.chatId !== chatId) return;
      applyRemoteWatchState(action, time, ts);
    });
    state.socket.on('watch:end', ({ chatId }) => {
      if (incomingWatchInvite && incomingWatchInvite.chatId === chatId) {
        hideWatchInviteModal();
        return;
      }
      if (isPartnerChoosing && partnerChoosingChatId === chatId) {
        // Співрозмовник почав обирати заміну, але передумав і вийшов зовсім — не лишаємось чекати вічно
        isPartnerChoosing = false;
        partnerChoosingChatId = null;
        resetWatchUI();
        return;
      }
      if (isSwitchingVideo && switchingChatId === chatId) {
        // Це я саме зараз обираю заміну, а співрозмовник, який чекав, тим часом вийшов зовсім
        isSwitchingVideo = false;
        switchingChatId = null;
        resetWatchUI();
        return;
      }
      if (!watchSession || watchSession.chatId !== chatId) return;
      closeWatchSession(false);
    });
    state.socket.on('watch:switching', ({ chatId }) => {
      if (!watchSession || watchSession.chatId !== chatId) return;
      // НЕ виходимо з режиму перегляду — просто зупиняємо поточне відео й чекаємо нового вибору
      stopCurrentPlayer();
      watchSession = null;
      isPartnerChoosing = true;
      partnerChoosingChatId = chatId;
      partnerChoosingIsGroup = false;
      showChoosingState();
    });
    state.socket.on('watch:switch-video', ({ chatId, source }) => {
      if (!isPartnerChoosing || partnerChoosingChatId !== chatId) return;
      isPartnerChoosing = false;
      partnerChoosingChatId = null;
      if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId);
      else if (source.type === 'file') beginFileSession(source.url, chatId);
    });

    // ---------- Груповий спільний перегляд ----------

    state.socket.on('group-watch:announced', ({ chatId, participantCount }) => {
      showGroupWatchBanner(chatId, participantCount);
    });
    state.socket.on('group-watch:participant-update', ({ chatId, participantCount }) => {
      if (isPartnerChoosing && partnerChoosingChatId === chatId) {
        // Стан учасників поточної сесії змінився, поки я чекав вибору когось іншого —
        // на випадок якщо це був саме той, хто обирав (і раптово від'єднався), просто
        // повертаємось до перегляду наново, а не лишаємось чекати марно
        isPartnerChoosing = false;
        partnerChoosingChatId = null;
        joinGroupWatch(chatId);
        return;
      }
      if (watchSession && watchSession.isGroup && watchSession.chatId === chatId) {
        // Я сам зараз дивлюсь — оновлюємо кількість у заголовку
        updateGroupWatchParticipantCount(participantCount);
        return;
      }
      showGroupWatchBanner(chatId, participantCount);
    });
    state.socket.on('group-watch:session-ended', ({ chatId }) => {
      if (groupWatchBannerChatId === chatId) hideGroupWatchBanner();
      if (watchSession && watchSession.isGroup && watchSession.chatId === chatId) {
        // Малоймовірно (я мав би вже вийти сам, якщо був останнім) — але про всяк випадок
        resetWatchUI();
        watchSession = null;
      }
      if (isPartnerChoosing && partnerChoosingChatId === chatId) {
        isPartnerChoosing = false;
        partnerChoosingChatId = null;
        resetWatchUI();
      }
    });
    state.socket.on('group-watch:state', ({ chatId, action, time, ts }) => {
      if (!watchSession || !watchSession.isGroup || watchSession.chatId !== chatId) return;
      applyRemoteWatchState(action, time, ts);
    });
    state.socket.on('group-watch:switching', ({ chatId, fromUsername }) => {
      if (!watchSession || !watchSession.isGroup || watchSession.chatId !== chatId) return;
      // НЕ виходимо з режиму перегляду — просто зупиняємо поточне відео й чекаємо нового вибору
      stopCurrentPlayer();
      watchSession = null;
      isPartnerChoosing = true;
      partnerChoosingChatId = chatId;
      partnerChoosingIsGroup = true;
      showChoosingState(fromUsername);
    });
    state.socket.on('group-watch:switch-cancel', ({ chatId }) => {
      if (!isPartnerChoosing || partnerChoosingChatId !== chatId) return;
      isPartnerChoosing = false;
      partnerChoosingChatId = null;
      // Сесія на сервері весь цей час лишалась незмінною — просто "перезаходимо" в той самий перегляд
      joinGroupWatch(chatId);
    });
    state.socket.on('group-watch:switch-video', ({ chatId, source }) => {
      if (isPartnerChoosing && partnerChoosingChatId === chatId) {
        isPartnerChoosing = false;
        partnerChoosingChatId = null;
        if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId, { isGroup: true });
        else if (source.type === 'file') beginFileSession(source.url, chatId, { isGroup: true });
        return;
      }
      if (!watchSession || !watchSession.isGroup || watchSession.chatId !== chatId) return;
      if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId, { isGroup: true });
      else if (source.type === 'file') beginFileSession(source.url, chatId, { isGroup: true });
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
      const typingLabel = getTypingLabelForChat(chat.chatId);
      const preview = typingLabel || previewText;
      const previewClass = typingLabel ? 'chat-list-preview typing' : 'chat-list-preview';
      const displayName = chat.isGroup ? chat.groupName : chat.withUser.username;
      const usernameClass = chat.isGroup ? 'chat-list-username group' : 'chat-list-username';
      item.innerHTML = `
        <div class="avatar-slot"></div>
        <div class="chat-list-text">
          <span class="${usernameClass}">${escapeHtml(displayName)}</span>
          <span class="${previewClass}">${escapeHtml(preview)}</span>
        </div>
      `;
      if (chat.isGroup) {
        renderAvatarInto(item.querySelector('.avatar-slot'), chat.groupName, chat.groupAvatarUrl);
      } else {
        renderAvatarInto(item.querySelector('.avatar-slot'), chat.withUser.username, chat.withUser.avatarUrl);
        if (chat.withUser.presence && chat.withUser.presence.online) {
          const dot = document.createElement('div');
          dot.className = 'avatar-online-dot';
          item.querySelector('.avatar-slot').appendChild(dot);
        }
      }
      item.addEventListener('click', () => openChat(chat));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openChatMenu(e.clientX, e.clientY, item, chat);
      });
      attachChatLongPress(item, chat);
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
          openChat({ chatId: chat.id, isGroup: false, withUser: chat.withUser });
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

  const imageInput = el('imageInput');
  const imagePreview = el('imagePreview');
  const imagePreviewImg = el('imagePreviewImg');
  const cancelImageBtn = el('cancelImageBtn');
  let pendingImageFile = null;

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
    updateSendButtonMode();
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
    updateSendButtonMode();
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

  const audioInput = el('audioInput');
  const audioPreview = el('audioPreview');
  const audioPreviewName = el('audioPreviewName');
  const cancelAudioBtn = el('cancelAudioBtn');
  let pendingAudioFile = null;

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
    updateSendButtonMode();
  });

  cancelAudioBtn.addEventListener('click', () => {
    pendingAudioFile = null;
    audioInput.value = '';
    audioPreview.classList.add('hidden');
    updateSendButtonMode();
  });

  // ---------- Прикріплення відео ----------

  const videoInput = el('videoInput');
  const videoPreview = el('videoPreview');
  const videoPreviewEl = el('videoPreviewEl');
  const cancelVideoBtn = el('cancelVideoBtn');
  const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
  let pendingVideoFile = null;

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
    updateSendButtonMode();
  });

  cancelVideoBtn.addEventListener('click', () => {
    pendingVideoFile = null;
    videoInput.value = '';
    videoPreviewEl.pause();
    videoPreviewEl.removeAttribute('src');
    videoPreview.classList.add('hidden');
    updateSendButtonMode();
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

  // ---------- Меню вкладень (скріпка) ----------

  const attachControlBtn = el('attachBtn');
  const attachMenu = el('attachMenu');

  function openAttachMenu() {
    attachMenu.classList.remove('hidden', 'animate-in');
    void attachMenu.offsetWidth;
    attachMenu.classList.add('animate-in');
  }

  function closeAttachMenu() {
    attachMenu.classList.add('hidden');
    attachMenu.classList.remove('animate-in');
  }

  attachControlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (attachMenu.classList.contains('hidden')) openAttachMenu();
    else closeAttachMenu();
  });

  attachMenu.querySelectorAll('.attach-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      closeAttachMenu();
      if (action === 'image') imageInput.click();
      else if (action === 'video') videoInput.click();
      else if (action === 'audio') audioInput.click();
    });
  });

  document.addEventListener('click', (e) => {
    if (!attachMenu.classList.contains('hidden') && !attachMenu.contains(e.target) && e.target !== attachControlBtn) {
      closeAttachMenu();
    }
  });


  const recordingBar = el('recordingBar');
  const recordingTime = el('recordingTime');
  const recordCancelBtn = el('recordCancelBtn');
  const recordSendBtn = el('recordSendBtn');
  const messageFormEl = el('messageForm');

  // ---------- Редагування повідомлення ----------

  const editBar = el('editBar');
  const cancelEditBtn = el('cancelEditBtn');

  function startEditMessage(messageId, currentText) {
    // Редагування стосується лише тексту — прибираємо будь-які прикріплені файли, що чекають відправки
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

    state.editingMessageId = messageId;
    messageInputEl.value = currentText || '';
    autoResizeMessageInput();
    updateSendButtonMode();
    editBar.classList.remove('hidden');
    messageInputEl.focus();
  }

  function cancelEditMessage() {
    state.editingMessageId = null;
    messageInputEl.value = '';
    autoResizeMessageInput();
    updateSendButtonMode();
    editBar.classList.add('hidden');
  }

  cancelEditBtn.addEventListener('click', cancelEditMessage);

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
      updateSendButtonMode();
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
    sendTypingSignal('voice');

    messageFormEl.classList.add('hidden');
    recordingBar.classList.remove('hidden');
  }

  function stopRecording(cancel) {
    recordingCancelled = !!cancel;
    sendTypingSignal(null);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  async function sendVoiceMessage(file) {
    if (!state.activeChatId) return;
    try {
      sendTypingSignal('voice');
      const uploaded = await uploadFile(file);
      state.socket.emit('message:send', { chatId: state.activeChatId, text: '', audioUrl: uploaded.url }, (ack) => {
        if (ack && ack.error) console.error(ack.error);
      });
      sendTypingSignal(null);
    } catch (err) {
      sendTypingSignal(null);
      alert(err.message);
    }
  }

  recordSendBtn.addEventListener('click', () => stopRecording(false));
  recordCancelBtn.addEventListener('click', () => stopRecording(true));

  async function openPrivateChatWithUser(username) {
    if (username === state.user.username) return;
    try {
      const { chat } = await api('/api/chats/start', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      await loadChats();
      openChat({ chatId: chat.id, isGroup: false, withUser: chat.withUser });
    } catch (err) {
      console.error(err);
    }
  }

  async function openChat(entry) {
    pauseAllAudio();
    cancelEditMessage();
    stopTypingSignal();
    if (watchSession && watchSession.chatId !== entry.chatId) {
      if (watchSession.isGroup) leaveGroupWatch();
      else closeWatchSession(true);
    }
    if (pendingWatchInvite && pendingWatchInvite.chatId !== entry.chatId) {
      cancelPendingInvite();
    }
    if (incomingWatchInvite && incomingWatchInvite.chatId !== entry.chatId) {
      state.socket.emit('watch:decline', { chatId: incomingWatchInvite.chatId });
      hideWatchInviteModal();
    }
    if (isSwitchingVideo && switchingChatId !== entry.chatId) {
      if (!switchingIsGroup) state.socket.emit('watch:end', { chatId: switchingChatId });
      isSwitchingVideo = false;
      switchingChatId = null;
      switchingIsGroup = false;
    }
    if (isPartnerChoosing && partnerChoosingChatId !== entry.chatId) {
      if (partnerChoosingIsGroup) state.socket.emit('group-watch:leave', { chatId: partnerChoosingChatId });
      else state.socket.emit('watch:end', { chatId: partnerChoosingChatId });
      isPartnerChoosing = false;
      partnerChoosingChatId = null;
      partnerChoosingIsGroup = false;
    }
    if (groupWatchBannerChatId && groupWatchBannerChatId !== entry.chatId) {
      hideGroupWatchBanner();
    }
    const chatId = entry.chatId;
    state.activeChatId = chatId;
    state.activeChatIsGroup = !!entry.isGroup;
    if (entry.isGroup) {
      state.activeChatWith = null;
      state.activeGroup = {
        id: chatId,
        name: entry.groupName,
        avatarUrl: entry.groupAvatarUrl,
        memberCount: entry.memberCount,
      };
      // Якщо в цій групі вже триває перегляд — покажемо банер "N дивляться разом", не чекаючи
      // на живу подію (актуально після перезавантаження сторінки чи переходу в іншу групу)
      api(`/api/groups/${chatId}`).then((data) => {
        if (state.activeChatId !== chatId) return; // могли вже переключитись деінде, поки чекали відповідь
        if (data.group.watchActive) showGroupWatchBanner(chatId, data.group.watchParticipantCount);
      }).catch(() => {});
    } else {
      state.activeChatWith = entry.withUser;
      state.activeGroup = null;
    }
    exitSelectMode();
    emptyState.classList.add('hidden');
    activeChatEl.classList.remove('hidden');
    appScreen.classList.add('chat-open');
    renderChatHeader();
    sendChatActiveUpdate();
    renderChatList();

    // Якщо відкрита панель профілю чи карточка групи — тримаємо її відкритою й перемикаємо
    // на потрібний тип під новий чат (профіль ⇄ карточка групи), а не просто закриваємо.
    // openUserProfileModal/openGroupInfoModal самі закривають протилежну панель — паралельні
    // CSS-переходи ширини створюють плавне "перемикання" замість зникнення й появи заново
    const infoPanelOpen = userProfileModal.classList.contains('active') || groupInfoModal.classList.contains('active');
    if (infoPanelOpen) {
      if (entry.isGroup) openGroupInfoModal(entry.chatId);
      else if (entry.withUser) openUserProfileModal(entry.withUser.id);
    }

    // Плавний перехід: приховуємо старий вміст, показуємо новий уже після завантаження
    messagesEl.classList.add('chat-switching');

    try {
      const { messages } = await api(`/api/chats/${chatId}/messages`);
      messagesEl.innerHTML = '';
      messages.forEach((m) => appendMessage({
        id: m.id,
        chatId,
        senderId: m.senderId,
        senderUsername: m.senderUsername,
        senderAvatarUrl: m.senderAvatarUrl,
        text: m.text,
        imageUrl: m.imageUrl,
        audioUrl: m.audioUrl,
        videoUrl: m.videoUrl,
        readAt: m.readAt,
        editedAt: m.editedAt,
        eventType: m.eventType,
        reactions: m.reactions,
        createdAt: m.createdAt,
      }));
      scrollMessagesToBottom();
      markActiveChatReadIfVisible();
    } catch (err) {
      console.error(err);
    } finally {
      // Знімаємо клас у наступному кадрі — саме тоді запуститься CSS-перехід плавної появи
      requestAnimationFrame(() => messagesEl.classList.remove('chat-switching'));
    }
  }

  function pluralizeMembers(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    let word = 'учасників';
    if (mod10 === 1 && mod100 !== 11) word = 'учасник';
    else if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) word = 'учасники';
    return `${n} ${word}`;
  }

  function renderChatHeader() {
    const infoEl = el('chatHeaderInfo');
    if (state.activeChatIsGroup && state.activeGroup) {
      infoEl.classList.add('clickable');
      infoEl.onclick = () => openGroupInfoModal(state.activeGroup.id);
      el('chatWithUsername').classList.add('group-title');
      el('chatWithUsername').textContent = state.activeGroup.name;
      renderAvatarInto(el('chatHeaderAvatar'), state.activeGroup.name, state.activeGroup.avatarUrl);
      el('callBtn').classList.add('hidden');
      el('watchTogetherBtn').classList.remove('hidden');
    } else if (state.activeChatWith) {
      infoEl.classList.add('clickable');
      infoEl.onclick = () => openUserProfileModal(state.activeChatWith.id);
      el('chatWithUsername').classList.remove('group-title');
      el('chatWithUsername').textContent = state.activeChatWith.username;
      renderAvatarInto(el('chatHeaderAvatar'), state.activeChatWith.username, state.activeChatWith.avatarUrl);
      el('callBtn').classList.remove('hidden');
      el('watchTogetherBtn').classList.remove('hidden');
    }
    updateChatHeaderStatusLine();
  }

  function updateChatHeaderStatusLine() {
    const statusEl = el('chatHeaderStatus');
    const typingLabel = state.activeChatId ? getTypingLabelForChat(state.activeChatId) : null;
    if (typingLabel) {
      statusEl.textContent = typingLabel;
      statusEl.classList.add('online');
      return;
    }
    if (state.activeChatIsGroup && state.activeGroup) {
      statusEl.textContent = pluralizeMembers(state.activeGroup.memberCount);
      statusEl.classList.remove('online');
    } else if (state.activeChatWith) {
      renderChatHeaderStatus(state.activeChatWith.presence);
    }
  }

  function applyEditedTextToNode(node, text, editedAt) {
    let textSpan = node.querySelector('.msg-text');
    if (textSpan) {
      textSpan.textContent = text;
    } else if (text) {
      textSpan = document.createElement('span');
      textSpan.className = 'msg-text';
      textSpan.textContent = text;
      const timeRow = node.querySelector('.msg-time-row');
      node.insertBefore(textSpan, timeRow);
    }
    if (editedAt && !node.querySelector('.msg-edited-mark')) {
      const mark = document.createElement('span');
      mark.className = 'msg-edited-mark';
      mark.textContent = 'ред.';
      mark.title = formatExactDateTime(editedAt);
      const timeRow = node.querySelector('.msg-time-row');
      timeRow.insertBefore(mark, timeRow.firstChild);
    }
  }

  function appendMessage(msg) {
    if (msg.chatId !== state.activeChatId) return;

    const eventType = msg.eventType || msg.event_type;
    if (eventType) {
      const sysDiv = document.createElement('div');
      sysDiv.className = 'msg-system';
      if (msg.id != null) sysDiv.dataset.id = msg.id;
      sysDiv.textContent = msg.text || '';
      messagesEl.appendChild(sysDiv);
      return;
    }

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
    const senderUsername = msg.senderUsername || msg.sender_username;
    const showSenderName = state.activeChatIsGroup && !mine && senderUsername;

    let inner = '<div class="msg-checkbox"></div>';
    if (showSenderName) {
      inner += '<div class="msg-sender-row"><div class="msg-sender-avatar"></div>'
        + `<span class="msg-sender-name">${escapeHtml(senderUsername)}</span></div>`;
    }
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
    const editedAtValue = msg.editedAt || msg.edited_at;
    if (editedAtValue) {
      inner += `<span class="msg-edited-mark" title="${escapeAttr(formatExactDateTime(editedAtValue))}">ред.</span>`;
    }
    inner += `<span class="msg-time">${time}</span>`;
    if (mine) {
      const isRead = !!(msg.readAt || msg.read_at);
      inner += `<span class="msg-status${isRead ? ' read' : ''}">${isRead ? '✓✓' : '✓'}</span>`;
    }
    inner += '</span>';
    inner += '<div class="msg-reactions"></div>';

    div.innerHTML = inner;

    if (showSenderName) {
      const senderAvatarUrl = msg.senderAvatarUrl || msg.sender_avatar_url;
      renderAvatarInto(div.querySelector('.msg-sender-avatar'), senderUsername, senderAvatarUrl);
      const senderRow = div.querySelector('.msg-sender-row');
      senderRow.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectionMode) return;
        openPrivateChatWithUser(senderUsername);
      });
    }

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

    div.addEventListener('click', () => {
      if (!state.selectionMode || messageId == null) return;
      toggleMessageSelect(messageId, div);
    });

    if (messageId != null) {
      const menuInfo = {
        messageId,
        mine,
        text,
        imageUrl: imageUrl || null,
        audioUrl: audioUrl || null,
        videoUrl: videoUrl || null,
      };

      div.addEventListener('contextmenu', (e) => {
        if (state.selectionMode) return;
        e.preventDefault();
        openMessageMenu(e.clientX, e.clientY, div, menuInfo);
      });

      attachLongPressMenu(div, menuInfo);
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
    div.dataset.reactionsJson = JSON.stringify(reactions || []);
    box.innerHTML = '';
    reactions.forEach((r) => {
      const users = r.users || [];
      const mine = r.userIds && r.userIds.includes(state.user.id);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'msg-reaction-pill' + (mine ? ' mine' : '');
      pill.textContent = `${r.emoji} ${r.userIds.length}`;
      if (users.length) pill.title = users.map((u) => u.username).join(', ');
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

  let contextMenuTargetDiv = null;

  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  function attachLongPressMenu(div, info) {
    if (!isTouchDevice) return;
    let timer = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let fired = false;

    div.addEventListener('touchstart', (e) => {
      if (state.selectionMode) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      moved = false;
      fired = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (moved) return;
        fired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openMessageMenu(startX, startY, div, info);
      }, 450);
    }, { passive: true });

    div.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
        moved = true;
        clearTimeout(timer);
      }
    }, { passive: true });

    div.addEventListener('touchend', (e) => {
      clearTimeout(timer);
      // Довге утримання щойно відкрило меню — гасимо "синтетичний" клік по повідомленню,
      // щоб він одразу не закрив щойно відкрите меню
      if (fired) {
        e.preventDefault();
        fired = false;
      }
    });
    div.addEventListener('touchcancel', () => clearTimeout(timer));
  }

  function openMessageMenu(x, y, msgDiv, info) {
    closeMessageMenu();
    contextMenuTargetDiv = msgDiv;
    msgDiv.classList.add('context-active');
    lastMenuX = x;
    lastMenuY = y;

    reactionPopover.innerHTML = '';

    const emojiRow = document.createElement('div');
    emojiRow.className = 'context-menu-emojis';
    REACTIONS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-popover-item';
      btn.textContent = emoji;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendReaction(info.messageId, emoji);
        closeMessageMenu();
      });
      emojiRow.appendChild(btn);
    });
    reactionPopover.appendChild(emojiRow);

    // Хто саме поставив яку реакцію
    let reactions = [];
    try { reactions = JSON.parse(msgDiv.dataset.reactionsJson || '[]'); } catch (e) { reactions = []; }
    if (reactions.length) {
      const reactionsBox = document.createElement('div');
      reactionsBox.className = 'context-menu-reactions';
      reactions.forEach((r) => {
        const line = document.createElement('div');
        line.className = 'context-menu-reaction-line';
        const names = (r.users || []).map((u) => u.username).join(', ');
        line.innerHTML = `<span>${escapeHtml(r.emoji)}</span> ${escapeHtml(names)}`;
        reactionsBox.appendChild(line);
      });
      reactionPopover.appendChild(reactionsBox);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'context-menu-actions';

    const forwardBtn = document.createElement('button');
    forwardBtn.type = 'button';
    forwardBtn.className = 'context-menu-item';
    forwardBtn.innerHTML = '<span>↪</span> Переслати';
    forwardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMessageMenu();
      openForwardModal([{ text: info.text, imageUrl: info.imageUrl, audioUrl: info.audioUrl, videoUrl: info.videoUrl }]);
    });
    actionsRow.appendChild(forwardBtn);

    if (info.mine) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'context-menu-item';
      editBtn.innerHTML = '<span>✏️</span> Редагувати';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMessageMenu();
        startEditMessage(info.messageId, info.text);
      });
      actionsRow.appendChild(editBtn);

      const seenBtn = document.createElement('button');
      seenBtn.type = 'button';
      seenBtn.className = 'context-menu-item';
      seenBtn.innerHTML = '<span>👁</span> Переглянуто';
      seenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showReadReceipts(info.messageId, seenBtn);
      });
      actionsRow.appendChild(seenBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'context-menu-item danger';
    deleteBtn.innerHTML = '<span>🗑</span> Видалити';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMessageMenu();
      openDeleteChoiceModal([info.messageId], info.mine);
    });
    actionsRow.appendChild(deleteBtn);

    reactionPopover.appendChild(actionsRow);

    reactionPopover.classList.remove('hidden', 'closing');
    // Спочатку показуємо, щоб дізнатись реальні розміри, потім позиціонуємо в межах екрана
    positionPopoverNear(reactionPopover, x, y);

    // Перезапускаємо CSS-анімацію появи
    reactionPopover.classList.remove('animate-in');
    void reactionPopover.offsetWidth;
    reactionPopover.classList.add('animate-in');
  }

  let lastMenuX = 0;
  let lastMenuY = 0;

  function positionPopoverNear(popoverEl, x, y) {
    const rect = popoverEl.getBoundingClientRect();
    let left = x - rect.width / 2;
    let top = y - rect.height - 12;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    if (top < 8) top = y + 12;
    top = Math.min(top, window.innerHeight - rect.height - 8);
    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
  }

  async function showReadReceipts(messageId, anchorBtn) {
    let box = reactionPopover.querySelector('.context-menu-read-receipts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'context-menu-read-receipts';
      box.textContent = 'Завантаження…';
      reactionPopover.insertBefore(box, anchorBtn.closest('.context-menu-actions'));
      positionPopoverNear(reactionPopover, lastMenuX, lastMenuY);
    }
    try {
      const { reads } = await api(`/api/messages/${messageId}/reads`);
      if (!reads.length) {
        box.textContent = 'Ще ніхто не переглянув';
      } else {
        box.innerHTML = '';
        reads.forEach((r) => {
          const line = document.createElement('div');
          line.className = 'context-menu-read-line';
          line.textContent = `${r.username} · ${formatExactDateTime(r.readAt)}`;
          box.appendChild(line);
        });
      }
    } catch (err) {
      box.textContent = 'Не вдалося завантажити';
    } finally {
      // Контент міг змінити розмір попапа — перепозиціонуємо, щоб точно не вилазив за екран
      positionPopoverNear(reactionPopover, lastMenuX, lastMenuY);
    }
  }

  function closeMessageMenu() {
    if (contextMenuTargetDiv) {
      contextMenuTargetDiv.classList.remove('context-active');
      contextMenuTargetDiv = null;
    }
    if (!reactionPopover.classList.contains('hidden')) {
      reactionPopover.classList.add('hidden');
    }
    reactionPopover.classList.remove('animate-in');
  }

  document.addEventListener('click', (e) => {
    if (!reactionPopover.classList.contains('hidden') && !reactionPopover.contains(e.target)) {
      closeMessageMenu();
    }
    if (!chatMenuPopover.classList.contains('hidden') && !chatMenuPopover.contains(e.target)) {
      closeChatMenu();
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.msg')) closeMessageMenu();
    if (!e.target.closest('.chat-list-item')) closeChatMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMessageMenu(); closeChatMenu(); }
  });

  // ---------- Меню чату (правий клік / довге натискання на чаті у списку) ----------

  const chatMenuPopover = el('chatMenuPopover');
  let chatMenuTargetDiv = null;

  function openChatMenu(x, y, itemDiv, chat) {
    closeMessageMenu();
    closeChatMenu();
    chatMenuTargetDiv = itemDiv;
    itemDiv.classList.add('context-active');

    chatMenuPopover.innerHTML = '';
    const actionsRow = document.createElement('div');
    actionsRow.className = 'context-menu-actions';
    actionsRow.style.borderTop = 'none';
    actionsRow.style.paddingTop = '0';

    if (chat.isGroup) {
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'context-menu-item';
      infoBtn.innerHTML = '<span>ℹ️</span> Інформація про групу';
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatMenu();
        openGroupInfoModal(chat.chatId);
      });
      actionsRow.appendChild(infoBtn);

      const leaveBtn = document.createElement('button');
      leaveBtn.type = 'button';
      leaveBtn.className = 'context-menu-item danger';
      leaveBtn.innerHTML = '<span>🚪</span> Покинути групу';
      leaveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatMenu();
        if (!confirm(`Покинути групу "${chat.groupName}"?`)) return;
        leaveGroup(chat.chatId);
      });
      actionsRow.appendChild(leaveBtn);
    } else {
      const forMeBtn = document.createElement('button');
      forMeBtn.type = 'button';
      forMeBtn.className = 'context-menu-item';
      forMeBtn.innerHTML = '<span>🙈</span> Видалити чат для мене';
      forMeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatMenu();
        deleteChat(chat.chatId, 'me');
      });
      actionsRow.appendChild(forMeBtn);

      const forBothBtn = document.createElement('button');
      forBothBtn.type = 'button';
      forBothBtn.className = 'context-menu-item danger';
      forBothBtn.innerHTML = '<span>🗑</span> Видалити чат для обох';
      forBothBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatMenu();
        if (!confirm(`Видалити всю переписку з @${chat.withUser.username} для обох? Це незворотно.`)) return;
        deleteChat(chat.chatId, 'both');
      });
      actionsRow.appendChild(forBothBtn);
    }

    chatMenuPopover.appendChild(actionsRow);

    chatMenuPopover.classList.remove('hidden');
    const rect = chatMenuPopover.getBoundingClientRect();
    let left = x - rect.width / 2;
    let top = y - rect.height - 12;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    if (top < 8) top = y + 12;
    chatMenuPopover.style.left = `${left}px`;
    chatMenuPopover.style.top = `${top}px`;

    chatMenuPopover.classList.remove('animate-in');
    void chatMenuPopover.offsetWidth;
    chatMenuPopover.classList.add('animate-in');
  }

  function closeChatMenu() {
    if (chatMenuTargetDiv) {
      chatMenuTargetDiv.classList.remove('context-active');
      chatMenuTargetDiv = null;
    }
    chatMenuPopover.classList.add('hidden');
    chatMenuPopover.classList.remove('animate-in');
  }

  function attachChatLongPress(itemDiv, chat) {
    if (!isTouchDevice) return;
    let timer = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let fired = false;

    itemDiv.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      moved = false;
      fired = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (moved) return;
        fired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openChatMenu(startX, startY, itemDiv, chat);
      }, 450);
    }, { passive: true });

    itemDiv.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
        moved = true;
        clearTimeout(timer);
      }
    }, { passive: true });

    itemDiv.addEventListener('touchend', (e) => {
      clearTimeout(timer);
      if (fired) {
        e.preventDefault();
        fired = false;
      }
    });
    itemDiv.addEventListener('touchcancel', () => clearTimeout(timer));
  }

  function deleteChat(chatId, scope) {
    state.socket.emit('chat:delete', { chatId, scope }, (ack) => {
      if (ack && ack.error) {
        alert(ack.error);
        return;
      }
      applyChatRemoved(chatId);
    });
  }

  function leaveGroup(chatId) {
    state.socket.emit('group:leave', { chatId }, (ack) => {
      if (ack && ack.error) {
        alert(ack.error);
        return;
      }
      applyChatRemoved(chatId);
      closeGroupInfoModal();
    });
  }

  function applyChatRemoved(chatId) {
    state.chats = state.chats.filter((c) => c.chatId !== chatId);
    renderChatList();
    if (watchSession && watchSession.chatId === chatId) {
      // Групу видалили/мене з неї прибрали, поки я саме дивився в ній відео — просто прибираємо
      // локальний стан перегляду без нового emit: сервер уже сам вивів мене з учасників
      watchSession = null;
      resetWatchUI();
    }
    if (isPartnerChoosing && partnerChoosingChatId === chatId) {
      isPartnerChoosing = false;
      partnerChoosingChatId = null;
      partnerChoosingIsGroup = false;
      resetWatchUI();
    }
    if (groupWatchBannerChatId === chatId) hideGroupWatchBanner();
    if (state.activeChatId === chatId) {
      state.activeChatId = null;
      state.activeChatWith = null;
      state.activeChatIsGroup = false;
      state.activeGroup = null;
      exitSelectMode();
      activeChatEl.classList.add('hidden');
      emptyState.classList.remove('hidden');
      appScreen.classList.remove('chat-open');
    }
  }

  // ---------- Поле вводу, що росте (до ~4 рядків, далі скрол) ----------

  const messageInputEl = el('messageInput');
  const sendBtn = el('sendBtn');

  function updateSendButtonMode() {
    const hasContent = !!messageInputEl.value.trim() || pendingImageFile || pendingAudioFile || pendingVideoFile;
    const micMode = !hasContent && !state.editingMessageId;
    sendBtn.textContent = micMode ? '🎙️' : '➤';
    sendBtn.title = micMode ? 'Записати голосове' : (state.editingMessageId ? 'Зберегти' : 'Надіслати');
    sendBtn.classList.toggle('mic-mode', micMode);
  }
  updateSendButtonMode();

  function autoResizeMessageInput() {
    if (!messageInputEl.value) {
      // Текст порожній — скидаємо висоту й прокрутку до початкового однорядкового стану
      messageInputEl.style.height = '';
      messageInputEl.scrollTop = 0;
      return;
    }
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = messageInputEl.scrollHeight + 'px';
  }

  messageInputEl.addEventListener('input', () => {
    autoResizeMessageInput();
    updateSendButtonMode();
    if (messageInputEl.value.trim()) notifyTyping();
    else stopTypingSignal();
  });

  messageInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const hasContent = messageInputEl.value.trim() || pendingImageFile || pendingAudioFile || pendingVideoFile;
      // Enter надсилає лише коли є що надсилати — не запускає запис голосового на порожньому полі
      if (hasContent) el('messageForm').requestSubmit();
    }
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
      autoResizeMessageInput();
      updateSendButtonMode();
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
    selectionDeleteBtn.disabled = count === 0;
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
    const ids = [...state.selectedIds];
    const allMine = ids.every((id) => {
      const node = messagesEl.querySelector(`[data-id="${id}"]`);
      return node && String(node.dataset.senderId) === String(state.user.id);
    });
    openDeleteChoiceModal(ids, allMine, () => exitSelectMode());
  });

  function deleteMessages(ids, scope) {
    if (!state.activeChatId || !ids.length) return;
    state.socket.emit('message:delete', { chatId: state.activeChatId, messageIds: ids, scope }, (ack) => {
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

  // ---------- Вибір способу видалення (для мене / для всіх) ----------

  const deleteChoiceModal = el('deleteChoiceModal');
  const deleteForMeBtn = el('deleteForMeBtn');
  const deleteForEveryoneBtn = el('deleteForEveryoneBtn');
  let pendingDeleteIds = [];
  let pendingDeleteCallback = null;

  function openDeleteChoiceModal(ids, canDeleteForEveryone, onDone) {
    pendingDeleteIds = ids;
    pendingDeleteCallback = onDone || null;
    deleteForEveryoneBtn.classList.toggle('hidden', !canDeleteForEveryone);
    deleteChoiceModal.classList.remove('hidden');
  }

  function closeDeleteChoiceModal() {
    deleteChoiceModal.classList.add('hidden');
    pendingDeleteIds = [];
    pendingDeleteCallback = null;
  }

  deleteForMeBtn.addEventListener('click', () => {
    const ids = pendingDeleteIds;
    const cb = pendingDeleteCallback;
    closeDeleteChoiceModal();
    deleteMessages(ids, 'me');
    if (cb) cb();
  });

  deleteForEveryoneBtn.addEventListener('click', () => {
    const ids = pendingDeleteIds;
    const cb = pendingDeleteCallback;
    closeDeleteChoiceModal();
    deleteMessages(ids, 'everyone');
    if (cb) cb();
  });

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
      const label = chat.isGroup ? chat.groupName : chat.withUser.username;
      item.className = 'forward-chat-item' + (chat.isGroup ? ' group' : '');
      item.textContent = label;
      item.addEventListener('click', () => forwardItemsTo(chat.chatId, label));
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
  document.querySelectorAll('[data-close="deleteChoice"]').forEach((btn) => btn.addEventListener('click', closeDeleteChoiceModal));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!watchInviteModal.classList.contains('hidden')) {
      state.socket.emit('watch:decline', { chatId: incomingWatchInvite.chatId });
      hideWatchInviteModal();
    } else if (pendingWatchInvite) cancelPendingInvite();
    else if (!deleteChoiceModal.classList.contains('hidden')) closeDeleteChoiceModal();
    else if (userProfileModal.classList.contains('active')) closeUserProfileModal();
    else if (groupInfoModal.classList.contains('active')) closeGroupInfoModal();
    else if (!createGroupModal.classList.contains('hidden')) closeCreateGroupModal();
    else if (!settingsModal.classList.contains('hidden')) closeSettingsModal();
    else if (!forwardModal.classList.contains('hidden')) closeForwardModal();
    else if (!imageModal.classList.contains('hidden')) closeImageModal();
  });

  // ---------- Налаштування профілю (аватарка) ----------

  const meProfileBtn = el('meProfileBtn');
  const chatBackBtn = el('chatBackBtn');

  chatBackBtn.addEventListener('click', () => {
    appScreen.classList.remove('chat-open');
  });

  const settingsModal = el('settingsModal');
  const settingsAvatar = el('settingsAvatar');
  const settingsUsername = el('settingsUsername');
  const settingsStatus = el('settingsStatus');
  const avatarInput = el('avatarInput');
  const changeAvatarBtn = el('changeAvatarBtn');
  const removeAvatarBtn = el('removeAvatarBtn');
  const showLastSeenToggle = el('showLastSeenToggle');

  function renderAvatarHistoryGrid(gridEl, sectionEl, history) {
    gridEl.innerHTML = '';
    if (!history || !history.length) {
      sectionEl.classList.add('hidden');
      return;
    }
    sectionEl.classList.remove('hidden');
    history.forEach((h) => {
      const item = document.createElement('div');
      item.className = 'avatar-history-item';
      item.title = formatExactDateTime(h.createdAt);
      const img = document.createElement('img');
      img.src = h.avatarUrl;
      img.alt = '';
      item.appendChild(img);
      item.addEventListener('click', () => openMediaModal(h.avatarUrl, 'image'));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'avatar-history-delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Видалити цю аватарку';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Видалити цю аватарку назавжди?')) return;
        try {
          const data = await api(`/api/me/avatar-history/${h.id}`, { method: 'DELETE' });
          state.user.avatarUrl = data.avatarUrl;
          persistUser();
          const me = await api('/api/me');
          renderAvatarHistoryGrid(settingsHistoryGrid, settingsHistorySection, me.user.avatarHistory);
        } catch (err) {
          showSettingsStatus(err.message);
        }
      });
      item.appendChild(deleteBtn);

      gridEl.appendChild(item);
    });
  }

  const settingsHistorySection = el('settingsHistorySection');
  const settingsHistoryGrid = el('settingsHistoryGrid');

  function openSettingsModal() {
    settingsStatus.classList.add('hidden');
    settingsUsername.textContent = state.user.username;
    renderAvatarInto(settingsAvatar, state.user.username, state.user.avatarUrl);
    showLastSeenToggle.checked = state.user.showLastSeen !== false;
    settingsHistorySection.classList.add('hidden');
    settingsModal.classList.remove('hidden');
    api('/api/me').then(({ user }) => {
      renderAvatarHistoryGrid(settingsHistoryGrid, settingsHistorySection, user.avatarHistory);
    }).catch(() => {});
  }

  // ---------- Профіль користувача (клік на аватарку/юзернейм у шапці особистого чату) ----------

  const userProfileModal = el('userProfileModal');
  const userProfilePhoto = el('userProfilePhoto');
  const userProfilePhotoFallback = el('userProfilePhotoFallback');
  const userProfileDots = el('userProfileDots');
  const userProfilePrevBtn = el('userProfilePrevBtn');
  const userProfileNextBtn = el('userProfileNextBtn');
  const userProfileUsername = el('userProfileUsername');
  const userProfileStatus = el('userProfileStatus');

  let profilePhotos = [];
  let profilePhotoIndex = 0;
  let profileUsernameForFallback = '?';

  async function openUserProfileModal(userId) {
    closeGroupInfoModal();
    userProfileStatus.classList.add('hidden');
    userProfileUsername.textContent = '';
    profilePhotos = [];
    profilePhotoIndex = 0;
    renderProfilePhoto();
    userProfileModal.classList.add('active');
    try {
      const { user } = await api(`/api/users/${userId}`);
      userProfileUsername.textContent = user.username;
      profileUsernameForFallback = user.username;
      profilePhotos = (user.avatarHistory && user.avatarHistory.length)
        ? user.avatarHistory
        : (user.avatarUrl ? [{ avatarUrl: user.avatarUrl }] : []);
      profilePhotoIndex = 0;
      renderProfilePhoto();
    } catch (err) {
      userProfileStatus.textContent = err.message;
      userProfileStatus.classList.remove('hidden');
    }
  }

  function renderProfilePhoto() {
    const total = profilePhotos.length;

    userProfileDots.innerHTML = '';
    if (total > 1) {
      for (let i = 0; i < total; i++) {
        const dot = document.createElement('div');
        dot.className = 'profile-photo-dot' + (i === profilePhotoIndex ? ' active' : '');
        userProfileDots.appendChild(dot);
      }
    }
    userProfilePrevBtn.classList.toggle('hidden', total <= 1);
    userProfileNextBtn.classList.toggle('hidden', total <= 1);

    if (total === 0) {
      userProfilePhoto.classList.add('hidden');
      userProfilePhotoFallback.classList.remove('hidden');
      userProfilePhotoFallback.style.background = colorForUsername(profileUsernameForFallback);
      userProfilePhotoFallback.textContent = (profileUsernameForFallback || '?').charAt(0);
    } else {
      userProfilePhotoFallback.classList.add('hidden');
      userProfilePhoto.classList.remove('hidden');
      userProfilePhoto.src = profilePhotos[profilePhotoIndex].avatarUrl;
    }
  }

  userProfilePrevBtn.addEventListener('click', () => {
    if (!profilePhotos.length) return;
    profilePhotoIndex = (profilePhotoIndex - 1 + profilePhotos.length) % profilePhotos.length;
    renderProfilePhoto();
  });
  userProfileNextBtn.addEventListener('click', () => {
    if (!profilePhotos.length) return;
    profilePhotoIndex = (profilePhotoIndex + 1) % profilePhotos.length;
    renderProfilePhoto();
  });

  function closeUserProfileModal() {
    userProfileModal.classList.remove('active');
  }

  document.querySelectorAll('[data-close="userProfile"]').forEach((btn) => btn.addEventListener('click', closeUserProfileModal));

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

  el('cleanupFilesBtn').addEventListener('click', async () => {
    if (!confirm('Видалити всі файли, які ніде не використовуються (старі відео зі спільного перегляду, залишки після видалених повідомлень тощо)? Це не вплине на активні аватарки й вкладення в чатах.')) {
      return;
    }
    const btn = el('cleanupFilesBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Очищення…';
    try {
      const data = await api('/api/admin/cleanup-orphaned-files', { method: 'POST' });
      showSettingsStatus(
        data.deletedCount > 0
          ? `Видалено файлів: ${data.deletedCount}, звільнено ${data.freedMB} МБ`
          : 'Невикористаних файлів не знайдено'
      );
    } catch (err) {
      showSettingsStatus(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
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
    if (!confirm('Видалити поточну аватарку назавжди?')) return;
    removeAvatarBtn.disabled = true;
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + state.token },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не вдалося видалити аватарку');
      // Тепер сервер сам повертає попередню аватарку з історії (якщо є), а не завжди null
      state.user.avatarUrl = data.avatarUrl;
      persistUser();
      showSettingsStatus(data.avatarUrl ? 'Аватарку видалено, встановлено попередню' : 'Аватарку видалено');
      const me = await api('/api/me');
      renderAvatarHistoryGrid(settingsHistoryGrid, settingsHistorySection, me.user.avatarHistory);
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
    if (!state.activeChatId) return;
    const input = el('messageInput');
    const text = input.value.trim();

    if (state.editingMessageId) {
      if (!text) {
        alert('Текст повідомлення не може бути порожнім');
        return;
      }
      const editId = state.editingMessageId;
      stopTypingSignal();
      state.socket.emit('message:edit', { messageId: editId, text }, (ack) => {
        if (ack && ack.error) alert(ack.error);
      });
      cancelEditMessage();
      return;
    }

    const hasContent = text || pendingImageFile || pendingAudioFile || pendingVideoFile;

    if (!hasContent) {
      // Поле порожнє — кнопка зараз у режимі мікрофона, тож замість надсилання починаємо запис
      startRecording();
      return;
    }

    stickerPopover.classList.add('hidden');
    stopTypingSignal();

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      let imageUrl = null;
      let audioUrl = null;
      let videoUrl = null;
      if (pendingImageFile) {
        sendTypingSignal('photo');
        const uploaded = await uploadFile(pendingImageFile);
        imageUrl = uploaded.url;
      }
      if (pendingAudioFile) {
        sendTypingSignal('audio');
        const uploaded = await uploadFile(pendingAudioFile);
        audioUrl = uploaded.url;
      }
      if (pendingVideoFile) {
        sendTypingSignal('video');
        const uploaded = await uploadFile(pendingVideoFile);
        videoUrl = uploaded.url;
      }
      state.socket.emit('message:send', { chatId: state.activeChatId, text, imageUrl, audioUrl, videoUrl }, (ack) => {
        if (ack && ack.error) console.error(ack.error);
      });
      sendTypingSignal(null);
      input.value = '';
      autoResizeMessageInput();
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
      updateSendButtonMode();
    } catch (err) {
      sendTypingSignal(null);
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

  function formatExactDateTime(iso) {
    if (!iso) return '';
    const d = parseServerDate(iso);
    if (!d) return '';
    const time = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const now = new Date();
    const isSameDay = d.toDateString() === now.toDateString();
    if (isSameDay) return `сьогодні о ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `вчора о ${time}`;
    const dateStr = d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${dateStr} о ${time}`;
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

    // Рахуємо "щойно" від реального часу на клієнті (а не від статичного прапорця з моменту події),
    // щоб текст сам оновився на точний час через хвилину без нової події з сервера
    const secondsSinceSeen = (now - seenDate) / 1000;
    if (secondsSinceSeen < 60) {
      return { text: 'був(ла) щойно', online: false };
    }

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

  // Раз на 15 секунд перемальовуємо статус відкритого чату — щоб "щойно" саме
  // перетворилось на точний час через хвилину, без перезавантаження сторінки
  setInterval(() => {
    if (state.activeChatWith) {
      renderChatHeaderStatus(state.activeChatWith.presence);
    }
  }, 15000);

  // ---------- Групові чати ----------

  function attachUserSearch(inputEl, resultsEl, onPick, excludeIds) {
    let timer = null;
    inputEl.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inputEl.value.trim();
      if (!q) {
        resultsEl.classList.add('hidden');
        return;
      }
      timer = setTimeout(async () => {
        try {
          const { users } = await api('/api/search?username=' + encodeURIComponent(q));
          const filtered = users.filter((u) => !(excludeIds && excludeIds().includes(u.id)));
          resultsEl.innerHTML = '';
          if (!filtered.length) {
            resultsEl.innerHTML = '<div class="search-result-item" style="cursor:default;color:var(--text-dim)">Нікого не знайдено</div>';
            resultsEl.classList.remove('hidden');
            return;
          }
          filtered.forEach((u) => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.textContent = u.username;
            item.addEventListener('click', () => {
              inputEl.value = '';
              resultsEl.classList.add('hidden');
              onPick(u);
            });
            resultsEl.appendChild(item);
          });
          resultsEl.classList.remove('hidden');
        } catch (err) {
          console.error(err);
        }
      }, 250);
    });
    document.addEventListener('click', (e) => {
      if (!resultsEl.classList.contains('hidden') && !resultsEl.contains(e.target) && e.target !== inputEl) {
        resultsEl.classList.add('hidden');
      }
    });
  }

  // ---------- Створення групи ----------

  const newGroupBtn = el('newGroupBtn');
  const createGroupModal = el('createGroupModal');
  const createGroupAvatar = el('createGroupAvatar');
  const createGroupAvatarInput = el('createGroupAvatarInput');
  const createGroupAvatarBtn = el('createGroupAvatarBtn');
  const createGroupNameInput = el('createGroupNameInput');
  const createGroupInviteInput = el('createGroupInviteInput');
  const createGroupInviteResults = el('createGroupInviteResults');
  const createGroupMembers = el('createGroupMembers');
  const createGroupStatus = el('createGroupStatus');
  const createGroupSubmitBtn = el('createGroupSubmitBtn');

  let pendingGroupAvatarFile = null;
  let pendingGroupMembers = [];

  function openCreateGroupModal() {
    pendingGroupAvatarFile = null;
    pendingGroupMembers = [];
    createGroupNameInput.value = '';
    createGroupInviteInput.value = '';
    createGroupStatus.classList.add('hidden');
    renderAvatarInto(createGroupAvatar, '?', null);
    renderGroupMemberChips();
    createGroupModal.classList.remove('hidden');
  }

  function closeCreateGroupModal() {
    createGroupModal.classList.add('hidden');
  }

  function renderGroupMemberChips() {
    createGroupMembers.innerHTML = '';
    pendingGroupMembers.forEach((u) => {
      const chip = document.createElement('div');
      chip.className = 'group-member-chip';
      chip.innerHTML = `<span>@${escapeHtml(u.username)}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        pendingGroupMembers = pendingGroupMembers.filter((m) => m.id !== u.id);
        renderGroupMemberChips();
      });
      chip.appendChild(removeBtn);
      createGroupMembers.appendChild(chip);
    });
  }

  attachUserSearch(createGroupInviteInput, createGroupInviteResults, (u) => {
    pendingGroupMembers.push(u);
    renderGroupMemberChips();
  }, () => pendingGroupMembers.map((m) => m.id));

  newGroupBtn.addEventListener('click', openCreateGroupModal);

  createGroupAvatarBtn.addEventListener('click', () => createGroupAvatarInput.click());
  createGroupAvatarInput.addEventListener('change', () => {
    const file = createGroupAvatarInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      createGroupStatus.textContent = 'Файл занадто великий (максимум 5 МБ)';
      createGroupStatus.classList.remove('hidden');
      createGroupAvatarInput.value = '';
      return;
    }
    pendingGroupAvatarFile = file;
    createGroupAvatar.innerHTML = `<img class="avatar" src="${URL.createObjectURL(file)}" alt="">`;
  });

  createGroupSubmitBtn.addEventListener('click', async () => {
    const name = createGroupNameInput.value.trim();
    if (!name) {
      createGroupStatus.textContent = 'Вкажіть назву групи';
      createGroupStatus.classList.remove('hidden');
      return;
    }
    createGroupSubmitBtn.disabled = true;
    createGroupStatus.classList.add('hidden');
    try {
      const { group } = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
      const chatId = group.id;

      if (pendingGroupAvatarFile) {
        const formData = new FormData();
        formData.append('avatar', pendingGroupAvatarFile);
        await fetch(`/api/groups/${chatId}/avatar`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + state.token },
          body: formData,
        });
      }

      for (const member of pendingGroupMembers) {
        try {
          await api(`/api/groups/${chatId}/invite`, { method: 'POST', body: JSON.stringify({ username: member.username }) });
        } catch (err) {
          console.error('Не вдалося запросити', member.username, err);
        }
      }

      closeCreateGroupModal();
      await loadChats();
      const entry = state.chats.find((c) => c.chatId === chatId);
      if (entry) openChat(entry);
    } catch (err) {
      createGroupStatus.textContent = err.message;
      createGroupStatus.classList.remove('hidden');
    } finally {
      createGroupSubmitBtn.disabled = false;
    }
  });

  // ---------- Інформація про групу ----------

  const groupInfoModal = el('groupInfoModal');
  const groupInfoAvatar = el('groupInfoAvatar');
  const groupInfoAvatarInput = el('groupInfoAvatarInput');
  const groupInfoChangeAvatarBtn = el('groupInfoChangeAvatarBtn');
  const groupInfoNameView = el('groupInfoNameView');
  const groupInfoNameEdit = el('groupInfoNameEdit');
  const groupInfoNameInput = el('groupInfoNameInput');
  const groupInfoRenameBtn = el('groupInfoRenameBtn');
  const groupInfoNameSaveBtn = el('groupInfoNameSaveBtn');
  const groupInfoMemberCount = el('groupInfoMemberCount');
  const groupInfoInviteInput = el('groupInfoInviteInput');
  const groupInfoInviteResults = el('groupInfoInviteResults');
  const groupInfoMembersList = el('groupInfoMembersList');
  const groupInfoStatus = el('groupInfoStatus');
  const groupLeaveBtn = el('groupLeaveBtn');

  let openGroupInfoChatId = null;
  let openGroupInfoData = null;

  async function openGroupInfoModal(chatId) {
    closeUserProfileModal();
    openGroupInfoChatId = chatId;
    groupInfoStatus.classList.add('hidden');
    groupInfoNameEdit.classList.add('hidden');
    groupInfoModal.classList.add('active');
    await refreshGroupInfoModal();
  }

  async function refreshGroupInfoModal() {
    if (!openGroupInfoChatId) return;
    try {
      const { group } = await api(`/api/groups/${openGroupInfoChatId}`);
      openGroupInfoData = group;
      renderGroupInfoModal(group);
    } catch (err) {
      groupInfoStatus.textContent = err.message;
      groupInfoStatus.classList.remove('hidden');
    }
  }

  function renderGroupInfoModal(group) {
    const isAdmin = group.members.some((m) => m.id === state.user.id && (m.role === 'admin' || m.isOwner));
    renderAvatarInto(groupInfoAvatar, group.groupName, group.groupAvatarUrl);
    groupInfoNameView.textContent = group.groupName;
    groupInfoMemberCount.textContent = pluralizeMembers(group.memberCount);
    groupInfoChangeAvatarBtn.classList.toggle('hidden', !isAdmin);
    groupInfoRenameBtn.classList.toggle('hidden', !isAdmin);
    groupInfoNameEdit.classList.add('hidden');

    groupInfoMembersList.innerHTML = '';
    group.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'group-member-row';

      const avatarSlot = document.createElement('div');
      avatarSlot.className = 'avatar-slot';
      row.appendChild(avatarSlot);

      const textCol = document.createElement('div');
      textCol.className = 'group-member-row-text';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'group-member-row-name';
      nameSpan.textContent = m.username;
      textCol.appendChild(nameSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'group-member-row-status';
      const formatted = formatPresence(m.presence);
      if (formatted) {
        statusSpan.textContent = formatted.text;
        statusSpan.classList.toggle('online', formatted.online);
        textCol.appendChild(statusSpan);
      }
      row.appendChild(textCol);

      if (m.isOwner) {
        const badge = document.createElement('span');
        badge.className = 'group-member-role-badge owner';
        badge.textContent = 'власник';
        row.appendChild(badge);
      } else if (m.role === 'admin') {
        const badge = document.createElement('span');
        badge.className = 'group-member-role-badge';
        badge.textContent = 'адмін';
        row.appendChild(badge);
      }

      if (isAdmin && !m.isOwner && m.id !== state.user.id) {
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'group-member-kick-btn';
        kickBtn.title = `Видалити @${m.username} з групи`;
        kickBtn.textContent = '✕';
        kickBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Видалити @${m.username} з групи?`)) return;
          kickGroupMember(group.id, m.id);
        });
        row.appendChild(kickBtn);
      }

      groupInfoMembersList.appendChild(row);
      renderAvatarInto(avatarSlot, m.username, m.avatarUrl);
    });
  }

  function kickGroupMember(chatId, userId) {
    state.socket.emit('group:kick', { chatId, userId }, (ack) => {
      if (ack && ack.error) {
        groupInfoStatus.textContent = ack.error;
        groupInfoStatus.classList.remove('hidden');
      }
    });
  }

  function closeGroupInfoModal() {
    groupInfoModal.classList.remove('active');
    openGroupInfoChatId = null;
    openGroupInfoData = null;
  }

  groupInfoRenameBtn.addEventListener('click', () => {
    groupInfoNameInput.value = openGroupInfoData ? openGroupInfoData.groupName : '';
    groupInfoNameEdit.classList.remove('hidden');
  });

  groupInfoNameSaveBtn.addEventListener('click', async () => {
    const name = groupInfoNameInput.value.trim();
    if (!name || !openGroupInfoChatId) return;
    try {
      await api(`/api/groups/${openGroupInfoChatId}/rename`, { method: 'POST', body: JSON.stringify({ name }) });
      groupInfoNameEdit.classList.add('hidden');
      await refreshGroupInfoModal();
    } catch (err) {
      groupInfoStatus.textContent = err.message;
      groupInfoStatus.classList.remove('hidden');
    }
  });

  groupInfoChangeAvatarBtn.addEventListener('click', () => groupInfoAvatarInput.click());
  groupInfoAvatarInput.addEventListener('change', async () => {
    const file = groupInfoAvatarInput.files[0];
    if (!file || !openGroupInfoChatId) return;
    if (file.size > 5 * 1024 * 1024) {
      groupInfoStatus.textContent = 'Файл занадто великий (максимум 5 МБ)';
      groupInfoStatus.classList.remove('hidden');
      groupInfoAvatarInput.value = '';
      return;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    try {
      const res = await fetch(`/api/groups/${openGroupInfoChatId}/avatar`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не вдалося оновити аватарку');
      await refreshGroupInfoModal();
    } catch (err) {
      groupInfoStatus.textContent = err.message;
      groupInfoStatus.classList.remove('hidden');
    } finally {
      groupInfoAvatarInput.value = '';
    }
  });

  attachUserSearch(groupInfoInviteInput, groupInfoInviteResults, async (u) => {
    if (!openGroupInfoChatId) return;
    try {
      await api(`/api/groups/${openGroupInfoChatId}/invite`, { method: 'POST', body: JSON.stringify({ username: u.username }) });
      await refreshGroupInfoModal();
    } catch (err) {
      groupInfoStatus.textContent = err.message;
      groupInfoStatus.classList.remove('hidden');
    }
  }, () => (openGroupInfoData ? openGroupInfoData.members.map((m) => m.id) : []));

  groupLeaveBtn.addEventListener('click', () => {
    if (!openGroupInfoChatId || !openGroupInfoData) return;
    if (!confirm(`Покинути групу "${openGroupInfoData.groupName}"?`)) return;
    leaveGroup(openGroupInfoChatId);
  });

  document.querySelectorAll('[data-close="createGroup"]').forEach((btn) => btn.addEventListener('click', closeCreateGroupModal));
  document.querySelectorAll('[data-close="groupInfo"]').forEach((btn) => btn.addEventListener('click', closeGroupInfoModal));

  // ---------- Дзвінки (WebRTC, лише в особистих чатах) ----------

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const callModal = el('callModal');
  const callModalContent = el('callModalContent');
  const callAvatar = el('callAvatar');
  const callUsername = el('callUsername');
  const callStatusText = el('callStatusText');
  const remoteCallAudio = el('remoteCallAudio');
  const callDeclineBtn = el('callDeclineBtn');
  const callAcceptBtn = el('callAcceptBtn');
  const callMuteBtn = el('callMuteBtn');
  const callEndBtn = el('callEndBtn');
  const callBtn = el('callBtn');
  const callVideoArea = el('callVideoArea');
  const callRemoteScreen = el('callRemoteScreen');
  const callLocalScreen = el('callLocalScreen');
  const callScreenShareBtn = el('callScreenShareBtn');
  const callFullscreenBtn = el('callFullscreenBtn');
  const remoteScreenAudio = el('remoteScreenAudio');

  let currentCall = null; // { callId, chatId, peerId, peerUsername, peerAvatarUrl, pc, localStream, role, pendingOffer, screenStream, screenSender }
  let callTimerInterval = null;
  let callRingTimeout = null;

  function updateVideoAreaLayout() {
    const hasRemote = !callRemoteScreen.classList.contains('hidden');
    const hasLocal = !callLocalScreen.classList.contains('hidden');
    const hasVideo = hasRemote || hasLocal;
    callVideoArea.classList.toggle('hidden', !hasVideo);
    callVideoArea.classList.toggle('only-local', hasLocal && !hasRemote);
    callModalContent.classList.toggle('has-video', hasVideo);
    callFullscreenBtn.classList.toggle('hidden', !hasVideo);
    if (!hasVideo && document.fullscreenElement === callVideoArea) {
      document.exitFullscreen().catch(() => {});
    }
  }

  callFullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      callVideoArea.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', () => {
    callFullscreenBtn.textContent = document.fullscreenElement === callVideoArea ? '⤢' : '⛶';
  });

  function setupPeerConnectionHandlers(pc) {
    pc.onicecandidate = (e) => {
      if (e.candidate && currentCall && currentCall.callId) {
        state.socket.emit('call:ice-candidate', { callId: currentCall.callId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        callRemoteScreen.srcObject = e.streams[0];
        callRemoteScreen.classList.remove('hidden');
        updateVideoAreaLayout();
        e.track.onended = () => {
          callRemoteScreen.classList.add('hidden');
          callRemoteScreen.srcObject = null;
          updateVideoAreaLayout();
        };
        return;
      }
      // Аудіо: перший аудіотрек, який приходить під час дзвінка — це голос співрозмовника (мікрофон).
      // Якщо пізніше приходить ще один аудіотрек з ІНШИМ ID потоку — це системний звук демонстрації екрана,
      // його виводимо окремо, щоб не заглушити мікрофон
      const streamId = e.streams[0] ? e.streams[0].id : null;
      if (!currentCall.remoteMicStreamId || streamId === currentCall.remoteMicStreamId) {
        if (!currentCall.remoteMicStreamId) currentCall.remoteMicStreamId = streamId;
        remoteCallAudio.srcObject = e.streams[0];
      } else {
        remoteScreenAudio.srcObject = e.streams[0];
        e.track.onended = () => { remoteScreenAudio.srcObject = null; };
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endCall();
      }
    };
  }

  function showCallUI(mode, peer) {
    if (peer) {
      renderAvatarInto(callAvatar, peer.username, peer.avatarUrl);
      callUsername.textContent = peer.username;
    }
    callModalContent.classList.toggle('active', mode === 'active');
    callDeclineBtn.classList.toggle('hidden', mode !== 'incoming');
    callAcceptBtn.classList.toggle('hidden', mode !== 'incoming');
    callEndBtn.classList.toggle('hidden', mode === 'incoming');
    callMuteBtn.classList.toggle('hidden', mode !== 'active');
    callMuteBtn.classList.remove('active');
    callScreenShareBtn.classList.toggle('hidden', mode !== 'active');
    callScreenShareBtn.classList.remove('active');

    if (mode === 'outgoing') callStatusText.textContent = 'Дзвонимо…';
    else if (mode === 'incoming') callStatusText.textContent = 'Вхідний дзвінок…';
    else if (mode === 'active') callStatusText.textContent = '00:00';
    callStatusText.classList.toggle('timer', mode === 'active');

    callModal.classList.remove('hidden');
  }

  function hideCallUI() {
    callModal.classList.add('hidden');
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    remoteCallAudio.srcObject = null;
    remoteScreenAudio.srcObject = null;
    callRemoteScreen.srcObject = null;
    callRemoteScreen.classList.add('hidden');
    callLocalScreen.srcObject = null;
    callLocalScreen.classList.add('hidden');
    updateVideoAreaLayout();
  }

  function startCallTimer() {
    const startedAt = Date.now();
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      callStatusText.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function cleanupCallResources() {
    if (currentCall) {
      if (currentCall.pc) {
        try { currentCall.pc.close(); } catch (e) { /* ignore */ }
      }
      if (currentCall.localStream) {
        currentCall.localStream.getTracks().forEach((t) => t.stop());
      }
      if (currentCall.screenStream) {
        currentCall.screenStream.getTracks().forEach((t) => t.stop());
      }
    }
    clearTimeout(callRingTimeout);
    callRingTimeout = null;
    currentCall = null;
  }

  async function startScreenShare() {
    if (!currentCall || !currentCall.pc || currentCall.screenStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('Цей браузер не підтримує демонстрацію екрана');
      return;
    }
    let screenStream;
    try {
      // audio: true — спроба захопити системний звук трансляції (звук вкладки/системи).
      // Підтримка залежить від браузера й того, що саме людина обере ділитись (вкладка з Chrome
      // зазвичай дозволяє, повний екран — залежить від ОС); якщо звук не підхопився, це не помилка —
      // просто продовжуємо без нього
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      return; // людина сама скасувала вибір вікна/екрана — нічого страшного
    }
    const videoTrack = screenStream.getVideoTracks()[0];
    const videoSender = currentCall.pc.addTrack(videoTrack, screenStream);
    currentCall.screenStream = screenStream;
    currentCall.screenSender = videoSender;

    const audioTrack = screenStream.getAudioTracks()[0];
    if (audioTrack) {
      currentCall.screenAudioSender = currentCall.pc.addTrack(audioTrack, screenStream);
    } else {
      currentCall.screenAudioSender = null;
    }

    callLocalScreen.srcObject = screenStream;
    callLocalScreen.classList.remove('hidden');
    updateVideoAreaLayout();
    callScreenShareBtn.classList.add('active');

    // Якщо людина натисне вбудовану кнопку браузера "Припинити доступ" — гасимо демонстрацію коректно
    videoTrack.onended = () => stopScreenShare();

    try {
      const offer = await currentCall.pc.createOffer();
      await currentCall.pc.setLocalDescription(offer);
      state.socket.emit('call:renegotiate-offer', { callId: currentCall.callId, offer });
    } catch (err) {
      console.error(err);
    }
  }

  async function stopScreenShare() {
    if (!currentCall || !currentCall.screenStream) return;
    currentCall.screenStream.getTracks().forEach((t) => t.stop());
    if (currentCall.screenSender && currentCall.pc) {
      try { currentCall.pc.removeTrack(currentCall.screenSender); } catch (e) { /* ignore */ }
    }
    if (currentCall.screenAudioSender && currentCall.pc) {
      try { currentCall.pc.removeTrack(currentCall.screenAudioSender); } catch (e) { /* ignore */ }
    }
    currentCall.screenStream = null;
    currentCall.screenSender = null;
    currentCall.screenAudioSender = null;

    callLocalScreen.srcObject = null;
    callLocalScreen.classList.add('hidden');
    updateVideoAreaLayout();
    callScreenShareBtn.classList.remove('active');

    if (currentCall.pc) {
      try {
        const offer = await currentCall.pc.createOffer();
        await currentCall.pc.setLocalDescription(offer);
        state.socket.emit('call:renegotiate-offer', { callId: currentCall.callId, offer });
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function startCall(peer) {
    if (currentCall) {
      alert('У вас вже є активний дзвінок');
      return;
    }
    if (!navigator.mediaDevices || !window.RTCPeerConnection) {
      alert('Цей браузер не підтримує дзвінки');
      return;
    }
    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Не вдалося отримати доступ до мікрофона');
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    currentCall = {
      callId: null,
      chatId: state.activeChatId,
      peerId: peer.id,
      peerUsername: peer.username,
      peerAvatarUrl: peer.avatarUrl,
      pc,
      localStream,
      role: 'caller',
    };
    setupPeerConnectionHandlers(pc);
    showCallUI('outgoing', peer);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('call:offer', { chatId: state.activeChatId, offer }, (ack) => {
        if (!currentCall) return; // могли вже скасувати
        if (ack && ack.error) {
          alert(ack.error);
          cleanupCallResources();
          hideCallUI();
          return;
        }
        currentCall.callId = ack.callId;
        // Якщо за 40 секунд ніхто не відповів — самі завершуємо
        callRingTimeout = setTimeout(() => {
          if (currentCall && currentCall.callId === ack.callId) endCall();
        }, 40000);
      });
    } catch (err) {
      cleanupCallResources();
      hideCallUI();
      alert('Не вдалося ініціювати дзвінок');
    }
  }

  async function acceptCall() {
    if (!currentCall || currentCall.role !== 'callee') return;
    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Не вдалося отримати доступ до мікрофона');
      declineCall();
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    currentCall.pc = pc;
    currentCall.localStream = localStream;
    setupPeerConnectionHandlers(pc);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(currentCall.pendingOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('call:answer', { callId: currentCall.callId, answer });
      showCallUI('active');
      startCallTimer();
    } catch (err) {
      console.error(err);
      declineCall();
    }
  }

  function declineCall() {
    if (!currentCall) return;
    if (currentCall.callId) state.socket.emit('call:decline', { callId: currentCall.callId });
    cleanupCallResources();
    hideCallUI();
  }

  function endCall() {
    if (!currentCall) return;
    if (currentCall.callId) state.socket.emit('call:end', { callId: currentCall.callId });
    cleanupCallResources();
    hideCallUI();
  }

  function toggleCallMute() {
    if (!currentCall || !currentCall.localStream) return;
    const track = currentCall.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callMuteBtn.classList.toggle('active', !track.enabled);
  }

  callBtn.addEventListener('click', () => {
    if (state.activeChatIsGroup || !state.activeChatWith) return;
    startCall(state.activeChatWith);
  });
  callDeclineBtn.addEventListener('click', declineCall);
  callAcceptBtn.addEventListener('click', acceptCall);
  callEndBtn.addEventListener('click', endCall);
  callMuteBtn.addEventListener('click', toggleCallMute);
  callScreenShareBtn.addEventListener('click', () => {
    if (currentCall && currentCall.screenStream) stopScreenShare();
    else startScreenShare();
  });

  // ---------- Спільний перегляд відео (YouTube або власний файл) ----------

  const watchTogetherBtn = el('watchTogetherBtn');
  const watchVideoArea = el('watchVideoArea');
  const watchCloseBtn = el('watchCloseBtn');
  const watchChangeBtn = el('watchChangeBtn');
  const watchSourcePicker = el('watchSourcePicker');
  const watchWaitingState = el('watchWaitingState');
  const watchChoosingState = el('watchChoosingState');
  const watchYoutubeInput = el('watchYoutubeInput');
  const watchYoutubeBtn = el('watchYoutubeBtn');
  const watchFileInput = el('watchFileInput');
  const watchFileBtn = el('watchFileBtn');
  const watchSourceStatus = el('watchSourceStatus');
  const watchPlayerWrap = el('watchPlayerWrap');
  const watchYoutubeMount = el('watchYoutubeMount');
  const watchVideoFile = el('watchVideoFile');
  const watchYtControls = el('watchYtControls');
  const watchInteractionOverlay = el('watchInteractionOverlay');
  const groupWatchBanner = el('groupWatchBanner');
  const groupWatchBannerText = el('groupWatchBannerText');
  const groupWatchJoinBtn = el('groupWatchJoinBtn');
  const watchYtPlayBtn = el('watchYtPlayBtn');
  const watchYtSeek = el('watchYtSeek');
  const watchYtTime = el('watchYtTime');
  const watchYtVolume = el('watchYtVolume');
  const watchFullscreenBtn = el('watchFullscreenBtn');
  const watchCcBtn = el('watchCcBtn');

  let watchSession = null; // { chatId, isGroup, type: 'youtube'|'file', ytPlayer, applyingRemote, pollTimer, seekDragging }
  let pendingWatchInvite = null; // { chatId, source } — я запросив і чекаю відповіді
  let incomingWatchInvite = null; // { chatId, source, fromUserId, fromUsername } — мене запросили
  let isSwitchingVideo = false; // я вже дивлюсь разом і зараз обираю ІНШЕ відео (без повторного запрошення)
  let switchingChatId = null;
  let switchingIsGroup = false;
  let isPartnerChoosing = false; // співрозмовник зараз обирає нове відео — я лише чекаю, не виходячи з режиму
  let partnerChoosingChatId = null;
  let partnerChoosingIsGroup = false;
  let groupWatchBannerChatId = null; // групу, для якої зараз показаний банер "N дивляться разом"
  let youtubeApiPromise = null;

  function parseYoutubeVideoId(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    if (/^[\w-]{11}$/.test(trimmed)) return trimmed; // вже голий ID
    try {
      const url = new URL(trimmed);
      if (url.hostname.includes('youtu.be')) return url.pathname.slice(1).split('/')[0] || null;
      if (url.hostname.includes('youtube.com')) {
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
        if (shortsMatch) return shortsMatch[1];
        const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
        if (embedMatch) return embedMatch[1];
      }
    } catch (e) { /* не URL — не підходить */ }
    return null;
  }

  function loadYoutubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve) => {
      const prevReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prevReady) prevReady();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    });
    return youtubeApiPromise;
  }

  function openWatchArea() {
    if (!state.activeChatId) return;
    activeChatEl.classList.add('watch-mode');
    appScreen.classList.add('watch-active');
    watchVideoArea.classList.remove('hidden');
  }

  function showSourcePicker() {
    watchSourcePicker.classList.remove('hidden');
    watchWaitingState.classList.add('hidden');
    watchChoosingState.classList.add('hidden');
    watchPlayerWrap.classList.add('hidden');
    watchSourceStatus.classList.add('hidden');
    watchChangeBtn.classList.add('hidden'); // нема ще жодного відео — нічого міняти
  }

  function showWaitingState(username) {
    watchSourcePicker.classList.add('hidden');
    watchWaitingState.classList.remove('hidden');
    watchChoosingState.classList.add('hidden');
    watchPlayerWrap.classList.add('hidden');
    el('watchWaitingUsername').textContent = username;
    watchChangeBtn.classList.remove('hidden');
  }

  // Співрозмовник зараз обирає нове відео (після його кліку на 🔄) — ми лишаємось у режимі
  // перегляду, просто чекаємо, нічого не закриваючи й нікуди не виходячи
  function showChoosingState(username) {
    watchSourcePicker.classList.add('hidden');
    watchWaitingState.classList.add('hidden');
    watchChoosingState.classList.remove('hidden');
    watchPlayerWrap.classList.add('hidden');
    watchChangeBtn.classList.add('hidden');
    el('watchChoosingText').textContent = username ? `${username} обирає нове відео…` : 'Співрозмовник обирає нове відео…';
  }

  function showPlayer() {
    watchSourcePicker.classList.add('hidden');
    watchWaitingState.classList.add('hidden');
    watchChoosingState.classList.add('hidden');
    watchPlayerWrap.classList.remove('hidden');
    watchChangeBtn.classList.remove('hidden');
  }

  async function beginYoutubeSession(videoId, chatId, opts) {
    const { isGroup = false, initialState = null } = opts || {};
    openWatchArea();
    showPlayer();
    watchVideoFile.classList.add('hidden');
    watchYoutubeMount.classList.remove('hidden');
    watchYtControls.classList.remove('hidden');
    watchCcBtn.classList.remove('hidden'); // субтитри доступні лише для YouTube
    watchYtPlayBtn.textContent = '▶';
    watchYtSeek.value = '0';
    watchYtTime.textContent = '0:00 / 0:00';
    showWatchControls();

    await loadYoutubeApi();

    watchSession = {
      chatId,
      isGroup,
      type: 'youtube',
      ytPlayer: null,
      applyingRemote: false,
      pollTimer: null,
      seekDragging: false,
      lastYtPlayerState: null,
      priming: false,
    };

    watchYoutubeMount.innerHTML = '<div id="watchYoutubeMountInner"></div>';
    const ytPlayer = new YT.Player('watchYoutubeMountInner', {
      videoId,
      playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: () => {
          if (!watchSession) return; // сесію вже могли закрити, поки плеєр вантажився
          watchYtSeek.max = String(ytPlayer.getDuration() || 100);
          // Гучність — суто локальна для мене, не синхронізується із співрозмовником
          ytPlayer.setVolume(Number(watchYtVolume.value));
          applyCaptionsState(); // те саме для субтитрів — застосовуємо збережений локальний вибір

          if (initialState) {
            // Пізнє приєднання до вже активного групового перегляду — одразу синхронізуємось
            // на поточну позицію замість старту з нуля, з тією ж компенсацією затримки мережі
            watchSession.applyingRemote = true;
            const latency = initialState.action === 'play' ? Math.max(0, (Date.now() - initialState.ts) / 1000) : 0;
            const targetTime = initialState.time + latency;
            ytPlayer.seekTo(targetTime, true);
            if (initialState.action === 'play') {
              ytPlayer.playVideo();
              watchYtPlayBtn.textContent = '⏸';
            } else {
              ytPlayer.pauseVideo();
              watchYtPlayBtn.textContent = '▶';
            }
            setTimeout(() => { if (watchSession) watchSession.applyingRemote = false; }, 1800);
            return;
          }

          // "Прогріваємо" плеєр одразу після завантаження: коротко й беззвучно програємо кадр,
          // щоб YouTube почав завантажувати буфер заздалегідь, а не лише в момент першого
          // реального натискання плей. Саме брак цього буфера й спричиняв затримку в ~2с у
          // того, хто щойно приєднався — його плеєр був геть "холодний" на старті
          watchSession.priming = true;
          try {
            ytPlayer.mute();
            ytPlayer.playVideo();
          } catch (e) { /* ignore */ }
          setTimeout(() => {
            try {
              ytPlayer.pauseVideo();
              ytPlayer.seekTo(0, true);
              ytPlayer.unMute();
              ytPlayer.setVolume(Number(watchYtVolume.value));
            } catch (e) { /* ignore */ }
            if (watchSession) watchSession.priming = false;
          }, 600);
        },
        onStateChange: (e) => {
          if (!watchSession) return;
          watchSession.lastYtPlayerState = e.data;

          // Під час "прогріву" (беззвучний плей+пауза одразу після завантаження) не міняємо
          // кнопку й нічого не транслюємо — це суто технічна дія, не справжня команда людини
          if (watchSession.priming) return;

          if (e.data === YT.PlayerState.PLAYING) watchYtPlayBtn.textContent = '⏸';
          else if (e.data === YT.PlayerState.PAUSED) watchYtPlayBtn.textContent = '▶';

          // Придушуємо трансляцію лише поки САМЕ ЗАРАЗ застосовуємо чужий стан (applyingRemote) —
          // це запобігає "пінг-понгу", коли наша ж реакція на подію співрозмовника відсилається
          // йому назад. Звичайні власні дії (плей/пауза/перемотка) завжди транслюються одразу
          if (watchSession.applyingRemote) return;

          if (e.data === YT.PlayerState.PLAYING) {
            emitWatchState('play', ytPlayer.getCurrentTime());
          } else if (e.data === YT.PlayerState.PAUSED) {
            emitWatchState('pause', ytPlayer.getCurrentTime());
          }
        },
      },
    });
    watchSession.ytPlayer = ytPlayer;

    watchSession.pollTimer = setInterval(() => {
      if (!watchSession || !watchSession.ytPlayer || watchSession.seekDragging) return;
      const cur = watchSession.ytPlayer.getCurrentTime() || 0;
      const dur = watchSession.ytPlayer.getDuration() || 0;
      if (dur) watchYtSeek.max = String(dur);
      watchYtSeek.value = String(cur);
      watchYtTime.textContent = `${formatDuration(cur)} / ${formatDuration(dur)}`;
    }, 500);
  }

  function beginFileSession(url, chatId, opts) {
    const { isGroup = false, initialState = null } = opts || {};
    openWatchArea();
    showPlayer();
    watchYoutubeMount.classList.add('hidden');
    watchVideoFile.classList.remove('hidden');
    watchYtControls.classList.remove('hidden'); // та сама панель керування, що й для YouTube — тепер працює для обох
    watchCcBtn.classList.add('hidden'); // субтитрів для власного файлу немає

    watchSession = { chatId, isGroup, type: 'file', applyingRemote: false };
    watchVideoFile.preload = 'auto'; // просимо браузер почати буферизацію одразу, ще до першого натискання плей
    watchVideoFile.src = url;
    watchVideoFile.load();
    watchVideoFile.volume = Number(watchYtVolume.value) / 100;
    watchYtSeek.value = '0';
    watchYtTime.textContent = '0:00 / 0:00';
    showWatchControls();

    if (initialState) {
      // Пізнє приєднання до вже активного групового перегляду — синхронізуємось на поточну
      // позицію, щойно стануть відомі метадані відео (currentTime до цього момента могло
      // просто ігноруватись браузером)
      watchSession.applyingRemote = true;
      watchVideoFile.addEventListener('loadedmetadata', () => {
        if (!watchSession) return;
        const latency = initialState.action === 'play' ? Math.max(0, (Date.now() - initialState.ts) / 1000) : 0;
        watchVideoFile.currentTime = initialState.time + latency;
        if (initialState.action === 'play') {
          watchVideoFile.play().catch(() => {});
          watchYtPlayBtn.textContent = '⏸';
        } else {
          watchVideoFile.pause();
          watchYtPlayBtn.textContent = '▶';
        }
      }, { once: true });
      setTimeout(() => { if (watchSession) watchSession.applyingRemote = false; }, 1800);
    } else {
      watchYtPlayBtn.textContent = '▶';
    }
  }

  function emitWatchState(action, time) {
    if (!watchSession) return;
    const eventName = watchSession.isGroup ? 'group-watch:state' : 'watch:state';
    state.socket.emit(eventName, { chatId: watchSession.chatId, action, time });
  }

  function stopCurrentPlayer() {
    if (watchSession) {
      if (watchSession.pollTimer) clearInterval(watchSession.pollTimer);
      if (watchSession.ytPlayer) {
        try { watchSession.ytPlayer.destroy(); } catch (e) { /* ignore */ }
      }
    }
    if (document.fullscreenElement === watchPlayerWrap) {
      document.exitFullscreen().catch(() => {});
    }
    watchVideoFile.pause();
    watchVideoFile.removeAttribute('src');
    watchVideoFile.load();
    watchYoutubeMount.innerHTML = '';
    clearTimeout(watchControlsHideTimer);
    watchYtControls.classList.remove('controls-hidden');
  }

  // ---------- Автоприховування панелі керування при бездіяльності ----------

  let watchControlsHideTimer = null;

  function showWatchControls() {
    watchYtControls.classList.remove('controls-hidden');
    clearTimeout(watchControlsHideTimer);
    watchControlsHideTimer = setTimeout(() => {
      watchYtControls.classList.add('controls-hidden');
    }, 2500);
  }

  // Рух миші/дотик будь-де над відео — показуємо панель і скидаємо таймер приховування.
  // Рух/наведення саме на самій панелі теж скидає таймер, щоб вона не зникла посеред перетягування повзунка
  // Слухаємо саме на watchInteractionOverlay (не watchPlayerWrap) — рух миші/дотик прямо над
  // YouTube-плеєром інакше не долетів би через чужий iframe до батьківської сторінки
  watchInteractionOverlay.addEventListener('mousemove', showWatchControls);
  watchInteractionOverlay.addEventListener('mousedown', showWatchControls);
  watchInteractionOverlay.addEventListener('touchstart', showWatchControls, { passive: true });
  watchYtControls.addEventListener('mousemove', showWatchControls);
  watchYtControls.addEventListener('touchmove', showWatchControls, { passive: true });

  // Клік по самому відео теж перемикає плей/пауза — звичний жест для будь-якого відеоплеєра
  watchInteractionOverlay.addEventListener('click', () => {
    showWatchControls();
    watchYtPlayBtn.click();
  });

  function resetWatchUI() {
    stopCurrentPlayer();
    activeChatEl.classList.remove('watch-mode');
    appScreen.classList.remove('watch-active');
    watchVideoArea.classList.add('hidden');
    showSourcePicker();
    watchYoutubeInput.value = '';
    updateGroupWatchParticipantCount(0);
  }

  function closeWatchSession(announce) {
    if (watchSession && announce) {
      state.socket.emit('watch:end', { chatId: watchSession.chatId });
    }
    resetWatchUI(); // виклик, поки watchSession ще не обнулено — stopCurrentPlayer() всередині коректно прибере таймер/плеєр
    watchSession = null;
  }

  function cancelPendingInvite() {
    if (!pendingWatchInvite) return;
    state.socket.emit('watch:end', { chatId: pendingWatchInvite.chatId });
    pendingWatchInvite = null;
    resetWatchUI();
  }

  // Групова "кімната" перегляду — вихід лише мене одного, перегляд триває для решти учасників
  function leaveGroupWatch() {
    if (!watchSession || !watchSession.isGroup) return;
    state.socket.emit('group-watch:leave', { chatId: watchSession.chatId });
    resetWatchUI();
    watchSession = null;
  }

  function startGroupWatch(source) {
    state.socket.emit('group-watch:start', { chatId: state.activeChatId, source }, (ack) => {
      if (!ack || ack.error) {
        watchSourceStatus.textContent = (ack && ack.error) || 'Не вдалося почати перегляд';
        watchSourceStatus.classList.remove('hidden');
        return;
      }
      const chatId = state.activeChatId;
      if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId, { isGroup: true });
      else if (source.type === 'file') beginFileSession(source.url, chatId, { isGroup: true });
      updateGroupWatchParticipantCount(1);
    });
  }

  function joinGroupWatch(chatId) {
    state.socket.emit('group-watch:join', { chatId }, (ack) => {
      if (!ack || ack.error) {
        alert((ack && ack.error) || 'Не вдалося приєднатися до перегляду');
        return;
      }
      hideGroupWatchBanner();
      if (ack.source.type === 'youtube') {
        beginYoutubeSession(ack.source.videoId, chatId, { isGroup: true, initialState: ack.lastState });
      } else if (ack.source.type === 'file') {
        beginFileSession(ack.source.url, chatId, { isGroup: true, initialState: ack.lastState });
      }
      updateGroupWatchParticipantCount(ack.participantCount);
    });
  }

  function showGroupWatchBanner(chatId, participantCount) {
    if (state.activeChatId !== chatId) return; // не той чат зараз відкритий — банер там не потрібен
    if (watchSession && watchSession.chatId === chatId) return; // я вже сам дивлюсь — банер зайвий
    groupWatchBannerChatId = chatId;
    groupWatchBannerText.textContent = `🎬 ${pluralizeMembers(participantCount)} дивляться відео разом`;
    groupWatchBanner.classList.remove('hidden');
  }

  function hideGroupWatchBanner() {
    groupWatchBannerChatId = null;
    groupWatchBanner.classList.add('hidden');
  }

  function updateGroupWatchParticipantCount(count) {
    const el2 = el('watchGroupParticipantCount');
    if (watchSession && watchSession.isGroup && count) {
      el2.textContent = ` · ${pluralizeMembers(count)}`;
      el2.classList.remove('hidden');
    } else {
      el2.classList.add('hidden');
    }
  }

  groupWatchJoinBtn.addEventListener('click', () => {
    if (!groupWatchBannerChatId) return;
    joinGroupWatch(groupWatchBannerChatId);
  });

  // Кнопка "поставити інше відео" — завершує поточний перегляд (як і хрестик), але замість
  // повного закриття одразу показує вибір нового джерела, не виходячи з режиму перегляду
  function changeVideo() {
    if (watchSession && watchSession.isGroup) {
      if (!confirm('Поставити інше відео? Поточний перегляд зупиниться для тих, хто зараз дивиться.')) return;
      // Повідомляємо решту поточних глядачів (не всю групу) — вони НЕ виходять з режиму
      // перегляду, а лише бачать "N обирає нове відео…", так само як в особистому чаті.
      // Важливо: тут викликаємо лише stopCurrentPlayer(), а НЕ resetWatchUI() — інакше й сам
      // ініціатор заміни теж вилітав би із режиму перегляду назад у звичайний чат
      switchingChatId = watchSession.chatId;
      switchingIsGroup = true;
      state.socket.emit('group-watch:switching', { chatId: switchingChatId });
      stopCurrentPlayer();
      watchSession = null;
      isSwitchingVideo = true;
      showSourcePicker();
      return;
    }
    if (!watchSession && !pendingWatchInvite) return;
    if (!confirm('Поставити інше відео? Поточний перегляд завершиться для обох.')) return;
    if (pendingWatchInvite) {
      // Ще навіть не почали дивитись разом (чекали прийняття) — просто скасовуємо запрошення, як і раніше
      state.socket.emit('watch:end', { chatId: pendingWatchInvite.chatId });
      pendingWatchInvite = null;
      showSourcePicker();
      watchYoutubeInput.value = '';
    } else if (watchSession) {
      // Дивимось разом уже узгоджено раніше — тому повторне запрошення не потрібне.
      // Повідомляємо співрозмовника "я обираю нове відео", щоб він НЕ вийшов з режиму перегляду,
      // а лишень зачекав; новий вибір надішлемо напряму (watch:switch-video), без нового прийняття
      switchingChatId = watchSession.chatId;
      switchingIsGroup = false;
      state.socket.emit('watch:switching', { chatId: switchingChatId });
      stopCurrentPlayer();
      watchSession = null;
      isSwitchingVideo = true;
      showSourcePicker();
      watchYoutubeInput.value = '';
    }
  }

  watchTogetherBtn.addEventListener('click', () => {
    if (watchSession || pendingWatchInvite) return; // вже дивимось або чекаємо відповіді — повторний клік нічого не робить
    openWatchArea();
    showSourcePicker();
  });

  watchCloseBtn.addEventListener('click', () => {
    if (watchSession && watchSession.isGroup) {
      leaveGroupWatch();
      return;
    }
    // Якщо вже щось запущено, ще чекаємо відповіді, або зараз триває заміна (в будь-яку сторону) —
    // перепитуємо, бо перегляд зупиниться в обох. Якщо ж людина ще на початковому екрані вибору —
    // питати нема сенсу
    if ((watchSession || pendingWatchInvite || isSwitchingVideo || isPartnerChoosing)
      && !confirm('Завершити перегляд? Відео зупиниться для обох.')) {
      return;
    }
    if (pendingWatchInvite) {
      cancelPendingInvite();
    } else if (isSwitchingVideo) {
      // Розпочали обирати заміну (глядачі вже чекають з повідомленням "обирає відео…"),
      // але передумали — обов'язково повідомляємо про скасування, інакше вони так і лишаться чекати
      if (switchingIsGroup) state.socket.emit('group-watch:switch-cancel', { chatId: switchingChatId });
      else state.socket.emit('watch:end', { chatId: switchingChatId });
      isSwitchingVideo = false;
      switchingChatId = null;
      switchingIsGroup = false;
      resetWatchUI();
    } else if (isPartnerChoosing) {
      // Ми пасивно чекаємо, поки хтось обирає заміну, але самі вирішили вийти —
      // повідомляємо про це теж, інакше інша сторона лишиться чекати марно
      if (partnerChoosingIsGroup) state.socket.emit('group-watch:leave', { chatId: partnerChoosingChatId });
      else state.socket.emit('watch:end', { chatId: partnerChoosingChatId });
      isPartnerChoosing = false;
      partnerChoosingChatId = null;
      partnerChoosingIsGroup = false;
      resetWatchUI();
    } else {
      closeWatchSession(true);
    }
  });

  watchChangeBtn.addEventListener('click', changeVideo);

  watchYoutubeBtn.addEventListener('click', () => {
    const videoId = parseYoutubeVideoId(watchYoutubeInput.value);
    if (!videoId) {
      watchSourceStatus.textContent = 'Не вдалося розпізнати посилання на YouTube';
      watchSourceStatus.classList.remove('hidden');
      return;
    }
    chooseWatchSource({ type: 'youtube', videoId });
  });

  watchFileBtn.addEventListener('click', () => watchFileInput.click());
  watchFileInput.addEventListener('change', async () => {
    const file = watchFileInput.files[0];
    if (!file) return;
    watchSourceStatus.textContent = 'Завантаження…';
    watchSourceStatus.classList.remove('hidden');
    try {
      const uploaded = await uploadFile(file);
      chooseWatchSource({ type: 'file', url: uploaded.url });
    } catch (err) {
      watchSourceStatus.textContent = err.message;
      watchSourceStatus.classList.remove('hidden');
    } finally {
      watchFileInput.value = '';
    }
  });

  function sendWatchInvite(source) {
    if (!state.activeChatWith) return;
    pendingWatchInvite = { chatId: state.activeChatId, source };
    showWaitingState(state.activeChatWith.username);
    state.socket.emit('watch:invite', { chatId: state.activeChatId, source });
  }

  // Спільна точка вибору джерела: заміна відео (особиста чи групова) транслюється напряму;
  // початок групового перегляду стартує одразу; початок особистого йде через запрошення/прийняття
  function chooseWatchSource(source) {
    if (isSwitchingVideo) {
      const chatId = switchingChatId;
      const isGroup = switchingIsGroup;
      isSwitchingVideo = false;
      switchingChatId = null;
      switchingIsGroup = false;
      state.socket.emit(isGroup ? 'group-watch:switch-video' : 'watch:switch-video', { chatId, source });
      if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId, { isGroup });
      else if (source.type === 'file') beginFileSession(source.url, chatId, { isGroup });
      return;
    }
    if (state.activeChatIsGroup) {
      startGroupWatch(source);
      return;
    }
    sendWatchInvite(source);
  }

  el('watchWaitingCancelBtn').addEventListener('click', cancelPendingInvite);

  // Повноекранний режим спільного перегляду — суто локальний для мене, не впливає на співрозмовника
  // (Fullscreen API браузера завжди діє лише в межах власної вкладки/пристрою кожного)
  //
  // На телефоні контейнер у fullscreen лишається портретним (вузьким і високим), і YouTube у
  // такому неприродно витягнутому вікні підставляє власний UI (рекламну картку, блок субтитрів)
  // замість відео. Тому додатково примусово повертаємо екран у альбомну орієнтацію —
  // Screen Orientation API підтримується не всюди (немає в Safari/iOS), тому обгорнуто в try/catch
  // і просто мовчки ігнорується там, де недоступне.
  function lockWatchLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (e) { /* API недоступне на цьому пристрої/браузері — просто ігноруємо */ }
  }

  function unlockWatchOrientation() {
    try {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch (e) { /* те саме */ }
  }

  watchFullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement === watchPlayerWrap) {
      document.exitFullscreen().catch(() => {});
    } else {
      watchPlayerWrap.requestFullscreen()
        .then(lockWatchLandscape)
        .catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', () => {
    watchFullscreenBtn.textContent = document.fullscreenElement === watchPlayerWrap ? '⤢' : '⛶';
    if (document.fullscreenElement !== watchPlayerWrap) {
      unlockWatchOrientation();
    }
  });

  // ---------- Модалка вхідного запрошення на спільний перегляд ----------

  const watchInviteModal = el('watchInviteModal');
  const watchInviteAvatar = el('watchInviteAvatar');
  const watchInviteUsername = el('watchInviteUsername');

  function showWatchInviteModal(fromUsername, avatarUrl) {
    renderAvatarInto(watchInviteAvatar, fromUsername, avatarUrl);
    watchInviteUsername.textContent = fromUsername;
    watchInviteModal.classList.remove('hidden');
  }

  function hideWatchInviteModal() {
    watchInviteModal.classList.add('hidden');
    incomingWatchInvite = null;
  }

  el('watchInviteAcceptBtn').addEventListener('click', async () => {
    if (!incomingWatchInvite) return;
    const { chatId, source } = incomingWatchInvite;
    state.socket.emit('watch:accept', { chatId, source });
    hideWatchInviteModal();

    // Якщо запросили дивитись в чаті, який зараз не відкритий — спершу перемикаємось саме на нього,
    // інакше режим перегляду застосувався б до чату, який відкритий зараз, а не до потрібного
    if (state.activeChatId !== chatId) {
      const entry = state.chats.find((c) => c.chatId === chatId);
      if (entry) await openChat(entry);
    }

    if (source.type === 'youtube') beginYoutubeSession(source.videoId, chatId);
    else if (source.type === 'file') beginFileSession(source.url, chatId);
  });

  el('watchInviteDeclineBtn').addEventListener('click', () => {
    if (!incomingWatchInvite) return;
    state.socket.emit('watch:decline', { chatId: incomingWatchInvite.chatId });
    hideWatchInviteModal();
  });

  watchYtPlayBtn.addEventListener('click', () => {
    if (!watchSession || watchSession.priming) return; // прогрів триває долі секунди — просто ігноруємо клік у цей момент
    if (watchSession.type === 'youtube') {
      if (!watchSession.ytPlayer) return;
      const ytState = watchSession.ytPlayer.getPlayerState();
      if (ytState === YT.PlayerState.PLAYING) watchSession.ytPlayer.pauseVideo();
      else watchSession.ytPlayer.playVideo();
    } else if (watchSession.type === 'file') {
      if (watchVideoFile.paused) watchVideoFile.play().catch(() => {});
      else watchVideoFile.pause();
    }
  });
  watchYtSeek.addEventListener('mousedown', () => { if (watchSession) watchSession.seekDragging = true; });
  watchYtSeek.addEventListener('touchstart', () => { if (watchSession) watchSession.seekDragging = true; });
  watchYtSeek.addEventListener('change', () => {
    if (!watchSession) return;
    const time = parseFloat(watchYtSeek.value);
    if (watchSession.type === 'youtube' && watchSession.ytPlayer) {
      watchSession.ytPlayer.seekTo(time, true);
    } else if (watchSession.type === 'file') {
      watchVideoFile.currentTime = time;
    }
    watchSession.seekDragging = false;
    if (!watchSession.applyingRemote) emitWatchState('seek', time);
  });

  // Гучність — суто локальна для мене, у кожного учасника своя, ніколи не транслюється й не синхронізується
  const watchYtVolumeIcon = el('watchYtVolumeIcon');
  let watchVolumeBeforeMute = 100;

  function applyWatchVolume(value) {
    const numeric = Number(value);
    localStorage.setItem('watchYtVolume', String(numeric));
    watchYtVolumeIcon.textContent = numeric === 0 ? '🔇' : numeric < 50 ? '🔉' : '🔊';
    if (!watchSession) return;
    if (watchSession.type === 'youtube' && watchSession.ytPlayer) {
      watchSession.ytPlayer.setVolume(numeric);
    } else if (watchSession.type === 'file') {
      watchVideoFile.volume = numeric / 100;
    }
  }

  watchYtVolume.value = localStorage.getItem('watchYtVolume') || '100';
  applyWatchVolume(watchYtVolume.value); // виставляємо стартову іконку без застосування до сесії (її ще нема)

  watchYtVolume.addEventListener('input', () => {
    if (Number(watchYtVolume.value) > 0) watchVolumeBeforeMute = Number(watchYtVolume.value);
    applyWatchVolume(watchYtVolume.value);
  });

  watchYtVolumeIcon.addEventListener('click', () => {
    if (Number(watchYtVolume.value) > 0) {
      // Вимикаємо — запам'ятовуємо, на якому рівні був звук, щоб повернути саме його
      watchVolumeBeforeMute = Number(watchYtVolume.value);
      watchYtVolume.value = '0';
    } else {
      // Вмикаємо назад на той рівень, що був до вимкнення (а не завжди на 100%)
      watchYtVolume.value = String(watchVolumeBeforeMute || 100);
    }
    applyWatchVolume(watchYtVolume.value);
  });

  // Субтитри YouTube — так само суто локально для мене, у кожного свій вибір, не синхронізується.
  // Працює лише для YouTube (кнопка ховається для власних файлів — субтитрів там немає)
  let watchCcEnabled = localStorage.getItem('watchCcEnabled') === 'true';

  function applyCaptionsState() {
    if (!watchSession || watchSession.type !== 'youtube' || !watchSession.ytPlayer) return;
    try {
      if (watchCcEnabled) {
        watchSession.ytPlayer.loadModule('captions');
        watchSession.ytPlayer.setOption('captions', 'track', {});
      } else {
        watchSession.ytPlayer.unloadModule('captions');
      }
    } catch (e) { /* ignore — деякі відео просто не мають субтитрів */ }
    watchCcBtn.classList.toggle('active', watchCcEnabled);
  }

  watchCcBtn.addEventListener('click', () => {
    if (!watchSession || watchSession.type !== 'youtube') return;
    watchCcEnabled = !watchCcEnabled;
    localStorage.setItem('watchCcEnabled', String(watchCcEnabled));
    applyCaptionsState();
  });

  watchVideoFile.addEventListener('loadedmetadata', () => {
    watchYtSeek.max = String(watchVideoFile.duration || 100);
  });
  watchVideoFile.addEventListener('timeupdate', () => {
    if (!watchSession || watchSession.type !== 'file' || watchSession.seekDragging) return;
    watchYtSeek.value = String(watchVideoFile.currentTime);
    watchYtTime.textContent = `${formatDuration(watchVideoFile.currentTime)} / ${formatDuration(watchVideoFile.duration)}`;
  });

  watchVideoFile.addEventListener('play', () => {
    watchYtPlayBtn.textContent = '⏸';
    if (!watchSession || watchSession.applyingRemote) return;
    emitWatchState('play', watchVideoFile.currentTime);
  });
  watchVideoFile.addEventListener('pause', () => {
    watchYtPlayBtn.textContent = '▶';
    if (!watchSession || watchSession.applyingRemote) return;
    emitWatchState('pause', watchVideoFile.currentTime);
  });
  watchVideoFile.addEventListener('seeked', () => {
    if (!watchSession || watchSession.applyingRemote) return;
    emitWatchState('seek', watchVideoFile.currentTime);
  });

  function applyRemoteWatchState(action, rawTime, ts) {
    if (!watchSession) return;
    const latencyCompensation = action === 'play' ? Math.max(0, (Date.now() - ts) / 1000) : 0;
    const time = rawTime + latencyCompensation;
    // Поки застосовуємо чужий стан — наші ж обробники подій (onStateChange/play/pause/seeked)
    // спрацюють у відповідь на ці програмні виклики; applyingRemote не дає їм відправити це
    // назад як "нову" дію, інакше вийшов би пінг-понг
    watchSession.applyingRemote = true;

    if (watchSession.type === 'youtube' && watchSession.ytPlayer) {
      if (action === 'seek') {
        watchSession.ytPlayer.seekTo(time, true);
      } else if (action === 'play') {
        watchSession.ytPlayer.seekTo(time, true);
        watchSession.ytPlayer.playVideo();
        watchYtPlayBtn.textContent = '⏸';
      } else if (action === 'pause') {
        watchSession.ytPlayer.pauseVideo();
        watchSession.ytPlayer.seekTo(time, true);
        watchYtPlayBtn.textContent = '▶';
      }
    } else if (watchSession.type === 'file') {
      watchVideoFile.currentTime = time;
      if (action === 'play') {
        watchVideoFile.play().catch(() => {});
        // Оновлюємо іконку одразу, не чекаючи на подію 'play' — деякі браузери можуть заблокувати
        // автовідтворення відео, ініційованого не прямим кліком людини (сама подія тоді не спрацює)
        watchYtPlayBtn.textContent = '⏸';
      } else if (action === 'pause') {
        watchVideoFile.pause();
        watchYtPlayBtn.textContent = '▶';
      }
    }

    // Достатньо довге вікно, щоб пережити типову буферизацію після перемотки на повільнішій мережі,
    // не переплутавши це відновлення зі справжньою локальною дією людини
    setTimeout(() => { if (watchSession) watchSession.applyingRemote = false; }, 1800);
  }

  // ---------- Init ----------

  if (state.token && state.user) {
    startApp();
  }
})();
