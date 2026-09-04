// Кастомний банер "Встановити застосунок" внизу екрана.
// Не чіпає app.js — підключається окремим файлом.

(function () {
  var DISMISS_KEY = 'installBannerDismissedAt';
  var DISMISS_DAYS = 7; // якщо закрили — не показувати повторно N днів

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true // старий Safari iOS
    );
  }

  function isDismissedRecently() {
    var ts = localStorage.getItem(DISMISS_KEY);
    if (!ts) return false;
    var days = (Date.now() - Number(ts)) / (1000 * 60 * 60 * 24);
    return days < DISMISS_DAYS;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  if (isStandalone() || isDismissedRecently()) return;

  var deferredPrompt = null;
  var banner = null;

  function buildBanner(mode) {
    var el = document.createElement('div');
    el.id = 'installBanner';

    var iconHtml = '<div class="install-icon"></div>';
    var textHtml, actionHtml;

    if (mode === 'ios') {
      textHtml =
        '<div class="install-text">' +
        '<div class="install-title">Встановити як застосунок</div>' +
        '<div class="install-sub">Поділитися ' + shareGlyph() + ' → «На екран Домой»</div>' +
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

  function shareGlyph() {
    // невеличка іконка "поділитися" текстом, без залежності від емодзі-набору
    return '⬆︎';
  }

  function dismiss() {
    if (banner) banner.remove();
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  }

  function showBanner(mode) {
    if (banner) return;
    banner = buildBanner(mode);

    document.getElementById('installBannerClose').addEventListener('click', dismiss);

    if (mode !== 'ios') {
      document.getElementById('installBannerBtn').addEventListener('click', function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () {
          deferredPrompt = null;
          dismiss();
        });
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

  window.addEventListener('appinstalled', dismiss);
})();
