// Кастомний банер "Встановити застосунок" внизу екрана + спільний стан
// для кнопки в налаштуваннях профілю (app.js читає window.chatAppInstall).
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
        if (banner) banner.remove();
      });
      return true;
    },
  };

  if (isStandalone()) return; // вже встановлено — банер на головній не потрібен

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

  function dismiss() {
    // Навмисно нічого не запам'ятовуємо — банер має пропонувати встановлення
    // на головній щоразу, коли сайт відкривають не в встановленому режимі.
    if (banner) banner.remove();
  }

  function showBanner(mode) {
    if (banner) return;
    banner = buildBanner(mode);

    document.getElementById('installBannerClose').addEventListener('click', dismiss);

    if (mode !== 'ios') {
      document.getElementById('installBannerBtn').addEventListener('click', function () {
        window.chatAppInstall.promptInstall();
      });
    }
  }

  if (isIOS()) {
    // На iOS немає beforeinstallprompt — показуємо інструкцію одразу
    showBanner('ios');
  } else {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      showBanner('android');
    });
  }

  window.addEventListener('appinstalled', function () {
    if (banner) banner.remove();
  });
})();
