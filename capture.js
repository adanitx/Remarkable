(async () => {
  const key = new URLSearchParams(location.search).get('key');
  const img = document.getElementById('shot');
  const message = document.getElementById('message');
  const download = document.getElementById('download');
  const info = document.getElementById('info');

  const stored = key ? await chrome.storage.local.get(key) : {};
  const dataUrl = stored[key];
  if (!dataUrl) {
    message.textContent = 'No se encontró la captura. Vuelve a generarla desde Remarkable.';
    return;
  }
  await chrome.storage.local.remove(key);

  img.onload = () => {
    info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
  };
  img.src = dataUrl;
  img.hidden = false;
  message.hidden = true;
  download.disabled = false;

  download.addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `remarkable-${stamp}.png`;
    link.click();
  });
})();
