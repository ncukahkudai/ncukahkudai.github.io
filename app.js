// Show script errors on screen so a screenshot tells what went wrong.
window.addEventListener('error', e => {
  const m = document.querySelector('main'); if (!m) return;
  const d = document.createElement('div'); d.className = 'err';
  d.textContent = 'Error: ' + (e.message || 'tidak diketahui') + (e.lineno ? ' (baris ' + e.lineno + ')' : '');
  m.prepend(d);
});
(() => {
const $ = id => document.getElementById(id);
const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtTime = t => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtCoord = it => it.lat == null ? 'Tanpa koordinat' : `${it.lat.toFixed(6)}, ${it.lon.toFixed(6)}`;
const SRC = { gps: 'GPS', exif: 'Data foto', manual: 'Manual' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

let toastT;
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

/* ---------- storage (IndexedDB, falls back to memory) ---------- */
let mem = null;
const dbP = new Promise(res => {
  try {
    const r = indexedDB.open('catatan-lapangan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  } catch { res(null); }
});
async function store(mode) { const db = await dbP; return db ? db.transaction('photos', mode).objectStore('photos') : null; }
const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
async function getAll() { const s = await store('readonly'); if (!s) { mem ??= []; return mem.slice(); } return req(s.getAll()); }
async function put(it) { const s = await store('readwrite'); if (!s) { mem ??= []; const i = mem.findIndex(x => x.id === it.id); i < 0 ? mem.push(it) : mem[i] = it; return; } return req(s.put(it)); }
async function del(id) { const s = await store('readwrite'); if (!s) { mem = (mem || []).filter(x => x.id !== id); return; } return req(s.delete(id)); }

try { $('surveyName').value = localStorage.getItem('cl-survey') || ''; } catch {}
$('surveyName').addEventListener('input', e => { try { localStorage.setItem('cl-survey', e.target.value); } catch {} });

/* ---------- live GPS ---------- */
let fix = null;
// claude.ai pages cannot read live GPS; location then comes from the photo itself.
const onClaude = !window.AndroidApp && !!window.claude?.use;
function setGps(s, txt) { $('gps').dataset.s = s; $('gps').querySelector('span').textContent = txt; }
const gpsListeners = new Set();
const showFix = () => fix && setGps(fix.acc <= 10 ? 'ok' : 'warn', `GPS ±${Math.round(fix.acc)} m`);
if ('geolocation' in navigator) {
  try {
    navigator.geolocation.watchPosition(p => {
      fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, time: Date.now() };
      if (!gpsListeners.size) showFix();
      gpsListeners.forEach(f => f(fix));
    }, () => onClaude ? setGps('warn', 'Lokasi dari foto') : setGps('off', 'GPS tidak aktif'), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  } catch { setGps('off', 'GPS tidak aktif'); }
} else setGps('off', 'GPS tidak ada');

// Averages readings, weighting each by 1/accuracy² and ignoring ones much worse than the best.
function averageFix(list) {
  if (!list.length) return null;
  const best = Math.min(...list.map(f => f.acc));
  const use = list.filter(f => f.acc <= Math.max(best * 1.5, best + 3));
  let w = 0, lat = 0, lon = 0, alt = 0, altW = 0;
  for (const f of use) {
    const k = 1 / (f.acc * f.acc); w += k; lat += f.lat * k; lon += f.lon * k;
    if (f.alt != null) { alt += f.alt * k; altW += k; }
  }
  return { lat: lat / w, lon: lon / w, acc: best, alt: altW ? alt / altW : null, n: use.length, time: Date.now() };
}
// Collects only readings that arrive from now on (never a stored old position).
// Stops after `ms`, or earlier once a reading reaches `goodAcc` metres, unless `full` is set.
function lockGps(ms, { goodAcc = 5, full = false, onProgress } = {}) {
  return new Promise(resolve => {
    const got = [];
    const finish = () => { gpsListeners.delete(on); clearTimeout(timer); showFix(); resolve(averageFix(got)); };
    const on = f => {
      got.push(f); onProgress?.(got.length, averageFix(got));
      if (!full && f.acc <= goodAcc && got.length >= 2) finish();
    };
    gpsListeners.add(on);
    const timer = setTimeout(finish, ms);
  });
}

/* ---------- EXIF GPS reader ---------- */
function readExif(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off < v.byteLength - 10) {
    const m = v.getUint16(off);
    if ((m & 0xFF00) !== 0xFF00) break;
    if (m === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    off += 2 + v.getUint16(off + 2);
  }
  return null;
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const SZ = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 };
  const ifd = o => {
    const out = {}; const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12, type = u16(e + 2), count = u32(e + 4);
      const p = (SZ[type] || 1) * count > 4 ? t + u32(e + 8) : e + 8;
      out[u16(e)] = { type, count, p };
    }
    return out;
  };
  const rat = p => { const d = u32(p + 4); return d ? u32(p) / d : 0; };
  const str = en => { let s = ''; for (let i = 0; i < en.count - 1; i++) s += String.fromCharCode(v.getUint8(en.p + i)); return s; };
  const res = {};
  try {
    const i0 = ifd(t + u32(t + 4));
    if (i0[0x8769]) { const ex = ifd(t + u32(i0[0x8769].p)); if (ex[0x9003]) res.date = str(ex[0x9003]); }
    if (i0[0x8825]) {
      const g = ifd(t + u32(i0[0x8825].p));
      if (g[2] && g[4]) {
        const dms = en => rat(en.p) + rat(en.p + 8) / 60 + rat(en.p + 16) / 3600;
        let lat = dms(g[2]), lon = dms(g[4]);
        if (g[1] && String.fromCharCode(v.getUint8(g[1].p)) === 'S') lat = -lat;
        if (g[3] && String.fromCharCode(v.getUint8(g[3].p)) === 'W') lon = -lon;
        if (lat || lon) { res.lat = lat; res.lon = lon; }
        if (g[6]) res.alt = rat(g[6].p) * (g[5] && v.getUint8(g[5].p) === 1 ? -1 : 1);
      }
    }
  } catch {}
  return res;
}
function exifDate(s) { const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s || ''); return m ? new Date(+m[1], m[2]-1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }

/* ---------- coordinate text parsing ---------- */
function parseCoord(s) {
  s = s.trim(); if (!s) return null;
  const dec = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (dec) { const lat = +dec[1], lon = +dec[2]; if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon }; }
  // DMS: N/U = utara, S = selatan, E/T = timur, W/B = barat
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEWUTB])/gi)];
  if (parts.length === 2) {
    const val = p => { const x = +p[1] + (+p[2] || 0) / 60 + (+p[3] || 0) / 3600; return /[SWB]/i.test(p[4]) ? -x : x; };
    const isLat = p => /[NSU]/i.test(p[4]);
    const a = parts.find(isLat), b = parts.find(p => !isLat(p));
    if (a && b) return { lat: val(a), lon: val(b) };
  }
  return null;
}

/* ---------- image helpers ---------- */
function loadImg(src) { return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; }); }
async function normalize(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const max = 2400, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    return { blob, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}
async function stamped(it) {
  const url = URL.createObjectURL(it.blob);
  try {
    const img = await loadImg(url);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const fs = Math.max(11, Math.round(Math.min(c.width, c.height) * 0.02));
    const lines = [fmtCoord(it) + (it.acc ? `  ±${Math.round(it.acc)} m` : ''), fmtTime(it.time) + (it.title ? '  ·  ' + it.title : '')];
    g.font = `500 ${fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    const padX = fs * 0.6, lh = fs * 1.3, m = fs * 0.7;
    const w = Math.min(c.width - m * 2, Math.max(...lines.map(l => g.measureText(l).width)) + padX * 2);
    const h = lh * lines.length + padX * 0.8;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.roundRect ? g.roundRect(m, c.height - m - h, w, h, fs * 0.3) : g.rect(m, c.height - m - h, w, h); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, m + padX, c.height - m - h + padX * 0.4 + i * lh + (lh - fs) / 2, w - padX * 2));
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- files out ---------- */
// Inside the Android app, files go through the native bridge in chunks.
const native = window.AndroidApp || null;
async function nativeSave(name, blob, open) {
  const id = native.begin(name, blob.type || 'application/octet-stream');
  const step = 384 * 1024;
  for (let i = 0; i < blob.size; i += step) {
    const buf = new Uint8Array(await blob.slice(i, i + step).arrayBuffer());
    let bin = ''; for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000));
    if (!native.append(id, btoa(bin))) throw new Error('gagal menulis file');
  }
  const r = native.finish(id, !!open);
  if (r.startsWith('err:')) throw new Error(r.slice(4));
  return r.slice(3);
}
async function saveFile(name, blob, open) {
  if (native) {
    try { const where = await nativeSave(name, blob, open); toast('Tersimpan di ' + where); return true; }
    catch (e) { toast('File tidak bisa disimpan: ' + e.message); return false; }
  }
  const dl = window.claude?.use ? await window.claude.use('downloads') : null;
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); return true; }
    catch (e) { if (e?.code !== 'declined') toast('File tidak bisa disimpan di sini: ' + (e?.message || e?.code)); return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
const inArtifact = () => !native && !!window.claude?.use;
const slug = s => (s || 'survey').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'survey';

/* ---------- state + render ---------- */
let items = [];
const urls = new Map();
const thumb = it => { if (it.sampleUrl) return it.sampleUrl; if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.blob)); return urls.get(it.id); };
const earthUrl = it => `https://earth.google.com/web/search/${it.lat},${it.lon}`;
const mapsUrl = it => `https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lon}`;

let sample = null;
function makeSample() {
  const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d');
  let gr = g.createLinearGradient(0, 0, 0, 380); gr.addColorStop(0, '#8fb6d8'); gr.addColorStop(1, '#dfe9ef'); g.fillStyle = gr; g.fillRect(0, 0, 800, 600);
  g.fillStyle = '#7f9b6a'; g.beginPath(); g.moveTo(0, 360); g.quadraticCurveTo(220, 250, 430, 330); g.quadraticCurveTo(620, 380, 800, 300); g.lineTo(800, 600); g.lineTo(0, 600); g.fill();
  g.fillStyle = '#5c7a49'; g.beginPath(); g.moveTo(0, 470); g.quadraticCurveTo(400, 380, 800, 450); g.lineTo(800, 600); g.lineTo(0, 600); g.fill();
  g.fillStyle = '#6b8fa8'; g.beginPath(); g.moveTo(330, 600); g.quadraticCurveTo(420, 470, 560, 430); g.lineTo(600, 432); g.quadraticCurveTo(470, 490, 430, 600); g.fill();
  g.fillStyle = '#e8e3d6'; g.fillRect(250, 360, 34, 150); g.fillStyle = '#d9531a'; g.fillRect(250, 360, 34, 22);
  return { id: 'contoh', sample: true, sampleUrl: c.toDataURL('image/jpeg', .85), lat: -6.917464, lon: 107.619123, acc: 6, src: 'gps', time: Date.now() - 3600e3,
    title: 'Patok batas B-03', note: 'Patok beton di sisi timur saluran irigasi. Miring sekitar 10°, cat merah mulai pudar. Perlu diganti.' };
}

function render() {
  const list = items.length ? items : [sample ??= makeSample()];
  $('grid').innerHTML = list.map(it => `
    <button class="card" data-id="${esc(it.id)}" ${it.sample ? 'aria-disabled="true"' : ''}>
      <div class="ph"><img src="${thumb(it)}" alt="" loading="lazy">
        ${it.sample ? '<span class="badge">Contoh</span>' : ''}
        <div class="stamp ${it.lat == null ? 'none' : ''}">${esc(fmtCoord(it))}${it.acc ? ' ±' + Math.round(it.acc) + 'm' : ''}</div></div>
      <div class="body">
        <h3>${esc(it.title || 'Tanpa judul')}</h3>
        <p>${esc(it.note || 'Ketuk untuk menulis catatan…')}</p>
        <div class="meta"><span>${fmtTime(it.time)}</span>${it.lat != null ? `<span class="chip">${SRC[it.src] || ''}</span>` : ''}</div>
      </div>
    </button>`).join('');
  const n = items.length, nc = items.filter(i => i.lat != null).length;
  $('count').innerHTML = n ? `<b>${n}</b> foto · <b>${nc}</b> berlokasi` : 'Belum ada foto. Contoh di atas akan hilang setelah foto pertama.';
  $('exportBtn').disabled = !nc;
  $('exportBtn').classList.toggle('busy', !nc);
}
$('grid').addEventListener('click', e => {
  const c = e.target.closest('.card'); if (!c) return;
  if (c.dataset.id === 'contoh') { toast('Ini contoh. Ambil foto untuk mulai mencatat.'); return; }
  openSheet(c.dataset.id);
});

/* ---------- adding photos ---------- */
async function addFiles(files, fromCamera) {
  let added = 0, noLoc = 0;
  for (const file of files) {
    try {
      const head = await file.slice(0, 256 * 1024).arrayBuffer();
      const ex = readExif(head) || {};
      const { blob, w, h } = await normalize(file);
      const it = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), blob, w, h,
        time: (!fromCamera && exifDate(ex.date)) || file.lastModified || Date.now(), title: '', note: '', lat: null, lon: null, acc: null, alt: null, src: null };
      let live = null;
      if (fromCamera && fix) {
        toast('Mengunci GPS… tetap di titik foto sebentar.', 9000);
        setGps('wait', 'Mengunci GPS…');
        live = await lockGps(8000, { onProgress: (n, a) => setGps('wait', `Mengunci GPS ±${Math.round(a.acc)} m`) });
        if (!live && Date.now() - fix.time < 20000) live = fix;
        $('toast').hidden = true;
      }
      if (live) Object.assign(it, { lat: live.lat, lon: live.lon, acc: live.acc, alt: live.alt, n: live.n || 1, src: 'gps' });
      else if (ex.lat != null) Object.assign(it, { lat: ex.lat, lon: ex.lon, alt: ex.alt ?? null, src: 'exif' });
      if (fromCamera) it.time = Date.now();
      if (it.lat == null) noLoc++;
      await put(it); items.unshift(it); added++;
    } catch (err) { toast('Foto tidak bisa dibaca: ' + (file.name || '')); }
  }
  render();
  if (added === 1 && fromCamera) openSheet(items[0].id);
  else if (noLoc) toast(`${noLoc} foto tanpa lokasi. Buka fotonya lalu isi koordinat atau pakai GPS.`, 5000);
  else if (added) toast(`${added} foto ditambahkan.`);
}
$('camIn').addEventListener('change', e => { addFiles([...e.target.files], true); e.target.value = ''; });
$('galIn').addEventListener('change', e => { addFiles([...e.target.files], false); e.target.value = ''; });

/* ---------- editor ---------- */
let cur = null, saveT;
function syncSheet() {
  $('sStamp').textContent = fmtCoord(cur) + (cur.acc ? `  ±${Math.round(cur.acc)} m` : '') + '  ·  ' + fmtTime(cur.time);
  $('sStamp').classList.toggle('none', cur.lat == null);
  const has = cur.lat != null;
  for (const [id, fn] of [['lnkEarth', earthUrl], ['lnkMaps', mapsUrl]]) {
    const a = $(id); if (has) a.href = fn(cur); else a.removeAttribute('href'); a.classList.toggle('busy', !has);
  }
  $('coordNote').className = 'note';
  $('coordNote').textContent = has ? `Sumber: ${SRC[cur.src] || '-'}${cur.acc ? ` · akurasi ±${Math.round(cur.acc)} m` : ''}${cur.n > 1 ? ` · rata-rata ${cur.n} bacaan` : ''}${cur.alt != null ? ` · elevasi ${Math.round(cur.alt)} m` : ''}` : 'Foto ini belum punya lokasi. Isi koordinat (bisa ditempel dari Google Earth/Maps) atau tekan "Kunci GPS di titik ini".';
}
function openSheet(id) {
  cur = items.find(i => i.id === id); if (!cur) return;
  $('sImg').src = thumb(cur);
  $('fTitle').value = cur.title; $('fNote').value = cur.note;
  $('fCoord').value = cur.lat != null ? fmtCoord(cur) : '';
  $('delConfirm').hidden = true;
  syncSheet(); $('sheet').hidden = false; $('sheet').scrollTop = 0;
}
function queueSave() { clearTimeout(saveT); saveT = setTimeout(() => cur && put(cur), 350); }
$('fTitle').addEventListener('input', e => { cur.title = e.target.value; queueSave(); });
$('fNote').addEventListener('input', e => { cur.note = e.target.value; queueSave(); });
$('fCoord').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (!v) { Object.assign(cur, { lat: null, lon: null, acc: null, src: null }); syncSheet(); queueSave(); return; }
  const p = parseCoord(v);
  if (!p) { $('coordNote').className = 'note err'; $('coordNote').textContent = 'Format tidak dikenali. Contoh: -6.917464, 107.619123 atau 6°55\'02.9"S 107°37\'08.8"E'; return; }
  Object.assign(cur, { lat: p.lat, lon: p.lon, acc: null, alt: null, n: 0, src: 'manual' });
  e.target.value = fmtCoord(cur); syncSheet(); queueSave();
});
$('useGps').addEventListener('click', async () => {
  if (!fix) { toast('GPS belum mendapat posisi. Pastikan izin lokasi aktif dan tunggu sebentar.'); return; }
  const btn = $('useGps'), label = btn.textContent, target = cur;
  btn.classList.add('busy');
  toast('Berdiri diam tepat di titik foto. GPS dirata-rata selama 15 detik.', 4000);
  const a = await lockGps(15000, { full: true, onProgress: (n, avg) => { btn.textContent = `Merata-rata… ${n} bacaan ±${Math.round(avg.acc)} m`; } });
  btn.textContent = label; btn.classList.remove('busy');
  if (!a) { toast('Tidak ada bacaan GPS baru. Coba di tempat terbuka.'); return; }
  Object.assign(target, { lat: a.lat, lon: a.lon, acc: a.acc, alt: a.alt, n: a.n, src: 'gps' });
  if (cur === target) { $('fCoord').value = fmtCoord(cur); syncSheet(); }
  put(target); toast(`Lokasi dikunci dari ${a.n} bacaan GPS (±${Math.round(a.acc)} m).`);
});
$('copyCoord').addEventListener('click', async () => {
  if (cur.lat == null) return;
  try { await navigator.clipboard.writeText(fmtCoord(cur)); toast('Koordinat disalin.'); }
  catch { $('fCoord').focus(); $('fCoord').select(); toast('Tekan salin pada teks yang terpilih.'); }
});
$('saveJpg').addEventListener('click', async () => {
  const b = await stamped(cur);
  await saveFile(`${slug(cur.title || $('surveyName').value)}-${new Date(cur.time).toISOString().slice(0, 10)}.jpg`, b);
});
$('delBtn').addEventListener('click', () => { $('delConfirm').hidden = false; });
$('delNo').addEventListener('click', () => { $('delConfirm').hidden = true; });
$('delYes').addEventListener('click', async () => {
  await del(cur.id); items = items.filter(i => i.id !== cur.id);
  if (urls.has(cur.id)) { URL.revokeObjectURL(urls.get(cur.id)); urls.delete(cur.id); }
  cur = null; $('sheet').hidden = true; render(); toast('Foto dihapus.');
});
$('doneBtn').addEventListener('click', async () => {
  clearTimeout(saveT); if (cur) await put(cur);
  cur = null; $('sheet').hidden = true; render();
});

/* ---------- KMZ export ---------- */
function wrapText(g, text, maxW, maxLines) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const t = line ? line + ' ' + word : word;
      if (line && g.measureText(t).width > maxW) { out.push(line); line = word; } else line = t;
    }
    if (line) out.push(line);
  }
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, '') + ' …'; }
  return out;
}
// A square card (photo, title, note, coordinates) that Google Earth shows when the pointer is over a point.
async function hoverCard(it, title) {
  const url = URL.createObjectURL(it.blob);
  try {
    const img = await loadImg(url);
    const S = 512, PH = 300, c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
    const k = Math.max(S / img.naturalWidth, PH / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
    g.save(); g.beginPath(); g.rect(0, 0, S, PH); g.clip(); g.drawImage(img, (S - w) / 2, (PH - h) / 2, w, h); g.restore();
    g.fillStyle = '#d9531a'; g.fillRect(0, PH, S, 5);
    g.fillStyle = '#1c2419'; g.textBaseline = 'top';
    g.font = 'bold 26px Arial, sans-serif';
    g.fillText(wrapText(g, title, S - 32, 1)[0] || '', 16, PH + 16, S - 32);
    g.font = '20px Arial, sans-serif'; g.fillStyle = '#333a30';
    wrapText(g, it.note || '(tanpa catatan)', S - 32, 4).forEach((l, i) => g.fillText(l, 16, PH + 54 + i * 25, S - 32));
    g.font = '15px "Courier New", monospace'; g.fillStyle = '#5d6a58';
    g.fillText(`${fmtCoord(it)}${it.acc ? ' ±' + Math.round(it.acc) + ' m' : ''} · ${fmtTime(it.time)}`, 16, S - 26, S - 32);
    g.strokeStyle = '#1c2419'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, S - 3, S - 3);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}

$('exportBtn').addEventListener('click', async () => {
  const pts = items.filter(i => i.lat != null).slice().sort((a, b) => a.time - b.time);
  if (!pts.length) return;
  if (!window.JSZip) { toast('Pustaka ekspor belum termuat. Periksa koneksi internet lalu coba lagi.'); return; }
  const btn = $('exportBtn'); btn.classList.add('busy');
  try {
    const name = $('surveyName').value.trim() || 'Survey lapangan';
    const zip = new JSZip(); const files = zip.folder('files');
    const cd = s => String(s ?? '').replace(/]]>/g, ']]&gt;');
    let pm = '';
    for (let i = 0; i < pts.length; i++) {
      const it = pts[i], fn = `foto-${pad(i + 1, 3)}.jpg`, card = `kartu-${pad(i + 1, 3)}.jpg`;
      const title = it.title || 'Foto ' + (i + 1);
      files.file(fn, await stamped(it));
      files.file(card, await hoverCard(it, title));
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px">
<img src="files/${fn}" width="500"><br>
<b>${esc(it.title || 'Foto ' + (i + 1))}</b><br>
${esc(it.note).replace(/\n/g, '<br>')}<br><br>
<small>${fmtCoord(it)}${it.acc ? ' ±' + Math.round(it.acc) + ' m' : ''} · ${fmtTime(it.time)} · sumber: ${SRC[it.src] || '-'}</small></div>`;
      pm += `
  <Placemark>
    <name>${esc(it.title || 'Foto ' + (i + 1))}</name>
    <Snippet maxLines="2">${esc((it.note || '').slice(0, 140))}</Snippet>
    <StyleMap>
      <Pair><key>normal</key><styleUrl>#foto</styleUrl></Pair>
      <Pair><key>highlight</key><Style>
        <IconStyle><scale>9</scale><Icon><href>files/${card}</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle>
        <LabelStyle><scale>0</scale></LabelStyle>
        <BalloonStyle><text>$[description]</text></BalloonStyle>
      </Style></Pair>
    </StyleMap>
    <description><![CDATA[${cd(html)}]]></description>
    <ExtendedData>
      <Data name="catatan"><value>${esc(it.note)}</value></Data>
      <Data name="waktu"><value>${new Date(it.time).toISOString()}</value></Data>
      <Data name="akurasi_m"><value>${it.acc ? Math.round(it.acc) : ''}</value></Data>
      <Data name="foto"><value>files/${fn}</value></Data>
    </ExtendedData>
    <Point><coordinates>${it.lon},${it.lat},0</coordinates></Point>
  </Placemark>`;
    }
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(name)}</name>
  <Style id="foto">
    <IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/camera.png</href></Icon></IconStyle>
    <LabelStyle><scale>0.8</scale></LabelStyle>
    <BalloonStyle><text>$[description]</text></BalloonStyle>
  </Style>
  <Folder><name>Foto survey (${pts.length})</name>${pm}
  </Folder>
</Document>
</kml>`;
    zip.file('doc.kml', kml);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.google-earth.kmz' });
    const base = `${slug(name)}-${new Date().toISOString().slice(0, 10)}`;
    // The artifact viewer only saves allowlisted extensions; .zip is the same bytes as .kmz.
    const ok = await saveFile(base + (inArtifact() ? '.zip' : '.kmz'), blob, true);
    const skipped = items.length - pts.length;
    if (ok && !native) toast((inArtifact() ? 'Tersimpan sebagai .zip — ganti ekstensinya menjadi .kmz lalu buka di Google Earth.' : 'File .kmz siap. Buka di Google Earth.') + (skipped ? ` ${skipped} foto tanpa lokasi tidak ikut.` : ''), 7000);
  } catch (e) { toast('Ekspor gagal: ' + (e?.message || e)); }
  finally { btn.classList.remove('busy'); }
});

/* ---------- install as app (works only when served over https, not inside claude.ai) ---------- */
let deferred = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt(); const r = await deferred.userChoice; deferred = null; $('installBtn').hidden = true;
  if (r.outcome === 'accepted') toast('Aplikasi dipasang. Buka dari layar utama HP.');
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });
let tipSeen = false; try { tipSeen = localStorage.getItem('cl-iostip') === '1'; } catch {}
if (!native && !standalone && !inArtifact() && /iphone|ipad|ipod/i.test(navigator.userAgent) && !tipSeen) $('iosTip').hidden = false;
$('iosTipX').addEventListener('click', () => { $('iosTip').hidden = true; try { localStorage.setItem('cl-iostip', '1'); } catch {} });
// When a new version takes over, reload once so the installed app shows it.
try { if (!native && navigator.serviceWorker?.controller) navigator.serviceWorker.addEventListener('controllerchange', () => location.reload()); } catch {}
try { if (!native && 'serviceWorker' in navigator && !inArtifact() && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {}); } catch {}

if (onClaude) $('hint').textContent = 'Di halaman ini lokasi diambil dari data GPS di dalam foto. Nyalakan "Tag lokasi" di setelan aplikasi Kamera HP. Foto tanpa lokasi bisa diisi koordinatnya secara manual.';

// Android back button: close the open photo first.
window.__clBack = () => { if ($('sheet').hidden) return false; $('doneBtn').click(); return true; };

getAll().then(all => {
  items = all.sort((a, b) => b.time - a.time); render();
  dbP.then(db => { if (!db) $('hint').textContent = 'Penyimpanan perangkat tidak tersedia di tampilan ini: foto hanya bertahan sampai halaman ditutup. Ekspor sebelum menutup.'; });
});
render();
})();
