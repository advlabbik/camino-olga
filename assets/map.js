/* Mappa per studiare il percorso — Leaflet locale, POI a livelli.
   Usa i globali DATA e S definiti in app.js. */
'use strict';

let MAP = null;
const MAPLAYERS = {};
const SEGNAME = { frances: 'Cammino Francese', valcarlos: 'Variante Valcarlos', epilogo_fisterra: 'Epilogo per Fisterra', epilogo_muxia: 'Ramo Muxía', link_fisterra_muxia: 'Costiera Fisterra–Muxía' };
const CATSTYLE = {
  water:    { c: '#1B9AAA', label: '💧 Acqua', on: true },
  sleep:    { c: '#7C4DBE', label: '🛏 Dormire', on: true },
  pharmacy: { c: '#C0392B', label: '💊 Farmacie', on: true },
  food:     { c: '#E07A1F', label: '🍽 Mangiare', on: false },
  shop:     { c: '#8B6B2E', label: '🛒 Negozi', on: false },
  atm:      { c: '#5C6672', label: '🏧 Bancomat', on: false }
};

function bcoInitMap() {
  const holder = document.getElementById('map');
  if (!holder) return;
  if (MAP) { MAP.remove(); MAP = null; }
  MAP = L.map('map', { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(MAP);

  /* tracce */
  const line = (seg, color, dash) => {
    const t = DATA.track[seg]; if (!t) return null;
    const pl = L.polyline(t.points.map(p => [p[0], p[1]]), { color, weight: 3, opacity: .9, dashArray: dash });
    pl.bindPopup('<b>' + SEGNAME[seg] + '</b><br>' + t.km_total.toFixed(1) + ' km');
    return pl;
  };
  const fr = line('frances', '#0F4C97');
  [fr, line('valcarlos', '#0F4C97', '6 6'), line('epilogo_fisterra', '#2E7D4F'),
   line('epilogo_muxia', '#2E7D4F', '6 6'), line('link_fisterra_muxia', '#2E7D4F', '2 6')]
    .filter(Boolean).forEach(l => l.addTo(MAP));
  const b = fr.getBounds().extend(DATA.track.epilogo_fisterra.points.map(p => [p[0], p[1]]));
  MAP.fitBounds(b, { padding: [16, 16] });

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
      const m = L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '🛏', iconSize: [24, 24], iconAnchor: [12, 12] }) });
      m.bindPopup('<b>' + escMap(n.name) + '</b><br>' + escMap(n.place) + ' · ' + escMap(n.date) + (n.note ? '<br>' + escMap(n.note) : ''));
      g.addLayer(m);
    }
    MAPLAYERS.bookings = g; g.addTo(MAP);
  }

  /* posizione (reale o simulata) */
  if (S.lastPos) {
    const pt = ptAt(S.lastPos.seg, S.lastPos.km);
    L.marker([pt[0], pt[1]], { icon: L.divIcon({ className: 'sello-ico', html: '📍', iconSize: [26, 26], iconAnchor: [13, 24] }) })
      .bindPopup('Ultima posizione registrata').addTo(MAP);
  }

  buildChips();
}

function escMap(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildChips() {
  const bar = document.getElementById('mapChips'); if (!bar) return;
  bar.innerHTML = '';
  const defs = Object.keys(CATSTYLE).map(k => [k, CATSTYLE[k].label, CATSTYLE[k].on])
    .concat([['loc', '🏘 Località con letti', false], ['sellos', '📮 Timbri', true], ['bookings', '📌 Prenotazioni', true]]);
  for (const [key, label, on] of defs) {
    if (!MAPLAYERS[key]) continue;
    const c = document.createElement('button');
    c.className = 'chip' + ((on || MAP.hasLayer(MAPLAYERS[key])) ? ' on' : '');
    c.textContent = label;
    c.onclick = () => {
      if (MAP.hasLayer(MAPLAYERS[key])) { MAP.removeLayer(MAPLAYERS[key]); c.classList.remove('on'); }
      else { MAPLAYERS[key].addTo(MAP); c.classList.add('on'); }
    };
    bar.append(c);
  }
}
