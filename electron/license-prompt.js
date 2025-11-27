const api = window.licensePrompt;

function formatStatus(status) {
  if (!status) return 'Статус лицензии недоступен.';
  const lines = [];
  if (status.licensed) {
    const owner = status.licenseOwner ? ` — ${status.licenseOwner}` : '';
    lines.push(`Лицензия активна${owner}. Спасибо за поддержку!`);
  } else if (status.trial && typeof status.trial.daysLeft === 'number') {
    const left = Math.max(0, status.trial.daysLeft);
    if (left > 0) {
      lines.push(`Пробная версия: осталось ${left} дн.`);
      if (status.trial.expiresAt) lines.push(`Срок истечения: ${status.trial.expiresAt}`);
    } else {
      lines.push('Пробный период истёк. Для продолжения необходима лицензия.');
    }
  } else {
    lines.push('Пробный период недоступен. Для доступа необходима лицензия.');
  }
  if (status.message) lines.push(status.message);
  if (!status.licensed && status.expectedOwner && status.identityEmail && status.expectedOwner !== status.identityEmail) {
    lines.push(`Ключ предназначен для: ${status.expectedOwner}. Ваша учётная запись: ${status.identityEmail || 'неизвестно'}.`);
  }
  return lines.join('\n');
}

function applyColorScheme() {
  try {
    if (!window.matchMedia) return () => undefined;
    const matcher = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (e) => { document.body.classList.toggle('dark', e.matches); };
    apply(matcher);
    matcher.addEventListener('change', apply);
    return () => { try { matcher.removeEventListener('change', apply); } catch {} };
  } catch { return () => undefined; }
}

function main() {
  if (!api) { console.error('licensePrompt API unavailable'); return; }

  const cleanupTheme = applyColorScheme();

  const keyInput = document.getElementById('license-key');
  const messageBox = document.getElementById('message');
  const statusBox = document.getElementById('status-info');
  const identityBox = document.getElementById('identity');
  const form = document.getElementById('license-form');
  const activateBtn = document.getElementById('activate-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const mailBtn = document.getElementById('mail-btn');

  let busy = false;
  let unsubscribeStatus = null;

  const setBusy = (next) => {
    busy = !!next; activateBtn.disabled = busy; keyInput.disabled = busy;
  };
  const showMessage = (text, kind = '') => {
    messageBox.textContent = text || ''; messageBox.className = `message ${kind}`.trim();
  };
  const updateStatus = (status) => {
    statusBox.textContent = formatStatus(status);
    try {
      const email = status?.identityEmail || '';
      identityBox.textContent = `Ваш логин: ${email || 'не определён'}`;
    } catch {}
    if (status && status.licensed) { setTimeout(() => api.close(), 250); }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const key = keyInput.value.trim();
    if (!key) { showMessage('Введите ключ.', 'error'); keyInput.focus(); return; }
    setBusy(true); showMessage('Активация...');
    try {
      const result = await api.activate(key);
      showMessage(result?.message || '', result?.success ? 'success' : 'error');
      if (result?.success) { keyInput.value = ''; }
    } catch (e) {
      console.error('activate error', e); showMessage('Ошибка активации. Попробуйте позже.', 'error');
    } finally { setBusy(false); }
  });

  cancelBtn.addEventListener('click', () => api.close());
  if (mailBtn) mailBtn.addEventListener('click', () => { try { window.location.href = 'mailto:pilot.vt@mail.ru'; } catch {} });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); api.close(); } });

  unsubscribeStatus = api.onStatus((s) => updateStatus(s));
  api.getStatus().then(updateStatus).catch((err) => { console.error('status error', err); showMessage('Не удалось получить статус лицензии.', 'error'); });

  window.addEventListener('beforeunload', () => { try { unsubscribeStatus && unsubscribeStatus(); } catch {}; try { cleanupTheme(); } catch {}; });
  setTimeout(() => { try { keyInput.focus(); } catch {} }, 50);
}

document.addEventListener('DOMContentLoaded', main);
