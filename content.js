(() => {
  'use strict';

  if (document.contentType === 'application/pdf') return;
  if (window.__remarkableLoaded) return;
  window.__remarkableLoaded = true;

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

  const MATCH_HL = 'remarkable-match';
  const CURRENT_HL = 'remarkable-current';
  const SAVED_HL = 'remarkable-saved';
  const MAX_MATCHES = 5000;
  const RESOLVE_DISTANCE = 600;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME']);
  const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
  const supportsHighlights = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

  let settings = { ...DEFAULTS };
  const state = {
    host: null, root: null, input: null, count: null, panel: null,
    ranges: [], current: -1, saved: [], query: ''
  };
  let refreshTimer = 0;
  const savedMeta = new WeakMap();

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

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = change.newValue ?? DEFAULTS[key];
    }
    state.host?.classList.toggle('dark', !!settings.darkMode);
  });

  function scrollFieldTo(field, range) {
    const mirror = fieldMirrors.get(field);
    if (!mirror) return;
    const r = range.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    if (r.top < f.top || r.bottom > f.bottom) field.scrollTop += r.top - f.top - (f.height - r.height) / 2;
    if (r.left < f.left || r.right > f.right) field.scrollLeft += r.left - f.left - (f.width - r.width) / 2;
    syncMirror(field, mirror);
  }

  function revealRange(range) {
    const node = range.startContainer.parentElement;
    const field = fieldOfMirror(node);
    const target = field ?? node;
    const horizontal = [];
    for (let el = field ? field.parentElement : node; el; el = el.parentElement) horizontal.push([el, el.scrollLeft]);
    const windowX = window.scrollX;
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    for (const [el, left] of horizontal) el.scrollLeft = left;
    window.scrollTo({ left: windowX, behavior: 'instant' });
    if (field) scrollFieldTo(field, range);
    let rect = range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      window.scrollBy({ top: rect.top + rect.height / 2 - window.innerHeight / 2, behavior: 'instant' });
      rect = range.getBoundingClientRect();
    }
    return rect;
  }

  function createHalo(rect, pad) {
    const halo = document.createElement('div');
    halo.className = 'remarkable-halo';
    Object.assign(halo.style, {
      left: `${rect.left - pad}px`,
      top: `${rect.top - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`
    });
    halo.style.setProperty('--remarkable-color', settings.haloColor);
    halo.style.setProperty('animation-duration', `${settings.haloDuration}ms`);
    document.documentElement.appendChild(halo);
    return halo;
  }

  function showHalos(ranges, primary) {
    const focus = primary ?? ranges[0];
    if (!focus) return;
    revealRange(focus);

    document.querySelectorAll('.remarkable-halo').forEach((node) => node.remove());

    const pad = 8;
    const halos = [];
    for (const range of ranges) {
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      halos.push(createHalo(rect, pad));
    }
    setTimeout(() => halos.forEach((halo) => halo.remove()), settings.haloDuration + 200);
  }

  function drawStaticHalos(ranges) {
    const halos = [];
    for (const range of ranges) {
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const halo = createHalo(rect, 8);
      halo.classList.add('remarkable-halo-static');
      halos.push(halo);
    }
    return halos;
  }

  function showHalo(range) {
    showHalos([range], range);
  }

  function isLive(range) {
    return range.startContainer.isConnected && range.endContainer.isConnected;
  }

  function sameRange(a, b) {
    return a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  }

  function isIntact(range) {
    return isLive(range) && range.toString() === savedMeta.get(range)?.text;
  }

  function docPoint(range) {
    const rect = range.getBoundingClientRect();
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
  }

  function rememberSaved(range) {
    savedMeta.set(range, { text: range.toString(), ...docPoint(range) });
    return range;
  }

  function resolveSaved() {
    const broken = state.saved
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => !isIntact(range));
    if (!broken.length) return;

    const candidatesByText = new Map();
    for (const { range } of broken) {
      const text = savedMeta.get(range)?.text;
      if (text && !candidatesByText.has(text)) candidatesByText.set(text, collectRanges(text));
    }

    for (const { range, index } of broken) {
      const meta = savedMeta.get(range);
      if (!meta) continue;
      const taken = state.saved.filter((other, i) => i !== index && isIntact(other));
      let best = null;
      let bestDistance = RESOLVE_DISTANCE;
      for (const candidate of candidatesByText.get(meta.text) ?? []) {
        if (taken.some((other) => sameRange(other, candidate))) continue;
        const point = docPoint(candidate);
        const distance = Math.hypot(point.x - meta.x, point.y - meta.y);
        if (distance <= bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (best) state.saved[index] = rememberSaved(best.cloneRange());
    }
  }

  function snippet(range) {
    const text = (savedMeta.get(range)?.text ?? range.toString()).replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  function remarkTargets() {
    resolveSaved();
    const current = currentRange();
    const ranges = state.saved.filter(isIntact);
    if (current && !ranges.some((range) => sameRange(range, current))) ranges.push(current);
    return { ranges, primary: current ?? ranges[0] };
  }

  function remarkAll() {
    const { ranges, primary } = remarkTargets();
    if (!ranges.length) return false;
    showHalos(ranges, primary);
    return true;
  }

  function savedIndexOf(range) {
    return state.saved.findIndex((saved) => sameRange(saved, range));
  }

  function updateSaveButton() {
    const btn = state.root?.querySelector('[data-act=save]');
    if (!btn) return;
    const range = currentRange();
    const isSaved = !!range && savedIndexOf(range) >= 0;
    btn.textContent = isSaved ? '-' : '+';
    btn.title = isSaved ? 'Quitar de recordadas' : 'Recordar coincidencia actual';
  }

  function setSaved(wanted) {
    const range = currentRange();
    if (!range || !range.toString().trim()) return;
    const index = savedIndexOf(range);
    if (wanted && index < 0) state.saved.push(rememberSaved(range.cloneRange()));
    else if (!wanted && index >= 0) state.saved.splice(index, 1);
    else return;
    renderSaved();
  }

  function toggleSaved() {
    setSaved(savedIndexOf(currentRange()) < 0);
  }

  function gotoSaved(range) {
    if (!range) return;
    if (!isIntact(range)) {
      resolveSaved();
      if (!isIntact(range)) return;
    }
    const index = state.ranges.findIndex((match) => sameRange(match, range));
    if (index >= 0) {
      state.current = index;
      paintHighlights();
      updateCount();
    }
    showHalo(range);
  }

  function renderSaved() {
    if (!state.panel) return;
    resolveSaved();
    state.panel.replaceChildren();

    if (!state.saved.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Sin coincidencias recordadas';
      state.panel.append(empty);
    } else {
      state.saved.forEach((range, index) => {
        const row = document.createElement('div');
        row.className = 'item';
        const label = document.createElement('span');
        label.className = 'label';
        label.dataset.go = String(index);
        label.textContent = snippet(range);
        const del = document.createElement('button');
        del.className = 'del';
        del.dataset.del = String(index);
        del.title = 'Quitar';
        del.textContent = '✕';
        row.append(label, del);
        state.panel.append(row);
      });
    }
    paintHighlights();
    updateSaveButton();
  }

  function onOutsideMouseDown(e) {
    if (state.panel && !state.panel.hidden && !e.composedPath().includes(state.host)) {
      state.panel.hidden = true;
    }
  }

  function collectRanges(query) {
    const found = [];
    if (!query || !document.body) return [];

    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const visibility = new WeakMap();
    const isVisible = (el) => {
      if (!visibility.has(el)) visibility.set(el, !el.checkVisibility || el.checkVisibility());
      return visibility.get(el);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        pattern.lastIndex = 0;
        if (!pattern.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const seenPlaces = new Set();
    let node;
    while ((node = walker.nextNode()) && found.length < MAX_MATCHES) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(node.nodeValue))) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        const place = `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
        if (seenPlaces.has(place)) continue;
        seenPlaces.add(place);
        found.push({ range, anchor: node });
      }
    }
    collectFieldMatches(pattern, found, seenPlaces);
    found.sort((a, b) => {
      if (a.anchor === b.anchor) return 0;
      return a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return found.slice(0, MAX_MATCHES).map((item) => item.range);
  }

  const fieldMirrors = new Map();
  const TEXT_FIELD_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);
  const MIRROR_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform', 'textAlign',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
  ];

  function isTextField(field) {
    return field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && TEXT_FIELD_TYPES.has(field.type));
  }

  function fieldOfMirror(el) {
    for (const [field, mirror] of fieldMirrors) if (mirror === el) return field;
    return null;
  }

  // Campos de texto no tienen nodos de texto en el DOM, así que se mide su contenido con un espejo transparente encima.
  function syncMirror(field, mirror) {
    const cs = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    const isArea = field.tagName === 'TEXTAREA';
    for (const prop of MIRROR_PROPS) mirror.style[prop] = cs[prop];
    Object.assign(mirror.style, {
      position: 'absolute',
      left: `${rect.left + window.scrollX}px`,
      top: `${rect.top + window.scrollY}px`,
      width: `${field.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`,
      height: `${rect.height}px`,
      boxSizing: 'border-box',
      borderStyle: 'solid',
      borderWidth: cs.borderWidth,
      borderColor: 'transparent',
      background: 'transparent',
      color: 'transparent',
      overflow: 'hidden',
      whiteSpace: isArea ? 'pre-wrap' : 'pre',
      overflowWrap: isArea ? 'break-word' : 'normal',
      display: isArea ? 'block' : 'flex',
      alignItems: 'center',
      pointerEvents: 'none',
      userSelect: 'none',
      margin: '0',
      zIndex: '2147483000'
    });
    if (mirror.firstChild?.nodeValue !== field.value) mirror.textContent = field.value;
    mirror.scrollTop = field.scrollTop;
    mirror.scrollLeft = field.scrollLeft;
  }

  function collectFieldMatches(pattern, found, seenPlaces) {
    const used = new Set();
    for (const field of document.querySelectorAll('textarea, input')) {
      if (!isTextField(field) || !field.value || field.hidden) continue;
      if (!field.getClientRects().length || (field.checkVisibility && !field.checkVisibility())) continue;
      pattern.lastIndex = 0;
      if (!pattern.test(field.value)) continue;

      let mirror = fieldMirrors.get(field);
      if (!mirror) {
        mirror = document.createElement('div');
        mirror.className = 'remarkable-mirror';
        document.documentElement.appendChild(mirror);
        fieldMirrors.set(field, mirror);
      }
      used.add(field);
      syncMirror(field, mirror);

      const text = mirror.firstChild;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text.nodeValue))) {
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        const place = `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
        if (seenPlaces.has(place)) continue;
        seenPlaces.add(place);
        found.push({ range, anchor: field });
      }
    }
    for (const [field, mirror] of fieldMirrors) {
      if (used.has(field)) continue;
      mirror.remove();
      fieldMirrors.delete(field);
    }
  }

  function overLimit() {
    return state.ranges.length > settings.highlightLimit;
  }

  function paintHighlights() {
    if (!supportsHighlights) return;
    if (overLimit()) CSS.highlights.delete(MATCH_HL);
    else if (state.ranges.length) CSS.highlights.set(MATCH_HL, new Highlight(...state.ranges));
    else CSS.highlights.delete(MATCH_HL);

    const current = state.ranges[state.current];
    if (current) CSS.highlights.set(CURRENT_HL, new Highlight(current));
    else CSS.highlights.delete(CURRENT_HL);

    const saved = state.host ? state.saved.filter(isIntact) : [];
    if (saved.length) CSS.highlights.set(SAVED_HL, new Highlight(...saved));
    else CSS.highlights.delete(SAVED_HL);
  }

  function updateCount() {
    updateSaveButton();
    if (!state.count) return;
    if (!state.ranges.length) {
      state.count.textContent = state.input?.value ? '0/0' : '';
      return;
    }
    state.count.textContent = overLimit()
      ? `+${settings.highlightLimit}`
      : `${state.current + 1}/${state.ranges.length}`;
  }

  function goTo(index) {
    if (state.ranges.some((range) => !isLive(range))) refreshRanges();
    if (!state.ranges.length) {
      updateCount();
      return;
    }
    state.current = (index + state.ranges.length) % state.ranges.length;
    paintHighlights();
    updateCount();
    const range = state.ranges[state.current];
    if (settings.haloAuto && !overLimit()) showHalo(range);
    else revealRange(range);
  }

  function runSearch(query) {
    state.query = query;
    state.ranges = collectRanges(query);
    state.current = -1;
    startWatching();
    paintHighlights();
    goTo(0);
  }

  function refreshRanges() {
    if (!state.query || !state.host) return;
    const previous = state.current;
    state.ranges = collectRanges(state.query);
    resolveSaved();
    state.current = previous < 0 || !state.ranges.length ? -1 : Math.min(previous, state.ranges.length - 1);
    paintHighlights();
    updateCount();
    updateSaveButton();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshRanges, 150);
  }

  const bodyObserver = new MutationObserver((mutations) => {
    if (mutations.every((m) => state.host?.contains(m.target))) return;
    scheduleRefresh();
  });

  function startWatching() {
    if (!document.body) return;
    bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopWatching() {
    bodyObserver.disconnect();
    clearTimeout(refreshTimer);
  }

  document.addEventListener('scroll', (e) => {
    const mirror = fieldMirrors.get(e.target);
    if (mirror) syncMirror(e.target, mirror);
    if (state.query) scheduleRefresh();
  }, { capture: true, passive: true });

  document.addEventListener('input', (e) => {
    if (state.query && state.host && !state.host.contains(e.target)) scheduleRefresh();
  }, true);

  function currentRange() {
    if (state.current >= 0 && state.ranges[state.current]) return state.ranges[state.current];
    const selection = window.getSelection();
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      return selection.getRangeAt(0).cloneRange();
    }
    return null;
  }

  function closeBar() {
    state.host?.remove();
    state.host = null;
    state.root = null;
    state.input = null;
    state.count = null;
    state.panel = null;
    state.ranges = [];
    state.current = -1;
    state.query = '';
    stopWatching();
    fieldMirrors.forEach((mirror) => mirror.remove());
    fieldMirrors.clear();
    document.removeEventListener('mousedown', onOutsideMouseDown, true);
    if (supportsHighlights) {
      CSS.highlights.delete(MATCH_HL);
      CSS.highlights.delete(CURRENT_HL);
      CSS.highlights.delete(SAVED_HL);
    }
  }

  const CAPTURE_GAP = 16;
  const CAPTURE_BADGE_RADIUS = 14;
  const CAPTURE_STRATEGIES = [
    {
      id: 'continuous',
      label: 'Franja continua',
      help: 'Una sola captura desde la coincidencia más alta hasta la más baja de la página, incluyendo lo que haya entre ellas.'
    },
    {
      id: 'clusters',
      label: 'Grupos cercanos',
      help: 'Separa las coincidencias guardadas en grupos: si hay más de media pantalla entre dos, empieza un grupo nuevo. Cada grupo se captura por separado.'
    },
    {
      id: 'individual',
      label: 'Recorte por coincidencia',
      help: 'Un recorte pequeño alrededor de cada coincidencia guardada, colocados en filas dentro de la misma imagen.'
    }
  ];

  function waitFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la captura'));
      img.src = src;
    });
  }

  function cropFromCapture(img, rect, pad) {
    const k = img.naturalWidth / window.innerWidth;
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const right = Math.min(window.innerWidth, rect.right + pad);
    const bottom = Math.min(window.innerHeight, rect.bottom + pad);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * k);
    canvas.height = Math.round(height * k);
    canvas.getContext('2d').drawImage(
      img, left * k, top * k, width * k, height * k, 0, 0, canvas.width, canvas.height
    );
    return { canvas, w: canvas.width, h: canvas.height, k };
  }

  function composeCaptures(crops) {
    const k = crops[0].k;
    const gap = CAPTURE_GAP * k;
    const maxWidth = window.innerWidth * k;
    const placed = [];
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let totalWidth = 0;

    for (const crop of crops) {
      if (x > 0 && x + crop.w > maxWidth) {
        y += rowHeight + gap;
        x = 0;
        rowHeight = 0;
      }
      placed.push({ ...crop, x, y });
      x += crop.w + gap;
      rowHeight = Math.max(rowHeight, crop.h);
      totalWidth = Math.max(totalWidth, x - gap);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(totalWidth);
    canvas.height = Math.ceil(y + rowHeight);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    placed.forEach((item, index) => {
      ctx.drawImage(item.canvas, item.x, item.y);
      ctx.strokeStyle = '#c4c7c5';
      ctx.lineWidth = Math.max(1, k);
      ctx.strokeRect(item.x, item.y, item.w, item.h);

      const r = CAPTURE_BADGE_RADIUS * k;
      const cx = item.x + r + 4 * k;
      const cy = item.y + r + 4 * k;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a73e8';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(14 * k)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), cx, cy);
    });

    return canvas;
  }

  function scrollContainerOf(range) {
    let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    while (el && el !== document.body) {
      const overflow = getComputedStyle(el).overflowY;
      if (el.scrollHeight > el.clientHeight && /auto|scroll|overlay/.test(overflow)) return el;
      el = el.parentElement;
    }
    return window;
  }

  function getScroll(ref) {
    return ref === window ? window.scrollY : ref.scrollTop;
  }

  function setScroll(ref, y) {
    if (ref === window) window.scrollTo(window.scrollX, y);
    else ref.scrollTop = y;
  }

  function unionRect(ranges) {
    const rects = ranges.map((range) => range.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom))
    };
  }

  function pageGroupKey(range) {
    const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    return el?.closest('[data-page-number]') ?? null;
  }

  function groupByPage(ranges) {
    const groups = new Map();
    for (const range of ranges) {
      const key = pageGroupKey(range);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(range);
    }
    return [...groups.values()];
  }

  function stackCrops(parts) {
    if (!parts.length) return null;
    const k = parts[0].k;
    const w = Math.max(...parts.map((p) => p.w));
    const h = parts.reduce((sum, p) => sum + p.h, 0);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    let y = 0;
    for (const part of parts) {
      ctx.drawImage(part.canvas, 0, y);
      y += part.h;
    }
    return { canvas, w, h, k };
  }

  async function captureGroup(ranges, pad, marks) {
    const ref = scrollContainerOf(ranges[0]);
    const vh = window.innerHeight;
    const start = unionRect(ranges);
    const absTop = start.top + getScroll(ref) - pad;
    const absBottom = start.bottom + getScroll(ref) + pad;
    const total = absBottom - absTop;

    const strips = [];
    if (total <= vh) {
      strips.push([absTop - (vh - total) / 2, absBottom + (vh - total) / 2]);
    } else {
      for (let s = absTop; s < absBottom; s += vh) strips.push([s, Math.min(s + vh, absBottom)]);
    }

    const parts = [];
    for (const [from, to] of strips) {
      setScroll(ref, from);
      await waitFrame();
      const actual = getScroll(ref);
      const box = unionRect(ranges);
      const rect = {
        left: Math.max(0, box.left - pad),
        right: Math.min(window.innerWidth, box.right + pad),
        top: from - actual,
        bottom: to - actual
      };

      const halos = drawStaticHalos(marks);
      await waitFrame();
      const response = await chrome.runtime.sendMessage({ type: 'remarkable:capture-tab' });
      halos.forEach((halo) => halo.remove());
      if (!response?.dataUrl) throw new Error(response?.error || 'Captura no disponible');
      const img = await loadImage(response.dataUrl);
      const crop = cropFromCapture(img, rect, 0);
      if (crop) parts.push(crop);
    }
    return stackCrops(parts);
  }

  function splitByDistance(ranges, maxGap) {
    const sorted = [...ranges].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const segments = [];
    let current = [];
    let lastBottom = 0;
    for (const range of sorted) {
      const rect = range.getBoundingClientRect();
      if (current.length && rect.top - lastBottom > maxGap) {
        segments.push(current);
        current = [];
      }
      current.push(range);
      lastBottom = current.length === 1 ? rect.bottom : Math.max(lastBottom, rect.bottom);
    }
    if (current.length) segments.push(current);
    return segments;
  }

  function planSegments(group, strategy) {
    if (strategy === 'individual') return group.map((range) => [range]);
    if (strategy === 'clusters') return splitByDistance(group, window.innerHeight / 2);
    return [group];
  }

  function askCaptureOptions(spread) {
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'dialog';
      const strategies = spread ? `
          <div class="dlg-sub">Coincidencias muy separadas en una misma página</div>
          ${CAPTURE_STRATEGIES.map((s, index) => `
            <label class="opt">
              <input type="radio" name="strategy" value="${s.id}"${index === 0 ? ' checked' : ''}>
              <span>${s.label}</span>
              <span class="help" title="${s.help}">?</span>
            </label>`).join('')}` : '';
      dialog.innerHTML = `
        <div class="dlg">
          <div class="dlg-title">Opciones de captura</div>
          <label class="opt">
            <input type="checkbox" name="highlight" checked>
            <span>Remarcar las coincidencias recordadas en la captura</span>
          </label>
          ${strategies}
          <div class="dlg-actions">
            <button type="button" data-ans="cancel">Cancelar</button>
            <button type="button" data-ans="ok" class="primary">Capturar</button>
          </div>
        </div>`;

      const finish = (value) => {
        dialog.remove();
        resolve(value);
      };
      dialog.addEventListener('click', (e) => {
        const ans = e.target.closest('[data-ans]')?.dataset.ans;
        if (ans === 'ok') {
          finish({
            highlight: dialog.querySelector('input[name=highlight]').checked,
            strategy: dialog.querySelector('input[name=strategy]:checked')?.value || 'continuous'
          });
        } else if (ans === 'cancel') finish(null);
      });
      state.root.append(dialog);
    });
  }

  async function captureSaved() {
    resolveSaved();
    const targets = state.saved.filter(isIntact);
    if (!targets.length || !state.host) return;

    const host = state.host;
    const pad = settings.capturePadding;
    const groups = groupByPage(targets);
    const spread = groups.some((group) => {
      const box = unionRect(group);
      return box.bottom - box.top + pad * 2 > window.innerHeight;
    });
    const options = await askCaptureOptions(spread);
    if (!options) return;
    const strategy = options.strategy;

    const savedScrolls = new Map();
    const crops = [];
    host.style.visibility = 'hidden';
    document.querySelectorAll('.remarkable-halo').forEach((node) => node.remove());
    if (supportsHighlights) {
      CSS.highlights.delete(MATCH_HL);
      CSS.highlights.delete(CURRENT_HL);
      if (!options.highlight) CSS.highlights.delete(SAVED_HL);
    }
    try {
      for (const group of groups) {
        for (const segment of planSegments(group, strategy)) {
          const ref = scrollContainerOf(segment[0]);
          if (!savedScrolls.has(ref)) savedScrolls.set(ref, getScroll(ref));
          const crop = await captureGroup(segment, pad, options.highlight ? state.saved.filter(isIntact) : []);
          if (crop) crops.push(crop);
        }
      }
      for (const [ref, y] of savedScrolls) setScroll(ref, y);
      if (!crops.length) return;

      const dataUrl = composeCaptures(crops).toDataURL('image/png');
      const result = await chrome.runtime.sendMessage({ type: 'remarkable:open-capture', dataUrl });
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      console.warn('[Remarkable] Error al capturar:', error);
    } finally {
      document.querySelectorAll('.remarkable-halo-static').forEach((node) => node.remove());
      host.style.visibility = '';
      paintHighlights();
    }
  }

  const BAR_STYLE = `
    .bar {
      display: flex; align-items: center; gap: 4px;
      padding: 6px 8px; background: #fff; color: #202124;
      border: 1px solid #c4c7c5; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
      font: 13px system-ui, sans-serif;
    }
    input {
      width: 220px; padding: 4px 6px; font: inherit;
      border: 1px solid #8ab4f8; border-radius: 4px; outline: none;
    }
    .count { min-width: 48px; text-align: center; color: #5f6368; }
    button {
      width: 26px; height: 26px; border: none; border-radius: 4px;
      background: transparent; cursor: pointer; font-size: 13px; color: #202124;
    }
    button:hover { background: #e8eaed; }
    .wrap { position: relative; }
    .saved { width: auto; padding: 0 6px; display: flex; align-items: center; gap: 2px; }
    .panel {
      position: absolute; top: calc(100% + 6px); right: 0;
      min-width: 260px; max-width: 360px; max-height: 320px; overflow-y: auto;
      padding: 4px; background: #fff; color: #202124;
      border: 1px solid #c4c7c5; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,.25); font: 13px system-ui, sans-serif;
    }
    .panel[hidden] { display: none; }
    .item { display: flex; align-items: center; gap: 4px; padding: 2px 4px; border-radius: 4px; }
    .item:hover { background: #f1f3f4; }
    .label {
      flex: 1; min-width: 0; padding: 4px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .empty { padding: 6px; color: #5f6368; }
    .dialog {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(32,33,36,.35);
    }
    .dlg {
      min-width: 340px; max-width: 420px; padding: 12px 14px;
      background: #fff; color: #202124; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.3); font: 13px system-ui, sans-serif;
    }
    .dlg-title { font-weight: 600; margin-bottom: 8px; }
    .dlg-sub { margin: 12px 0 4px; font-size: 13px; color: #5f6368; }
    .opt {
      display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 4px; cursor: pointer;
    }
    .opt:hover { background: #f1f3f4; }
    .help {
      margin-left: auto; width: 18px; height: 18px; border: 1px solid #5f6368; border-radius: 50%;
      color: #5f6368; display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; cursor: help;
    }
    .dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    .dlg-actions button { width: auto; padding: 4px 12px; border: 1px solid #c4c7c5; }
    .dlg-actions .primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
    .dlg-actions .primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
    :host(.dark) .bar, :host(.dark) .panel, :host(.dark) .dlg { background: #2d2e31; color: #e8eaed; border-color: #5f6368; }
    :host(.dark) input { background: #3c4043; color: #e8eaed; border-color: #8ab4f8; }
    :host(.dark) button { color: #e8eaed; }
    :host(.dark) button:hover, :host(.dark) .item:hover, :host(.dark) .opt:hover { background: #3c4043; }
    :host(.dark) .count, :host(.dark) .empty, :host(.dark) .dlg-sub, :host(.dark) .help { color: #9aa0a6; }
    :host(.dark) .dialog { background: rgba(0,0,0,.5); }
    :host(.dark) .dlg-actions button { border-color: #5f6368; }
  `;

  function openBar() {
    if (state.host) {
      state.input.focus();
      state.input.select();
      return;
    }

    const host = document.createElement('div');
    host.id = 'remarkable-host';
    Object.assign(host.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647'
    });
    host.classList.toggle('dark', !!settings.darkMode);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${BAR_STYLE}</style>
      <div class="wrap">
        <div class="bar">
          <input type="text" placeholder="Buscar en la página" spellcheck="false">
          <span class="count"></span>
          <button data-act="prev" title="Anterior (Shift+Enter / ↑)">▲</button>
          <button data-act="next" title="Siguiente (Enter / ↓)">▼</button>
          <button data-act="halo" title="Remarcar recordadas y actual (${settings.haloShortcut})">◎</button>
          <button data-act="save" title="Recordar coincidencia actual">+</button>
          <button data-act="saved" class="saved" title="Coincidencias recordadas">★</button>
          <button data-act="capture" title="Capturar coincidencias recordadas">📷</button>
          <button data-act="close" title="Cerrar (Esc)">✕</button>
        </div>
        <div class="panel" hidden></div>
      </div>`;

    const input = root.querySelector('input');
    state.host = host;
    state.root = root;
    state.input = input;
    state.count = root.querySelector('.count');
    state.panel = root.querySelector('.panel');

    input.addEventListener('input', () => runSearch(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        goTo(e.shiftKey ? state.current - 1 : state.current + 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        goTo(state.current + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        goTo(state.current - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSaved(true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSaved(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (!state.panel.hidden) state.panel.hidden = true;
        else closeBar();
      }
    });

    root.querySelector('.bar').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'next') goTo(state.current + 1);
      else if (act === 'prev') goTo(state.current - 1);
      else if (act === 'halo') remarkAll();
      else if (act === 'save') toggleSaved();
      else if (act === 'capture') captureSaved();
      else if (act === 'saved') {
        state.panel.hidden = !state.panel.hidden;
        renderSaved();
      } else if (act === 'close') closeBar();
    });

    state.panel.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      const go = e.target.closest('[data-go]');
      if (del) {
        state.saved.splice(Number(del.dataset.del), 1);
        renderSaved();
      } else if (go) {
        gotoSaved(state.saved[Number(go.dataset.go)]);
      }
    });

    const selected = window.getSelection()?.toString().trim();
    if (selected && selected.length <= 200 && !selected.includes('\n')) input.value = selected;

    document.documentElement.appendChild(host);
    document.addEventListener('mousedown', onOutsideMouseDown, true);
    renderSaved();
    input.focus();
    input.select();
    if (input.value) runSearch(input.value);
  }

  function handleCommand(type) {
    if (type === 'open-bar') {
      openBar();
    } else if (type === 'halo') {
      remarkAll();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type) handleCommand(message.type);
  });

  window.addEventListener('remarkable:command', (e) => handleCommand(e.detail));

  window.addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;

    if (combo === settings.findShortcut) {
      e.preventDefault();
      e.stopPropagation();
      openBar();
    } else if (combo === settings.haloShortcut) {
      if (!remarkTargets().ranges.length) return;
      e.preventDefault();
      e.stopPropagation();
      remarkAll();
    }
  }, true);
})();
