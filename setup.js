const WEB_ORIGINS = ['<all_urls>'];
const FILE_ORIGINS = ['file:///*'];

const webStatus = document.getElementById('web-status');
const fileStatus = document.getElementById('file-status');
const webError = document.getElementById('web-error');

function setStatus(el, granted) {
  el.textContent = granted ? 'concedido' : 'pendiente';
  el.className = `status ${granted ? 'ok' : 'pending'}`;
}

async function refresh() {
  const web = await chrome.permissions.contains({ origins: WEB_ORIGINS });
  setStatus(webStatus, web);
  document.getElementById('web-request').disabled = web;

  const fileGranted = await chrome.permissions.contains({ origins: FILE_ORIGINS });
  const fileAllowed = await new Promise((resolve) =>
    chrome.extension.isAllowedFileSchemeAccess
      ? chrome.extension.isAllowedFileSchemeAccess(resolve)
      : resolve(false)
  );
  const ready = fileGranted && fileAllowed;
  setStatus(fileStatus, ready);
  if (!fileGranted) fileStatus.textContent = 'pendiente (permiso de sitio)';
  else if (!fileAllowed) fileStatus.textContent = 'pendiente (activar «Permitir acceso a las URL de archivos»)';
}

document.getElementById('web-request').addEventListener('click', async () => {
  webError.textContent = '';
  try {
    await chrome.permissions.request({ origins: WEB_ORIGINS });
  } catch (error) {
    webError.textContent = error.message;
  }
  refresh();
});

document.getElementById('file-request').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: FILE_ORIGINS }).catch(() => false);
  if (granted) refresh();
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

document.getElementById('refresh').addEventListener('click', refresh);

refresh();
