const DEFAULTS = {
  findShortcut: 'Ctrl+F',
  haloShortcut: 'Alt+H',
  haloAuto: true,
  haloDuration: 1800,
  haloColor: '#ff3b30',
  capturePadding: 25
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
  document.getElementById('haloShortcut').value = settings.haloShortcut;
  document.getElementById('haloAuto').checked = settings.haloAuto;
  document.getElementById('haloDuration').value = settings.haloDuration;
  document.getElementById('haloColor').value = settings.haloColor;
  document.getElementById('capturePadding').value = settings.capturePadding;
}

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
  const settings = {
    findShortcut: document.getElementById('findShortcut').value,
    haloShortcut: document.getElementById('haloShortcut').value,
    haloAuto: document.getElementById('haloAuto').checked,
    haloDuration: duration,
    haloColor: document.getElementById('haloColor').value,
    capturePadding: padding
  };
  await chrome.storage.sync.set(settings);
  flash('Guardado');
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  fill(DEFAULTS);
  flash('Valores restaurados');
});

chrome.storage.sync.get(DEFAULTS).then((stored) => fill({ ...DEFAULTS, ...stored }));
