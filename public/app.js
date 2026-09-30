// Resale Tracker front-end: vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
let CUR = '$', AI = false, FEES = {}, tab = 'home', stockFilter = 'all';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `${n < 0 ? '-' : ''}${CUR}${Math.abs(Number(n) || 0).toFixed(2)}`;
const signed = n => `<span class="${n >= 0 ? 'good' : 'bad'}">${money(n)}</span>`;
const today = () => new Date().toISOString().slice(0, 10);

async function api(path, opts = {}) {
  const isBlob = opts.body instanceof Blob;
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: isBlob ? { 'content-type': opts.body.type } : opts.body ? { 'content-type': 'application/json' } : {},
    body: isBlob ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { showLogin(); throw new Error('Login required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
const openSheet = html => { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; $('#sheet .sheet-card').scrollTop = 0; };
const closeSheet = () => { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; };
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// Downscale photos before upload (phone photos are huge; 1280px is plenty for ID + listing reference).
async function shrink(file, max = 1280) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

async function barcodeFromBlob(blob) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    const found = await det.detect(await createImageBitmap(blob));
    return found[0]?.rawValue || null;
  } catch { return null; }
}

// Live camera barcode scan (Chrome/Android). Resolves with the code or null if cancelled/unsupported.
async function scanBarcode() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast('Live scanning not supported here — take a photo of the barcode or type it in'); return null;
  }
  const wrap = document.createElement('div'); wrap.id = 'video-wrap';
  wrap.innerHTML = '<video playsinline muted></video><button class="btn alt">Cancel</button>';
  document.body.append(wrap);
  const video = $('video', wrap);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { wrap.remove(); toast('Camera permission denied'); return null; }
  video.srcObject = stream; await video.play();
  const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; clearInterval(iv); stream.getTracks().forEach(t => t.stop()); wrap.remove(); resolve(v); };
    $('button', wrap).onclick = () => finish(null);
    const iv = setInterval(async () => {
      try { const f = await det.detect(video); if (f[0]) finish(f[0].rawValue); } catch { /* keep trying */ }
    }, 300);
  });
}

// ---------- shared pieces ----------
const thumb = i => `<div class="thumb" style="${i.photos?.[0] ? `background-image:url('${esc(i.photos[0].url)}')` : ''}">${i.photos?.[0] ? '' : '📦'}</div>`;

function itemRow(i, extra = '') {
  const right = i.status === 'sold' ? signed(i.profit) : money(i.cost);
  const sub = i.status === 'sold' ? `Sold ${esc(i.sold_date)} · ${esc(FEES[i.platform]?.label || i.platform)}` : `${esc(i.brand || '')} ${i.listed_on ? '· ' + esc(i.listed_on) : ''}`;
  return `<div class="card item" data-id="${i.id}">${thumb(i)}<div class="info"><div class="t">${esc(i.title)}</div><div class="muted">${sub}</div></div><div class="right">${right}${extra}</div></div>`;
}
const bindItemRows = (root, fn) => root.querySelectorAll('.item[data-id]').forEach(el => (el.onclick = () => fn(Number(el.dataset.id))));

// ---------- tabs ----------
document.querySelectorAll('#tabs button').forEach(b => (b.onclick = () => go(b.dataset.tab)));
function go(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  ({ home: renderHome, stock: renderStock, add: renderAdd, sell: renderSell, sold: renderSold })[t]();
  window.scrollTo(0, 0);
}

// ---------- home ----------
async function renderHome() {
  const s = await api('/stats');
  const t = s.totals;
  const plat = s.byPlatform.map(p => `<div class="row" style="margin:6px 0"><span>${esc(FEES[p.platform]?.label || p.platform)} <span class="muted">(${p.count})</span></span><span style="text-align:right">${signed(p.profit)}</span></div>`).join('') || '<div class="muted">No sales yet</div>';
  const months = s.byMonth.map(m => `<div class="row" style="margin:6px 0"><span>${esc(m.month)} <span class="muted">(${m.count} sold)</span></span><span style="text-align:right">${signed(m.profit)}</span></div>`).join('') || '<div class="muted">No sales yet</div>';
  const hr = new Date().getHours();
  const hi = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  view.innerHTML = `
    <div class="hero"><div class="hi">${hi}, Ashley 💖</div><div class="big">${money(t.profit)}</div><div class="sub">total profit · ${t.sold_count} item${t.sold_count === 1 ? '' : 's'} sold</div></div>
    <div class="stats">
      <div class="card stat"><span class="ico">💰</span><span class="muted">Revenue</span><b>${money(t.revenue)}</b></div>
      <div class="card stat"><span class="ico">📦</span><span class="muted">In stock</span><b>${s.stock.count}</b><span class="muted">${money(s.stock.cost)} at cost</span></div>
      <div class="card stat"><span class="ico">🧾</span><span class="muted">Fees paid</span><b>${money(t.fees)}</b></div>
      <div class="card stat"><span class="ico">🚚</span><span class="muted">Shipping</span><b>${money(t.shipping)}</b></div>
    </div>
    <div class="two-col">
      <div><h2>By platform</h2><div class="card">${plat}</div></div>
      <div><h2>By month</h2><div class="card">${months}</div></div>
    </div>
    <h2>Settings</h2>
    <div class="card">
      <button class="btn alt sm" id="fees-btn">Edit fee presets</button>
      <a class="btn alt sm" style="margin-left:8px" href="/api/export.csv">Export CSV</a>
    </div>`;
  $('#fees-btn').onclick = editFees;
}

function editFees() {
  const rows = Object.entries(FEES).map(([k, f]) => `
    <div class="card"><b>${esc(f.label)}</b>
      <div class="row"><div><label>Fee %</label><input type="number" step="0.01" data-k="${esc(k)}" data-f="pct" value="${f.pct}"></div>
      <div><label>+ fixed ${esc(CUR)}</label><input type="number" step="0.01" data-k="${esc(k)}" data-f="fixed" value="${f.fixed}"></div></div></div>`).join('');
  openSheet(`<h1>Fee presets</h1><div class="muted">Only used to pre-fill the sell form — you can always override the real fee per sale.</div>${rows}<button class="btn" id="save-fees">Save</button>`);
  $('#save-fees').onclick = async () => {
    document.querySelectorAll('#sheet-body input[data-k]').forEach(i => (FEES[i.dataset.k][i.dataset.f] = Number(i.value) || 0));
    await api('/fees', { method: 'PUT', body: FEES });
    closeSheet(); toast('Saved');
  };
}

// ---------- stock ----------
async function renderStock() {
  view.innerHTML = `<h1>Stock</h1>
    <input id="q" type="search" placeholder="Search title, brand, UPC…" style="margin-bottom:10px">
    <div class="chips">${[['all', 'Unsold'], ['in_stock', 'Not listed'], ['listed', 'Listed']].map(([k, l]) => `<button class="chip ${stockFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div id="list"></div>`;
  const draw = async () => {
    const all = await api('/items?q=' + encodeURIComponent($('#q').value));
    const items = all.filter(i => i.status !== 'sold' && (stockFilter === 'all' || i.status === stockFilter));
    $('#list').innerHTML = items.map(i => itemRow(i, i.status === 'listed' ? '<div><span class="badge">listed</span></div>' : '')).join('') || '<div class="card empty"><span class="em">🛍️</span>Nothing here yet — tap + to add your first find!</div>';
    bindItemRows($('#list'), openItem);
  };
  $('#q').oninput = debounce(draw, 200);
  view.querySelectorAll('.chip').forEach(c => (c.onclick = () => { stockFilter = c.dataset.f; renderStock(); }));
  draw();
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- item detail / edit ----------
const CONDITIONS = ['', 'new', 'like new', 'good', 'fair', 'poor'];
const opt = (list, cur) => list.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');

async function openItem(id) {
  const i = await api('/items/' + id);
  const sold = i.status === 'sold';
  openSheet(`
    <div class="photos" id="photos">${i.photos.map(p => `<div class="ph"><img src="${esc(p.url)}"><button class="x" data-p="${p.id}">×</button></div>`).join('')}</div>
    <label class="btn alt sm" style="display:inline-block">📷 Add photo<input type="file" accept="image/*" capture="environment" hidden id="more-photo"></label>
    ${sold ? `<div class="card" style="margin-top:12px"><b>Sold for ${money(i.sold_price)}</b> on ${esc(i.sold_date)} (${esc(FEES[i.platform]?.label || i.platform)})<br>
      <span class="muted">Fees ${money(i.fees)} · Shipping ${money(i.shipping)} · Cost ${money(i.cost)}</span><br>Profit ${signed(i.profit)}</div>` : ''}
    <form id="f">${itemFields(i)}<button class="btn" type="submit">Save changes</button></form>
    ${sold
      ? `<button class="btn alt" id="edit-sale">Edit sale</button><button class="btn alt" id="unsell">Mark as unsold</button>`
      : `<button class="btn" id="sell">Mark as sold</button>
         <button class="btn alt" id="toggle-list">${i.status === 'listed' ? 'Mark as not listed' : 'Mark as listed'}</button>`}
    <button class="btn danger" id="del">Delete item</button>
    <button class="btn alt" id="close">Close</button>`);

  $('#close').onclick = closeSheet;
  $('#f').onsubmit = async e => { e.preventDefault(); await api('/items/' + id, { method: 'PUT', body: formData(e.target) }); toast('Saved'); refresh(); closeSheet(); };
  $('#del').onclick = async () => { if (confirm('Delete this item and its photos?')) { await api('/items/' + id, { method: 'DELETE' }); closeSheet(); refresh(); } };
  $('#more-photo').onchange = async e => { const f = e.target.files[0]; if (!f) return; await api(`/items/${id}/photos`, { body: await shrink(f) }); openItem(id); refresh(); };
  document.querySelectorAll('#photos .x').forEach(b => (b.onclick = async () => { await api('/photos/' + b.dataset.p, { method: 'DELETE' }); openItem(id); refresh(); }));
  if (sold) {
    $('#edit-sale').onclick = () => openSell(i);
    $('#unsell').onclick = async () => { await api(`/items/${id}/sell`, { method: 'DELETE' }); closeSheet(); refresh(); toast('Moved back to stock'); };
  } else {
    $('#sell').onclick = () => openSell(i);
    $('#toggle-list').onclick = async () => { await api('/items/' + id, { method: 'PUT', body: { status: i.status === 'listed' ? 'in_stock' : 'listed' } }); closeSheet(); refresh(); };
  }
}

function itemFields(i = {}) {
  return `
    <label>Title</label><input name="title" required value="${esc(i.title)}">
    <div class="row"><div><label>Brand</label><input name="brand" value="${esc(i.brand)}"></div><div><label>Category</label><input name="category" value="${esc(i.category)}"></div></div>
    <div class="row"><div><label>Condition</label><select name="condition">${opt(CONDITIONS, i.condition)}</select></div><div><label>Size</label><input name="size" value="${esc(i.size)}"></div></div>
    <label>UPC / barcode</label><div class="row"><input name="upc" inputmode="numeric" value="${esc(i.upc)}" style="flex:3"><button type="button" class="btn alt sm" id="upc-go" style="flex:1">Look up</button></div>
    <div class="row"><div><label>Paid (${esc(CUR)})</label><input name="cost" type="number" step="0.01" inputmode="decimal" value="${i.cost ?? ''}" required></div><div><label>Date bought</label><input name="bought_date" type="date" value="${esc(i.bought_date || today())}"></div></div>
    <label>Bought from</label><input name="bought_from" value="${esc(i.bought_from)}" placeholder="Thrift store, garage sale, FB…">
    <label>Listed on</label><input name="listed_on" value="${esc(i.listed_on)}" placeholder="eBay, Vinted…">
    <label>Notes</label><textarea name="notes" rows="2">${esc(i.notes)}</textarea>`;
}
const formData = form => Object.fromEntries(new FormData(form));

// ---------- sell ----------
function openSell(i) {
  const platforms = Object.entries(FEES);
  const first = i.platform || (i.listed_on && platforms.find(([, f]) => i.listed_on.toLowerCase().includes(f.label.toLowerCase().split(' ')[0]))?.[0]) || platforms[0][0];
  openSheet(`
    <h1>${esc(i.title)}</h1><div class="muted">Paid ${money(i.cost)}</div>
    <form id="sf">
      <label>Sold on</label><select name="platform">${platforms.map(([k, f]) => `<option value="${esc(k)}" ${k === first ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      <div class="row"><div><label>Sold for (${esc(CUR)})</label><input name="sold_price" type="number" step="0.01" inputmode="decimal" required value="${i.sold_price ?? ''}" autofocus></div>
      <div><label>Fees taken (${esc(CUR)})</label><input name="fees" type="number" step="0.01" inputmode="decimal" value="${i.fees ?? ''}"></div></div>
      <div class="row"><div><label>Shipping you paid (${esc(CUR)})</label><input name="shipping" type="number" step="0.01" inputmode="decimal" value="${i.shipping ?? ''}"></div>
      <div><label>Date sold</label><input name="sold_date" type="date" value="${esc(i.sold_date || today())}"></div></div>
      <div class="profit-preview" id="pp"></div>
      <button class="btn" type="submit">Save sale</button>
    </form><button class="btn alt" id="cancel">Cancel</button>`);
  const f = $('#sf');
  let feesTouched = i.fees != null;
  const calc = () => {
    const price = Number(f.sold_price.value) || 0;
    if (!feesTouched) { const p = FEES[f.platform.value]; f.fees.value = price ? (price * p.pct / 100 + p.fixed).toFixed(2) : ''; }
    const profit = price - (Number(f.fees.value) || 0) - (Number(f.shipping.value) || 0) - i.cost;
    $('#pp').innerHTML = price ? `Profit ${signed(profit)}` : '';
  };
  f.fees.oninput = () => { feesTouched = true; calc(); };
  f.platform.onchange = () => { feesTouched = false; calc(); };
  f.sold_price.oninput = f.shipping.oninput = calc;
  calc();
  $('#cancel').onclick = closeSheet;
  f.onsubmit = async e => { e.preventDefault(); await api(`/items/${i.id}/sell`, { body: formData(f) }); closeSheet(); toast('Sale recorded 🎉'); refresh(); };
}

async function renderSell() {
  view.innerHTML = `<h1>Mark an item sold</h1>
    <div class="big-actions"><input id="q" type="search" placeholder="Search your stock…"><label class="btn alt" id="find-photo">📷 Find by photo<input type="file" accept="image/*" capture="environment" hidden id="findp"></label></div>
    <div id="banner"></div><div id="list" style="margin-top:12px"></div>`;
  const draw = async (items) => {
    items ??= (await api('/items?q=' + encodeURIComponent($('#q').value))).filter(i => i.status !== 'sold');
    $('#list').innerHTML = items.map(i => itemRow(i, '<div class="muted" style="font-weight:400">tap to sell</div>')).join('') || '<div class="muted card">No matching unsold items.</div>';
    bindItemRows($('#list'), async id => openSell(await api('/items/' + id)));
  };
  $('#q').oninput = debounce(() => { $('#banner').innerHTML = ''; draw(); }, 200);
  $('#findp').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    $('#banner').innerHTML = '<div class="banner">Looking at your photo…</div>';
    try {
      const r = await api('/identify', { body: await shrink(file) });
      const hits = r.matches.filter(m => m.status !== 'sold');
      $('#banner').innerHTML = `<div class="banner">${hits.length ? `Looks like <b>${esc(r.ai.title)}</b> — closest matches in your stock:` : `Looks like <b>${esc(r.ai.title)}</b>, but nothing similar is in stock.`}</div>`;
      draw(hits);
    } catch (err) { $('#banner').innerHTML = `<div class="banner">${esc(err.message)}</div>`; }
  };
  draw();
}

async function renderSold() {
  const items = (await api('/items?status=sold')).sort((a, b) => b.sold_date.localeCompare(a.sold_date));
  view.innerHTML = `<h1>Sold</h1><div id="list">${items.map(i => itemRow(i)).join('') || '<div class="card empty"><span class="em">🎉</span>Your first sale will show up here.</div>'}</div>`;
  bindItemRows(view, openItem);
}

// ---------- add ----------
let draft = null;
function renderAdd() {
  draft = { photos: [], fields: {} };
  view.innerHTML = `<h1>Add item</h1>
    <div class="big-actions">
      <label class="btn">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="cam"></label>
      <button class="btn alt" id="scan" type="button">▮▮▮ Scan barcode</button>
    </div>
    <div class="muted" style="margin:8px 0">Snap a photo and I'll try to fill in the details and check whether it's already in your stock. Or scan a barcode. Or just type it in below.</div>
    <div id="status"></div><div id="matches"></div>
    <form id="f"><div class="photos" id="pending"></div>${itemFields({})}
      <button class="btn" type="submit">Save item</button>
      <button class="btn alt" type="button" id="save-more">Save &amp; add another</button>
    </form>`;
  const form = $('#f');
  $('#cam').onchange = async e => { for (const f of e.target.files) await addPhoto(f); e.target.value = ''; };
  $('#scan').onclick = async () => { const c = await scanBarcode(); if (c) { form.upc.value = c; lookupUpc(); } };
  $('#upc-go').onclick = lookupUpc;
  form.onsubmit = e => { e.preventDefault(); save(false); };
  $('#save-more').onclick = () => form.reportValidity() && save(true);

  const fill = (data, overwrite = false) => {
    for (const k of ['title', 'brand', 'category', 'condition', 'size', 'upc']) {
      if (data[k] && (overwrite || !form[k].value)) form[k].value = data[k];
    }
  };

  async function lookupUpc() {
    const code = form.upc.value.replace(/\D/g, '');
    if (code.length < 8) return toast('Enter a full barcode number');
    $('#status').innerHTML = '<div class="banner">Looking up barcode…</div>';
    try {
      const r = await api('/upc/' + code);
      $('#status').innerHTML = '';
      if (r.product) { fill(r.product); toast(`Found: ${r.product.title.slice(0, 40)}`); } else toast('No product found for that barcode');
      showMatches(r.existing);
    } catch (err) { $('#status').innerHTML = `<div class="banner">${esc(err.message)}</div>`; }
  }

  function showMatches(list) {
    $('#matches').innerHTML = list.length ? `<div class="banner"><b>Already in your system?</b> Tap one to open it instead of adding a duplicate.</div>${list.map(m => itemRow(m, m.score ? `<div class="muted">${Math.round(m.score * 100)}% match</div>` : '')).join('')}` : '';
    bindItemRows($('#matches'), openItem);
  }

  async function addPhoto(file) {
    const blob = await shrink(file);
    draft.photos.push(blob);
    drawPending();
    const first = draft.photos.length === 1;
    const code = await barcodeFromBlob(blob);
    if (code && !form.upc.value) { form.upc.value = code; lookupUpc(); }
    if (!first || !AI) return;
    $('#status').innerHTML = '<div class="banner">Identifying item…</div>';
    try {
      const r = await api('/identify', { body: blob });
      $('#status').innerHTML = `<div class="banner">Guessed: <b>${esc(r.ai.title)}</b> (${Math.round(r.ai.confidence * 100)}% sure) — check the details below.</div>`;
      fill(r.upcProduct ? { ...r.ai, ...Object.fromEntries(Object.entries(r.upcProduct).filter(([, v]) => v)) } : r.ai);
      showMatches(r.matches);
    } catch (err) { $('#status').innerHTML = `<div class="banner">Couldn't identify: ${esc(err.message)}</div>`; }
  }

  function drawPending() {
    const urls = draft.photos.map(b => URL.createObjectURL(b));
    $('#pending').innerHTML = urls.map((u, n) => `<div class="ph"><img src="${u}"><button type="button" class="x" data-n="${n}">×</button></div>`).join('');
    document.querySelectorAll('#pending .x').forEach(b => (b.onclick = () => { draft.photos.splice(Number(b.dataset.n), 1); drawPending(); }));
  }

  async function save(again) {
    const btns = form.querySelectorAll('button'); btns.forEach(b => (b.disabled = true));
    try {
      const item = await api('/items', { body: formData(form) });
      for (const blob of draft.photos) await api(`/items/${item.id}/photos`, { body: blob });
      toast(`Added "${item.title.slice(0, 30)}"`);
      again ? renderAdd() : go('stock');
    } catch (err) { toast(err.message); btns.forEach(b => (b.disabled = false)); }
  }
}

// ---------- boot ----------
function refresh() { go(tab); }

function showLogin() {
  document.body.classList.add('locked');
  $('#tabs').hidden = true;
  view.innerHTML = `<form class="login card" id="lf"><h1>Resale Tracker</h1><label>Password</label><input type="password" name="password" autofocus required><button class="btn" type="submit">Log in</button><div class="muted" id="lerr" style="margin-top:8px"></div></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(formData(e.target)) });
    r.ok ? location.reload() : ($('#lerr').textContent = 'Wrong password');
  };
}

(async () => {
  const s = await fetch('/api/session').then(r => r.json());
  CUR = s.currency; AI = s.ai;
  if (!s.authed) return showLogin();
  FEES = await api('/fees');
  go('home');
})();
