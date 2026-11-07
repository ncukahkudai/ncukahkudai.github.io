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
const SRC = { gps: 'GPS', exif: 'Data foto', manual: 'Manual', map: 'Peta satelit' };
const fmtDate = t => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const fmtAlt = it => it.alt != null ? `${Math.round(it.alt)} m` : '–';
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
      drawGps();
    }, () => onClaude ? setGps('warn', 'Lokasi dari foto') : setGps('off', 'GPS tidak aktif'), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  } catch { setGps('off', 'GPS tidak aktif'); }
} else setGps('off', 'GPS tidak ada');

// Distance in metres between two nearby positions.
function metres(a, b) {
  const dy = (a.lat - b.lat) * 110574, dx = (a.lon - b.lon) * 111320 * Math.cos(b.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}
// Averages readings weighted by 1/accuracy², drops readings much worse than the best one,
// then drops jumps far from the cluster (reflections off walls and water). `spread` is the
// RMS distance of the kept readings from the result, in metres.
function averageFix(list) {
  if (!list.length) return null;
  const mean = arr => { let w = 0, lat = 0, lon = 0; for (const f of arr) { const k = 1 / (f.acc * f.acc); w += k; lat += f.lat * k; lon += f.lon * k; } return { lat: lat / w, lon: lon / w }; };
  const best = Math.min(...list.map(f => f.acc));
  let use = list.filter(f => f.acc <= Math.max(best * 1.5, best + 3)), m = mean(use);
  if (use.length >= 5) {
    const d = use.map(f => metres(f, m)), med = [...d].sort((a, b) => a - b)[d.length >> 1];
    const keep = use.filter((f, i) => d[i] <= Math.max(2.5 * med, 1));
    if (keep.length >= 3) { use = keep; m = mean(use); }
  }
  const spread = Math.sqrt(use.reduce((t, f) => t + metres(f, m) ** 2, 0) / use.length);
  const withAlt = use.filter(f => f.alt != null);
  const alt = withAlt.length ? withAlt.reduce((t, f) => t + f.alt, 0) / withAlt.length : null;
  return { lat: m.lat, lon: m.lon, acc: best, spread, alt, n: use.length, time: Date.now() };
}
// Collects only readings that arrive from now on (never a stored old position).
// Stops after `ms`, earlier once a reading reaches `goodAcc` metres (unless `full`), or when ctl.stop() is called.
function lockGps(ms, { goodAcc = 5, full = false, onProgress, ctl } = {}) {
  return new Promise(resolve => {
    const got = [];
    const finish = () => { gpsListeners.delete(on); clearTimeout(timer); showFix(); resolve(averageFix(got)); };
    const on = f => {
      got.push(f); onProgress?.(got.length, averageFix(got));
      if (!full && f.acc <= goodAcc && got.length >= 2) finish();
    };
    gpsListeners.add(on);
    const timer = setTimeout(finish, ms);
    if (ctl) ctl.stop = finish;
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
    const lines = [fmtCoord(it) + (it.acc ? `  ±${Math.round(it.acc)} m` : ''),
      `Tinggi ${fmtAlt(it)}  ·  Tgl survey ${fmtDate(it.time)} ${new Date(it.time).toTimeString().slice(0, 5)}`];
    if (it.title) lines.push(it.title);
    g.font = `500 ${fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    const padX = fs * 0.6, lh = fs * 1.3, m = fs * 0.7;
    const w = Math.min(c.width - m * 2, Math.max(...lines.map(l => g.measureText(l).width)) + padX * 2);
    const h = lh * lines.length + padX * 0.8;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.roundRect ? g.roundRect(m, c.height - m - h, w, h, fs * 0.3) : g.rect(m, c.height - m - h, w, h); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, m + padX, c.height - m - h + padX * 0.4 + i * lh + (lh - fs) / 2, w - padX * 2));
    return withExif(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)), it);
  } finally { URL.revokeObjectURL(url); }
}

// Writes the GPS position, altitude, accuracy and date into the JPEG as EXIF, so gallery apps,
// Google Photos and GIS tools read the location from the file itself.
async function withExif(blob, it) {
  const asc = t => [...Array.from(t, c => c.charCodeAt(0) & 0x7f), 0];
  const d = new Date(it.time);
  const ts = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const dms = v => { v = Math.abs(v); const deg = Math.floor(v), mf = (v - deg) * 60, min = Math.floor(mf); return [[deg, 1], [min, 1], [Math.round((mf - min) * 600000), 10000]]; };
  const ifd0 = [[0x0132, 2, asc(ts)], [0x8769, 4, 'exif']];
  const exif = [[0x9003, 2, asc(ts)], [0x9004, 2, asc(ts)]];
  let gps = null;
  if (it.lat != null) {
    gps = [[0x0000, 1, [2, 3, 0, 0]], [0x0001, 2, asc(it.lat < 0 ? 'S' : 'N')], [0x0002, 5, dms(it.lat)],
      [0x0003, 2, asc(it.lon < 0 ? 'W' : 'E')], [0x0004, 5, dms(it.lon)], [0x0012, 2, asc('WGS-84')]];
    if (it.alt != null) gps.push([0x0005, 1, [it.alt < 0 ? 1 : 0]], [0x0006, 5, [[Math.round(Math.abs(it.alt) * 100), 100]]]);
    if (it.acc) gps.push([0x001f, 5, [[Math.round(it.acc * 100), 100]]]);
    ifd0.push([0x8825, 4, 'gps']);
  }
  const size = ([, type, val]) => type === 5 ? val.length * 8 : type === 4 ? 4 : val.length;
  const ifdLen = E => 2 + 12 * E.length + 4 + E.reduce((t, e) => t + (size(e) > 4 ? size(e) + (size(e) & 1) : 0), 0);
  const off = { exif: 8 + ifdLen(ifd0) }; off.gps = off.exif + ifdLen(exif);
  const total = off.gps + (gps ? ifdLen(gps) : 0), v = new DataView(new ArrayBuffer(total));
  v.setUint16(0, 0x4d4d); v.setUint16(2, 42); v.setUint32(4, 8);   // big-endian TIFF header
  const write = (E, at) => {
    E.sort((a, b) => a[0] - b[0]);
    v.setUint16(at, E.length);
    let data = at + 2 + 12 * E.length + 4;
    E.forEach(([tag, type, val], k) => {
      const e = at + 2 + k * 12, n = size([tag, type, val]);
      v.setUint16(e, tag); v.setUint16(e + 2, type); v.setUint32(e + 4, type === 4 ? 1 : val.length);
      if (type === 4) { v.setUint32(e + 8, off[val]); return; }
      let p = e + 8;
      if (n > 4) { p = data; v.setUint32(e + 8, data); data += n + (n & 1); }
      if (type === 5) val.forEach(([a, b]) => { v.setUint32(p, a); v.setUint32(p + 4, b); p += 8; });
      else val.forEach(b => v.setUint8(p++, b));
    });
    v.setUint32(at + 2 + 12 * E.length, 0);
  };
  write(ifd0, 8); write(exif, off.exif); if (gps) write(gps, off.gps);
  const app1 = new Uint8Array([0xff, 0xe1, (total + 8) >> 8, (total + 8) & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  const buf = await blob.arrayBuffer();
  return new Blob([new Uint8Array(buf, 0, 2), app1, new Uint8Array(v.buffer), new Uint8Array(buf, 2)], { type: 'image/jpeg' });
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
      if (live) Object.assign(it, { lat: live.lat, lon: live.lon, acc: live.acc, spread: live.spread ?? null, alt: live.alt, n: live.n || 1, src: 'gps' });
      if (fromCamera) it.toGallery = true;
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
  $('sStamp').textContent = fmtCoord(cur) + (cur.acc ? `  ±${Math.round(cur.acc)} m` : '') + `  ·  tinggi ${fmtAlt(cur)}  ·  ${fmtTime(cur.time)}`;
  $('sStamp').classList.toggle('none', cur.lat == null);
  const has = cur.lat != null;
  for (const [id, fn] of [['lnkEarth', earthUrl], ['lnkMaps', mapsUrl]]) {
    const a = $(id); if (has) a.href = fn(cur); else a.removeAttribute('href'); a.classList.toggle('busy', !has);
  }
  $('coordNote').className = 'note';
  $('coordNote').textContent = has ? `Sumber: ${SRC[cur.src] || '-'}${cur.acc ? ` · akurasi ±${Math.round(cur.acc)} m` : ''}${cur.n > 1 ? ` · rata-rata ${cur.n} bacaan` : ''}${cur.spread != null && cur.n > 1 ? `, sebaran ${cur.spread.toFixed(1)} m` : ''} · tinggi ${fmtAlt(cur)}` : 'Foto ini belum punya lokasi. Isi koordinat (bisa ditempel dari Google Earth/Maps) atau tekan "Kunci presisi GPS".';
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
let lockCtl = null;
$('useGps').addEventListener('click', async () => {
  if (lockCtl) { lockCtl.stop?.(); return; }
  if (!fix) { toast('GPS belum mendapat posisi. Pastikan izin lokasi aktif dan tunggu sebentar.'); return; }
  const btn = $('useGps'), label = btn.textContent, target = cur;
  lockCtl = {};
  toast('Berdiri diam tepat di atas titik, HP mendatar menghadap langit. Ketuk tombol lagi untuk berhenti lebih awal.', 5000);
  const a = await lockGps(30000, { full: true, ctl: lockCtl, onProgress: (n, avg) => {
    btn.textContent = `Berhenti & pakai · ${n} bacaan ±${Math.round(avg.acc)} m, sebaran ${avg.spread.toFixed(1)} m`; } });
  lockCtl = null; btn.textContent = label;
  if (!a) { toast('Tidak ada bacaan GPS baru. Coba di tempat yang lebih terbuka.'); return; }
  Object.assign(target, { lat: a.lat, lon: a.lon, acc: a.acc, spread: a.spread, alt: a.alt, n: a.n, src: 'gps' });
  if (cur === target) { $('fCoord').value = fmtCoord(cur); syncSheet(); }
  put(target); toast(`Lokasi dikunci dari ${a.n} bacaan GPS (±${Math.round(a.acc)} m, sebaran ${a.spread.toFixed(1)} m).`, 5000);
});
$('copyCoord').addEventListener('click', async () => {
  if (cur.lat == null) return;
  try { await navigator.clipboard.writeText(fmtCoord(cur)); toast('Koordinat disalin.'); }
  catch { $('fCoord').focus(); $('fCoord').select(); toast('Tekan salin pada teks yang terpilih.'); }
});
// Chrome on Android saves downloads to the Download folder, which gallery apps and Google Photos show as an album.
const galleryName = it => { const d = new Date(it.time);
  return `CatatanLapangan_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${it.title ? '_' + slug(it.title) : ''}.jpg`; };
async function saveToGallery(it, quiet) {
  const ok = await saveFile(galleryName(it), await stamped(it));
  if (ok) { it.toGallery = false; put(it); if (!quiet && !native) toast('Foto tersimpan ke galeri HP (album Download).'); }
  return ok;
}
let autoSave = true;
try { autoSave = localStorage.getItem('cl-autosave') !== '0'; } catch {}
$('autoSave').checked = autoSave;
$('autoSave').addEventListener('change', e => { autoSave = e.target.checked; try { localStorage.setItem('cl-autosave', autoSave ? '1' : '0'); } catch {} });
$('autoSaveRow').hidden = onClaude;
$('saveJpg').addEventListener('click', () => saveToGallery(cur));
$('delBtn').addEventListener('click', () => { $('delConfirm').hidden = false; });
$('delNo').addEventListener('click', () => { $('delConfirm').hidden = true; });
$('delYes').addEventListener('click', async () => {
  await del(cur.id); items = items.filter(i => i.id !== cur.id);
  if (urls.has(cur.id)) { URL.revokeObjectURL(urls.get(cur.id)); urls.delete(cur.id); }
  cur = null; $('sheet').hidden = true; render(); toast('Foto dihapus.');
});
$('doneBtn').addEventListener('click', async () => {
  clearTimeout(saveT); if (cur) await put(cur);
  if (cur?.toGallery && autoSave && !onClaude) await saveToGallery(cur);
  cur = null; $('sheet').hidden = true; render();
});

/* ---------- fine-tune a point on satellite imagery ---------- */
// Leaflet is part of the app; only the imagery tiles come from Esri (needs internet).
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
let leafletP = null, map = null, mapTarget = null;
const mapLayers = {};
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return leafletP ??= new Promise((ok, no) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'leaflet.js';
    js.onload = ok; js.onerror = () => { leafletP = null; no(new Error('peta tidak termuat')); };
    document.head.appendChild(js);
  });
}
function drawGps() {
  if (!map || !fix || $('mapSheet').hidden) return;
  const ll = [fix.lat, fix.lon];
  if (!mapLayers.gps) {
    mapLayers.acc = L.circle(ll, { radius: fix.acc, color: '#2b7de9', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    mapLayers.gps = L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#2b7de9', fillOpacity: 1, interactive: false }).addTo(map);
  } else { mapLayers.gps.setLatLng(ll); mapLayers.acc.setLatLng(ll).setRadius(fix.acc); }
}
function showMapCenter() { const c = map.getCenter(); $('mapRead').textContent = `${c.lat.toFixed(7)}, ${c.lng.toFixed(7)}  ·  zoom ${map.getZoom()}`; }
$('mapBtn').hidden = onClaude;
$('mapBtn').addEventListener('click', async () => {
  try { await loadLeaflet(); } catch { toast('Peta belum bisa dimuat. Periksa koneksi internet.'); return; }
  mapTarget = cur;
  $('mapSheet').hidden = false;
  const has = cur.lat != null, start = has ? [cur.lat, cur.lon] : fix ? [fix.lat, fix.lon] : [-2.5, 118];
  if (!map) {
    map = L.map('map', { maxZoom: 22, zoomSnap: 0.5 });
    L.tileLayer(TILES, { maxZoom: 22, maxNativeZoom: 19, attribution: 'Citra © Esri, Maxar, Earthstar Geographics' }).addTo(map);
    map.on('move', showMapCenter);
  }
  map.invalidateSize();
  map.setView(start, has || fix ? 20 : 5, { animate: false });
  mapLayers.orig?.remove();
  mapLayers.orig = has ? L.circleMarker(start, { radius: 6, color: '#fff', weight: 2, fillColor: '#d9531a', fillOpacity: 1, interactive: false }).addTo(map) : null;
  drawGps(); showMapCenter();
});
$('mapCancel').addEventListener('click', () => { $('mapSheet').hidden = true; });
$('mapGps').addEventListener('click', () => {
  if (!fix) { toast('GPS belum mendapat posisi.'); return; }
  map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 19));
});
$('mapUse').addEventListener('click', () => {
  const c = map.getCenter(), t = mapTarget;
  Object.assign(t, { lat: c.lat, lon: c.lng, acc: null, spread: null, n: 0, src: 'map' });
  put(t); $('mapSheet').hidden = true;
  if (cur === t) { $('fCoord').value = fmtCoord(t); syncSheet(); }
  toast('Titik disesuaikan di peta satelit.');
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

const exportPoints = () => items.filter(i => i.lat != null).slice().sort((a, b) => a.time - b.time);
const photoName = i => `foto-${pad(i + 1, 3)}.jpg`;
const localStamp = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

// WGS 84 latitude/longitude to UTM (Transverse Mercator series, accurate to millimetres within a zone).
function toUTM(lat, lon) {
  const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = lat * Math.PI / 180, dl = (lon - ((zone - 1) * 6 - 177)) * Math.PI / 180;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = cos * dl;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return { zone: zone + (lat < 0 ? 'S' : 'N'), x, y: lat < 0 ? y + 10000000 : y };
}

function exportRows(pts) {
  return pts.map((it, i) => {
    const u = toUTM(it.lat, it.lon);
    return { no: i + 1, judul: it.title || 'Foto ' + (i + 1), catatan: it.note || '', lat: it.lat, lon: it.lon,
      zona: u.zone, utmX: u.x, utmY: u.y, akurasi: it.acc ?? null, elevasi: it.alt ?? null,
      waktu: localStamp(it.time), sumber: SRC[it.src] || '', foto: photoName(i) };
  });
}

// Element order follows the OGC KML 2.2 schema (Google Earth Pro drops elements that are out of order),
// and doc.kml is the first entry of the KMZ, as Google's KMZ guide places it.
async function buildKmz(pts, name) {
  const cd = s => String(s ?? '').replace(/]]>/g, ']]&gt;');
  const images = [];
  let styles = '', pm = '';
  for (let i = 0; i < pts.length; i++) {
    const it = pts[i], n = pad(i + 1, 3), fn = `foto-${n}.jpg`, card = `kartu-${n}.jpg`;
    const title = it.title || 'Foto ' + (i + 1);
    images.push([fn, await stamped(it)], [card, await hoverCard(it, title)]);
    styles += `
  <Style id="kartu-${n}">
    <IconStyle><scale>9</scale><Icon><href>files/${card}</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle>
    <LabelStyle><scale>0</scale></LabelStyle>
    <BalloonStyle><text>$[description]</text></BalloonStyle>
  </Style>
  <StyleMap id="titik-${n}">
    <Pair><key>normal</key><styleUrl>#foto</styleUrl></Pair>
    <Pair><key>highlight</key><styleUrl>#kartu-${n}</styleUrl></Pair>
  </StyleMap>`;
    const html = `<div style="font-family:Arial,sans-serif;width:500px;word-wrap:break-word;overflow-wrap:anywhere">
<img src="files/${fn}" width="500"><br>
<b style="font-size:15px">${esc(title)}</b><br>
${esc(it.note).replace(/\n/g, '<br>')}<br><br>
<small>${fmtCoord(it)}${it.acc ? ' ±' + Math.round(it.acc) + ' m' : ''} · ${fmtTime(it.time)} · sumber: ${SRC[it.src] || '-'}</small></div>`;
    pm += `
    <Placemark>
      <name>${esc(title)}</name>
      <Snippet maxLines="2">${esc((it.note || '').slice(0, 140))}</Snippet>
      <description><![CDATA[${cd(html)}]]></description>
      <styleUrl>#titik-${n}</styleUrl>
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
  </Style>${styles}
  <Folder>
    <name>Foto survey (${pts.length})</name>${pm}
  </Folder>
</Document>
</kml>
`;
  const zip = new JSZip();
  zip.file('doc.kml', kml);
  for (const [fn, blob] of images) zip.file('files/' + fn, blob);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.google-earth.kmz' });
}

function buildCsv(rows) {
  const q = v => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['no', 'judul', 'catatan', 'lintang', 'bujur', 'utm_zona', 'utm_x', 'utm_y', 'akurasi_m', 'elevasi_m', 'waktu', 'sumber', 'foto'];
  const lines = rows.map(r => [r.no, r.judul, r.catatan, r.lat.toFixed(7), r.lon.toFixed(7), r.zona, r.utmX.toFixed(2), r.utmY.toFixed(2),
    r.akurasi != null ? r.akurasi.toFixed(1) : '', r.elevasi != null ? r.elevasi.toFixed(1) : '', r.waktu, r.sumber, r.foto].map(q).join(','));
  return '\ufeff' + [head.join(','), ...lines].join('\r\n') + '\r\n';  // BOM so Excel reads UTF-8
}

function buildGeoJson(rows, withPhotos) {
  const r1 = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
  return JSON.stringify({ type: 'FeatureCollection', features: rows.map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r1(r.lon, 8), r1(r.lat, 8)] },
    properties: { no: r.no, judul: r.judul, catatan: r.catatan, utm_zona: r.zona, utm_x: r1(r.utmX, 2), utm_y: r1(r.utmY, 2),
      akurasi_m: r1(r.akurasi, 1), elevasi_m: r1(r.elevasi, 1), waktu: r.waktu, sumber: r.sumber, foto: withPhotos ? 'foto/' + r.foto : null }
  })) }, null, 2);
}

function buildGpx(rows, pts, name) {
  const wpt = rows.map((r, i) => `  <wpt lat="${r.lat.toFixed(8)}" lon="${r.lon.toFixed(8)}">${pts[i].alt != null ? `<ele>${pts[i].alt.toFixed(1)}</ele>` : ''}`
    + `<time>${new Date(pts[i].time).toISOString()}</time><name>${esc(r.judul)}</name><desc>${esc(r.catatan)}</desc><sym>Flag, Blue</sym></wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Catatan Lapangan" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
${wpt}
</gpx>
`;
}

// ESRI Shapefile (point, WGS 84): .shp geometry, .shx index, .dbf attributes, .prj and .cpg (UTF-8).
const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
function buildShapefile(rows) {
  const n = rows.length, shpLen = 100 + n * 28, shxLen = 100 + n * 8;
  const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(shxLen));
  const xs = rows.map(r => r.lon), ys = rows.map(r => r.lat);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  for (const [v, len] of [[shp, shpLen], [shx, shxLen]]) {
    v.setInt32(0, 9994); v.setInt32(24, len / 2); v.setInt32(28, 1000, true); v.setInt32(32, 1, true);
    box.forEach((b, k) => v.setFloat64(36 + k * 8, b, true));
  }
  rows.forEach((r, i) => {
    const o = 100 + i * 28;
    shp.setInt32(o, i + 1); shp.setInt32(o + 4, 10);
    shp.setInt32(o + 8, 1, true); shp.setFloat64(o + 12, r.lon, true); shp.setFloat64(o + 20, r.lat, true);
    shx.setInt32(100 + i * 8, o / 2); shx.setInt32(104 + i * 8, 10);
  });
  return { shp: shp.buffer, shx: shx.buffer, dbf: buildDbf(rows) };
}
function buildDbf(rows) {
  const F = [['NO', 'N', 5, 0], ['JUDUL', 'C', 100, 0], ['CATATAN', 'C', 254, 0], ['LINTANG', 'N', 13, 8], ['BUJUR', 'N', 13, 8],
    ['UTM_ZONA', 'C', 4, 0], ['UTM_X', 'N', 12, 2], ['UTM_Y', 'N', 12, 2], ['AKURASI_M', 'N', 7, 1], ['ELEVASI_M', 'N', 8, 1],
    ['WAKTU', 'C', 19, 0], ['SUMBER', 'C', 10, 0], ['FOTO', 'C', 40, 0]];
  const enc = new TextEncoder();
  const recLen = 1 + F.reduce((t, f) => t + f[2], 0), headLen = 32 + 32 * F.length + 1;
  const buf = new Uint8Array(headLen + recLen * rows.length + 1), v = new DataView(buf.buffer), d = new Date();
  buf[0] = 0x03; buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
  v.setUint32(4, rows.length, true); v.setUint16(8, headLen, true); v.setUint16(10, recLen, true);
  F.forEach(([name, type, len, dec], k) => { const o = 32 + k * 32; buf.set(enc.encode(name), o); buf[o + 11] = type.charCodeAt(0); buf[o + 16] = len; buf[o + 17] = dec; });
  buf[headLen - 1] = 0x0d;
  // Text fields hold at most `max` bytes; cut whole characters so UTF-8 stays valid.
  const fit = (t, max) => { let b = enc.encode(t); while (b.length > max) { t = t.slice(0, -1); b = enc.encode(t); } return b; };
  rows.forEach((r, i) => {
    let o = headLen + i * recLen; buf[o++] = 0x20;
    const vals = [r.no, r.judul, r.catatan.replace(/\s*\n\s*/g, ' / '), r.lat, r.lon, r.zona, r.utmX, r.utmY, r.akurasi, r.elevasi, r.waktu, r.sumber, r.foto];
    F.forEach(([, type, len, dec], k) => {
      const val = vals[k];
      const bytes = type === 'N' ? enc.encode((val == null ? '' : Number(val).toFixed(dec)).padStart(len).slice(-len)) : fit(String(val ?? ''), len);
      buf.fill(0x20, o, o + len); buf.set(bytes, o); o += len;
    });
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}

async function addPhotos(zip, pts) {
  const dir = zip.folder('foto');
  for (let i = 0; i < pts.length; i++) dir.file(photoName(i), await stamped(pts[i]));
}
const zipBlob = zip => zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

const EXPORTS = {
  kmz: async (pts, name, base) => ({ file: base + '.kmz', blob: await buildKmz(pts, name), open: true }),
  shp: async (pts, name, base, withPhotos) => {
    const zip = new JSZip(), stem = base, sh = buildShapefile(exportRows(pts));
    zip.file(stem + '.shp', sh.shp); zip.file(stem + '.shx', sh.shx); zip.file(stem + '.dbf', sh.dbf);
    zip.file(stem + '.prj', WGS84_PRJ); zip.file(stem + '.cpg', 'UTF-8');
    if (withPhotos) await addPhotos(zip, pts);
    return { file: base + '-shapefile.zip', blob: await zipBlob(zip) };
  },
  geojson: async (pts, name, base, withPhotos) => {
    const text = buildGeoJson(exportRows(pts), withPhotos);
    if (!withPhotos) return { file: base + '.geojson', blob: new Blob([text], { type: 'application/geo+json' }) };
    const zip = new JSZip(); zip.file(base + '.geojson', text); await addPhotos(zip, pts);
    return { file: base + '-geojson.zip', blob: await zipBlob(zip) };
  },
  csv: async (pts, name, base, withPhotos) => {
    const text = buildCsv(exportRows(pts));
    if (!withPhotos) return { file: base + '.csv', blob: new Blob([text], { type: 'text/csv' }) };
    const zip = new JSZip(); zip.file(base + '.csv', text); await addPhotos(zip, pts);
    return { file: base + '-csv.zip', blob: await zipBlob(zip) };
  },
  gpx: async (pts, name, base) => ({ file: base + '.gpx', blob: new Blob([buildGpx(exportRows(pts), pts, name)], { type: 'application/gpx+xml' }) }),
};

// The claude.ai viewer saves only some extensions: same bytes under an accepted name, or wrapped in a zip.
async function viewerSafe(out) {
  if (!inArtifact()) return out;
  if (out.file.endsWith('.kmz')) return { ...out, file: out.file.replace(/\.kmz$/, '.zip'), note: 'Ganti ekstensinya menjadi .kmz lalu buka di Google Earth.' };
  if (out.file.endsWith('.geojson')) return { ...out, file: out.file.replace(/\.geojson$/, '.json') };
  if (out.file.endsWith('.gpx')) { const z = new JSZip(); z.file(out.file, out.blob); return { ...out, file: out.file + '.zip', blob: await zipBlob(z) }; }
  return out;
}

try { $('withPhotos').checked = localStorage.getItem('cl-withphotos') !== '0'; } catch {}
$('withPhotos').addEventListener('change', e => { try { localStorage.setItem('cl-withphotos', e.target.checked ? '1' : '0'); } catch {} });
$('exportBtn').addEventListener('click', () => {
  const pts = exportPoints(); if (!pts.length) return;
  const skipped = items.length - pts.length;
  $('expSummary').textContent = `${pts.length} titik akan diekspor` + (skipped ? `. ${skipped} foto tanpa koordinat tidak ikut.` : '.');
  $('exportSheet').hidden = false;
});
$('exportClose').addEventListener('click', () => { $('exportSheet').hidden = true; });
document.querySelectorAll('.fmt').forEach(btn => btn.addEventListener('click', async () => {
  const pts = exportPoints(); if (!pts.length) return;
  if (!window.JSZip) { toast('Pustaka ekspor belum termuat. Periksa koneksi internet lalu coba lagi.'); return; }
  const list = $('exportSheet').querySelector('.fmt-list'); list.classList.add('busy');
  toast('Menyiapkan file…', 20000);
  try {
    const name = $('surveyName').value.trim() || 'Survey lapangan';
    const base = `${slug(name)}-${new Date().toISOString().slice(0, 10)}`;
    const out = await viewerSafe(await EXPORTS[btn.dataset.fmt](pts, name, base, $('withPhotos').checked));
    $('toast').hidden = true;
    const ok = await saveFile(out.file, out.blob, out.open);
    if (ok && !native) toast(`Tersimpan: ${out.file}` + (out.note ? '. ' + out.note : ''), 6000);
  } catch (e) { toast('Ekspor gagal: ' + (e?.message || e)); }
  finally { list.classList.remove('busy'); }
}));

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
/* ---------- exit ---------- */
// A page may close itself only when the system allows it (e.g. the installed app with no page history);
// otherwise show that everything is saved and how to leave.
$('exitBtn').hidden = onClaude;
$('exitBtn').addEventListener('click', async () => {
  clearTimeout(saveT);
  try { if (cur) await put(cur); if (cur?.toGallery && autoSave && !onClaude) await saveToGallery(cur, true); } catch {}
  if (native?.exit) { native.exit(); return; }
  try { window.close(); } catch {}
  setTimeout(() => { if (!document.hidden) $('exitDone').hidden = false; }, 400);
});
$('exitStay').addEventListener('click', () => { $('exitDone').hidden = true; });

window.__clBack = () => { if (!$('mapSheet').hidden) { $('mapSheet').hidden = true; return true; } if (!$('exitDone').hidden) { $('exitDone').hidden = true; return true; } if (!$('exportSheet').hidden) { $('exportSheet').hidden = true; return true; } if ($('sheet').hidden) return false; $('doneBtn').click(); return true; };

getAll().then(all => {
  items = all.sort((a, b) => b.time - a.time); render();
  dbP.then(db => { if (!db) $('hint').textContent = 'Penyimpanan perangkat tidak tersedia di tampilan ini: foto hanya bertahan sampai halaman ditutup. Ekspor sebelum menutup.'; });
});
render();
})();
