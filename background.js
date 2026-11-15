const PDF_PATH = /\.pdf$/i;
const VIEWER_PAGE = 'viewer.html';
const CAPTURE_PAGE = 'capture.html';
const SETUP_PAGE = 'setup.html';

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL(SETUP_PAGE) });
  }
});

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
    await chrome.tabs.create({ url: chrome.runtime.getURL(SETUP_PAGE) });
    throw new Error('Falta el permiso de acceso a sitios web; concédelo en la página de configuración.');
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
  if (!tab?.url) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(SETUP_PAGE) });
    return;
  }

  if (tab.url.startsWith('file:') && !(await fileAccessAllowed())) {
    await chrome.tabs.create({
      url: `chrome://extensions/?id=${chrome.runtime.id}`,
      index: tab.index + 1,
      openerTabId: tab.id
    });
    return;
  }

  const type = command === 'show-halo' ? 'halo' : 'open-bar';
  const viewerBase = chrome.runtime.getURL(VIEWER_PAGE);

  if (tab.url.startsWith(viewerBase)) {
    chrome.runtime.sendMessage({ type }).catch(() => {});
    return;
  }

  if (PDF_PATH.test(new URL(tab.url).pathname)) {
    const src = encodeURIComponent(tab.url);
    await chrome.tabs.create({
      url: `${viewerBase}?src=${src}&bar=1`,
      index: tab.index + 1,
      openerTabId: tab.id
    });
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }).catch(() => {});
});
