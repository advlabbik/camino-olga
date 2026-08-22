/* Vista percorso — mappa vera + POI raggruppati + altimetria interattiva (pattern tg-guida).
   Usa i globali DATA, S, ptAt, dplusBetween definiti in app.js. */
'use strict';

let MAP = null, CURSOR = null, POILAYER = null;
const MAPLAYERS = {};
const SEGNAME = { frances: 'Francese', valcarlos: 'Valcarlos', epilogo_fisterra: 'Epilogo', epilogo_muxia: 'Ramo Muxía', link_fisterra_muxia: 'Costiera' };
const SEGLONG = { frances: 'Cammino Francese', valcarlos: 'Variante Valcarlos', epilogo_fisterra: 'Epilogo per Fisterra', epilogo_muxia: 'Ramo Muxía (da Hospital)', link_fisterra_muxia: 'Costiera Fisterra–Muxía' };
const CATSTYLE = {
  water:    { c: '#1B9AAA', label: '💧 Acqua' },
  sleep:    { c: '#7C4DBE', label: '🛏 Dormire' },
  pharmacy: { c: '#C0392B', label: '💊 Farmacie' },
  food:     { c: '#E07A1F', label: '🍽 Mangiare' },
  shop:     { c: '#8B6B2E', label: '🛒 Negozi' },
  atm:      { c: '#5C6672', label: '🏧 Bancomat' }
};
const CATS_ON = new Set(['water', 'sleep', 'pharmacy']);
const PROF = { seg: 'frances', km: 0 };
const SUFFIX = {};

function bcoInitMap() {
  const holder = document.getElementById('map');
  if (!holder) return;
  if (MAP) { MAP.remove(); MAP = null; POILAYER = null; }
  for (const k of Object.keys(MAPLAYERS)) delete MAPLAYERS[k]; /* niente livelli fantasma dopo re-init o Cancella tutto */
  MAP = L.map('map', { preferCanvas: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors'
  }).addTo(MAP);

  /* tracce */
  const line = (seg, color, dash) => {
    const t = DATA.track[seg]; if (!t) return null;
    const pl = L.polyline(t.points.map(p => [p[0], p[1]]), { color, weight: 3.5, opacity: .92, dashArray: dash });
    pl.bindPopup('<b>' + SEGLONG[seg] + '</b><br>' + t.km_total.toFixed(1) + ' km');
    pl.on('click', () => setSeg(seg));
    return pl;
  };
  const fr = line('frances', '#0F4C97');
  [fr, line('valcarlos', '#0F4C97', '7 7'), line('epilogo_fisterra', '#2E7D4F'),
   line('epilogo_muxia', '#2E7D4F', '7 7'), line('link_fisterra_muxia', '#2E7D4F', '2 7')]
    .filter(Boolean).forEach(l => l.addTo(MAP));
  const b = fr.getBounds().extend(DATA.track.epilogo_fisterra.points.map(p => [p[0], p[1]]));
  MAP.fitBounds(b, { padding: [16, 16], animate: false }); /* animate:false — trappola nota dei README */

  /* località con letti */
  if (DATA.loc) {
    const g = L.layerGroup();
    for (const L2 of DATA.loc) {
      if (!(L2.sl > 0)) continue;
      const m = L.circleMarker([L2.lat, L2.lon], { radius: 8, color: '#0F4C97', weight: 2.5, fillColor: '#fff', fillOpacity: .8 });
      m.bindPopup('<b>' + escMap(L2.name) + '</b><br>' + SEGNAME[L2.seg] + ' · km ' + L2.km.toFixed(1) +
        '<br>🛏 ' + L2.sl + (L2.alb ? ' (albergue ' + L2.alb + ')' : '') +
        (L2.f ? ' · 🍽 ' + L2.f : '') + (L2.s ? ' · 🛒 ' + L2.s : '') +
        (L2.ph ? ' · 💊' : '') + (L2.atm ? ' · 🏧' : '') + (L2.w ? ' · 💧' : '') +
        '<br>📮 qui puoi chiedere il timbro');
      g.addLayer(m);
    }
    MAPLAYERS.loc = g;
  }

  /* timbri famosi */
  if (DATA.sellos) {
    const g = L.layerGroup();
    for (const s of DATA.sellos.famosi) {
      const pt = ptAt(s.seg, s.km);
      const m = L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📮', iconSize: [28, 28], iconAnchor: [14, 14] }) });
      m.bindPopup('<b>' + escMap(s.name) + '</b><br>' + SEGNAME[s.seg] + ' · km ' + s.km.toFixed(1) + '<br>' + escMap(s.note));
      g.addLayer(m);
    }
    MAPLAYERS.sellos = g; g.addTo(MAP);
  }

  /* prenotazioni di Olga (solo dal telefono, mai dal repo) */
  if (S.setup && S.setup.nights) {
    const g = L.layerGroup();
    for (const n of S.setup.nights) {
      if (n.seg == null || n.km == null || !DATA.track[n.seg] || !Number.isFinite(n.km)) continue;
      const pt = ptAt(n.seg, n.km);
      const m = L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📌', iconSize: [28, 28], iconAnchor: [14, 14] }) });
      m.bindPopup('<b>' + escMap(n.name) + '</b><br>' + escMap(n.place) + ' · ' + escMap(n.date) + (n.note ? '<br>' + escMap(n.note) : ''));
      g.addLayer(m);
    }
    MAPLAYERS.bookings = g; g.addTo(MAP);
  }

  /* ultima posizione (reale o simulata) */
  if (S.lastPos && DATA.track[S.lastPos.seg]) {
    const pt = ptAt(S.lastPos.seg, S.lastPos.km);
    const quando = S.lastPos.t ? ' · ' + new Date(S.lastPos.t).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📍', iconSize: [28, 28], iconAnchor: [14, 26] }) })
      .bindPopup('Ultima posizione registrata' + quando).addTo(MAP);
    PROF.seg = S.lastPos.seg; PROF.km = S.lastPos.km;
  }

  /* cursore dell'altimetria sulla mappa */
  CURSOR = L.circleMarker([0, 0], { radius: 9, color: '#DFA00A', weight: 3.5, fillColor: '#fff', fillOpacity: .95 }).addTo(MAP);

  /* POI raggruppati — ricalcolo a ogni zoom/pan */
  MAP.on('zoomend moveend', reclusterPOIs);
  reclusterPOIs();

  buildChips();
  buildSegSel();
  profBind();
  cursorTo(PROF.km, false);
  requestAnimationFrame(profDraw);
}

function escMap(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ===================== POI: raggruppa invece di nascondere (pattern tg-guida) ===================== */
function poiMarker(p) {
  const m = L.circleMarker([p.lat, p.lon], { radius: 7.5, color: '#fff', weight: 2, fillColor: CATSTYLE[p.t].c, fillOpacity: .95 });
  let txt = '<b>' + (p.n ? escMap(p.n) : CATSTYLE[p.t].label.slice(2).trim()) + '</b><br>' + SEGNAME[p.seg] + ' · km ' + Number(p.km).toFixed(1);
  if (p.np) txt += '<br><i>acqua non garantita</i>';
  if (p.alb) txt += '<br>albergue';
  m.bindPopup(txt);
  return m;
}
function clusterMarker(arr) {
  const cnt = {}; arr.forEach(p => { cnt[p.t] = (cnt[p.t] || 0) + 1; });
  const cats = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
  const color = cats.length === 1 ? CATSTYLE[cats[0]].c : '#0F4C97';
  const n = arr.length;
  const size = n >= 60 ? 44 : n >= 20 ? 38 : n >= 6 ? 33 : 28;
  const lat = arr.reduce((a, p) => a + p.lat, 0) / n, lon = arr.reduce((a, p) => a + p.lon, 0) / n;
  const m = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'clu', html: '<span style="background:' + color + ';width:' + size + 'px;height:' + size + 'px;line-height:' + (size - 4) + 'px">' + n + '</span>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
  });
  const det = cats.map(c => CATSTYLE[c].label.split(' ')[0] + ' ' + cnt[c]).join(' · ');
  m.bindTooltip(det, { direction: 'top' });
  m.on('click', () => MAP.setView([lat, lon], Math.min(17, MAP.getZoom() + 2)));
  return m;
}
function reclusterPOIs() {
  if (!DATA.pois || !MAP) return;
  if (!POILAYER) POILAYER = L.layerGroup().addTo(MAP);
  POILAYER.clearLayers();
  const z = MAP.getZoom();
  const bounds = MAP.getBounds().pad(0.25);
  const pts = DATA.pois.filter(p => CATS_ON.has(p.t) && bounds.contains([p.lat, p.lon]));
  let signs = 0;
  if (z >= 15) {
    for (const p of pts) POILAYER.addLayer(poiMarker(p));
    signs = pts.length;
  } else {
    const cell = 54;
    const buckets = new Map();
    for (const p of pts) {
      const c = MAP.latLngToContainerPoint([p.lat, p.lon]);
      const key = Math.floor(c.x / cell) + '_' + Math.floor(c.y / cell);
      let arr = buckets.get(key); if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(p);
    }
    for (const arr of buckets.values()) {
      signs++;
      POILAYER.addLayer(arr.length === 1 ? poiMarker(arr[0]) : clusterMarker(arr));
    }
  }
  const out = document.getElementById('poiCount');
  if (out) out.textContent = pts.length ? pts.length + ' punti in vista, in ' + signs + ' segni — tocca un gruppo per avvicinarti' : 'nessun punto delle categorie accese in questa vista';
}

function buildChips() {
  const bar = document.getElementById('mapChips'); if (!bar) return;
  bar.innerHTML = '';
  for (const k of Object.keys(CATSTYLE)) {
    const c = document.createElement('button');
    c.className = 'chip' + (CATS_ON.has(k) ? ' on' : '');
    c.textContent = CATSTYLE[k].label;
    c.onclick = () => {
      if (CATS_ON.has(k)) { CATS_ON.delete(k); c.classList.remove('on'); }
      else { CATS_ON.add(k); c.classList.add('on'); }
      reclusterPOIs(); profDraw();
    };
    bar.append(c);
  }
  for (const [key, label] of [['loc', '🏘 Località con letti'], ['sellos', '\u{1F4EE} Timbri famosi'], ['bookings', '📌 Prenotazioni']]) {
    if (!MAPLAYERS[key]) continue;
    const c = document.createElement('button');
    c.className = 'chip' + (MAP.hasLayer(MAPLAYERS[key]) ? ' on' : '');
    c.textContent = label;
    c.onclick = () => {
      if (MAP.hasLayer(MAPLAYERS[key])) { MAP.removeLayer(MAPLAYERS[key]); c.classList.remove('on'); }
      else { MAPLAYERS[key].addTo(MAP); c.classList.add('on'); }
      profDraw();
    };
    bar.append(c);
  }
}

/* ===================== altimetria ===================== */
function buildSegSel() {
  const bar = document.getElementById('segSel'); if (!bar) return;
  bar.innerHTML = '';
  for (const seg of Object.keys(SEGNAME)) {
    if (!DATA.track[seg]) continue;
    const c = document.createElement('button');
    c.className = 'chip' + (seg === PROF.seg ? ' on' : '');
    c.dataset.seg = seg;
    c.textContent = SEGNAME[seg] + ' · ' + DATA.track[seg].km_total.toFixed(0) + ' km';
    c.onclick = () => setSeg(seg);
    bar.append(c);
  }
}
function setSeg(seg) {
  PROF.seg = seg; PROF.km = Math.min(PROF.km, DATA.track[seg].km_total);
  document.querySelectorAll('#segSel .chip').forEach(x => x.classList.toggle('on', x.dataset.seg === seg));
  cursorTo(Math.min(PROF.km, DATA.track[seg].km_total), false);
  profDraw();
}
function suffixDplus(seg) {
  if (SUFFIX[seg]) return SUFFIX[seg];
  const pts = DATA.track[seg].points, n = pts.length, out = new Float64Array(n);
  for (let i = n - 2; i >= 0; i--) {
    const d = (pts[i + 1][2] || 0) - (pts[i][2] || 0);
    out[i] = out[i + 1] + (d > 0 ? d : 0);
  }
  SUFFIX[seg] = out; return out;
}
function idxAtKm(seg, km) {
  const cums = DATA.track[seg].cum_km;
  let lo = 0, hi = cums.length - 1;
  while (hi - lo > 1) { const m = (hi + lo) >> 1; if (cums[m] <= km) lo = m; else hi = m; }
  return lo;
}
function cursorTo(km, pan) {
  const t = DATA.track[PROF.seg];
  PROF.km = Math.max(0, Math.min(km, t.km_total));
  const pt = ptAt(PROF.seg, PROF.km);
  if (CURSOR) {
    CURSOR.setLatLng([pt[0], pt[1]]);
    if (pan && MAP && !MAP.getBounds().contains([pt[0], pt[1]])) MAP.panTo([pt[0], pt[1]], { animate: false });
  }
  const left = t.km_total - PROF.km;
  const dp = Math.round(suffixDplus(PROF.seg)[idxAtKm(PROF.seg, PROF.km)]);
  const out = document.getElementById('profOut');
  if (out) out.innerHTML = '<b>km ' + PROF.km.toFixed(1) + '</b> · quota ' + Math.round(pt[2] || 0) + ' m · alla fine del segmento <b>' + left.toFixed(1) + ' km</b> e <b>+' + dp + ' m</b>';
}
function profBind() {
  const cv = document.getElementById('prof'); if (!cv) return;
  let dragging = false;
  const toKm = ev => {
    const r = cv.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    return Math.max(0, Math.min(1, x / r.width)) * DATA.track[PROF.seg].km_total;
  };
  const move = ev => { if (!dragging) return; ev.preventDefault(); cursorTo(toKm(ev), true); profDraw(); };
  cv.addEventListener('pointerdown', ev => { dragging = true; cv.setPointerCapture(ev.pointerId); cursorTo(toKm(ev), true); profDraw(); });
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointercancel', () => { dragging = false; });
  if (window.ResizeObserver) {
    if (PROF.ro) PROF.ro.disconnect();
    PROF.ro = new ResizeObserver(() => requestAnimationFrame(profDraw));
    PROF.ro.observe(cv);
  }
  if (!window.__bcoProfResize) { window.__bcoProfResize = true; window.addEventListener('resize', () => requestAnimationFrame(profDraw)); }
}
function profDraw() {
  const cv = document.getElementById('prof'); if (!cv || !DATA.track[PROF.seg]) return;
  const rect = cv.getBoundingClientRect();
  if (rect.width < 20) { requestAnimationFrame(profDraw); return; } /* vista non ancora impaginata */
  const dpr = window.devicePixelRatio || 1;
  const W = rect.width, H = rect.height;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  g.clearRect(0, 0, W, H);
  const t = DATA.track[PROF.seg], pts = t.points, cums = t.cum_km, kmT = t.km_total;
  let eMin = Infinity, eMax = -Infinity;
  for (const p of pts) { const e = p[2] || 0; if (e < eMin) eMin = e; if (e > eMax) eMax = e; }
  const pad = (eMax - eMin) * 0.12 + 10; eMin -= pad * 0.4; eMax += pad;
  const X = km => km / kmT * W, Y = e => H - 16 - (e - eMin) / (eMax - eMin) * (H - 30);
  g.strokeStyle = dark ? 'rgba(255,255,255,.09)' : 'rgba(35,43,54,.09)'; g.lineWidth = 1;
  g.beginPath();
  const step = kmT > 400 ? 100 : kmT > 100 ? 25 : 5;
  for (let k = step; k < kmT; k += step) { g.moveTo(X(k), 0); g.lineTo(X(k), H - 14); }
  g.stroke();
  g.fillStyle = dark ? 'rgba(233,229,219,.6)' : 'rgba(35,43,54,.6)';
  g.font = '11px system-ui, sans-serif';
  for (let k = step; k < kmT; k += step) g.fillText(k, X(k) + 2, H - 4);
  const stride = Math.max(1, Math.floor(pts.length / (W * 1.5)));
  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, dark ? 'rgba(127,169,224,.45)' : 'rgba(15,76,151,.30)');
  fill.addColorStop(1, dark ? 'rgba(127,169,224,.06)' : 'rgba(15,76,151,.04)');
  g.beginPath(); g.moveTo(0, Y(pts[0][2] || 0));
  for (let i = stride; i < pts.length; i += stride) g.lineTo(X(cums[i]), Y(pts[i][2] || 0));
  g.lineTo(X(kmT), Y(pts[pts.length - 1][2] || 0));
  g.save(); g.lineTo(X(kmT), H - 14); g.lineTo(0, H - 14); g.closePath(); g.fillStyle = fill; g.fill(); g.restore();
  g.beginPath(); g.moveTo(0, Y(pts[0][2] || 0));
  for (let i = stride; i < pts.length; i += stride) g.lineTo(X(cums[i]), Y(pts[i][2] || 0));
  g.strokeStyle = dark ? '#7FA9E0' : '#0F4C97'; g.lineWidth = 2.2; g.stroke();
  /* POI sul profilo — solo categorie accese */
  if (DATA.pois) {
    for (const cat of CATS_ON) {
      g.fillStyle = CATSTYLE[cat].c;
      for (const p of DATA.pois) {
        if (p.t !== cat || p.seg !== PROF.seg) continue;
        const e = ptAt(PROF.seg, p.km)[2] || 0;
        g.beginPath(); g.arc(X(p.km), Y(e) - 6, 3, 0, 7); g.fill();
      }
    }
  }
  /* timbri sul profilo */
  if (DATA.sellos && MAPLAYERS.sellos && MAP && MAP.hasLayer(MAPLAYERS.sellos)) {
    g.font = '12px system-ui, sans-serif';
    for (const s of DATA.sellos.famosi) {
      if (s.seg !== PROF.seg) continue;
      g.fillText('📮', X(s.km) - 6, Y(ptAt(PROF.seg, s.km)[2] || 0) - 10);
    }
  }
  const cx = X(PROF.km);
  g.strokeStyle = '#DFA00A'; g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(cx, 4); g.lineTo(cx, H - 14); g.stroke();
  g.fillStyle = '#DFA00A'; g.beginPath(); g.arc(cx, Y(ptAt(PROF.seg, PROF.km)[2] || 0), 5, 0, 7); g.fill();
}
window.bcoProfDraw = profDraw;
