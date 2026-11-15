const DEFAULTS = {
  findShortcut: 'Ctrl+Shift+F',
  haloShortcut: 'Alt+H',
  haloAuto: true,
  haloDuration: 1800,
  haloColor: '#ff3b30',
  highlightLimit: 500,
  capturePadding: 150,
  darkMode: false
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const status = document.getElementById('status');

function comboFromEvent(e) {
  if (MODIFIER_KEYS.has(e.key)) return '';
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

document.querySelectorAll('input[data-shortcut]').forEach((input) => {
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      input.blur();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    if (!combo.includes('+')) {
      status.style.color = '#d93025';
      status.textContent = 'Usa al menos un modificador (Ctrl, Alt, Shift o Meta).';
      return;
    }
    input.value = combo;
    status.textContent = '';
  });
});

function fill(settings) {
  document.getElementById('findShortcut').value = settings.findShortcut;
  document.getElementById('findHint').textContent =
    `Por defecto: ${DEFAULTS.findShortcut}. Chrome no permite que la extensión cambie sus atajos: si la combinación choca con Chrome, reasígnala en chrome://extensions/shortcuts.`;
  document.getElementById('haloShortcut').value = settings.haloShortcut;
  document.getElementById('haloAuto').checked = settings.haloAuto;
  document.getElementById('haloDuration').value = settings.haloDuration;
  document.getElementById('haloColor').value = settings.haloColor;
  document.getElementById('highlightLimit').value = settings.highlightLimit;
  document.getElementById('capturePadding').value = settings.capturePadding;
  document.getElementById('darkMode').checked = settings.darkMode;
  applyTheme(settings.darkMode);
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

document.getElementById('darkMode').addEventListener('change', (e) => applyTheme(e.target.checked));

chrome.commands.getAll().then((commands) => {
  const open = commands.find((command) => command.name === 'open-bar');
  document.getElementById('systemHint').textContent = open?.shortcut
    ? `Atajo de Chrome para la misma acción: ${open.shortcut} (cámbialo en chrome://extensions/shortcuts).`
    : 'Chrome no tiene atajo asignado para la barra (puedes asignarlo en chrome://extensions/shortcuts).';
});

function flash(message, ok = true) {
  status.style.color = ok ? '#188038' : '#d93025';
  status.textContent = message;
  setTimeout(() => (status.textContent = ''), 2500);
}

document.getElementById('save').addEventListener('click', async () => {
  const duration = Number(document.getElementById('haloDuration').value);
  if (!Number.isFinite(duration) || duration < 300 || duration > 10000) {
    flash('La duración debe estar entre 300 y 10000 ms.', false);
    return;
  }
  const padding = Number(document.getElementById('capturePadding').value);
  if (!Number.isFinite(padding) || padding < 0 || padding > 300) {
    flash('El margen de captura debe estar entre 0 y 300 px.', false);
    return;
  }
  const limit = Number(document.getElementById('highlightLimit').value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    flash('El límite de remarcado debe estar entre 1 y 5000 coincidencias.', false);
    return;
  }
  const settings = {
    findShortcut: document.getElementById('findShortcut').value,
    haloShortcut: document.getElementById('haloShortcut').value,
    haloAuto: document.getElementById('haloAuto').checked,
    haloDuration: duration,
    haloColor: document.getElementById('haloColor').value,
    highlightLimit: limit,
    capturePadding: padding,
    darkMode: document.getElementById('darkMode').checked
  };
  await chrome.storage.sync.set(settings);
  fill(settings);
  flash('Guardado');
});

document.getElementById('reset').addEventListener('click', async () => {
  const restored = { ...DEFAULTS };
  await chrome.storage.sync.set(restored);
  fill(restored);
  flash('Valores restaurados');
});

chrome.storage.sync
  .get(DEFAULTS)
  .then((stored) => fill(stored));

const WEB_ORIGINS = ['<all_urls>'];
const FILE_ORIGINS = ['file:///*'];

function setPermStatus(el, granted, pendingText = 'pendiente') {
  el.textContent = granted ? 'concedido' : pendingText;
  el.className = `badge ${granted ? 'ok' : 'pending'}`;
}

async function refreshPermissions() {
  const web = await chrome.permissions.contains({ origins: WEB_ORIGINS });
  setPermStatus(document.getElementById('web-status'), web);
  document.getElementById('web-request').disabled = web;

  const fileGranted = await chrome.permissions.contains({ origins: FILE_ORIGINS });
  const fileAllowed = await new Promise((resolve) =>
    chrome.extension.isAllowedFileSchemeAccess ? chrome.extension.isAllowedFileSchemeAccess(resolve) : resolve(false)
  );
  let pending = 'pendiente';
  if (!fileGranted) pending = 'pendiente (permiso de sitio)';
  else if (!fileAllowed) pending = 'pendiente (activar «Permitir acceso a las URL de archivos»)';
  setPermStatus(document.getElementById('file-status'), fileGranted && fileAllowed, pending);
}

document.getElementById('web-request').addEventListener('click', async () => {
  const error = document.getElementById('web-error');
  error.textContent = '';
  try {
    await chrome.permissions.request({ origins: WEB_ORIGINS });
  } catch (e) {
    error.textContent = e.message;
  }
  refreshPermissions();
});

document.getElementById('file-request').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: FILE_ORIGINS }).catch(() => false);
  if (granted) refreshPermissions();
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

document.getElementById('refresh').addEventListener('click', refreshPermissions);

refreshPermissions();
