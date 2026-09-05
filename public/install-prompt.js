// Кастомний банер "Встановити застосунок" — показується лише поки видно
// #authScreen (тобто до входу в акаунт). Після логіну банер ховається,
// а встановити застосунок можна через кнопку в налаштуваннях профілю
// (app.js читає window.chatAppInstall.promptInstall()).
// Не чіпає app.js напряму — підключається окремим файлом.

(function () {
  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true // старий Safari iOS
    );
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  var deferredPrompt = null;
  var banner = null;
  var pendingMode = null; // 'ios' | 'android' — що показати, коли настане час

  // Публічний інтерфейс для app.js (кнопка "Завантажити застосунок" у налаштуваннях)
  window.chatAppInstall = {
    isStandalone: isStandalone,
    isIOS: isIOS,
    // Повертає true, якщо вдалось показати нативний діалог встановлення (Android/Chrome).
    // Якщо системного діалогу немає (iOS, десктоп без підтримки) — повертає false,
    // виклик коду сам вирішує, що показати користувачу (інструкцію тощо).
    promptInstall: function () {
      if (!deferredPrompt) return false;
      var p = deferredPrompt;
      deferredPrompt = null;
      p.prompt();
      p.userChoice.finally(function () {
        removeBanner();
      });
      return true;
    },
  };

  if (isStandalone()) return; // вже встановлено — банер узагалі не потрібен

  var authScreenEl = document.getElementById('authScreen');

  function isAuthScreenVisible() {
    return !!authScreenEl && !authScreenEl.classList.contains('hidden');
  }

  function buildBanner(mode) {
    var el = document.createElement('div');
    el.id = 'installBanner';

    var iconHtml = '<div class="install-icon"></div>';
    var textHtml, actionHtml;

    if (mode === 'ios') {
      textHtml =
        '<div class="install-text">' +
        '<div class="install-title">Встановити як застосунок</div>' +
        '<div class="install-sub">Поділитися ⬆︎ → «На екран Домой»</div>' +
        '</div>';
      actionHtml = '';
    } else {
      textHtml =
        '<div class="install-text">' +
        '<div class="install-title">Встановити як застосунок</div>' +
        '<div class="install-sub">Швидкий доступ з головного екрана</div>' +
        '</div>';
      actionHtml = '<button type="button" class="install-btn" id="installBannerBtn">Встановити</button>';
    }

    el.innerHTML =
      iconHtml +
      textHtml +
      actionHtml +
      '<button type="button" class="install-close" id="installBannerClose" aria-label="Закрити">×</button>';

    document.body.appendChild(el);
    return el;
  }

  function removeBanner() {
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function renderBannerIfNeeded() {
    if (!isAuthScreenVisible() || !pendingMode) {
      removeBanner();
      return;
    }
    if (banner) return; // вже показано

    banner = buildBanner(pendingMode);
    document.getElementById('installBannerClose').addEventListener('click', removeBanner);

    if (pendingMode !== 'ios') {
      document.getElementById('installBannerBtn').addEventListener('click', function () {
        window.chatAppInstall.promptInstall();
      });
    }
  }

  if (isIOS()) {
    // На iOS немає beforeinstallprompt — інструкція готова одразу
    pendingMode = 'ios';
    renderBannerIfNeeded();
  } else {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      pendingMode = 'android';
      renderBannerIfNeeded();
    });
  }

  // Стежимо за переходами екран-входу ↔ екран-застосунку (SPA, без перезавантаження сторінки)
  if (authScreenEl) {
    var observer = new MutationObserver(renderBannerIfNeeded);
    observer.observe(authScreenEl, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('appinstalled', removeBanner);
})();
