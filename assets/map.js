/* Vista percorso — mappa vera + POI + altimetria interattiva (pattern tg-guida).
   Usa i globali DATA, S, ptAt, dplusBetween definiti in app.js. */
'use strict';

let MAP = null, CURSOR = null;
const MAPLAYERS = {};
const SEGNAME = { frances: 'Francese', valcarlos: 'Valcarlos', epilogo_fisterra: 'Epilogo', epilogo_muxia: 'Ramo Muxía', link_fisterra_muxia: 'Costiera' };
const SEGLONG = { frances: 'Cammino Francese', valcarlos: 'Variante Valcarlos', epilogo_fisterra: 'Epilogo per Fisterra', epilogo_muxia: 'Ramo Muxía (da Hospital)', link_fisterra_muxia: 'Costiera Fisterra–Muxía' };
const CATSTYLE = {
  water:    { c: '#1B9AAA', label: '💧 Acqua', on: true },
  sleep:    { c: '#7C4DBE', label: '🛏 Dormire', on: true },
  pharmacy: { c: '#C0392B', label: '💊 Farmacie', on: true },
  food:     { c: '#E07A1F', label: '🍽 Mangiare', on: false },
  shop:     { c: '#8B6B2E', label: '🛒 Negozi', on: false },
  atm:      { c: '#5C6672', label: '🏧 Bancomat', on: false }
};
const PROF = { seg: 'frances', km: 0 };
const SUFFIX = {}; /* D+ residuo precalcolato per segmento */

function bcoInitMap() {
  const holder = document.getElementById('map');
  if (!holder) return;
  if (MAP) { MAP.remove(); MAP = null; }
  MAP = L.map('map', { preferCanvas: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors'
  }).addTo(MAP);

  /* tracce */
  const line = (seg, color, dash) => {
    const t = DATA.track[seg]; if (!t) return null;
    const pl = L.polyline(t.points.map(p => [p[0], p[1]]), { color, weight: 3, opacity: .92, dashArray: dash });
    pl.bindPopup('<b>' + SEGLONG[seg] + '</b><br>' + t.km_total.toFixed(1) + ' km');
    pl.on('click', () => setSeg(seg));
    return pl;
  };
  const fr = line('frances', '#0F4C97');
  [fr, line('valcarlos', '#0F4C97', '6 6'), line('epilogo_fisterra', '#2E7D4F'),
   line('epilogo_muxia', '#2E7D4F', '6 6'), line('link_fisterra_muxia', '#2E7D4F', '2 6')]
    .filter(Boolean).forEach(l => l.addTo(MAP));
  const b = fr.getBounds().extend(DATA.track.epilogo_fisterra.points.map(p => [p[0], p[1]]));
  MAP.fitBounds(b, { padding: [16, 16], animate: false }); /* animate:false — trappola nota dei README */

  const popKm = p => SEGNAME[p.seg] + ' · km ' + Number(p.km).toFixed(1);

  /* POI per categoria */
  if (DATA.pois) {
    for (const cat of Object.keys(CATSTYLE)) {
      const g = L.layerGroup();
      for (const p of DATA.pois) {
        if (p.t !== cat) continue;
        const m = L.circleMarker([p.lat, p.lon], { radius: 5, color: '#fff', weight: 1, fillColor: CATSTYLE[cat].c, fillOpacity: .92 });
        let txt = '<b>' + (p.n ? escMap(p.n) : CATSTYLE[cat].label.slice(2).trim()) + '</b><br>' + popKm(p);
        if (p.np) txt += '<br><i>acqua non garantita</i>';
        if (p.alb) txt += '<br>albergue';
        m.bindPopup(txt);
        g.addLayer(m);
      }
      MAPLAYERS[cat] = g;
      if (CATSTYLE[cat].on) g.addTo(MAP);
    }
  }

  /* località con letti */
  if (DATA.loc) {
    const g = L.layerGroup();
    for (const L2 of DATA.loc) {
      if (!(L2.sl > 0)) continue;
      const m = L.circleMarker([L2.lat, L2.lon], { radius: 7, color: '#0F4C97', weight: 2, fillColor: '#fff', fillOpacity: .7 });
      m.bindPopup('<b>' + escMap(L2.name) + '</b><br>' + popKm(L2) +
        '<br>🛏 ' + L2.sl + (L2.alb ? ' (albergue ' + L2.alb + ')' : '') +
        (L2.f ? ' · 🍽 ' + L2.f : '') + (L2.s ? ' · 🛒 ' + L2.s : '') +
        (L2.ph ? ' · 💊' : '') + (L2.atm ? ' · 🏧' : '') + (L2.w ? ' · 💧' : ''));
      g.addLayer(m);
    }
    MAPLAYERS.loc = g;
  }

  /* timbri famosi */
  if (DATA.sellos) {
    const g = L.layerGroup();
    for (const s of DATA.sellos.famosi) {
      const pt = ptAt(s.seg, s.km);
      const m = L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📮', iconSize: [24, 24], iconAnchor: [12, 12] }) });
      m.bindPopup('<b>' + escMap(s.name) + '</b><br>' + popKm(s) + '<br>' + escMap(s.note));
      g.addLayer(m);
    }
    MAPLAYERS.sellos = g; g.addTo(MAP);
  }

  /* prenotazioni di Olga (solo dal telefono, mai dal repo) */
  if (S.setup && S.setup.nights) {
    const g = L.layerGroup();
    for (const n of S.setup.nights) {
      if (n.seg == null || n.km == null) continue;
      const pt = ptAt(n.seg, n.km);
      const m = L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📌', iconSize: [24, 24], iconAnchor: [12, 12] }) });
      m.bindPopup('<b>' + escMap(n.name) + '</b><br>' + escMap(n.place) + ' · ' + escMap(n.date) + (n.note ? '<br>' + escMap(n.note) : ''));
      g.addLayer(m);
    }
    MAPLAYERS.bookings = g; g.addTo(MAP);
  }

  /* ultima posizione (reale o simulata) */
  if (S.lastPos) {
    const pt = ptAt(S.lastPos.seg, S.lastPos.km);
    L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📍', iconSize: [26, 26], iconAnchor: [13, 24] }) })
      .bindPopup('Ultima posizione registrata').addTo(MAP);
    PROF.seg = S.lastPos.seg; PROF.km = S.lastPos.km;
  }

  /* cursore dell'altimetria sulla mappa */
  CURSOR = L.circleMarker([0, 0], { radius: 8, color: '#DFA00A', weight: 3, fillColor: '#fff', fillOpacity: .95 }).addTo(MAP);

  buildChips();
  buildSegSel();
  profBind();
  cursorTo(PROF.km, false);
  requestAnimationFrame(profDraw);
}

function escMap(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildChips() {
  const bar = document.getElementById('mapChips'); if (!bar) return;
  bar.innerHTML = '';
  const defs = Object.keys(CATSTYLE).map(k => [k, CATSTYLE[k].label])
    .concat([['loc', '🏘 Località con letti'], ['sellos', '📮 Timbri'], ['bookings', '📌 Prenotazioni']]);
  for (const [key, label] of defs) {
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
  window.addEventListener('resize', () => requestAnimationFrame(profDraw));
}
function profDraw() {
  const cv = document.getElementById('prof'); if (!cv || !DATA.track[PROF.seg]) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  g.clearRect(0, 0, W, H);
  const t = DATA.track[PROF.seg], pts = t.points, cums = t.cum_km, kmT = t.km_total;
  let eMin = Infinity, eMax = -Infinity;
  for (const p of pts) { const e = p[2] || 0; if (e < eMin) eMin = e; if (e > eMax) eMax = e; }
  const pad = (eMax - eMin) * 0.12 + 10; eMin -= pad * 0.4; eMax += pad;
  const X = km => km / kmT * W, Y = e => H - 16 - (e - eMin) / (eMax - eMin) * (H - 30);
  /* griglia leggera */
  g.strokeStyle = dark ? 'rgba(255,255,255,.09)' : 'rgba(35,43,54,.09)'; g.lineWidth = 1;
  g.beginPath();
  const step = kmT > 400 ? 100 : kmT > 100 ? 25 : 5;
  for (let k = step; k < kmT; k += step) { g.moveTo(X(k), 0); g.lineTo(X(k), H - 14); }
  g.stroke();
  g.fillStyle = dark ? 'rgba(233,229,219,.55)' : 'rgba(35,43,54,.55)';
  g.font = '10px system-ui, sans-serif';
  for (let k = step; k < kmT; k += step) g.fillText(k, X(k) + 2, H - 4);
  /* area + linea */
  const stride = Math.max(1, Math.floor(pts.length / (W * 1.5)));
  g.beginPath(); g.moveTo(0, Y(pts[0][2] || 0));
  for (let i = stride; i < pts.length; i += stride) g.lineTo(X(cums[i]), Y(pts[i][2] || 0));
  g.lineTo(X(kmT), Y(pts[pts.length - 1][2] || 0));
  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, dark ? 'rgba(127,169,224,.45)' : 'rgba(15,76,151,.30)');
  fill.addColorStop(1, dark ? 'rgba(127,169,224,.06)' : 'rgba(15,76,151,.04)');
  g.save(); g.lineTo(X(kmT), H - 14); g.lineTo(0, H - 14); g.closePath(); g.fillStyle = fill; g.fill(); g.restore();
  g.beginPath(); g.moveTo(0, Y(pts[0][2] || 0));
  for (let i = stride; i < pts.length; i += stride) g.lineTo(X(cums[i]), Y(pts[i][2] || 0));
  g.strokeStyle = dark ? '#7FA9E0' : '#0F4C97'; g.lineWidth = 2; g.stroke();
  /* POI sul profilo, alla loro quota — solo le categorie accese */
  if (DATA.pois) {
    for (const cat of Object.keys(CATSTYLE)) {
      if (!MAPLAYERS[cat] || !MAP.hasLayer(MAPLAYERS[cat])) continue;
      g.fillStyle = CATSTYLE[cat].c;
      for (const p of DATA.pois) {
        if (p.t !== cat || p.seg !== PROF.seg) continue;
        const e = ptAt(PROF.seg, p.km)[2] || 0;
        g.beginPath(); g.arc(X(p.km), Y(e) - 5, 2.6, 0, 7); g.fill();
      }
    }
  }
  /* timbri sul profilo */
  if (DATA.sellos && MAPLAYERS.sellos && MAP.hasLayer(MAPLAYERS.sellos)) {
    g.font = '11px system-ui, sans-serif';
    for (const s of DATA.sellos.famosi) {
      if (s.seg !== PROF.seg) continue;
      g.fillText('📮', X(s.km) - 5, Y(ptAt(PROF.seg, s.km)[2] || 0) - 8);
    }
  }
  /* cursore */
  const cx = X(PROF.km);
  g.strokeStyle = '#DFA00A'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, 4); g.lineTo(cx, H - 14); g.stroke();
  g.fillStyle = '#DFA00A'; g.beginPath(); g.arc(cx, Y(ptAt(PROF.seg, PROF.km)[2] || 0), 4.5, 0, 7); g.fill();
}
window.bcoProfDraw = profDraw;
