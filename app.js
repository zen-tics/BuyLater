/* ============================================================
   BUY LATER — app logic
   100% offline. No fetch(), no XHR, no analytics, no network.
   Storage: IndexedDB (images as blobs) on this device only.
   ============================================================ */

'use strict';

/* ---------- Defaults / settings ---------- */
const DEFAULTS = {
  theme: 'dark',
  remindersOn: true,
  thresholdPrice: 50,      // SGD
  daysUnder: 7,            // cooling-off for items < threshold
  daysOver: 14,            // cooling-off for items >= threshold
  ocrOn: true,
};
let settings = { ...DEFAULTS };

/* ---------- IndexedDB ---------- */
const DB_NAME = 'buylater', DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('items')) {
        const s = d.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function dbGetAll(store) {
  return new Promise((res, rej) => { const r = tx(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function dbPut(store, val) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
function dbGet(store, key) {
  return new Promise((res, rej) => { const r = tx(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function dbDelete(store, key) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

async function loadSettings() {
  const rows = await dbGetAll('settings');
  rows.forEach(r => { if (r.k in settings) settings[r.k] = r.v; });
}
async function saveSetting(k, v) { settings[k] = v; await dbPut('settings', { k, v }); }

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAY = 86400000;
const todayISO = () => new Date().toISOString().slice(0, 10);
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtMoney(n) {
  if (n == null || n === '' || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function coolingDays(price) {
  return Number(price) >= settings.thresholdPrice ? settings.daysOver : settings.daysUnder;
}
function reviewDate(item) {
  const base = new Date((item.lastDeferredOn || item.addedOn) + 'T00:00:00').getTime();
  return base + coolingDays(item.price) * DAY;
}
function isDue(item) {
  return item.status === 'waiting' && Date.now() >= reviewDate(item);
}
function daysLeft(item) {
  return Math.ceil((reviewDate(item) - Date.now()) / DAY);
}
let blobURLs = [];
function blobURL(blob) { const u = URL.createObjectURL(blob); blobURLs.push(u); return u; }
function revokeURLs() { blobURLs.forEach(u => URL.revokeObjectURL(u)); blobURLs = []; }

/* ---------- Toast ---------- */
let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Navigation ---------- */
let current = 'list';
function go(tab) {
  current = tab;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + tab).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('main').scrollTop = 0;
  if (tab === 'list') renderList();
  if (tab === 'inbox') renderInbox();
  if (tab === 'stats') renderStats();
  if (tab === 'settings') renderSettings();
}

/* ============================================================
   ADD FLOW
   ============================================================ */
let draft = null; // { blob, imgURL, source, url }

function openAdd() {
  draft = { blob: null, imgURL: null, source: '', url: '' };
  $('urlField').style.display = 'none';
  $('previewWrap').style.display = 'none';
  $('formFields').style.display = 'none';
  $('urlInput').value = '';
  document.querySelectorAll('.src-opt').forEach(o => o.classList.remove('on'));
  showSheet('add');
}
function closeAdd() { hideSheet('add'); }

function pickSource(kind) {
  document.querySelectorAll('.src-opt').forEach(o => o.classList.remove('on'));
  $('src' + kind.charAt(0).toUpperCase() + kind.slice(1)).classList.add('on');
  $('screenshotTip').style.display = 'none';
  if (kind === 'camera') { $('urlField').style.display = 'none'; $('fileCamera').click(); }
  else if (kind === 'upload') { $('urlField').style.display = 'none'; $('fileUpload').click(); }
  else if (kind === 'screenshot') {
    $('urlField').style.display = 'none';
    $('previewWrap').style.display = 'none';
    $('formFields').style.display = 'none';
    $('screenshotTip').style.display = 'block';
  }
  else if (kind === 'url') {
    $('urlField').style.display = 'block';
    $('previewWrap').style.display = 'none';
    $('formFields').style.display = 'block';
    prefillForm({});
    draft.source = '';
  }
}

async function takeScreenshot() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Screen capture not supported in this browser');
    return;
  }
  let stream;
  try {
    // Ask the browser to share the screen — a system-level permission prompt
    // appears; the user chooses what to share. This is enforced by the OS and
    // cannot be bypassed. The app captures ONE frame then immediately stops.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    });
  } catch (err) {
    // User cancelled or denied — not an error, just close the tip
    $('screenshotTip').style.display = 'none';
    $('srcScreenshot').classList.remove('on');
    return;
  }

  // Grab a single frame via an offscreen video element -> canvas -> blob
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  // Give the video one frame to render
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  // Stop sharing immediately — single frame captured, nothing more is read
  stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;

  // Convert to blob and process exactly like a photo upload
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('Capture failed — try again'); return; }
    $('screenshotTip').style.display = 'none';
    const scaled = await downscale(blob, 1280);
    draft.blob = scaled;
    draft.imgURL = blobURL(scaled);
    $('previewImg').src = draft.imgURL;
    $('previewWrap').style.display = 'block';
    $('formFields').style.display = 'block';
    prefillForm({});
    if (settings.ocrOn) runOCR(scaled);
  }, 'image/jpeg', 0.85);
}

$('urlInput')?.addEventListener('input', (e) => {
  const v = e.target.value.trim();
  draft.url = v;
  try { const h = new URL(v).hostname.replace(/^www\./, ''); if (h) $('fSource').value = h; } catch (_) {}
});

async function onFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  // downscale to keep storage light & speed OCR — all in-browser
  const blob = await downscale(file, 1280);
  draft.blob = blob;
  draft.imgURL = blobURL(blob);
  $('previewImg').src = draft.imgURL;
  $('previewWrap').style.display = 'block';
  $('formFields').style.display = 'block';
  prefillForm({});
  if (settings.ocrOn) runOCR(blob);
}

function downscale(file, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => resolve(b), 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

function prefillForm({ name, price, source, date }) {
  $('fName').value = name || '';
  $('fPrice').value = price != null ? price : '';
  $('fSource').value = source || $('fSource').value || '';
  $('fDate').value = date || todayISO();
  $('fNote').value = '';
}

/* ---------- On-device OCR (Tesseract.js, model bundled locally) ---------- */
async function runOCR(blob) {
  if (typeof Tesseract === 'undefined') { return; } // bundle missing — skip silently
  const status = $('scanStatus'); status.style.display = 'flex';
  $('scanText').textContent = 'Reading details on-device…';
  try {
    const { data } = await Tesseract.recognize(blob, 'eng', {
      // point Tesseract at LOCAL assets so it never reaches the internet
      workerPath: 'tess/worker.min.js',
      corePath: 'tess/tesseract-core-simd-lstm.wasm.js',
      langPath: 'tess/',
      logger: m => {
        if (m.status === 'recognizing text') $('scanText').textContent = 'Reading details… ' + Math.round(m.progress * 100) + '%';
      }
    });
    const text = (data && data.text) ? data.text : '';
    const found = applyOCR(text) || {};
    status.style.display = 'none';
    const got = ['name', 'price', 'source'].filter(k => found[k]);
    if (got.length >= 2) toast('Scanned — check the details');
    else if (got.length === 1) toast('Got the ' + got[0] + ' — add the rest');
    else toast("Couldn't read it — type the details");
  } catch (err) {
    status.style.display = 'none';
    // OCR is best-effort; the user can always type the fields.
    console.warn('OCR unavailable:', err && err.message);
  }
}

function applyOCR(text) {
  if (!text) return;
  const rawLines = text.split('\n').map(s => s.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
  const joined = text.replace(/\n/g, ' ');

  /* ---------- PRICE ----------
     Prefer a value attached to a currency symbol. Also handle "split" prices
     where a retail tag shows the dollars big and the cents small, so OCR
     reads "$9 10" or "$9" then "10" on separate tokens -> 9.10. */
  const price = detectPrice(text);

  /* ---------- NAME ----------
     Score each line. A product name is usually a SHORT, prominent line with
     capital letters, near the top — not a long lowercase marketing sentence
     and not a block of non-Latin script. We score and pick the best. */
  const name = detectName(rawLines);

  /* ---------- SOURCE ---------- */
  const sources = ['Shopee', 'Lazada', 'Taobao', 'Amazon', 'Qoo10', 'Carousell', 'AliExpress', 'Zalora', 'IKEA', 'Decathlon', 'Guardian', 'Watsons', 'Unity', 'NTUC', 'FairPrice', 'Cold Storage'];
  let source = '';
  for (const s of sources) { if (new RegExp('\\b' + s.replace(/\s/g, '\\s?') + '\\b', 'i').test(joined)) { source = s; break; } }

  if (name && !$('fName').value) $('fName').value = name;
  if (price != null && !$('fPrice').value) $('fPrice').value = price;
  if (source && !$('fSource').value) $('fSource').value = source;

  return { name: !!name, price: price != null, source: !!source };
}

/* Remove characters OCR shouldn't be putting in a text field, collapse spaces. */
function sanitizeField(s) {
  return String(s || '')
    .replace(/[<>{}\\|`~^]/g, ' ')      // strip markup-ish / junk chars
    .replace(/[^\w\s.,&+%/()'°-]/g, ' ') // keep letters, digits, common punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Detect a price. Only currency-anchored numbers are trusted, so we don't grab
   random digits (sizes, quantities, SKU codes) by mistake. */
function detectPrice(text) {
  const joined = text.replace(/\n/g, ' ');
  const candidates = [];
  let m;

  // 1) symbol + number with proper decimals e.g. $9.10, SGD 12.90, RM8.80, 5.00
  const full = /(?:S?\$|SGD|RM|USD|US\$|£|€|¥)\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/gi;
  while ((m = full.exec(joined)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 3 });
  }

  // 2) split price: symbol, dollars, then exactly 2 small "cents" digits, no decimal
  //    e.g. "$9 10" (cents printed small on a shelf tag) -> 9.10
  const split = /(?:S?\$|SGD|RM)\s?(\d{1,4})\s+(\d{2})\b(?!\s*\d)/gi;
  while ((m = split.exec(joined)) !== null) {
    const v = parseFloat(parseInt(m[1], 10) + '.' + m[2]);
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 2 });
  }

  // 3) a bare "N.NN" number on its OWN short line (common on shelf tags like "5.00")
  text.split('\n').forEach(line => {
    const t = line.trim();
    if (/^\d{1,4}\.\d{2}$/.test(t)) {
      const v = parseFloat(t);
      if (v > 0 && v < 100000) candidates.push({ v, score: 2 });
    }
  });

  // 4) symbol + whole number e.g. $9, RM 80 (least specific)
  const whole = /(?:S?\$|SGD|RM|USD|US\$|£|€|¥)\s?(\d{1,5})\b(?!\s*[.\d])/gi;
  while ((m = whole.exec(joined)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 1 });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.v - a.v);
  return candidates[0].v;
}

/* Pick the most name-like line. Conservative: if nothing scores well, return
   '' and let the user type it — a blank beats a wrong guess they must delete. */
function detectName(lines) {
  // Words that mean "this line is packaging boilerplate, not the product name"
  const stop = /(^sterile$|strips?$|pcs$|pieces$|net wt|barcode|qty|made in|expiry|best before|ingredients|warning|directions|hypoallergenic|www\.|http|\.com|reg\.?\s?no|illustration|availability|visuals are|more information|flexible fabric|low allergy|low adherent|for cuts|for grazes|skin friendly)/i;
  // Promo-poster phrases (Image 4): "BUY ANY 2 ... GET 1 ..."
  const promo = /(buy any|get \d|play mode|free|% off|promo|offer|discount|drinks?)/i;

  let best = null, bestScore = 1.5; // require a real positive score to accept anything
  lines.forEach((ln, idx) => {
    const clean = sanitizeField(ln);
    if (!clean) return;
    const latin = (clean.match(/[A-Za-z]/g) || []).length;
    const total = clean.replace(/\s/g, '').length || 1;
    if (latin / total < 0.6) return;        // mostly non-Latin script -> skip
    if (latin < 4) return;                   // too few letters (e.g. "N Cs") -> skip

    const words = clean.split(/\s+/).filter(Boolean);
    const realWords = words.filter(w => /[A-Za-z]{3,}/.test(w)); // words with >=3 letters
    if (realWords.length < 1) return;        // all fragments/codes -> skip

    // reject SKU/receipt code lines like "G ADH D/S6X8.3CM (N)" — lots of
    // single letters, slashes and digits, few real words
    const codey = words.filter(w => /[/\d]/.test(w) || w.length <= 2).length;
    if (codey >= words.length * 0.5 && realWords.length < 2) return;

    let score = 0;
    score += Math.max(0, 6 - idx) * 1.2;     // earlier lines slightly favoured
    score += realWords.length * 2;            // more real words = more name-like
    const capWords = words.filter(w => /^[A-Z]/.test(w)).length;
    score += capWords * 1.5;
    const lowerStart = words.filter(w => /^[a-z]/.test(w)).length;
    score -= lowerStart * 1.5;                // lowercase prose -> description
    if (clean.includes(' - ') || clean.includes('·')) score -= 6;
    if (realWords.length >= 1 && words.length <= 6) score += 2;
    if (words.length > 8) score -= 6;
    if (clean.length > 45) score -= 4;
    if (stop.test(clean)) score -= 10;
    if (promo.test(clean)) score -= 10;

    if (score > bestScore) { bestScore = score; best = clean; }
  });

  if (!best) return '';

  // If a clear brand line sits just above, prepend it (e.g. "Hansaplast" + product).
  // Skip store names (those belong in "Where from") and all-lowercase logos.
  const storeName = /^(guardian|watsons|unity|ntuc|fairprice|cold storage|shopee|lazada)$/i;
  const bi = lines.findIndex(l => sanitizeField(l) === best);
  if (bi > 0) {
    const nb = sanitizeField(lines[bi - 1]);
    const nbWords = nb.split(/\s+/).filter(Boolean);
    const nbReal = nbWords.filter(w => /[A-Za-z]{3,}/.test(w));
    if (nbReal.length >= 1 && nbWords.length <= 3 && /^[A-Z]/.test(nb) &&
        !storeName.test(nb) && !stop.test(nb) && !promo.test(nb) && !nb.includes(' - ')) {
      best = (nb + ' ' + best).trim();
    }
  }
  best = best.replace(/\s{2,}/g, ' ').trim();
  if (best.length > 60) best = best.slice(0, 60).trim();
  return best;
}

async function saveItem() {
  const name = $('fName').value.trim();
  const price = parseFloat($('fPrice').value);
  if (!name) { toast('Give it a name first'); $('fName').focus(); return; }

  const item = {
    id: uid(),
    name,
    price: isNaN(price) ? null : price,
    source: $('fSource').value.trim(),
    note: $('fNote').value.trim(),
    url: draft.url || '',
    addedOn: $('fDate').value || todayISO(),
    lastDeferredOn: null,
    status: 'waiting',          // waiting | bought | dropped
    deferCount: 0,
    blob: draft.blob || null,
    decidedOn: null,
    history: [{ action: 'added', on: todayISO() }],
  };
  await dbPut('items', item);
  closeAdd();
  toast('Saved — review in ' + coolingDays(item.price) + ' days');
  go('list');
  await refreshBadge();
}

/* ============================================================
   RENDER: LIST
   ============================================================ */
async function renderList() {
  revokeURLs();
  const items = (await dbGetAll('items')).filter(i => i.status === 'waiting');
  items.sort((a, b) => reviewDate(a) - reviewDate(b));
  const el = $('listContent');
  if (!items.length) {
    el.innerHTML = emptyState('grid', 'Nothing waiting yet',
      'Tap the + button to photograph something you want to buy. Give it a few days — most wants fade.');
    return;
  }
  el.innerHTML = '<div class="grid">' + items.map(i => cardHTML(i)).join('') + '</div>';
}

function cardHTML(i) {
  const due = isDue(i);
  const img = i.blob
    ? `<img class="thumb" src="${blobURL(i.blob)}" alt="">`
    : `<div class="thumb placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>`;
  const pill = due
    ? '<span class="pill due">Decide now</span>'
    : `<span class="pill waiting">${daysLeft(i)}d left</span>`;
  return `<div class="card" onclick="openDetail('${i.id}')">
    ${due ? '<div class="due-dot"></div>' : ''}
    ${img}
    <div class="body">
      <div class="name">${esc(i.name)}</div>
      <div class="meta"><span class="price">${fmtMoney(i.price)}</span>${pill}</div>
      <div class="when">Added ${fmtDate(i.addedOn)}</div>
    </div>
  </div>`;
}

/* ============================================================
   RENDER: INBOX (due reviews)
   ============================================================ */
async function renderInbox() {
  revokeURLs();
  const items = (await dbGetAll('items')).filter(i => isDue(i));
  items.sort((a, b) => reviewDate(a) - reviewDate(b));
  const el = $('inboxContent');
  if (!items.length) {
    el.innerHTML = emptyState('check', 'Inbox zero',
      'No items are due for review. When a cooling-off period ends, the item shows up here to decide on.');
    return;
  }
  el.innerHTML = items.map(i => {
    const img = i.blob
      ? `<img class="ithumb" src="${blobURL(i.blob)}" alt="">`
      : `<div class="ithumb placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>`;
    const waited = Math.round((Date.now() - new Date(i.addedOn + 'T00:00:00').getTime()) / DAY);
    return `<div class="inbox-row" onclick="openDetail('${i.id}')">
      ${img}
      <div class="info">
        <div class="n">${esc(i.name)}</div>
        <div class="d">${fmtMoney(i.price)} · <b>waited ${waited}d</b>${i.deferCount ? ' · deferred ' + i.deferCount + '×' : ''}</div>
      </div>
      <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`;
  }).join('');
}

/* ============================================================
   DETAIL + ACTIONS
   ============================================================ */
let activeId = null;
async function openDetail(id) {
  const i = await dbGet('items', id);
  if (!i) return;
  activeId = id;
  const due = isDue(i);
  const img = i.blob
    ? `<img class="detail-img" src="${blobURL(i.blob)}" alt="">` : '';
  const banner = i.status === 'waiting'
    ? (due
      ? `<div class="review-banner due"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Cooling-off complete. Still want it?</div>`
      : `<div class="review-banner waiting"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Cooling off — review in ${daysLeft(i)} day${daysLeft(i) === 1 ? '' : 's'} (${fmtDate(new Date(reviewDate(i)).toISOString().slice(0,10))}).</div>`)
    : `<div class="review-banner ${i.status === 'bought' ? 'waiting' : 'due'}" style="background:var(--${i.status==='bought'?'buy':'drop'}-soft);color:var(--${i.status==='bought'?'buy':'drop'})">${i.status === 'bought' ? 'You bought this' : 'You dropped this'} on ${fmtDate(i.decidedOn)}.</div>`;

  const urlChip = i.url ? `<a class="chip" href="${esc(i.url)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open link</a>` : '';

  const actions = i.status === 'waiting' ? `
    <div class="action-grid">
      <button class="btn buy" onclick="decide('buy')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>Buy it</button>
      <button class="btn defer" onclick="decide('defer')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Defer</button>
      <button class="btn drop" onclick="decide('drop')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Drop it</button>
    </div>` : `
    <button class="btn ghost" onclick="reopen()" style="margin-top:6px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Move back to waiting</button>`;

  $('detailContent').innerHTML = `
    <h2 style="margin-bottom:14px">Item</h2>
    ${img}
    <div class="detail-price">${fmtMoney(i.price)}</div>
    <div class="detail-name">${esc(i.name)}</div>
    <div class="detail-meta">
      ${i.source ? `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>${esc(i.source)}</span>` : ''}
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${fmtDate(i.addedOn)}</span>
      ${i.deferCount ? `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Deferred ${i.deferCount}×</span>` : ''}
      ${urlChip}
    </div>
    ${i.note ? `<div class="chip" style="display:block;width:100%;text-align:left;white-space:normal;line-height:1.5;padding:12px 14px;margin-bottom:16px">${esc(i.note)}</div>` : ''}
    ${banner}
    ${actions}
    <button class="btn ghost" onclick="deleteItem()" style="margin-top:10px;color:var(--text-dim)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete permanently</button>
  `;
  showSheet('detail');
}
function closeDetail() { hideSheet('detail'); }

async function decide(action) {
  const i = await dbGet('items', activeId);
  if (!i) return;
  if (action === 'defer') {
    i.lastDeferredOn = todayISO();
    i.deferCount = (i.deferCount || 0) + 1;
    i.history.push({ action: 'deferred', on: todayISO() });
    await dbPut('items', i);
    toast('Deferred — back in ' + coolingDays(i.price) + ' days');
  } else {
    i.status = action === 'buy' ? 'bought' : 'dropped';
    i.decidedOn = todayISO();
    i.history.push({ action: action === 'buy' ? 'bought' : 'dropped', on: todayISO() });
    await dbPut('items', i);
    toast(action === 'buy' ? 'Marked as bought ✓' : 'Dropped — money saved 🎉');
  }
  closeDetail();
  await refreshBadge();
  go(current);
}

async function reopen() {
  const i = await dbGet('items', activeId);
  i.status = 'waiting'; i.decidedOn = null; i.lastDeferredOn = todayISO();
  i.history.push({ action: 'reopened', on: todayISO() });
  await dbPut('items', i);
  closeDetail(); await refreshBadge(); go(current);
  toast('Back in waiting');
}

async function deleteItem() {
  await dbDelete('items', activeId);
  closeDetail(); await refreshBadge(); go(current);
  toast('Deleted');
}

/* ============================================================
   RENDER: STATS / TRENDS
   ============================================================ */
async function renderStats() {
  const items = await dbGetAll('items');
  const bought = items.filter(i => i.status === 'bought').length;
  const dropped = items.filter(i => i.status === 'dropped').length;
  const deferTotal = items.reduce((s, i) => s + (i.deferCount || 0), 0);
  const waiting = items.filter(i => i.status === 'waiting').length;
  const decided = bought + dropped;

  const el = $('statsContent');
  if (!items.length) {
    el.innerHTML = emptyState('chart', 'No data yet',
      'Once you start deciding on items, your buy / drop / defer patterns appear here.');
    return;
  }

  const dropRate = decided ? Math.round(dropped / decided * 100) : 0;
  const savedAmt = items.filter(i => i.status === 'dropped').reduce((s, i) => s + (Number(i.price) || 0), 0);

  // Build 6-month trend of decisions
  const months = lastNMonths(6);
  const buySeries = months.map(() => 0), dropSeries = months.map(() => 0), deferSeries = months.map(() => 0);
  items.forEach(i => {
    (i.history || []).forEach(h => {
      const idx = months.findIndex(m => h.on && h.on.startsWith(m.key));
      if (idx === -1) return;
      if (h.action === 'bought') buySeries[idx]++;
      else if (h.action === 'dropped') dropSeries[idx]++;
      else if (h.action === 'deferred') deferSeries[idx]++;
    });
  });

  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card buy"><div class="v">${bought}</div><div class="k">Bought</div></div>
      <div class="stat-card drop"><div class="v">${dropped}</div><div class="k">Dropped</div></div>
      <div class="stat-card defer"><div class="v">${deferTotal}</div><div class="k">Defers</div></div>
    </div>

    <div class="chart-card">
      <h4>Decisions over time</h4>
      <div class="cs">Last 6 months — buy vs drop vs defer</div>
      <canvas id="trendChart" height="200"></canvas>
      <div class="chart-legend">
        <span><i style="background:var(--buy)"></i>Bought</span>
        <span><i style="background:var(--drop)"></i>Dropped</span>
        <span><i style="background:var(--defer)"></i>Deferred</span>
      </div>
    </div>

    <div class="chart-card">
      <h4>Where they end up</h4>
      <div class="cs">Of everything you've decided on</div>
      <canvas id="donutChart" height="180"></canvas>
    </div>

    <div class="insight">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>
      <div class="it">You dropped <b>${dropRate}%</b> of items you've decided on${savedAmt > 0 ? `, avoiding about <b>${fmtMoney(savedAmt)}</b> in impulse spending` : ''}. ${waiting ? `<b>${waiting}</b> still cooling off.` : 'The cooling-off habit is working.'}</div>
    </div>
  `;

  drawTrend('trendChart', months.map(m => m.label), buySeries, dropSeries, deferSeries);
  drawDonut('donutChart', bought, dropped, deferTotal);
}

function lastNMonths(n) {
  const out = [], d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: m.toISOString().slice(0, 7), label: m.toLocaleDateString(undefined, { month: 'short' }) });
  }
  return out;
}

function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

/* Lightweight canvas charts (no external chart lib needed -> smaller, offline) */
function drawTrend(id, labels, s1, s2, s3) {
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 26, r: 8, t: 12, b: 24 };
  const maxV = Math.max(1, ...s1, ...s2, ...s3);
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const x = i => pad.l + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = v => pad.t + plotH - (v / maxV) * plotH;

  // grid
  ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = 1; ctx.fillStyle = cssVar('--text-faint'); ctx.font = '10px system-ui';
  const steps = Math.min(maxV, 4);
  for (let g = 0; g <= steps; g++) {
    const val = Math.round(maxV * g / steps), yy = y(val);
    ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(val, 4, yy + 3);
  }
  labels.forEach((lb, i) => { ctx.textAlign = 'center'; ctx.fillText(lb, x(i), H - 7); });
  ctx.textAlign = 'left';

  const series = [[s1, cssVar('--buy')], [s2, cssVar('--drop')], [s3, cssVar('--defer')]];
  series.forEach(([data, color]) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    data.forEach((v, i) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(i), y(v), 3, 0, 7); ctx.fill(); });
  });
}

function drawDonut(id, buy, drop, defer) {
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 180;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const total = buy + drop + defer;
  const cx = W / 2, cy = H / 2, r = 62, lw = 26;
  if (total === 0) {
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    ctx.fillStyle = cssVar('--text-faint'); ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('No decisions yet', cx, cy + 4);
    return;
  }
  const parts = [[buy, cssVar('--buy')], [drop, cssVar('--drop')], [defer, cssVar('--defer')]];
  let a = -Math.PI / 2;
  parts.forEach(([v, c]) => {
    if (!v) return;
    const ang = v / total * Math.PI * 2;
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, r, a, a + ang); ctx.stroke();
    a += ang;
  });
  ctx.fillStyle = cssVar('--text'); ctx.font = '700 26px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(total, cx, cy - 2);
  ctx.fillStyle = cssVar('--text-dim'); ctx.font = '11px system-ui';
  ctx.fillText('actions', cx, cy + 16);
}

/* ============================================================
   RENDER: SETTINGS
   ============================================================ */
function renderSettings() {
  const el = $('settingsContent');
  el.innerHTML = `
    <div class="eyebrow" style="margin-top:8px">Appearance</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Theme</div><div class="s">Light or dark — your eyes, your call.</div></div>
      </div>
      <div style="padding:0 16px 16px">
        <div class="segment">
          <button class="${settings.theme==='light'?'on':''}" onclick="setTheme('light')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>Light</button>
          <button class="${settings.theme==='dark'?'on':''}" onclick="setTheme('dark')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>Dark</button>
        </div>
      </div>
    </div>

    <div class="eyebrow">Cooling-off rules</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Price threshold</div><div class="s">Items at or above this wait longer.</div></div>
        <div class="num"><input type="number" id="setThresh" value="${settings.thresholdPrice}" inputmode="decimal" onchange="saveNum('thresholdPrice',this.value,1)"></div>
      </div>
      <div class="set-row">
        <div class="l"><div class="t">Wait — under threshold</div><div class="s">Days to cool off for cheaper items.</div></div>
        <div class="num"><input type="number" id="setUnder" value="${settings.daysUnder}" inputmode="numeric" onchange="saveNum('daysUnder',this.value,1)"></div>
      </div>
      <div class="set-row">
        <div class="l"><div class="t">Wait — over threshold</div><div class="s">Days to cool off for pricier items.</div></div>
        <div class="num"><input type="number" id="setOver" value="${settings.daysOver}" inputmode="numeric" onchange="saveNum('daysOver',this.value,1)"></div>
      </div>
    </div>

    <div class="eyebrow">Reminders & scanning</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Review reminders</div><div class="s">Notify when an item's cooling-off ends. Works while the app is open; install to home screen for background nudges where supported.</div></div>
        <div class="toggle ${settings.remindersOn?'on':''}" onclick="toggleSet('remindersOn',this)"><div class="knob"></div></div>
      </div>
      <div class="set-row">
        <div class="l"><div class="t">Auto-scan photos</div><div class="s">Read name, price & store from the image on-device. Turn off to always type by hand.</div></div>
        <div class="toggle ${settings.ocrOn?'on':''}" onclick="toggleSet('ocrOn',this)"><div class="knob"></div></div>
      </div>
    </div>

    <div class="eyebrow">Your data</div>
    <div class="set-group">
      <div class="set-row" onclick="exportData()">
        <div class="l"><div class="t">Export backup</div><div class="s">Save all items as a file you control.</div></div>
        <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
      </div>
      <div class="set-row" onclick="clearAll()">
        <div class="l"><div class="t" style="color:var(--drop)">Erase everything</div><div class="s">Permanently delete all items from this device.</div></div>
        <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></div>
      </div>
    </div>

    <div class="privacy">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Fully offline · No accounts · Data never leaves this device
    </div>
  `;
}

async function setTheme(t) { document.body.setAttribute('data-theme', t); await saveSetting('theme', t); renderSettings(); }
async function saveNum(k, v, min) { let n = parseFloat(v); if (isNaN(n) || n < min) n = DEFAULTS[k]; await saveSetting(k, n); }
async function toggleSet(k, el) {
  const v = !settings[k]; el.classList.toggle('on', v); await saveSetting(k, v);
  if (k === 'remindersOn' && v) requestNotifyPermission();
}

async function exportData() {
  const items = await dbGetAll('items');
  // strip blobs (binary) -> JSON keeps it portable & private
  const clean = items.map(({ blob, ...rest }) => ({ ...rest, hadImage: !!blob }));
  const data = { app: 'Buy Later', exportedOn: new Date().toISOString(), settings, items: clean };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'buy-later-backup.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup saved');
}

async function clearAll() {
  if (!confirm('Erase all items permanently? This cannot be undone.')) return;
  const items = await dbGetAll('items');
  for (const i of items) await dbDelete('items', i.id);
  await refreshBadge(); go('list');
  toast('Everything erased');
}

/* ============================================================
   Reminders (local, no server)
   ============================================================ */
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
async function checkDueReminders() {
  if (!settings.remindersOn) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const items = (await dbGetAll('items')).filter(isDue);
  // notify once per item per day
  const today = todayISO();
  const notifiedKey = 'bl_notified_' + today;
  let notified = [];
  try { notified = JSON.parse(localStorage.getItem(notifiedKey) || '[]'); } catch (_) {}
  const fresh = items.filter(i => !notified.includes(i.id));
  if (fresh.length) {
    new Notification('Buy Later — time to review', {
      body: fresh.length === 1
        ? `"${fresh[0].name}" finished cooling off. Still want it?`
        : `${fresh.length} items are ready for your decision.`,
      tag: 'buylater-review'
    });
    try { localStorage.setItem(notifiedKey, JSON.stringify([...notified, ...fresh.map(i => i.id)])); } catch (_) {}
  }
}

/* ---------- Badge ---------- */
async function refreshBadge() {
  const items = (await dbGetAll('items')).filter(isDue);
  const b = $('inboxBadge');
  b.textContent = items.length ? items.length : '';
  b.className = items.length ? 'badge' : '';
}

/* ---------- Sheets ---------- */
function showSheet(name) { $(name + 'Scrim').classList.add('show'); $(name + 'Sheet').classList.add('show'); document.body.style.overflow = 'hidden'; }
function hideSheet(name) { $(name + 'Scrim').classList.remove('show'); $(name + 'Sheet').classList.remove('show'); document.body.style.overflow = ''; }

/* ---------- utils ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function emptyState(icon, title, body) {
  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  };
  return `<div class="empty"><div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[icon]}</svg></div><h3>${title}</h3><p>${body}</p></div>`;
}

/* ============================================================
   INIT
   ============================================================ */
(async function init() {
  await openDB();
  await loadSettings();
  document.body.setAttribute('data-theme', settings.theme);
  await refreshBadge();
  renderList();
  checkDueReminders();
  setInterval(checkDueReminders, 60 * 60 * 1000); // hourly while open
  if (settings.remindersOn) requestNotifyPermission();

  // register service worker for offline + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
