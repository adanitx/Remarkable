import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';

const statusEl = document.getElementById('status');
const pagesEl = document.getElementById('pages');
const params = new URLSearchParams(location.search);
const src = params.get('src');
const canvasRenderers = new WeakMap();

const lazyCanvas = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    lazyCanvas.unobserve(entry.target);
    canvasRenderers.get(entry.target)?.();
  }
}, { rootMargin: '1000px 0px' });

function renderCanvas(page, viewport, canvas) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  return page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: [dpr, 0, 0, dpr, 0, 0]
  }).promise;
}

function askPassword(updatePassword, reason, task) {
  const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
  const password = prompt(incorrect ? 'Contraseña incorrecta. Inténtalo de nuevo:' : 'Este PDF requiere contraseña:');
  if (password) updatePassword(password);
  else task.destroy();
}

async function load() {
  if (!src) throw new Error('no se indicó ningún PDF');

  const task = pdfjsLib.getDocument({
    url: src,
    withCredentials: /^https?:/i.test(src),
    isEvalSupported: false
  });
  task.onPassword = (updatePassword, reason) => askPassword(updatePassword, reason, task);

  const pdf = await task.promise;
  const fileName = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
  document.title = fileName ? `Remarkable: ${fileName}` : 'Remarkable: PDF';

  const first = await pdf.getPage(1);
  const baseWidth = first.getViewport({ scale: 1 }).width;
  const scale = Math.min(2, Math.max(0.5, (document.documentElement.clientWidth - 48) / baseWidth));

  for (let number = 1; number <= pdf.numPages; number++) {
    const page = number === 1 ? first : await pdf.getPage(number);
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    textDiv.style.setProperty('--scale-factor', viewport.scale);
    textDiv.style.setProperty('--total-scale-factor', viewport.scale);
    wrap.append(canvas, textDiv);
    pagesEl.append(wrap);

    canvasRenderers.set(wrap, () => renderCanvas(page, viewport, canvas));
    lazyCanvas.observe(wrap);

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport
    });
    await textLayer.render();
    statusEl.textContent = `Preparando texto… ${number}/${pdf.numPages}`;
  }

  statusEl.remove();
  if (params.get('bar') === '1') {
    window.dispatchEvent(new CustomEvent('remarkable:command', { detail: 'open-bar' }));
  }
}

load().catch((error) => {
  statusEl.textContent = `No se pudo abrir el PDF: ${error.message}`;
});
