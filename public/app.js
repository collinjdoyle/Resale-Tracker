// Resale Tracker front-end: vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
let CUR = '$', AI = false, STALE = 60, FEES = {}, tab = 'home', stockFilter = 'all';

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
  const stale = i.status !== 'sold' && i.days_held >= STALE;
  const age = i.status === 'sold' ? `sold in ${i.days_held}d` : `<span class="${stale ? 'stale' : ''}">${i.days_held}d in stock</span>`;
  const sub = i.status === 'sold'
    ? `Sold ${esc(i.sold_date)} · ${esc(FEES[i.platform]?.label || i.platform)} · ${age}`
    : `${esc(i.brand || '')} ${i.listed_on ? '· ' + esc(i.listed_on) : ''} · ${age}${i.list_price != null ? ` · asking ${money(i.list_price)}` : ''}`;
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
  const line = (l, r) => `<div class="row" style="margin:6px 0"><span>${l}</span><span style="text-align:right">${r}</span></div>`;
  const plat = s.byPlatform.map(p => line(`${esc(FEES[p.platform]?.label || p.platform)} <span class="muted">(${p.count})</span>`, signed(p.profit))).join('') || '<div class="muted">No sales yet</div>';
  const src = s.bySource.map(p => line(`${esc(p.source)} <span class="muted">(${p.count})</span>`, signed(p.profit))).join('') || '<div class="muted">No sales yet</div>';

  // Monthly bar chart (oldest -> newest), profit after that month's expenses.
  const series = [...s.byMonth].reverse().map(m => ({ month: m.month, net: m.profit - m.expenses }));
  const peak = Math.max(1, ...series.map(m => Math.abs(m.net)));
  const chart = series.length ? `<div class="bars">${series.map(m => `<div class="bar-col"><div class="bar-val">${m.net >= 100 ? Math.round(m.net) : m.net.toFixed(0)}</div><div class="bar ${m.net < 0 ? 'neg' : ''}" style="height:${Math.max(4, Math.abs(m.net) / peak * 100)}px"></div><div class="bar-label">${esc(m.month.slice(5))}</div></div>`).join('')}</div>` : '<div class="muted">Your monthly chart will appear after your first sale</div>';

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
      <a class="btn alt sm" style="margin-left:8px" href="/api/export.csv">Export sales CSV</a>
      <a class="btn alt sm" style="margin-left:8px" href="/api/expenses.csv">Export expenses CSV</a>
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
    <input id="q" type="search" placeholder="Search title, brand, UPC…" style="margin-bottom:10px">
    <div class="chips">${[['all', 'Unsold'], ['in_stock', 'Not listed'], ['listed', 'Listed'], ['stale', `Stale ${STALE}d+`]].map(([k, l]) => `<button class="chip ${stockFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div id="list"></div>`;
  const draw = async () => {
    const all = await api('/items?q=' + encodeURIComponent($('#q').value));
    let items = all.filter(i => i.status !== 'sold' && (stockFilter === 'all' || stockFilter === 'stale' || i.status === stockFilter));
    if (stockFilter === 'stale') items = items.filter(i => i.days_held >= STALE).sort((a, b) => b.days_held - a.days_held);
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
    ${AI ? `<div class="card" style="margin-top:14px"><b>✨ Listing writer</b> <span class="muted">(uses the saved details + first photo)</span>
      <div class="row" style="margin-top:8px"><select id="lp">${[['ebay', 'eBay'], ['vinted', 'Vinted'], ['facebook', 'Facebook'], ['amazon', 'Amazon']].map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn sm" id="gen" style="flex:none">Write it</button></div>
      <div id="listing"></div></div>` : ''}
    <button class="btn danger" id="del">Delete item</button>
    <button class="btn alt" id="close">Close</button>`);

  $('#close').onclick = closeSheet;
  if (AI) $('#gen').onclick = async () => {
    const out = $('#listing'), btn = $('#gen');
    btn.disabled = true; out.innerHTML = '<div class="banner">Writing… (a local model can take a little while)</div>';
    try {
      const r = await api(`/items/${id}/listing`, { body: { platform: $('#lp').value } });
      out.innerHTML = `<label>Title</label><input id="lt" value="${esc(r.title)}"><button class="btn alt sm" data-copy="lt" style="margin-top:6px">Copy title</button>
        <label>Description</label><textarea id="ld" rows="7">${esc(r.description)}</textarea><button class="btn alt sm" data-copy="ld" style="margin-top:6px">Copy description</button>`;
      out.querySelectorAll('[data-copy]').forEach(b => (b.onclick = async () => { try { await navigator.clipboard.writeText($('#' + b.dataset.copy).value); toast('Copied'); } catch { $('#' + b.dataset.copy).select(); toast('Press copy on your keyboard'); } }));
    } catch (err) { out.innerHTML = `<div class="banner">${esc(err.message)}</div>`; }
    btn.disabled = false;
  };
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
    <div class="row"><div><label>Listed on</label><input name="listed_on" value="${esc(i.listed_on)}" placeholder="eBay, Vinted…"></div>
    <div><label>Asking price (${esc(CUR)})</label><input name="list_price" type="number" step="0.01" inputmode="decimal" value="${i.list_price ?? ''}"></div></div>
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
  CUR = s.currency; AI = s.ai; STALE = s.staleDays || 60;
  if (!s.authed) return showLogin();
  FEES = await api('/fees');
  go('home');
})();
