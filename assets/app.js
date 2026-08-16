/* Buen Camino, Olga — app v1
   Dati personali SOLO in localStorage (mai nel repo). Meteo: Open-Meteo. */
'use strict';

/* ===================== stato e dati ===================== */
const DATA = { track: null, pois: null, loc: null, alerts: [], phrases: null, sellos: null, status: null };
const LS_KEY = 'bco_v1';
let S = { setup: null, days: [], milestonesFired: [], phrasesUsed: {}, lastWeather: null, lastPos: null };

function loadState() {
  try { const raw = localStorage.getItem(LS_KEY); if (raw) S = Object.assign(S, JSON.parse(raw)); } catch (e) {}
}
function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

async function loadData() {
  const get = async (p, optional) => {
    try { const r = await fetch(p); if (!r.ok) throw 0; return await r.json(); }
    catch (e) { if (optional) return null; throw new Error('Impossibile caricare ' + p); }
  };
  /* in parallelo: su rete lenta ogni fetch sequenziale sarebbe un'attesa in più */
  const [track, phrases, alerts, sellos, pj, lj, status] = await Promise.all([
    get('data/track.json'), get('data/phrases.json'), get('data/alerts.json', true),
    get('data/sellos.json', true), get('data/pois.json', true), get('data/localities.json', true),
    get('data/status.json', true)
  ]);
  DATA.track = track; DATA.phrases = phrases; DATA.alerts = alerts || []; DATA.sellos = sellos;
  DATA.pois = pj ? (Array.isArray(pj) ? pj : pj.pois) : null;
  DATA.loc = lj ? (Array.isArray(lj) ? lj : lj.localities) : null;
  if (!Array.isArray(DATA.pois)) DATA.pois = null;
  if (!Array.isArray(DATA.loc)) DATA.loc = null;
  DATA.status = status;
}

/* ===================== tempo e posizione (con override di test) ===================== */
const QS = new URLSearchParams(location.search);
function now() { const o = QS.get('now'); return o ? new Date(o) : new Date(); }
function todayStr(d) { d = d || now(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function getPosition() {
  const o = QS.get('pos');
  if (o) { const [la, lo] = o.split(',').map(Number); return Promise.resolve({ lat: la, lon: lo, sim: true }); }
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('GPS non disponibile su questo dispositivo'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => rej(new Error('Non riesco a leggere la posizione. Controlla che il GPS sia attivo e che il browser abbia il permesso.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });
}

/* ===================== geometria ===================== */
const R = 6371000;
function hav(a, b) {
  const p = Math.PI / 180, la1 = a[0] * p, la2 = b[0] * p, dla = (b[0] - a[0]) * p, dlo = (b[1] - a[1]) * p;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* proiezione punto→segmento in coordinate locali piatte (ok per tratte brevi) */
function snapSeg(segName, lat, lon) {
  const seg = DATA.track[segName]; if (!seg) return null;
  const pts = seg.points, cums = seg.cum_km;
  const cosLat = Math.cos(lat * Math.PI / 180), kx = 111320 * cosLat, ky = 110574;
  let best = { d2: Infinity, km: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
    const bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy, d2 = px * px + py * py;
    if (d2 < best.d2) best = { d2, km: cums[i] + (cums[i + 1] - cums[i]) * t };
  }
  return { seg: segName, km: best.km, dist: Math.sqrt(best.d2) };
}
function snap(lat, lon) {
  const names = ['frances', 'valcarlos', 'epilogo_fisterra', 'epilogo_muxia', 'link_fisterra_muxia'];
  let best = null;
  for (const n of names) {
    const s = snapSeg(n, lat, lon);
    if (s && (!best || s.dist < best.dist)) best = s;
  }
  /* il Francese vince sulla Valcarlos a parità (condividono i capi) */
  if (best && best.seg === 'valcarlos') {
    const f = snapSeg('frances', lat, lon);
    if (f && f.dist < best.dist + 60) best = f;
  }
  return best;
}
function ptAt(segName, km) {
  const seg = DATA.track[segName], cums = seg.cum_km, pts = seg.points;
  if (km <= 0) return pts[0]; if (km >= seg.km_total) return pts[pts.length - 1];
  let lo = 0, hi = cums.length - 1;
  while (hi - lo > 1) { const m = (hi + lo) >> 1; if (cums[m] <= km) lo = m; else hi = m; }
  const t = (km - cums[lo]) / (cums[hi] - cums[lo] || 1);
  const a = pts[lo], b = pts[hi];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t];
}
function dplusBetween(segName, km0, km1) {
  const seg = DATA.track[segName]; let dp = 0;
  const cums = seg.cum_km, pts = seg.points;
  for (let i = 0; i < pts.length - 1; i++) {
    if (cums[i + 1] < km0 || cums[i] > km1) continue;
    const d = (pts[i + 1][2] || 0) - (pts[i][2] || 0);
    if (d > 0) dp += d;
  }
  return Math.round(dp);
}
const FR_LEN = () => DATA.track.frances.km_total;
const EP_LEN = () => DATA.track.epilogo_fisterra.km_total;
let FR_RONCES = 23.2; /* ricalcolato al boot con snap */

function kmToSantiago(seg, km) {
  if (seg === 'frances') return Math.max(0, FR_LEN() - km);
  if (seg === 'valcarlos') return (DATA.track.valcarlos.km_total - km) + (FR_LEN() - FR_RONCES);
  return 0;
}
function kmToFisterra(seg, km) {
  if (seg === 'epilogo_fisterra') return Math.max(0, EP_LEN() - km);
  /* sui rami di Muxía "l'oceano" è il capo di Muxía: residuo del ramo, non zero */
  if (seg === 'epilogo_muxia' || seg === 'link_fisterra_muxia') return Math.max(0, DATA.track[seg].km_total - km);
  return kmToSantiago(seg, km) + EP_LEN();
}
const MUXIA_FORK = 60.0; /* bivio di Hospital sul km dell'Epilogo */
function walkedBetween(s0, k0, s1, k1) {
  if (s0 === s1) return Math.max(0, k1 - k0);
  const M = {
    'valcarlos>frances': (DATA.track.valcarlos.km_total - k0) + Math.max(0, k1 - FR_RONCES),
    'frances>epilogo_fisterra': Math.max(0, FR_LEN() - k0) + k1,
    'epilogo_fisterra>epilogo_muxia': Math.max(0, MUXIA_FORK - k0) + k1,
    'epilogo_fisterra>link_fisterra_muxia': Math.max(0, 85.2 - k0) + k1
  };
  const v = M[s0 + '>' + s1];
  return v != null ? Math.max(0, v) : 0;
}

/* ===================== passo e proiezioni ===================== */
function median(arr) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function paceKmh() {
  const v = S.days.filter(d => d.end && d.start && d.km > 3)
    .map(d => d.km / Math.max(0.5, (new Date(d.end.t) - new Date(d.start.t)) / 3600000)).slice(-6);
  const m = median(v);
  if (m) return Math.min(5.5, Math.max(2.2, m));
  /* nessuna tappa CHIUSA ancora = giorno 1 in salita: prudente (il giorno di oggi può già essere in S.days) */
  return S.days.filter(d => d.end).length === 0 ? 3.0 : 3.5;
}
function dailyKmMedian() { const v = S.days.filter(d => d.km > 3).map(d => d.km).slice(-8); return median(v) || 21; }
function fmtDate(d) { return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }); }
function projezione(kmLeft) {
  const daily = dailyKmMedian();
  const dMin = Math.max(1, Math.ceil(kmLeft / (daily * 1.12)));
  const dMax = Math.max(dMin, Math.ceil(kmLeft / (daily * 0.85)));
  const a = now(); const d1 = new Date(a); d1.setDate(d1.getDate() + dMin);
  const d2 = new Date(a); d2.setDate(d2.getDate() + dMax);
  return { daily, dMin, dMax, from: d1, to: d2 };
}

/* ===================== meteo ===================== */
const WMO = c => c === 0 ? '☀️' : c <= 2 ? '🌤' : c === 3 ? '☁️' : c <= 48 ? '🌫' : c <= 57 ? '🌦' : c <= 67 ? '🌧' : c <= 77 ? '🌨' : c <= 82 ? '🌧' : '⛈';
async function fetchWeather(samples) {
  const las = samples.map(s => s.lat.toFixed(4)).join(','), los = samples.map(s => s.lon.toFixed(4)).join(',');
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + las + '&longitude=' + los +
    '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=sunrise,sunset&forecast_days=2&timezone=Europe%2FMadrid';
  const r = await fetch(url); if (!r.ok) throw new Error('meteo non raggiungibile');
  let j = await r.json(); if (!Array.isArray(j)) j = [j];
  /* H.time è in ORA LOCALE di Madrid (timezone della richiesta): la chiave va costruita
     nello stesso fuso, MAI in UTC — altrimenti tutto il meteo slitta di 2 ore (bug trovato
     dalla revisione multi-agente) */
  const fmtMadrid = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const out = samples.map((s, i) => {
    const loc = j[Math.min(i, j.length - 1)], H = loc.hourly;
    const key = fmtMadrid.format(s.eta).replace(' ', 'T') + ':00';
    let idx = H.time.indexOf(key);
    if (idx < 0) idx = Math.min(H.time.length - 1, Math.max(0, Math.round((s.eta - new Date(H.time[0])) / 3600000)));
    return { ...s, temp: Math.round(H.temperature_2m[idx]), prob: H.precipitation_probability[idx] == null ? 0 : H.precipitation_probability[idx], code: H.weather_code[idx], wind: Math.round(H.wind_speed_10m[idx]) };
  });
  const d0 = j[0].daily;
  return { rows: out, sunrise: d0.sunrise[0].slice(11, 16), sunset: d0.sunset[0].slice(11, 16), sunsetDate: new Date(d0.sunset[0]) };
}
function buildSamples(seg, km, pace, targetKm) {
  const end = targetKm != null ? targetKm : Math.min(km + 26, DATA.track[seg].km_total);
  const rows = []; const t0 = now();
  for (let k = km; k <= end + 0.01; k += Math.max(4.5, (end - km) / 5)) {
    const kk = Math.min(k, end); const p = ptAt(seg, kk);
    const eta = new Date(t0.getTime() + (kk - km) / pace * 3600000);
    rows.push({ lat: p[0], lon: p[1], km: kk, eta, label: nearLocName(seg, kk) });
    if (kk >= end) break;
  }
  return rows;
}
function nearLocName(seg, km) {
  if (!DATA.loc) return 'km ' + km.toFixed(0);
  let best = null;
  for (const L of DATA.loc) { if (L.seg !== seg) continue; const d = Math.abs(L.km - km); if (d < 2.2 && (!best || d < best.d)) best = { d, n: L.name }; }
  return best ? best.n : 'km ' + km.toFixed(0);
}

/* ===================== frasi ===================== */
function fillPhrase(t) {
  const nome = (S.setup && S.setup.profile && S.setup.profile.name) || 'pellegrina';
  const kmTot = Math.round(S.days.reduce((a, d) => a + (d.km || 0), 0));
  /* numero del giorno = giorni PRIMA di oggi + 1 (regge sia prima sia dopo il push di oggi) */
  const giorno = Math.max(1, S.days.filter(d => d.date < todayStr()).length + 1);
  return t.replace('{nome}', nome).replace('{giorno}', String(giorno)).replace('{km}', String(kmTot));
}
function pickPhrase(reg) {
  const pool = (DATA.phrases[reg] || []).map((t, i) => reg + ':' + i);
  const used = S.phrasesUsed;
  const fresh = pool.filter(id => !used[id] || (Date.now() - used[id]) > 7 * 86400000);
  const id = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh.length : pool.length))];
  used[id] = Date.now(); saveState();
  return fillPhrase(DATA.phrases[reg][Number(id.split(':')[1])]);
}
function milestoneHit(seg, km) {
  let hit = null;
  for (const m of DATA.phrases.milestones) {
    if (m.seg !== seg || km < m.km || S.milestonesFired.includes(m.id)) continue;
    S.milestonesFired.push(m.id);
    /* festeggia solo se appena attraversata; se è già alle spalle, archivia in silenzio */
    if (!hit && km <= m.km + 3.5) hit = fillPhrase(m.text);
  }
  if (hit) saveState();
  return hit;
}

/* ===================== alert ===================== */
function dayName(d) { return ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'][d.getDay()]; }
function activeAlerts(seg, km, horizon) {
  const t = todayStr(), d = now();
  const all = DATA.alerts.concat((S.setup && S.setup.alerts) || []);
  return all.filter(a => {
    if (a.dates && !a.dates.includes(t)) return false;
    if (a.dates_range && (t < a.dates_range[0] || t > a.dates_range[1])) return false;
    if (a.weekly && dayName(d) !== a.weekly) return false;
    if (a.daily) return true;
    if (a.weekly && !a.seg) return true;
    if (!a.seg) return !!(a.dates || a.dates_range);
    if (a.seg !== seg) return false;
    return a.km1 >= km - 0.3 && a.km0 <= km + horizon;
  });
}

/* ===================== nastro "cosa c'è davanti" ===================== */
const ICONS = { water: '💧', pharmacy: '💊', atm: '🏧', shop: '🛒', food: '🍽', sleep: '🛏', sello: '📮' };
function ribbon(seg, km, horizon) {
  const rows = [];
  if (DATA.loc) for (const L of DATA.loc) {
    if (L.seg !== seg || L.km < km - 0.2 || L.km > km + horizon) continue;
    const svc = [];
    if (L.f) svc.push('🍽' + L.f); if (L.s) svc.push('🛒' + L.s); if (L.w) svc.push('💧');
    if (L.ph) svc.push('💊'); if (L.atm) svc.push('🏧'); if (L.sl) svc.push('🛏' + L.sl);
    rows.push({ km: L.km, ico: L.place === 'city' || L.place === 'town' ? '🏘' : '🏡', main: L.name, sub: svc.join('  ') || 'nessun servizio noto', loc: true });
  }
  if (DATA.pois) {
    /* fontane raggruppate quando sono vicine (stesso km circa) — regola di Andrea */
    const waters = DATA.pois.filter(p => p.seg === seg && p.t === 'water' && p.km >= km - 0.1 && p.km <= km + horizon);
    let i = 0;
    while (i < waters.length) {
      let j = i;
      while (j + 1 < waters.length && waters[j + 1].km - waters[i].km <= 0.6) j++;
      const grp = waters.slice(i, j + 1);
      if (grp.length === 1) {
        const p = grp[0];
        rows.push({ km: p.km, ico: '💧', main: p.n || 'Fontana', sub: p.np ? 'acqua non garantita' : '', dim: !!p.np });
      } else {
        const np = grp.filter(p => p.np).length;
        const span = grp[grp.length - 1].km - grp[0].km;
        let sub = span > 0.05 ? 'nell’arco di ' + (span * 1000).toFixed(0) + ' m' : '';
        if (np) sub += (sub ? ' · ' : '') + (np === grp.length ? 'acqua non garantita' : np + ' non garantite');
        rows.push({ km: grp[0].km, ico: '💧', main: grp.length + ' fontane', sub, dim: np === grp.length });
      }
      i = j + 1;
    }
    for (const p of DATA.pois) {
      if (p.seg !== seg || p.km < km - 0.1 || p.km > km + horizon) continue;
      if (p.t === 'pharmacy') rows.push({ km: p.km, ico: '💊', main: p.n || 'Farmacia', sub: '' });
    }
  }
  if (DATA.sellos) for (const sl of DATA.sellos.famosi) {
    if (sl.seg !== seg || sl.km < km - 0.2 || sl.km > km + horizon) continue;
    rows.push({ km: sl.km, ico: ICONS.sello, main: sl.name, sub: sl.note });
  }
  rows.sort((a, b) => a.km - b.km);
  if (rows.length > 60) {
    const extra = rows.length - 60;
    const cut = rows.slice(0, 60);
    cut.push({ km: cut[59].km, ico: '…', main: 'altri ' + extra + ' punti più avanti nel raggio', sub: '', dim: true });
    return cut;
  }
  return rows;
}

/* ===================== advisor "dove dormo" ===================== */
const CANONICHE = ['Roncesvalles', 'Zubiri', 'Pamplona', 'Puente la Reina', 'Estella', 'Los Arcos', 'Logroño', 'Nájera', 'Santo Domingo de la Calzada', 'Belorado', 'San Juan de Ortega', 'Burgos', 'Hornillos del Camino', 'Castrojeriz', 'Frómista', 'Carrión de los Condes', 'Terradillos de los Templarios', 'Bercianos del Real Camino', 'Mansilla de las Mulas', 'León', 'Astorga', 'Foncebadón', 'Ponferrada', 'Villafranca del Bierzo', 'O Cebreiro', 'Triacastela', 'Sarria', 'Portomarín', 'Palas de Rei', 'Arzúa', 'O Pedrouzo', 'Negreira', 'Olveiroa', 'Cee', 'Fisterra'];
function classify(L) {
  if (L.place === 'city' || (L.pop && L.pop >= 15000)) return 'città';
  if ((L.sl || 0) >= 4 || ((L.sl || 0) >= 2 && (L.f || 0) >= 3)) return 'medio';
  return 'piccolo';
}
function adviseSleep(pos, wx) {
  const { seg, km } = pos;
  const pace = paceKmh();
  /* usa l'ORA del tramonto sulla data di oggi (l'API può rispondere con un'altra data);
     senza meteo, ripiega sull'ultimo tramonto noto o su una stima per mese (a ottobre il
     tramonto fisso delle 20:10 regalerebbe luce inesistente) */
  const fbSunset = (S.lastWeather && S.lastWeather.sunset) || (now().getMonth() + 1 >= 10 ? '19:45' : '20:10');
  const sunset = (() => { const d = now(); const [hh, mm] = (wx && wx.sunset ? wx.sunset : fbSunset).split(':').map(Number); d.setHours(hh, mm, 0, 0); return d; })();
  const hoursLeft = Math.max(0, (sunset - now()) / 3600000 - 1); /* margine 1h */
  const reach = Math.min(28, Math.max(2, pace * hoursLeft));
  const segLen = DATA.track[seg].km_total;
  const out = { reach, sunset, pace, options: [], degraded: !DATA.loc };
  if (!DATA.loc) return out;
  const sat = now().getDay() === 6;
  const rainPm = wx && wx.rows.some(r => r.prob >= 55);
  const sleepLocs = DATA.loc.filter(L => L.seg === seg && L.km > km + 0.3 && (L.sl || 0) > 0);
  /* NON le 8 più vicine (in Galizia le frazioni saturerebbero la lista nascondendo Sarria
     o Portomarín — bug trovato dalla revisione): prima le mete vere nel raggio, poi le frazioni */
  const within = sleepLocs.filter(L => L.km <= km + reach);
  const isMeta = L => classify(L) !== 'piccolo' || CANONICHE.some(c => L.name.toLowerCase().includes(c.toLowerCase()));
  const big = within.filter(isMeta), small = within.filter(L => !isMeta(L));
  const cands = big.slice(0, 8).concat(small.slice(0, Math.max(0, 8 - big.length))).sort((a, b) => a.km - b.km);
  for (const L of cands) {
    const etaH = (L.km - km) / pace;
    const eta = new Date(now().getTime() + etaH * 3600000);
    const next = sleepLocs.find(N => N.km > L.km + 0.5);
    const gapNext = next ? (next.km - L.km) : (segLen - L.km);
    let cls = classify(L);
    let pressure = 0;
    if (CANONICHE.some(c => L.name.toLowerCase().includes(c.toLowerCase()))) pressure++;
    if (sat) pressure++;
    if (rainPm) pressure++;
    if (seg === 'frances' && km > 640) pressure++;
    const etaStr = eta.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    /* cibo — se il posto è spoglio, prenotare i pasti INSIEME al letto (regola di Andrea) */
    let food = null;
    {
      const fCnt = L.f || 0, sCnt = L.s || 0;
      let nextFood = null;
      if (DATA.pois) for (const p of DATA.pois) {
        if (p.seg !== seg || (p.t !== 'food' && p.t !== 'shop')) continue;
        if (p.km > L.km + 0.4 && (nextFood == null || p.km < nextFood)) nextFood = p.km;
      }
      const gapMeal = nextFood != null ? nextFood - L.km : null;
      if (!fCnt && !sCnt) food = { level: 'crit', text: 'Qui non c’è niente da mangiare — quando chiami per il letto, prenota anche cena, colazione e panini da portare via' + (gapMeal != null && gapMeal > 4 ? ' (il primo cibo domattina è a ' + gapMeal.toFixed(0) + ' km)' : '') + (sat ? '. E domani è domenica' : '') };
      else if (!sCnt) food = { level: 'warn', text: 'Si cena ma non c’è negozio — chiedi al gestore colazione e panini per domani' + (sat ? ' (domani è domenica, negozi chiusi)' : '') };
      else if (sat) food = { level: 'info', text: 'Domani è domenica — compra stasera il pranzo di domani' };
    }
    let advice, tone;
    if (cls === 'città') { tone = 'ok'; advice = 'Qualcosa si trova sempre — al massimo paghi una pensione. Se vuoi la camera privata, prenota appena decidi.'; }
    else {
      const limitH = cls === 'medio' ? 15 : 13.5 + (pressure ? -0.5 : 0.5);
      const late = eta.getHours() + eta.getMinutes() / 60 > limitH - (pressure >= 2 ? 1 : 0);
      if (!late) { tone = pressure >= 2 ? 'warn' : 'ok'; advice = 'Arrivi in orario buono per trovare posto' + (pressure ? ' — ma oggi c’è più pressione del solito (prenota se puoi)' : '') + '.'; }
      else { tone = 'crit'; advice = 'A quest’ora d’arrivo rischi di trovare pieno — prenota prima di partire da qui, oppure scegli un’altra meta.'; }
    }
    out.options.push({ name: L.name, km: L.km, lat: L.lat, lon: L.lon, dist: L.km - km, eta: etaStr, cls, sl: L.sl || 0, alb: L.alb || 0, gapNext: gapNext, tone, advice, pressure, food });
  }
  /* Santiago geometricamente vive sull'Epilogo al km 0 — se è a portata (o ci è già), è sempre un'opzione */
  const toSdc = kmToSantiago(seg, km);
  const aSantiago = (seg === 'frances' && toSdc <= reach) || (seg === 'epilogo_fisterra' && km < 1);
  if (aSantiago && !out.options.some(o => /santiago/i.test(o.name))) {
    const d = seg === 'frances' ? Math.max(0, toSdc) : 0;
    const eta = new Date(now().getTime() + d / pace * 3600000);
    out.options.unshift({ name: 'Santiago de Compostela', km: km + d, lat: 42.8806, lon: -8.5446, dist: d, eta: eta.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }), cls: 'città', sl: 46, alb: 20, gapNext: 0, tone: 'ok', advice: d < 0.5 ? 'Sei a Santiago — qualcosa si trova sempre. Prima del letto, passa dall’Oficina del Peregrino per la Compostela.' : 'Sei quasi arrivata — qualcosa si trova sempre. E prima di cercare il letto, passa dall’Oficina del Peregrino per la Compostela.', pressure: 0 });
  }
  out.beyond = sleepLocs.filter(L => L.km > km + reach).slice(0, 2).map(L => ({ name: L.name, dist: L.km - km }));
  return out;
}

/* ===================== affiliazione Stay22 (Booking con tracciamento olgacamino) ===================== */
/* AID aziendale — regola dei README TT/NC4K: è quello che incassa le commissioni, non cambiarlo */
const STAY22_AID = 'adventurelabsrl';
function stay22Booking(lat, lon) {
  const d = now(); const dom = new Date(d); dom.setDate(dom.getDate() + 1);
  return 'https://www.stay22.com/allez/booking?aid=' + STAY22_AID + '&campaign=olgacamino' +
    '&lat=' + Number(lat).toFixed(5) + '&lng=' + Number(lon).toFixed(5) +
    '&checkin=' + todayStr(d) + '&checkout=' + todayStr(dom) + '&adults=1';
}

/* ===================== helper UI ===================== */
const $ = sel => document.querySelector(sel);
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function card(html, cls) { return '<div class="card ' + (cls || '') + '">' + html + '</div>'; }
function statusAge() {
  if (!DATA.status || !DATA.status.updated) return null;
  const days = Math.floor((now() - new Date(DATA.status.updated)) / 86400000);
  return { days, txt: days <= 0 ? 'aggiornati oggi' : days === 1 ? 'aggiornati ieri' : 'aggiornati ' + days + ' giorni fa' };
}

/* ===================== viste ===================== */
let TAB = 'oggi';
function render() { const v = { oggi: viewOggi, mappa: viewMappa, diario: viewDiario, info: viewInfo, setup: viewSetup }[TAB] || viewOggi; v(); markTabs(); }

let MAPJS = false;
function viewMappa() {
  const m = $('#main'); m.innerHTML = '';
  m.append(el('<div class="card"><h2>La mappa del cammino</h2><p class="small">Per studiare il percorso — accendi e spegni i livelli. Serve rete per lo sfondo. Trascina il dito sull’altimetria e il punto giallo si muove sulla mappa.</p><div class="chips" id="mapChips"></div><p class="age" id="poiCount" style="margin:8px 0 0"></p></div>'));
  m.append(el('<div id="map"></div>'));
  m.append(el('<div class="card mt"><h3>Altimetria</h3><div class="chips" id="segSel" style="margin-bottom:8px"></div><canvas id="prof"></canvas><p class="small" id="profOut" style="margin:8px 0 0"></p></div>'));
  const go = () => { if (window.bcoInitMap) window.bcoInitMap(); };
  if (window.L && MAPJS) return go();
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'assets/vendor/leaflet.css'; document.head.append(css);
  const s1 = document.createElement('script'); s1.src = 'assets/vendor/leaflet.js';
  s1.onload = () => { const s2 = document.createElement('script'); s2.src = 'assets/map.js'; s2.onload = () => { MAPJS = true; go(); }; document.body.append(s2); };
  document.body.append(s1);
}
function markTabs() { document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === TAB)); }

function viewOggi() {
  const m = $('#main'); m.innerHTML = '';
  if (!S.setup) {
    m.append(el(card('<h2>Ciao! 🐚</h2><p>Questa app accompagna il cammino di Olga. Per cominciare serve il file di configurazione con le prenotazioni — si carica una volta sola, resta solo su questo telefono.</p><button class="btn" onclick="TAB=\'setup\';render()">Carica configurazione</button>')));
    return;
  }
  const start = S.setup.profile.start;
  if (todayStr() < start) return viewVigilia(m);

  const today = todayStr();
  const day = S.days.find(d => d.date === today);
  const hour = now().getHours();

  m.append(el('<div class="bigbtns">' +
    bigBtn('parto', '🌅', 'Parto', day && day.start ? 'ripeti per aggiornare il piano' : 'meteo e piano della giornata', !day || !day.start) +
    bigBtn('dormo', '🛏', 'Dove dormo stasera?', 'consiglio onesto sulle prossime mete', false) +
    bigBtn('fine', '🏁', 'Fine tappa', day && day.end ? 'tappa già chiusa — ripeti se serve' : 'salva la giornata e guarda domani', false) +
    '</div>'));
  $('#b-parto').onclick = () => flowParto();
  $('#b-dormo').onclick = () => flowDormo();
  $('#b-fine').onclick = () => flowFine();

  const content = el('<div id="content"></div>'); m.append(content);
  if (day && day.plan) renderPlan(content, day.plan, true);
  else content.append(el(card('<p class="small">Buongiorno! Quando sei pronta a partire premi <b>Parto</b> — leggo dove sei e ti preparo la giornata. ' + (hour >= 13 ? 'Se sei già in cammino da stamattina, premilo comunque per il piano del pomeriggio.' : '') + '</p>')));
}
function bigBtn(id, e, t, s, primary) {
  return '<button class="bigbtn ' + (primary ? 'primary' : '') + '" id="b-' + id + '"><span class="e">' + e + '</span><span class="l"><b>' + t + '</b><span>' + s + '</span></span></button>';
}

function viewVigilia(m) {
  const start = new Date(S.setup.profile.start + 'T08:00');
  const gg = Math.ceil((start - now()) / 86400000);
  m.append(el('<div class="phrase">' + esc(gg > 1 ? 'Meno ' + gg + ' giorni, ' + (S.setup.profile.name || '') + '. Lo zaino si prepara da solo? No. Ma quasi.' : 'Ci siamo quasi. Domani si comincia a camminare davvero.') + '</div>'));
  let h = '<h2>Il viaggio verso il Cammino</h2><div class="timeline">';
  for (const t of (S.setup.travel || [])) {
    h += '<div class="tl"><span class="when">' + esc(t.when) + '</span><b>' + esc(t.title) + '</b><span class="small">' + esc(t.note || '') + '</span></div>';
  }
  h += '</div>';
  m.append(el(card(h)));
  let n = '<h2>Le prime notti</h2>';
  for (const nt of (S.setup.nights || [])) n += '<div class="tl" style="padding-left:0"><b>' + esc(nt.date) + ' — ' + esc(nt.place) + '</b><span class="small">' + esc(nt.name) + (nt.addr ? ' · ' + esc(nt.addr) : '') + (nt.note ? ' · ' + esc(nt.note) : '') + '</span></div>';
  m.append(el(card(n)));
}

async function flowParto() {
  const c = $('#content'); c.innerHTML = card('<p>Un attimo — leggo posizione e meteo…</p>');
  try {
    const g = await getPosition();
    let pos = snap(g.lat, g.lon);
    if (!pos || pos.dist > 3000) { c.innerHTML = card('<h3>Sei lontana dal cammino</h3><p class="small">Ti vedo a ' + (pos ? (pos.dist / 1000).toFixed(1) : '?') + ' km dalla traccia. Giorno di riposo o trasferimento? Nessun problema — ripremi Parto quando sei sul percorso.</p>', 'warn'); return; }
    const today = todayStr();
    const tonight = (S.setup.nights || []).find(n => n.date === today);
    /* ai capi condivisi (Saint-Jean, Santiago…) i segmenti si toccano: se il letto di stasera
       è su un altro segmento raggiungibile da qui, il piano nasce su QUEL segmento */
    if (tonight && tonight.seg && tonight.seg !== pos.seg && DATA.track[tonight.seg]) {
      const alt = snapSeg(tonight.seg, g.lat, g.lon);
      if (alt && alt.dist < 3000 && alt.dist < pos.dist + 800) pos = alt;
    }
    S.lastPos = { ...pos, t: now().toISOString() };
    let day = S.days.find(d => d.date === today);
    if (!day) { day = { date: today, km: 0 }; S.days.push(day); }
    if (!day.start) day.start = { t: now().toISOString(), seg: pos.seg, km: pos.km };
    const targetKm = tonight && tonight.seg === pos.seg && Number.isFinite(tonight.km) && tonight.km > pos.km + 0.2 ? tonight.km : null;
    const pace = paceKmh();
    const samples = buildSamples(pos.seg, pos.km, pace, targetKm);
    let wx = null;
    try { wx = await fetchWeather(samples); S.lastWeather = { t: Date.now(), sunset: wx.sunset }; } catch (e) {}
    day.plan = buildPlanModel(pos, wx, tonight, pace);
    saveState();
    c.innerHTML = ''; renderPlan(c, day.plan, false);
  } catch (e) { c.innerHTML = card('<h3>Ops</h3><p class="small">' + esc(e.message) + '</p>', 'warn'); }
}
function buildPlanModel(pos, wx, tonight, pace) {
  const mile = milestoneHit(pos.seg, pos.km);
  const phrase = mile || pickPhrase(wx && wx.rows.some(r => r.prob >= 55) ? 'parto_pioggia' : (dplusBetween(pos.seg, pos.km, pos.km + 15) > 600 ? 'parto_duro' : 'parto'));
  return {
    t: now().toISOString(), seg: pos.seg, km: pos.km, phrase, milestone: !!mile,
    wx: wx ? { rows: wx.rows.map(r => ({ km: r.km, label: r.label, etaH: r.eta.getHours() + ':' + String(r.eta.getMinutes()).padStart(2, '0'), temp: r.temp, prob: r.prob, code: r.code, wind: r.wind })), sunrise: wx.sunrise, sunset: wx.sunset } : null,
    tonight: tonight ? (() => {
      let kmLeft = null, dplus = null;
      if (tonight.seg === pos.seg && Number.isFinite(tonight.km)) { kmLeft = Math.max(0, tonight.km - pos.km); dplus = dplusBetween(pos.seg, pos.km, tonight.km); }
      else if (pos.seg === 'valcarlos' && tonight.seg === 'frances' && tonight.km >= FR_RONCES - 1.5) {
        /* variante bassa con letto prenotato sul Francese (Roncisvalle): si somma il residuo dei due segmenti */
        const rest = DATA.track.valcarlos.km_total - pos.km;
        kmLeft = Math.max(0, rest + (tonight.km - FR_RONCES));
        dplus = dplusBetween('valcarlos', pos.km, 1e9) + dplusBetween('frances', FR_RONCES, Math.max(FR_RONCES, tonight.km));
      }
      return { name: tonight.name, place: tonight.place, kmLeft, dplus, note: tonight.note || '' };
    })() : null,
    alerts: activeAlerts(pos.seg, pos.km, 26).map(a => ({ level: a.level, title: a.title, body: a.body })),
    rib: ribbon(pos.seg, pos.km, 26),
    santiago: kmToSantiago(pos.seg, pos.km), fisterra: kmToFisterra(pos.seg, pos.km), pace
  };
}
function renderPlan(c, P, stale) {
  c.append(el('<div class="phrase">' + (P.milestone ? '⭐ ' : '') + esc(P.phrase) + '</div>'));
  let s = '<div class="stat-row">';
  if (P.tonight && P.tonight.kmLeft != null) s += stat(P.tonight.kmLeft.toFixed(1) + ' km', 'a ' + esc(P.tonight.place)) + stat('+' + P.tonight.dplus + ' m', 'salita rimasta');
  s += stat(P.santiago.toFixed(0) + ' km', 'a Santiago') + stat(P.fisterra.toFixed(0) + ' km', 'all’oceano') + '</div>';
  if (P.wx) s += '<p class="small mt">🌅 alba ' + P.wx.sunrise + ' · 🌇 tramonto ' + P.wx.sunset + '</p>';
  c.append(el(card('<h2>' + (stale ? 'Il piano di oggi' : 'La tua giornata') + '</h2>' + s)));
  for (const a of P.alerts) c.append(el(card('<h3>' + (a.level === 'critico' ? '⚠️' : a.level === 'attenzione' ? '🔶' : 'ℹ️') + ' ' + esc(a.title) + '</h3><p class="small">' + esc(a.body) + '</p>', a.level === 'critico' ? 'crit' : a.level === 'attenzione' ? 'warn' : '')));
  if (P.wx) {
    let w = '<h3>Meteo lungo la strada</h3>';
    for (const r of P.wx.rows) w += '<div class="wxrow"><span class="h">' + r.etaH + '</span><span>' + WMO(r.code) + '</span><span class="pl">' + esc(r.label) + '</span><span class="tp">' + r.temp + '°</span><span class="pr' + (r.prob >= 50 ? ' wet' : '') + '">☔ ' + r.prob + '%</span></div>';
    c.append(el(card(w)));
  } else c.append(el(card('<p class="small">Meteo non raggiungibile ora — riprova quando hai campo. Il resto funziona lo stesso.</p>', 'warn')));
  if (P.tonight) c.append(el(card('<h3>🛏 Stasera</h3><p><b>' + esc(P.tonight.name) + '</b> — ' + esc(P.tonight.place) + '</p>' + (P.tonight.note ? '<p class="small">' + esc(P.tonight.note) + '</p>' : ''))));
  if (P.rib.length) {
    let r = '<h3>Cosa c’è davanti</h3><div class="ribbon">';
    for (const x of P.rib) r += '<div class="rib' + (x.dim ? ' dim' : '') + '"><span class="km">' + (x.km - P.km).toFixed(1) + ' km</span><span class="ico">' + x.ico + '</span><span class="what">' + (x.loc ? '<b>' : '') + esc(x.main) + (x.loc ? '</b>' : '') + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</span></div>';
    c.append(el(card(r + '</div>')));
  } else c.append(el(card('<p class="small">Il database dei servizi lungo il percorso arriva col prossimo aggiornamento — per ora guida la traccia.</p>')));
}
function stat(b, l) { return '<span class="stat"><b>' + b + '</b><span>' + l + '</span></span>'; }

async function flowDormo() {
  const c = $('#content'); c.innerHTML = card('<p>Guardo dove sei e cosa c’è davanti…</p>');
  try {
    const g = await getPosition();
    const pos = snap(g.lat, g.lon);
    if (!pos || pos.dist > 3000) { c.innerHTML = card('<p class="small">Sei lontana dalla traccia — il consiglio funziona in cammino.</p>', 'warn'); return; }
    S.lastPos = { ...pos, t: now().toISOString() };
    const tonight = (S.setup.nights || []).find(n => n.date === todayStr());
    let wx = null; const pace = paceKmh();
    try { wx = await fetchWeather(buildSamples(pos.seg, pos.km, pace)); } catch (e) {}
    const adv = adviseSleep(pos, wx);
    c.innerHTML = '';
    c.append(el('<div class="phrase">' + esc(pickPhrase('advisor')) + '</div>'));
    if (tonight) c.append(el(card('<h3>Hai già un letto per stasera 🎉</h3><p><b>' + esc(tonight.name) + '</b> — ' + esc(tonight.place) + (tonight.seg === pos.seg ? ' · mancano ' + Math.max(0, tonight.km - pos.km).toFixed(1) + ' km' : '') + '</p>', 'ok')));
    const age = statusAge();
    let head = '<h2>Dove fermarsi</h2><p class="small">Puoi camminare fino alle ' + (adv.sunset ? adv.sunset.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '~20:00') + ' (tramonto meno un’ora di margine) — al tuo passo sono <b>~' + adv.reach.toFixed(0) + ' km</b> ancora.</p>';
    if (age) head += '<p class="age">Dati strutture ' + age.txt + (age.days > 7 ? ' — fidati poco e telefona' : '') + '</p>';
    c.append(el(card(head)));
    if (adv.degraded) { c.append(el(card('<p class="small">Il database delle località non è ancora caricato — guida col nastro della tappa e chiedi in zona. Regola d’oro di settembre comunque valida — nei paesini arriva entro le 14, nelle città sei sempre a posto.</p>', 'warn'))); return; }
    if (!adv.options.length) c.append(el(card('<p class="small">Nel raggio di oggi non vedo località con posti letto censiti. ' + (adv.beyond.length ? 'Le prossime sono ' + adv.beyond.map(b => esc(b.name) + ' (' + b.dist.toFixed(0) + ' km)').join(' e ') + ' — valuta se fermarti prima o chiamare un taxi.' : '') + '</p>', 'warn')));
    for (const o of adv.options) {
      const pill = o.cls === 'città' ? '<span class="pill ok">città</span>' : o.cls === 'medio' ? '<span class="pill info">paese</span>' : '<span class="pill warn">paesino</span>';
      const gm = 'https://www.google.com/maps/search/' + encodeURIComponent('albergue ' + o.name);
      const bk = stay22Booking(o.lat, o.lon);
      let h = '<div class="opt"><div class="head">' + pill + '<b>' + esc(o.name) + '</b><span class="eta">' + o.dist.toFixed(1) + ' km · ~' + o.eta + '</span></div>';
      h += '<div class="why">' + (o.sl ? (o.sl === 1 ? '1 struttura per dormire' : o.sl + ' strutture per dormire') + (o.alb ? ' (di cui ' + o.alb + ' albergue)' : '') : 'letti non censiti') + (o.gapNext > 0.5 ? ' · dopo, il prossimo letto è a ' + o.gapNext.toFixed(0) + ' km' : '') + (o.pressure ? ' · pressione +' + o.pressure : '') + '</div>';
      h += '<p class="small mt" style="margin-bottom:0">' + esc(o.advice) + '</p>';
      if (o.food) h += '<p class="small foodnote ' + o.food.level + '">🍽 ' + esc(o.food.text) + '</p>';
      h += '<div class="act"><a href="' + gm + '" target="_blank" rel="noopener">Mappa</a><a href="' + bk + '" target="_blank" rel="noopener">Booking</a></div></div>';
      c.append(el(h));
    }
    if (adv.beyond && adv.beyond.length && adv.options.length) c.append(el(card('<p class="small">Più avanti, oltre il raggio di oggi — ' + adv.beyond.map(b => esc(b.name) + ' (' + b.dist.toFixed(0) + ' km)').join(' · ') + '</p>')));
    c.append(el(card('<p class="small">Ricorda — i municipali non si prenotano (fila, credencial, contanti), i privati sì (telefono, WhatsApp, Booking). Alle 18 pensa a domani sera.</p>')));
  } catch (e) { c.innerHTML = card('<p class="small">' + esc(e.message) + '</p>', 'warn'); }
}

async function flowFine() {
  const c = $('#content'); c.innerHTML = card('<p>Chiudo la giornata…</p>');
  try {
    const g = await getPosition();
    const pos = snap(g.lat, g.lon);
    if (pos && pos.dist <= 3000) S.lastPos = { ...pos, t: now().toISOString() };
    const today = todayStr();
    let day = S.days.find(d => d.date === today);
    if (!day) {
      /* fine tappa dopo mezzanotte: se ieri c'è una giornata aperta, si chiude quella */
      const last = S.days[S.days.length - 1];
      const yest = new Date(now()); yest.setDate(yest.getDate() - 1);
      if (last && last.date === todayStr(yest) && last.start && !last.end && now().getHours() < 4) day = last;
    }
    if (!day) { day = { date: today, km: 0 }; S.days.push(day); }
    day.end = { t: now().toISOString(), seg: pos ? pos.seg : null, km: pos ? pos.km : null };
    if (pos && day.start) day.km = walkedBetween(day.start.seg, day.start.km, pos.seg, pos.km);
    day.sleptAt = nearLocName(pos ? pos.seg : 'frances', pos ? pos.km : 0);
    saveState();
    const mile = pos ? milestoneHit(pos.seg, pos.km) : null;
    const hard = day.km > 26 || (pos && day.start && dplusBetween(pos.seg, day.start.km, pos.km) > 900);
    const phrase = mile || pickPhrase(hard ? 'fine_dura' : 'fine');
    c.innerHTML = '';
    c.append(el('<div class="phrase">' + (mile ? '⭐ ' : '') + esc(phrase) + '</div>'));
    const done = S.days.reduce((a, d) => a + (d.km || 0), 0);
    let h = '<h2>Tappa ' + S.days.length + ' chiusa</h2><div class="stat-row">' + stat(day.km.toFixed(1) + ' km', 'oggi') + stat(done.toFixed(0) + ' km', 'totali') + stat(dailyKmMedian().toFixed(0) + ' km', 'tua media') + '</div>';
    c.append(el(card(h)));
    if (pos && kmToFisterra(pos.seg, pos.km) > 1) {
      const sdc = kmToSantiago(pos.seg, pos.km);
      const pj1 = projezione(sdc);
      const pj2 = projezione(kmToFisterra(pos.seg, pos.km));
      let ph = sdc > 1 ? 'Santiago tra <b>' + fmtDate(pj1.from) + '</b> e <b>' + fmtDate(pj1.to) + '</b><br>' : '';
      c.append(el(card('<h3>Di questo passo</h3><p>' + ph + 'L’oceano a Fisterra tra <b>' + fmtDate(pj2.from) + '</b> e <b>' + fmtDate(pj2.to) + '</b></p><p class="small">Basata sulla tua media reale di ' + pj2.daily.toFixed(0) + ' km al giorno — si aggiusta da sola giorno dopo giorno.</p>')));
    }
    /* posto spoglio? l'alert cibo scatta anche a fine tappa, come rete di sicurezza */
    if (DATA.loc && pos) {
      const nearL = DATA.loc.filter(Lx => Lx.seg === pos.seg && Math.abs(Lx.km - pos.km) < 1.2)
        .sort((a, b) => Math.abs(a.km - pos.km) - Math.abs(b.km - pos.km))[0];
      if (nearL && !(nearL.f || 0) && !(nearL.s || 0))
        c.append(el(card('<h3>🍽 Qui non si mangia</h3><p class="small">A ' + esc(nearL.name) + ' non risultano bar, ristoranti né negozi. Se non l’hai già fatto, <b>prenota subito con la struttura cena, colazione e panini da portare via per domani</b> — dopo cena è tardi.</p>', 'crit')));
      else if (nearL && !(nearL.s || 0))
        c.append(el(card('<h3>🛒 Niente negozio qui</h3><p class="small">Si cena, ma domani non compri nulla — assicurati stasera colazione e panini per domani col gestore.</p>', 'warn')));
    }
    const tomorrow = new Date(now()); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomBooking = (S.setup.nights || []).find(n => n.date === todayStr(tomorrow));
    let ev = '<h3>Stasera, con calma</h3><p class="small">🛏 Controllo cimici in 60 secondi — cuciture del materasso, zaino MAI sul letto<br>🦶 Piedi — lava, asciuga, aria. Ogni punto caldo si tratta subito<br>🍽 Cena da pellegrina 19-20, i ristoranti spagnoli aprono tardi<br>📞 <b>Alle 18 prenota domani sera</b> — la regola d’oro di settembre' + (pos && pos.seg === 'frances' && pos.km > 640 ? '<br>📮 Da Sarria in poi — oggi hai preso i 2 timbri?' : '') + '</p>';
    if (tomBooking) ev += '<p class="small mt"><b>Domani sera sei già a posto</b> — ' + esc(tomBooking.name) + ', ' + esc(tomBooking.place) + '.</p>';
    c.append(el(card(ev)));
  } catch (e) { c.innerHTML = card('<p class="small">' + esc(e.message) + '</p>', 'warn'); }
}

function viewDiario() {
  const m = $('#main'); m.innerHTML = '';
  const done = S.days.reduce((a, d) => a + (d.km || 0), 0);
  m.append(el(card('<h2>Il tuo cammino</h2><div class="stat-row">' + stat(String(S.days.length), 'giorni') + stat(done.toFixed(0) + ' km', 'camminati') + '</div>')));
  if (!S.days.length) { m.append(el(card('<p class="small">Il diario si scrive da solo, un “Fine tappa” alla volta.</p>'))); return; }
  let h = '<h3>Giorno per giorno</h3>';
  S.days.forEach((d, i) => { h += '<div class="diary-day"><b>' + esc(d.date.slice(5)) + '</b><span>' + esc(d.sleptAt || '') + '</span><span class="km">' + (d.km || 0).toFixed(1) + ' km</span></div>'; });
  m.append(el(card(h)));
  const txt = 'Il mio Cammino 🐚\n' + S.days.map((d, i) => 'Giorno ' + (i + 1) + ' (' + d.date + ') — ' + (d.km || 0).toFixed(1) + ' km' + (d.sleptAt ? ', notte a ' + d.sleptAt : '')).join('\n') + '\nTotale ' + done.toFixed(0) + ' km';
  m.append(el('<a class="btn" style="text-decoration:none" href="https://wa.me/?text=' + encodeURIComponent(txt) + '" target="_blank" rel="noopener">Condividi su WhatsApp</a>'));
}

function viewInfo() {
  const m = $('#main'); m.innerHTML = '';
  const sellosList = DATA.sellos ? DATA.sellos.famosi.map(s => '<p><b>' + esc(s.name) + '</b><br><span class="small">' + esc(s.note) + '</span></p>').join('') : '';
  const cards = [
    ['📮 Timbri (sellos)', '<p>' + esc(DATA.sellos ? DATA.sellos.regola : '') + '</p><h3 class="mt">I timbri da non perdere</h3>' + sellosList],
    ['🆘 Sicurezza', '<p><b>112</b> funziona in Francia e Spagna su qualsiasi rete, anche senza campo del tuo operatore.</p><p><b>AlertCops</b> — app della polizia spagnola con SOS che invia la tua posizione. Attiva la funzione «Guardián Camino de Santiago» prima di partire.</p><p>Il Francese è tra i cammini più sicuri al mondo per una donna sola — la folla è la tua rete. In albergue i valori restano sempre con te (marsupio anche in doccia).</p>'],
    ['🦶 Piedi e gambe', '<p>Punto caldo = cerotto SUBITO, mai «alla prossima pausa». Vescica formata piccola — proteggi e basta. Grande e dolorosa — ago sterilizzato, svuota, NON togliere la pelle, disinfetta.</p><p>Tibie o tendini che tirano = rallenta subito. Un giorno corto oggi salva il cammino intero. Se peggiora, 1-2 giorni di riposo veri.</p>'],
    ['🛏 Cimici in 60 secondi', '<p>All’arrivo controlla le cuciture del materasso — puntini neri o insetti. Zaino MAI sul letto (pavimento o panca). Punture in fila che prudono? Dillo subito all’hospitalero, lava tutto a 60° e asciuga a caldo.</p>'],
    ['💧 Acqua', '<p>Le fontane dei paesi sono potabili salvo cartello «agua no potable» o «no tratada» (= non garantita). Nel dubbio riempi al bar. Regola d’oro — riparti sempre con acqua per tutto il tratto fino al prossimo paese.</p>'],
    ['💶 Contanti', '<p>Municipali e donativo si pagano SOLO in contanti. Tieni 100-150 € in tagli piccoli e preleva in ogni cittadina — i bancomat nei paesini non esistono.</p>'],
    ['💊 Farmacie', '<p>Orari spagnoli — mattina fino alle 14, poi 17-20:30. Domenica chiuse, ma c’è sempre una <b>farmacia de guardia</b> di turno — la trovi sul cartello di qualunque farmacia.</p>'],
    ['🎒 Zaino avanti', '<p>Se le gambe chiedono pietà, lo zaino può viaggiare da solo — <b>Correos Paq Mochila</b>, ~5-6 € a tappa, si prenota entro le 20 della sera prima (elcaminoconcorreos.com), consegna entro le 14:30. Non è barare, è durare.</p>'],
    ['📞 Prenotare al telefono', '<p>«Hola, ¿tienen cama para esta noche?» (un letto per stanotte?)<br>«Soy una peregrina, llego a las cinco» (arrivo alle 17)<br>«¿Me puede sellar, por favor?» (mi timbra?)<br>«La cuenta, por favor» (il conto)</p><p>Molti albergue rispondono su WhatsApp — se prenoti e fai tardi, avvisa con un messaggio o il letto vola.</p>'],
    ['✈️ Il rientro', '<p>Da Santiago NON ci sono voli diretti per l’Italia in ottobre. Due strade — Vueling Santiago→Barcellona→Firenze in un biglietto unico, oppure bus per Porto (2-4 ore) e Ryanair diretto su Pisa, Bologna o Bergamo.</p><p>Il momento giusto per prenotare è da León/Sarria, quando sai la data d’arrivo a ±1 giorno. Mai bus da Fisterra e volo lo stesso giorno — notte cuscinetto a Santiago o Porto, e taxi per l’aeroporto prenotato la sera prima.</p><p>Bus Fisterra→Santiago — Monbus, 4-6 al giorno, 2-3 ore, 7-13 €, biglietto a bordo. Orari su monbus.es.</p>'],
    ['📜 Compostela e certificati', '<p>La <b>Compostela</b> si ritira a Santiago (Oficina del Peregrino, Rúa Carretas 33) mostrando la credencial timbrata — 1 timbro al giorno, 2 da Sarria.</p><p>Per l’Epilogo c’è la credencial dedicata (3 €, stesso ufficio). A Fisterra ti danno la <b>Fisterrana</b>, a Muxía la <b>Muxiana</b>.</p>']
  ];
  let h = '<div class="accordion">';
  for (const [t, b] of cards) h += '<details><summary>' + t + '</summary><div class="body">' + b + '</div></details>';
  m.append(el(card('<h2>Le schede del cammino</h2><p class="small">Tutto quello che serve sapere, sempre disponibile anche offline.</p>')));
  m.append(el(h + '</div>'));
  m.append(el('<p class="foot">Buen Camino, Olga · dati percorso © OpenStreetMap (ODbL) · meteo Open-Meteo</p>'));
}

function viewSetup() {
  const m = $('#main'); m.innerHTML = '';
  m.append(el(card('<h2>Configurazione</h2><p class="small">Incolla qui il file di configurazione preparato con Andrea (prenotazioni e viaggio). Resta solo su questo telefono — non viene inviato da nessuna parte.</p><textarea id="setupTxt" placeholder=\'{"profile": {...}}\'></textarea><div class="mt"><button class="btn" id="setupSave">Salva</button> <button class="btn ghost" id="setupWipe">Cancella tutto</button></div><p class="small mt" id="setupMsg"></p>')));
  if (S.setup) $('#setupTxt').value = JSON.stringify(S.setup, null, 1);
  $('#setupSave').onclick = () => {
    try {
      const j = JSON.parse($('#setupTxt').value);
      if (!j.profile || !j.profile.start) throw new Error('manca profile.start');
      const isoRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!isoRe.test(j.profile.start)) throw new Error('profile.start deve essere AAAA-MM-GG (es. 2026-09-12)');
      for (const n of (j.nights || [])) {
        if (!isoRe.test(n.date || '')) throw new Error('notte con data non AAAA-MM-GG (' + (n.date || '?') + ')');
        if (n.seg != null && !DATA.track[n.seg]) throw new Error('notte ' + n.date + ' con seg sconosciuto "' + n.seg + '"');
        if (n.seg != null && !Number.isFinite(n.km)) throw new Error('notte ' + n.date + ' ha seg ma manca km');
      }
      S.setup = j; saveState();
      $('#setupMsg').textContent = 'Salvato! ✅'; TAB = 'oggi'; setTimeout(render, 400);
    } catch (e) { $('#setupMsg').textContent = 'File non valido — ' + e.message; }
  };
  $('#setupWipe').onclick = () => { if (confirm('Cancello configurazione e diario da questo telefono?')) { localStorage.removeItem(LS_KEY); location.reload(); } };
}

/* ===================== boot ===================== */
async function boot() {
  loadState();
  try { await loadData(); } catch (e) {
    $('#main').innerHTML = '<div class="card warn"><h3>Dati non raggiungibili</h3><p class="small">' + esc(e.message) + ' — serve rete la prima volta, poi funziona offline.</p></div>';
    return;
  }
  const r = snapSeg('frances', 43.00899, -1.31932); if (r) FR_RONCES = r.km;
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { TAB = b.dataset.tab; render(); });
  $('#hdrDate').textContent = now().toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
