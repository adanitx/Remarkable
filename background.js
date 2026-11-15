const PDF_PATH = /\.pdf$/i;
const VIEWER_PAGE = 'viewer.html';
const CAPTURE_PAGE = 'capture.html';
const SETTINGS_VERSION = 3;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

async function migrateSettings() {
  const stored = await chrome.storage.sync.get({
    settingsVersion: 1,
    findShortcut: 'Alt+G'
  });
  if (stored.settingsVersion >= SETTINGS_VERSION) return;
  const replaceBrokenCombo = (value) => (value === 'Alt+F' ? 'Alt+G' : value);
  const moveOldDefault = (value) => (value === 'Alt+G' ? 'Ctrl+Shift+F' : value);
  await chrome.storage.sync.set({
    settingsVersion: SETTINGS_VERSION,
    findShortcut: moveOldDefault(replaceBrokenCombo(stored.findShortcut))
  });
}
migrateSettings().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'remarkable:capture-tab') {
    captureTab(sender.tab?.windowId).then(
      (dataUrl) => sendResponse({ dataUrl }),
      (error) => sendResponse({ error: error.message })
    );
    return true;
  }
  if (message?.type === 'remarkable:open-capture') {
    openCapture(message.dataUrl).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ error: error.message })
    );
    return true;
  }
  return false;
});

let lastCaptureAt = 0;
const CAPTURE_INTERVAL_MS = 600;

async function captureTab(windowId) {
  if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) {
    await chrome.runtime.openOptionsPage();
    throw new Error('Falta el permiso de acceso a sitios web; concédelo en la configuración de Remarkable.');
  }
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function openCapture(dataUrl) {
  const key = `capture-${Date.now()}`;
  await chrome.storage.local.set({ [key]: dataUrl });
  await chrome.tabs.create({ url: `${chrome.runtime.getURL(CAPTURE_PAGE)}?key=${encodeURIComponent(key)}` });
}

function fileAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return Promise.resolve(true);
  return new Promise((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve));
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const url = tab.url || '';

  if (url.startsWith('file:') && !(await fileAccessAllowed())) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  const type = command === 'show-halo' ? 'halo' : 'open-bar';
  const viewerBase = chrome.runtime.getURL(VIEWER_PAGE);

  if (url.startsWith(viewerBase)) {
    chrome.runtime.sendMessage({ type }).catch(() => {});
    return;
  }

  if (url && PDF_PATH.test(new URL(url).pathname)) {
    const src = encodeURIComponent(url);
    await chrome.tabs.create({
      url: `${viewerBase}?src=${src}&cmd=${type}`,
      index: tab.index + 1,
      openerTabId: tab.id
    });
    return;
  }

  await sendToPage(tab.id, type);
});

async function sendToPage(tabId, type) {
  const message = { type };
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    return;
  } catch {
    // La página se abrió antes de conceder el permiso: se inyecta con activeTab.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['remarkable.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // Las páginas restringidas de Chrome no admiten scripts: no hay nada que mostrar.
  }
}
