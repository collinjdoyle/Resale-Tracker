// Resale Tracker front-end: vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
let CUR = '$', STALE = 60, FEES = {}, tab = 'home', stockFilter = 'all', prefill = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `${n < 0 ? '-' : ''}${CUR}${Math.abs(Number(n) || 0).toFixed(2)}`;
const signed = n => `<span class="${n >= 0 ? 'good' : 'bad'}">${money(n)}</span>`;
const today = () => new Date().toISOString().slice(0, 10);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const CONDITIONS = ['', 'new', 'like new', 'good', 'fair', 'poor'];
const opt = (list, cur) => list.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
const formData = form => Object.fromEntries(new FormData(form));

async function api(path, opts = {}) {
  const isBlob = opts.body instanceof Blob;
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { ...(isBlob ? { 'content-type': opts.body.type } : opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: isBlob ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { showLogin(); throw new Error('Login required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}
const openSheet = html => { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; $('#sheet .sheet-card').scrollTop = 0; };
const closeSheet = () => { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; };
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// ---------- photos: downscale, barcode ----------
// Phone photos are huge; 1280px is plenty for reference pictures.
async function shrink(file, max = 1280) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: BARCODE_FORMATS }) : null;

// Quagga (bundled in /vendor) is the fallback where BarcodeDetector doesn't exist, e.g. iPhone Safari.
// It is finicky, so try a few different detector settings (each rescues different photos) before giving up.
const QUAGGA_PASSES = [
  { locate: true },
  { locate: true, locator: { patchSize: 'large', halfSample: false } },
  { locate: false },
];
async function quagga(src, size, passes = QUAGGA_PASSES.length) {
  if (!window.Quagga) return null;
  for (const pass of QUAGGA_PASSES.slice(0, passes)) {
    const code = await new Promise(resolve => Quagga.decodeSingle({
      src, numOfWorkers: 0, inputStream: { size }, ...pass,
      // Only full-length UPC-A/EAN-13 (what toys use). The short formats produce too many false reads from striped photos.
      decoder: { readers: ['ean_reader', 'upc_reader'] },
    }, r => resolve(r?.codeResult?.code || null)));
    if (code && code.length >= 12) return code;
  }
  return null;
}

async function barcodeFromImage(source) { // source: File/Blob (full-resolution photo works best)
  try {
    if (detector) { const f = await detector.detect(await createImageBitmap(source)); if (f[0]) return f[0].rawValue; }
    const url = URL.createObjectURL(source);
    try { return (await quagga(url, 1600)) || (await quagga(url, 900)); } finally { URL.revokeObjectURL(url); }
  } catch { return null; }
}

// Over plain HTTP the browser blocks live camera access, so "scan" opens the phone's camera app for a
// photo of the barcode instead and reads the barcode from that picture.
function scanFromPhoto() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      toast('Reading barcode…');
      const code = await barcodeFromImage(file);
      if (!code) toast("Couldn't read it — get closer, hold steady, keep the barcode flat and well lit");
      resolve(code);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// Live camera scan. Needs HTTPS (or localhost); otherwise falls back to photo-of-barcode.
async function scanBarcode() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return scanFromPhoto();
  const wrap = document.createElement('div'); wrap.id = 'video-wrap';
  wrap.innerHTML = '<video playsinline muted></video><div class="scan-hint">Point at the barcode</div><button class="btn alt">Cancel</button>';
  document.body.append(wrap);
  const video = $('video', wrap);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } }); }
  catch { wrap.remove(); toast('Camera permission denied'); return null; }
  video.srcObject = stream; await video.play();
  const canvas = document.createElement('canvas');
  return new Promise(resolve => {
    let done = false, busy = false;
    const finish = v => { if (done) return; done = true; clearInterval(iv); stream.getTracks().forEach(t => t.stop()); wrap.remove(); resolve(v); };
    $('button', wrap).onclick = () => finish(null);
    const iv = setInterval(async () => {
      if (busy || !video.videoWidth) return; busy = true;
      try {
        if (detector) { const f = await detector.detect(video); if (f[0]) return finish(f[0].rawValue); }
        else {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          const code = await quagga(canvas.toDataURL('image/jpeg', 0.8), 1000, 2);
          if (code) return finish(code);
        }
      } catch { /* keep trying */ } finally { busy = false; }
    }, detector ? 300 : 600);
  });
}

// ---------- shared pieces ----------
const thumbStyle = url => url ? `background-image:url('${esc(url)}')` : '';
const thumb = (url) => `<div class="thumb" style="${thumbStyle(url)}">${url ? '' : '🧸'}</div>`;

function itemRow(i, extra = '') {
  const gone = i.status === 'sold';
  const stale = !gone && i.days_held >= STALE;
  const age = gone ? `sold in ${i.days_held}d` : `<span class="${stale ? 'stale' : ''}">${i.days_held}d in stock</span>`;
  const sub = (gone
    ? [i.quantity > 1 ? `${i.quantity} sold` : '', i.sold_date ? 'last sold ' + esc(i.sold_date) : '', age]
    : [i.quantity > 1 ? `${i.remaining} of ${i.quantity} left` : '', esc(i.brand || ''), esc(i.listed_on || ''), age, i.list_price != null ? `asking ${money(i.list_price)}` : '']
  ).filter(Boolean).join(' · ');
  const right = gone ? signed(i.profit || 0) : money(i.cost) + (i.quantity > 1 ? '<span class="muted" style="font-weight:400"> ea</span>' : '');
  return `<div class="card item" data-id="${i.id}">${thumb(i.photos?.[0]?.url)}<div class="info"><div class="t">${esc(i.title)}</div><div class="muted">${sub}</div></div><div class="right">${right}${extra}</div></div>`;
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
function refresh() { go(tab); }

// ---------- home ----------
async function renderHome() {
  const s = await api('/stats');
  const t = s.totals;
  const line = (l, r) => `<div class="row" style="margin:6px 0"><span>${l}</span><span style="text-align:right">${r}</span></div>`;
  const plat = s.byPlatform.map(p => line(`${esc(FEES[p.platform]?.label || p.platform)} <span class="muted">(${p.count})</span>`, signed(p.profit))).join('') || '<div class="muted">No sales yet</div>';
  const src = s.bySource.map(p => line(`${esc(p.source)} <span class="muted">(${p.count})</span>`, signed(p.profit))).join('') || '<div class="muted">No sales yet</div>';

  const series = [...s.byMonth].reverse().map(m => ({ month: m.month, net: m.profit - m.expenses }));
  const peak = Math.max(1, ...series.map(m => Math.abs(m.net)));
  const chart = series.length ? `<div class="bars">${series.map(m => `<div class="bar-col"><div class="bar-val">${Math.round(m.net)}</div><div class="bar ${m.net < 0 ? 'neg' : ''}" style="height:${Math.max(4, Math.abs(m.net) / peak * 100)}px"></div><div class="bar-label">${esc(m.month.slice(5))}</div></div>`).join('')}</div>` : '<div class="muted">Your monthly chart will appear after your first sale</div>';

  const g = s.thisMonth;
  const goal = g.goal > 0
    ? `<div class="row" style="align-items:baseline"><b>${money(g.profit)} <span class="muted">of ${money(g.goal)} this month</span></b><button class="btn alt sm" id="goal-btn" style="flex:none">Edit</button></div>
       <div class="progress"><div style="width:${Math.max(0, Math.min(100, g.profit / g.goal * 100))}%"></div></div>
       <div class="muted">${g.profit >= g.goal ? 'Goal reached — amazing! 🎉' : `${money(g.goal - g.profit)} to go`}</div>`
    : `<div class="row" style="align-items:center"><span class="muted">Set a monthly profit goal to track your progress</span><button class="btn alt sm" id="goal-btn" style="flex:none">Set goal</button></div>`;

  const hr = new Date().getHours();
  const hi = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  view.innerHTML = `
    <div class="hero"><div class="hi">${hi}, Ashley 💖</div><div class="big">${money(t.net)}</div>
      <div class="sub">profit after expenses · ${t.sold_count} item${t.sold_count === 1 ? '' : 's'} sold</div>
      ${t.expenses ? `<div class="sub">${money(t.profit)} from sales − ${money(t.expenses)} expenses</div>` : ''}</div>
    <div class="card">${goal}</div>
    <div class="stats">
      <div class="card stat"><span class="ico">💰</span><span class="muted">Revenue</span><b>${money(t.revenue)}</b></div>
      <div class="card stat"><span class="ico">📦</span><span class="muted">In stock</span><b>${s.stock.count}</b><span class="muted">${money(s.stock.cost)} at cost</span></div>
      <div class="card stat"><span class="ico">✨</span><span class="muted">Avg profit / item</span><b>${money(t.avg_profit)}</b><span class="muted">${t.margin.toFixed(0)}% margin</span></div>
      <div class="card stat"><span class="ico">⏱️</span><span class="muted">Avg time to sell</span><b>${t.sold_count ? Math.round(t.avg_days) + ' days' : '—'}</b>${s.stale ? `<span class="muted">${s.stale} unsold ${STALE}d+</span>` : ''}</div>
    </div>
    <h2>Profit by month</h2><div class="card">${chart}</div>
    <div class="two-col">
      <div><h2>By platform</h2><div class="card">${plat}</div></div>
      <div><h2>Best places to buy</h2><div class="card">${src}</div></div>
    </div>
    <h2>Expenses &amp; mileage</h2>
    <div class="card">
      <div class="muted" style="margin-bottom:10px">${money(t.expenses)} logged · ${Math.round(t.miles)} miles driven</div>
      <button class="btn sm" id="exp-add">＋ Add expense</button>
      <button class="btn alt sm" id="exp-list" style="margin-left:8px">View all</button>
    </div>
    <h2>Settings</h2>
    <div class="card">
      <button class="btn alt sm" id="fees-btn">Edit fee presets</button>
      <a class="btn alt sm" href="/api/sales.csv">Sales CSV</a>
      <a class="btn alt sm" href="/api/export.csv">Inventory CSV</a>
      <a class="btn alt sm" href="/api/expenses.csv">Expenses CSV</a>
    </div>`;
  $('#fees-btn').onclick = editFees;
  $('#goal-btn').onclick = editGoal;
  $('#exp-add').onclick = () => openExpense();
  $('#exp-list').onclick = openExpenseList;
}

async function editGoal() {
  const cur = (await api('/settings')).goal;
  openSheet(`<h1>Monthly goal</h1><div class="muted">Profit after expenses you'd like to make each month. Use 0 to hide the bar.</div>
    <form id="gf"><label>Goal (${esc(CUR)})</label><input name="goal" type="number" step="1" inputmode="numeric" value="${cur || ''}" autofocus><button class="btn" type="submit">Save</button></form>`);
  $('#gf').onsubmit = async e => { e.preventDefault(); await api('/settings', { method: 'PUT', body: { goal: Number(e.target.goal.value) || 0 } }); closeSheet(); refresh(); };
}

const EXPENSE_CATEGORIES = ['Mileage', 'Shipping supplies', 'Platform / booth fees', 'Gas', 'Cleaning / repair', 'Other'];

async function openExpense() {
  const rate = (await api('/settings')).mileage_rate;
  openSheet(`<h1>Add expense</h1>
    <form id="ef">
      <label>What kind?</label><select name="category">${opt(EXPENSE_CATEGORIES, 'Mileage')}</select>
      <div id="miles-box"><label>Miles driven</label><input name="miles" type="number" step="0.1" inputmode="decimal">
        <div class="muted" style="margin-top:4px">Counted at ${esc(CUR)}${rate}/mile <button type="button" class="chip" id="rate-edit" style="padding:2px 10px">change</button> <span id="miles-amt"></span></div></div>
      <div id="amt-box" hidden><label>Amount (${esc(CUR)})</label><input name="amount" type="number" step="0.01" inputmode="decimal"></div>
      <div class="row"><div><label>Date</label><input name="date" type="date" value="${today()}"></div><div><label>Note</label><input name="note" placeholder="Goodwill run…"></div></div>
      <button class="btn" type="submit">Save</button>
    </form><button class="btn alt" id="cancel">Cancel</button>`);
  const f = $('#ef');
  const sync = () => {
    const mileage = f.category.value === 'Mileage';
    $('#miles-box').hidden = !mileage; $('#amt-box').hidden = mileage;
    $('#miles-amt').textContent = mileage && f.miles.value ? `= ${money(f.miles.value * rate)}` : '';
  };
  f.category.onchange = f.miles.oninput = sync; sync();
  $('#rate-edit').onclick = async () => {
    const v = prompt('Mileage rate per mile (e.g. the current IRS rate)', rate);
    if (v !== null && Number(v) >= 0) { await api('/settings', { method: 'PUT', body: { mileage_rate: Number(v) } }); openExpense(); }
  };
  $('#cancel').onclick = closeSheet;
  f.onsubmit = async e => {
    e.preventDefault();
    const mileage = f.category.value === 'Mileage';
    const amount = mileage ? Number(f.miles.value) * rate : Number(f.amount.value);
    if (!(amount > 0)) return toast('Enter an amount or miles');
    await api('/expenses', { body: { category: f.category.value, amount: amount.toFixed(2), miles: mileage ? f.miles.value : null, date: f.date.value, note: f.note.value } });
    closeSheet(); toast('Expense saved'); refresh();
  };
}

async function openExpenseList() {
  const list = await api('/expenses');
  openSheet(`<h1>Expenses</h1>${list.map(e => `<div class="card row" style="align-items:center"><div><b>${esc(e.category)}</b> <span class="muted">${esc(e.date)}</span><div class="muted">${e.miles ? esc(e.miles) + ' mi · ' : ''}${esc(e.note)}</div></div><div style="flex:none;text-align:right"><b>${money(e.amount)}</b><br><button class="chip" data-x="${e.id}" style="padding:2px 10px;color:var(--bad)">delete</button></div></div>`).join('') || '<div class="card empty"><span class="em">🧾</span>No expenses yet</div>'}
    <button class="btn alt" id="close">Close</button>`);
  $('#close').onclick = closeSheet;
  document.querySelectorAll('#sheet-body [data-x]').forEach(b => (b.onclick = async () => { if (confirm('Delete this expense?')) { await api('/expenses/' + b.dataset.x, { method: 'DELETE' }); openExpenseList(); refresh(); } }));
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
    <input id="q" type="search" placeholder="Search title, brand, barcode…" style="margin-bottom:10px">
    <div class="chips">${[['all', 'Unsold'], ['in_stock', 'Not listed'], ['listed', 'Listed'], ['stale', `Stale ${STALE}d+`]].map(([k, l]) => `<button class="chip ${stockFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div id="list"></div>`;
  const draw = async () => {
    const all = await api('/items?q=' + encodeURIComponent($('#q').value));
    if (tab !== 'stock') return; // she switched tabs while this was loading
    let items = all.filter(i => i.status !== 'sold' && (stockFilter === 'all' || stockFilter === 'stale' || i.status === stockFilter));
    if (stockFilter === 'stale') items = items.filter(i => i.days_held >= STALE).sort((a, b) => b.days_held - a.days_held);
    $('#list').innerHTML = items.map(i => itemRow(i, i.status === 'listed' ? '<div><span class="badge">listed</span></div>' : '')).join('') || '<div class="card empty"><span class="em">🛍️</span>Nothing here yet — tap + to add your first find!</div>';
    bindItemRows($('#list'), openItem);
  };
  $('#q').oninput = debounce(draw, 200);
  view.querySelectorAll('.chip').forEach(c => (c.onclick = () => { stockFilter = c.dataset.f; renderStock(); }));
  draw();
}

// ---------- item form (shared by Add and the item sheet) ----------
function itemFields(i = {}) {
  return `
    <label>Title</label><input name="title" required value="${esc(i.title)}">
    <div class="row"><div><label>Brand</label><input name="brand" value="${esc(i.brand)}"></div><div><label>Category</label><input name="category" value="${esc(i.category)}"></div></div>
    <div class="row"><div><label>Condition</label><select name="condition">${opt(CONDITIONS, i.condition)}</select></div><div><label>Size</label><input name="size" value="${esc(i.size)}"></div></div>
    <label>Barcode (UPC)</label><div class="row"><input name="upc" inputmode="numeric" value="${esc(i.upc)}" style="flex:3"><button type="button" class="btn alt sm" id="upc-go" style="flex:1">Look up</button></div>
    <div class="row"><div><label>How many?</label><input name="quantity" type="number" min="1" step="1" inputmode="numeric" value="${i.quantity ?? 1}" required></div>
      <div><label>Paid each (${esc(CUR)})</label><input name="cost" type="number" step="0.01" inputmode="decimal" value="${i.cost ?? ''}" placeholder="${esc(i.cost_hint || '')}" required></div></div>
    <div class="muted cost-hint"><span id="total-hint"></span> <button type="button" class="chip" id="split-lot" style="padding:2px 10px">I paid one price for all</button></div>
    <div class="row"><div><label>Date bought</label><input name="bought_date" type="date" value="${esc(i.bought_date || today())}"></div>
      <div><label>Bought from</label><input name="bought_from" value="${esc(i.bought_from)}" placeholder="Thrift, garage sale…"></div></div>
    <div class="row"><div><label>Listed on</label><input name="listed_on" value="${esc(i.listed_on)}" placeholder="eBay, Vinted…"></div>
      <div><label>Asking price (${esc(CUR)})</label><input name="list_price" type="number" step="0.01" inputmode="decimal" value="${i.list_price ?? ''}"></div></div>
    <label>Notes</label><textarea name="notes" rows="2">${esc(i.notes)}</textarea>`;
}

// "= $X total" hint + the split-a-lot helper
function wireCost(form) {
  const hint = () => {
    const q = Math.max(1, Number(form.quantity.value) || 1), c = Number(form.cost.value) || 0;
    $('#total-hint').textContent = q > 1 && c ? `= ${money(q * c)} total for ${q}` : '';
  };
  form.quantity.oninput = form.cost.oninput = hint; hint();
  $('#split-lot').onclick = () => {
    const q = Math.max(1, Number(form.quantity.value) || 1);
    const v = prompt(`Total you paid for all ${q}?`);
    if (v !== null && Number(v) >= 0) { form.cost.value = (Number(v) / q).toFixed(2); hint(); }
  };
}

// ---------- item detail ----------
async function openItem(id) {
  const i = await api('/items/' + id);
  const open = i.remaining > 0;
  const sales = i.sales.map(s => `<div class="sale-row" data-sale="${s.id}"><span><b>${s.qty}×</b> ${esc(FEES[s.platform]?.label || s.platform)} · ${esc(s.sold_date)}</span><span>${signed(s.profit)}</span></div>`).join('');
  openSheet(`
    <div class="photos" id="photos">${i.photos.map(p => `<div class="ph"><img src="${esc(p.url)}"><button class="x" data-p="${p.id}">×</button></div>`).join('')}</div>
    <label class="btn alt sm" style="display:inline-block">📷 Add photo<input type="file" accept="image/*" capture="environment" hidden id="more-photo"></label>
    <div class="card" style="margin-top:12px">
      <b>${open ? `${i.remaining} of ${i.quantity} left` : `All ${i.quantity} sold`}</b>${i.sold_qty ? ` <span class="muted">· ${i.sold_qty} sold · profit so far</span> ${signed(i.profit || 0)}` : ''}
      ${sales ? `<div class="sales-list">${sales}<div class="muted" style="margin-top:4px">Tap a sale to edit or undo it</div></div>` : ''}
    </div>
    <form id="f">${itemFields(i)}<button class="btn" type="submit">Save changes</button></form>
    ${open ? `<button class="btn" id="sell">Mark sold</button>
              <button class="btn alt" id="toggle-list">${i.status === 'listed' ? 'Mark as not listed' : 'Mark as listed'}</button>` : ''}
    <button class="btn alt" id="again">🔁 Add again (bought more)</button>
    <button class="btn danger" id="del">Delete item</button>
    <button class="btn alt" id="close">Close</button>`);

  wireCost($('#f'));
  $('#upc-go').onclick = async () => { const f = $('#f'); const r = await lookupBarcode(f.upc.value); if (r?.product) for (const k of ['title', 'brand', 'category']) if (!f[k].value) f[k].value = r.product[k] || ''; };
  $('#close').onclick = closeSheet;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    try { await api('/items/' + id, { method: 'PUT', body: formData(e.target) }); toast('Saved'); refresh(); closeSheet(); } catch (err) { toast(err.message); }
  };
  $('#del').onclick = async () => { if (confirm('Delete this item, its photos and its sales history?')) { await api('/items/' + id, { method: 'DELETE' }); closeSheet(); refresh(); } };
  $('#again').onclick = () => { closeSheet(); addFromItem(i); };
  $('#more-photo').onchange = async e => { const f = e.target.files[0]; if (!f) return; const blob = await shrink(f); await api(`/items/${id}/photos`, { body: blob }); openItem(id); refresh(); };
  document.querySelectorAll('#photos .x').forEach(b => (b.onclick = async () => { await api('/photos/' + b.dataset.p, { method: 'DELETE' }); openItem(id); refresh(); }));
  document.querySelectorAll('.sale-row').forEach(r => (r.onclick = () => openSell(i, i.sales.find(s => s.id === Number(r.dataset.sale)))));
  if (open) {
    $('#sell').onclick = () => openSell(i);
    $('#toggle-list').onclick = async () => { await api('/items/' + id, { method: 'PUT', body: { status: i.status === 'listed' ? 'in_stock' : 'listed' } }); closeSheet(); refresh(); };
  }
}

// Start the Add form from an existing/old item ("I bought another one").
function addFromItem(i) {
  prefill = { ...i, cost_hint: i.cost ? `last paid ${i.cost}` : '', cost: '', quantity: 1, bought_date: today() };
  go('add');
}

// ---------- sell ----------
// openSell(item) records a new sale; openSell(item, sale) edits/undoes an existing one.
function openSell(i, sale = null) {
  const platforms = Object.entries(FEES);
  const max = i.remaining + (sale?.qty || 0);
  const first = sale?.platform || (i.listed_on && platforms.find(([, f]) => i.listed_on.toLowerCase().includes(f.label.toLowerCase().split(' ')[0]))?.[0]) || platforms[0][0];
  openSheet(`
    <h1>${esc(i.title)}</h1><div class="muted">Paid ${money(i.cost)} each${max > 1 ? ` · ${max} available to sell` : ''}</div>
    <form id="sf">
      ${max > 1 ? `<label>How many sold?</label><input name="qty" type="number" min="1" max="${max}" step="1" inputmode="numeric" value="${sale?.qty || 1}" required>` : '<input type="hidden" name="qty" value="1">'}
      <label>Sold on</label><select name="platform">${platforms.map(([k, f]) => `<option value="${esc(k)}" ${k === first ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      <div class="row"><div><label>Sold for${max > 1 ? ' each' : ''} (${esc(CUR)})</label><input name="sold_price" type="number" step="0.01" inputmode="decimal" required value="${sale?.sold_price ?? ''}" autofocus></div>
      <div><label>Fees taken (${esc(CUR)})</label><input name="fees" type="number" step="0.01" inputmode="decimal" value="${sale?.fees ?? ''}"></div></div>
      <div class="row"><div><label>Shipping you paid (${esc(CUR)})</label><input name="shipping" type="number" step="0.01" inputmode="decimal" value="${sale?.shipping ?? ''}"></div>
      <div><label>Date sold</label><input name="sold_date" type="date" value="${esc(sale?.sold_date || today())}"></div></div>
      <div class="profit-preview" id="pp"></div>
      <button class="btn" type="submit">${sale ? 'Save changes' : 'Save sale'}</button>
    </form>
    ${sale ? '<button class="btn danger" id="undo">Undo this sale (put back in stock)</button><button class="btn alt" id="view-item">View item</button>' : ''}
    <button class="btn alt" id="cancel">Cancel</button>`);
  const f = $('#sf');
  let feesTouched = sale != null;
  const calc = () => {
    const qty = Number(f.qty.value) || 1, price = Number(f.sold_price.value) || 0;
    if (!feesTouched) { const p = FEES[f.platform.value]; f.fees.value = price ? (price * qty * p.pct / 100 + p.fixed).toFixed(2) : ''; }
    const profit = qty * price - (Number(f.fees.value) || 0) - (Number(f.shipping.value) || 0) - qty * i.cost;
    $('#pp').innerHTML = price ? `Profit ${signed(profit)}` : '';
  };
  f.fees.oninput = () => { feesTouched = true; calc(); };
  f.platform.onchange = () => { feesTouched = false; calc(); };
  f.sold_price.oninput = f.shipping.oninput = calc;
  f.qty.oninput = calc;
  calc();
  $('#cancel').onclick = closeSheet;
  if (sale) {
    $('#undo').onclick = async () => { if (confirm('Undo this sale?')) { await api('/sales/' + sale.id, { method: 'DELETE' }); closeSheet(); toast('Sale removed'); refresh(); } };
    $('#view-item').onclick = () => openItem(i.id);
  }
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await (sale ? api('/sales/' + sale.id, { method: 'PUT', body: formData(f) }) : api(`/items/${i.id}/sell`, { body: formData(f) }));
      closeSheet(); toast(sale ? 'Saved' : 'Sale recorded 🎉'); refresh();
    } catch (err) { toast(err.message); }
  };
}

async function renderSell() {
  view.innerHTML = `<h1>Mark an item sold</h1>
    <input id="q" type="search" placeholder="Search your stock…">
    <div class="big-actions" style="margin-top:12px"><button class="btn alt" id="scan" type="button">▮▮▮ Scan barcode</button><label class="btn alt">📷 Barcode photo<input type="file" accept="image/*" capture="environment" hidden id="findp"></label></div>
    <div id="banner"></div><div id="list" style="margin-top:12px"></div>`;
  const draw = async (items) => {
    items ??= (await api('/items?q=' + encodeURIComponent($('#q').value))).filter(i => i.status !== 'sold');
    if (tab !== 'sell') return; // she switched tabs while this was loading
    $('#list').innerHTML = items.map(i => itemRow(i, '<div class="muted" style="font-weight:400">tap to sell</div>')).join('') || '<div class="muted card">No matching unsold items.</div>';
    bindItemRows($('#list'), async id => openSell(await api('/items/' + id)));
  };
  $('#q').oninput = debounce(() => { $('#banner').innerHTML = ''; draw(); }, 200);
  // Barcode -> the matching unsold item. Exactly one match opens the sale form straight away.
  const findByCode = async code => {
    if (!code) { $('#banner').innerHTML = '<div class="banner">Couldn\'t read a barcode — try again, or search by name.</div>'; return; }
    const hits = (await api('/items?q=' + encodeURIComponent(code.replace(/^0(?=\d{12}$)/, '')))).filter(i => i.status !== 'sold');
    if (hits.length === 1) return openSell(hits[0]);
    $('#banner').innerHTML = `<div class="banner">${hits.length ? `Barcode <b>${esc(code)}</b> matches ${hits.length} items — tap the right one:` : `Barcode <b>${esc(code)}</b> isn't in your stock.`}</div>`;
    draw(hits);
  };
  $('#scan').onclick = async () => findByCode(await scanBarcode());
  $('#findp').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    $('#banner').innerHTML = '<div class="banner">Reading barcode…</div>';
    try { await findByCode(await barcodeFromImage(file)); } catch (err) { $('#banner').innerHTML = `<div class="banner">${esc(err.message)}</div>`; }
    e.target.value = '';
  };
  draw();
}

// ---------- sold history ----------
async function renderSold() {
  const sales = await api('/sales');
  view.innerHTML = `<h1>Sold</h1><div id="list">${sales.map(s => `
    <div class="card item" data-sale="${s.id}" data-item="${s.item_id}">${thumb(s.thumb)}
      <div class="info"><div class="t">${esc(s.title)}</div><div class="muted">${s.qty > 1 ? s.qty + '× · ' : ''}${esc(FEES[s.platform]?.label || s.platform)} · ${esc(s.sold_date)}</div></div>
      <div class="right">${signed(s.profit)}<div class="muted" style="font-weight:400">${money(s.qty * s.sold_price)}</div></div></div>`).join('') || '<div class="card empty"><span class="em">🎉</span>Your first sale will show up here.</div>'}</div>`;
  view.querySelectorAll('.item[data-sale]').forEach(el => (el.onclick = async () => {
    const item = await api('/items/' + el.dataset.item);
    openSell(item, item.sales.find(s => s.id === Number(el.dataset.sale)));
  }));
}

// ---------- add ----------
let draft = null;

async function lookupBarcode(raw) {
  const code = String(raw).replace(/\D/g, '');
  if (code.length < 8) { toast('Enter the full barcode number'); return null; }
  try {
    const r = await api('/upc/' + code);
    if (r.product) toast(r.product.source === 'history' ? 'You have this one already — details filled in' : `Found: ${r.product.title.slice(0, 40)}`);
    else toast(r.note || 'No product found for that barcode — fill it in by hand');
    return r;
  } catch (err) { toast(err.message); return null; }
}

function renderAdd() {
  const pre = prefill; prefill = null;
  draft = { photos: [], copyFrom: pre?.id || null };
  view.innerHTML = `<h1>Add item</h1>
    <div class="big-actions">
      <label class="btn">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="cam"></label>
      <button class="btn alt" id="scan" type="button">▮▮▮ Scan barcode</button>
    </div>
    <button class="btn alt" id="hist" type="button" style="margin-top:12px">🔁 Add something I've had before</button>
    <div class="muted" style="margin:8px 0">Scan the barcode (or take a photo of it) to fill in the details. Photos are saved with the item; if the barcode is read from your photo it's filled in automatically.</div>
    <div id="status">${pre ? `<div class="banner">Adding another <b>${esc(pre.title)}</b> — details copied${pre.photos?.length ? ' (photos too)' : ''}. Enter how many and what you paid.</div>` : ''}</div><div id="matches"></div>
    <form id="f"><div class="photos" id="pending"></div>${itemFields(pre || {})}
      <button class="btn" type="submit">Save item</button>
      <button class="btn alt" type="button" id="save-more">Save &amp; add another</button>
    </form>`;
  const form = $('#f');
  wireCost(form);
  $('#cam').onchange = async e => { for (const f of e.target.files) await addPhoto(f); e.target.value = ''; };
  $('#scan').onclick = async () => { const c = await scanBarcode(); if (c) { form.upc.value = c; fromBarcode(); } };
  $('#upc-go').onclick = () => fromBarcode();
  $('#hist').onclick = openHistory;
  form.onsubmit = e => { e.preventDefault(); save(false); };
  $('#save-more').onclick = () => form.reportValidity() && save(true);

  const fill = data => { for (const k of ['title', 'brand', 'category', 'condition', 'size']) if (data[k] && !form[k].value) form[k].value = data[k]; };

  function showMatches(list, heading) {
    $('#matches').innerHTML = list.length ? `<div class="banner">${heading}</div>${list.map(m => itemRow(m, m.score ? `<div class="muted" style="font-weight:400">${Math.round(m.score * 100)}% alike</div>` : '')).join('')}` : '';
    bindItemRows($('#matches'), openItem);
  }

  async function fromBarcode() {
    $('#status').innerHTML = '<div class="banner">Looking up barcode…</div>';
    const r = await lookupBarcode(form.upc.value);
    $('#status').innerHTML = r?.note ? `<div class="banner">${esc(r.note)}</div>` : '';
    if (!r) return;
    if (r.product) fill(r.product);
    showMatches(r.existing, '<b>Already in your system?</b> Tap one to open it, or keep going to add a new batch.');
  }

  async function addPhoto(file) {
    const blob = await shrink(file);
    draft.photos.push({ blob });
    drawPending();
    const code = !form.upc.value ? await barcodeFromImage(file) : null;
    if (code) { form.upc.value = code; toast(`Read barcode ${code}`); return fromBarcode(); }
  }

  function drawPending() {
    $('#pending').innerHTML = draft.photos.map((p, n) => `<div class="ph"><img src="${URL.createObjectURL(p.blob)}"><button type="button" class="x" data-n="${n}">×</button></div>`).join('');
    document.querySelectorAll('#pending .x').forEach(b => (b.onclick = () => { draft.photos.splice(Number(b.dataset.n), 1); drawPending(); }));
  }

  async function save(again) {
    const btns = form.querySelectorAll('button'); btns.forEach(b => (b.disabled = true));
    try {
      const item = await api('/items', { body: { ...formData(form), copy_photos_from: draft.copyFrom } });
      for (const p of draft.photos) await api(`/items/${item.id}/photos`, { body: p.blob });
      toast(`Added "${item.title.slice(0, 30)}"`);
      again ? renderAdd() : go('stock');
    } catch (err) { toast(err.message); btns.forEach(b => (b.disabled = false)); }
  }
}

// Everything she has ever added (including sold-out items), one row per product, to re-add quickly.
async function openHistory() {
  openSheet(`<h1>Add from history</h1><input id="hq" type="search" placeholder="Search everything you've ever added…" autofocus style="margin-bottom:10px"><div id="hlist"></div><button class="btn alt" id="close">Close</button>`);
  $('#close').onclick = closeSheet;
  const draw = async () => {
    const all = await api('/items?q=' + encodeURIComponent($('#hq').value));
    const seen = new Set(), rows = [];
    for (const i of all) { const k = i.upc || i.title.toLowerCase().trim(); if (!seen.has(k)) { seen.add(k); rows.push(i); } }
    $('#hlist').innerHTML = rows.slice(0, 60).map(i => itemRow(i, i.status === 'sold' ? '<div class="muted" style="font-weight:400">sold out</div>' : '')).join('') || '<div class="card empty"><span class="em">🔍</span>Nothing found</div>';
    bindItemRows($('#hlist'), id => { closeSheet(); addFromItem(rows.find(r => r.id === id)); });
  };
  $('#hq').oninput = debounce(draw, 200);
  draw();
}

// ---------- boot ----------
function showLogin() {
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
  CUR = s.currency; STALE = s.staleDays || 60;
  if (!s.authed) return showLogin();
  FEES = await api('/fees');
  go('home');
})();
