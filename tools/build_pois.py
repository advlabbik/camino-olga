#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_pois.py — build data/pois.json and data/localities.json for the Camino
de Santiago companion app, from OpenStreetMap (Overpass API).

Reads data/track.json (built by build_track.py) and queries Overpass with
bbox tiles that cover the track corridor (~25 km of track per tile, padded
1.7 km so both the 400 m POI corridor and the 1500 m locality corridor are
fully covered by a single query per tile).

data/pois.json    — point features within 400 m of any segment:
    t   water | pharmacy | atm | shop | food | sleep
    n   name (omitted when OSM has none)
    lat/lon (5 dp), seg (segment name), km (snapped km along segment, 2 dp)
    np:1  water that is not guaranteed potable (natural=spring)
    alb:1 sleep that is a pilgrim albergue (tourism=hostel or name matches
          /albergue|peregrin|pilgrim/i)
  Category rules:
    water    amenity=drinking_water; amenity=fountain ONLY with
             drinking_water=yes; natural=spring (np:1). Anything with
             drinking_water=no is excluded.
    pharmacy amenity=pharmacy
    atm      amenity=atm, or amenity=bank with atm=yes
    shop     shop=supermarket|convenience|greengrocer|bakery
    food     amenity=cafe|bar|restaurant|fast_food
    sleep    tourism=hostel|guest_house|hotel|motel|apartment|camp_site
  Dedupe: within a category, two records closer than 40 m collapse to one
  (named preferred, then albergue-flagged). Sorted by seg, km.

data/localities.json — place=city|town|village|hamlet nodes within 1500 m:
    {name, lat, lon, seg, km, place, pop?} + service summary counted from the
    FINAL pois.json records: a POI belongs to the locality when it is on the
    same segment within km ±0.8, OR within 1000 m radius (union):
    w water, f food, s shop, ph pharmacy, atm, sl sleep, alb albergue-flagged.
  Places closer than 700 m keep only the higher rank (city>town>village>hamlet).

Usage (any cwd):
    python C:/CoworkClaude/camino-olga/tools/build_pois.py
    python .../build_pois.py --refresh     # ignore tools/cache, refetch

Overpass responses are cached in tools/cache/ (op_poi_*.json) — a rerun with
a warm cache is offline and deterministic. Build report (with validation) is
copied to tools/cache/pois_report.txt.

Data © OpenStreetMap contributors, ODbL.
"""

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)
from build_track import overpass, hav, log  # noqa: E402  shared etiquette+cache

BASE = os.path.dirname(TOOLS_DIR)
CACHE_DIR = os.path.join(BASE, "tools", "cache")
DATA_DIR = os.path.join(BASE, "data")
TRACK_PATH = os.path.join(DATA_DIR, "track.json")
POIS_PATH = os.path.join(DATA_DIR, "pois.json")
LOC_PATH = os.path.join(DATA_DIR, "localities.json")
REPORT_PATH = os.path.join(CACHE_DIR, "pois_report.txt")

SEG_ORDER = ["frances", "valcarlos", "epilogo_fisterra", "epilogo_muxia",
             "link_fisterra_muxia"]
SEG_IDX = {s: i for i, s in enumerate(SEG_ORDER)}

POI_MAX_M = 400.0        # POI corridor
PLACE_MAX_M = 1500.0     # locality corridor
TILE_KM = 25.0           # along-track length of one Overpass bbox tile
PAD_M = 1700.0           # bbox padding (covers PLACE_MAX_M with margin)
DEDUP_M = 40.0           # same-category POI dedupe radius
TIE_M = 30.0             # segs closer than this to each other: prefer SEG_ORDER
PLACE_MERGE_M = 700.0    # locality merge radius
WINDOW_KM = 0.8          # locality service window along track (±)
SERVICE_R_M = 1000.0     # locality service radius
CELL = 0.02              # snap grid cell (deg); 3x3 covers >1500 m
CELL_S = 0.0006          # dedupe grid cell (deg); 3x3 covers >40 m
INF = float("inf")

AMENITY_RE = "^(drinking_water|fountain|pharmacy|atm|bank|cafe|bar|restaurant|fast_food)$"
SHOP_RE = "^(supermarket|convenience|greengrocer|bakery)$"
TOURISM_RE = "^(hostel|guest_house|hotel|motel|apartment|camp_site)$"
PLACE_RE = "^(city|town|village|hamlet)$"
PLACE_TYPES = ("city", "town", "village", "hamlet")
RANK = {"city": 4, "town": 3, "village": 2, "hamlet": 1}
SHOPS = ("supermarket", "convenience", "greengrocer", "bakery")
FOODS = ("cafe", "bar", "restaurant", "fast_food")
SLEEPS = ("hostel", "guest_house", "hotel", "motel", "apartment", "camp_site")
ALB_RE = re.compile(r"albergue|peregrin|pilgrim", re.I)

QUERY_TMPL = (
    "[out:json][timeout:180];("
    'node["amenity"~"%(A)s"](%(b)s);'
    'way["amenity"~"%(A)s"](%(b)s);'
    'relation["amenity"~"%(A)s"](%(b)s);'
    'node["shop"~"%(S)s"](%(b)s);'
    'way["shop"~"%(S)s"](%(b)s);'
    'relation["shop"~"%(S)s"](%(b)s);'
    'node["tourism"~"%(T)s"](%(b)s);'
    'way["tourism"~"%(T)s"](%(b)s);'
    'relation["tourism"~"%(T)s"](%(b)s);'
    'node["natural"="spring"](%(b)s);'
    'way["natural"="spring"](%(b)s);'
    'node["place"~"%(P)s"](%(b)s);'
    ");out center;"
)

REPORT = []


def rep(msg):
    REPORT.append(msg)
    log(msg)


def nrm(s):
    """Accent-insensitive lowercase normalisation for name matching."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def name_parts(name):
    """Full name + slash/dash-separated parts ('Pamplona/Iruña' -> both)."""
    parts = [name] + re.split(r"[/\-–—]", name)
    return [nrm(p) for p in parts if p.strip()]


def parse_pop(v):
    if v is None:
        return None
    digits = re.sub(r"[\s.,\u00a0]", "", str(v))
    return int(digits) if digits.isdigit() else None


# --------------------------------------------------------------- track + snapping

def load_track():
    with open(TRACK_PATH, encoding="utf-8") as f:
        d = json.load(f)
    segs = {}
    for k in SEG_ORDER:
        v = d.get(k)
        if isinstance(v, dict) and v.get("points"):
            segs[k] = v
    rep("TRACK %s" % TRACK_PATH)
    for k, v in segs.items():
        rep("  %-20s %8.2f km  %5d points" % (k, v["km_total"], len(v["points"])))
    missing = [k for k in SEG_ORDER if k not in segs]
    if missing:
        rep("  ! segments missing/null in track.json: %s" % missing)
    return segs


def build_index(segs):
    """Spatial grid over all track edges for point->polyline snapping."""
    edges = []   # (la1, lo1, la2, lo2, cum1_km, cum2_km, segname)
    grid = {}
    for name in SEG_ORDER:
        s = segs.get(name)
        if not s:
            continue
        pts = s["points"]
        cum = s["cum_km"]
        for i in range(len(pts) - 1):
            la1, lo1 = pts[i][0], pts[i][1]
            la2, lo2 = pts[i + 1][0], pts[i + 1][1]
            eid = len(edges)
            edges.append((la1, lo1, la2, lo2, cum[i], cum[i + 1], name))
            x0 = int(math.floor(min(la1, la2) / CELL))
            x1 = int(math.floor(max(la1, la2) / CELL))
            y0 = int(math.floor(min(lo1, lo2) / CELL))
            y1 = int(math.floor(max(lo1, lo2) / CELL))
            for cx in range(x0, x1 + 1):
                for cy in range(y0, y1 + 1):
                    grid.setdefault((cx, cy), []).append(eid)
    log("  snap index: %d edges in %d cells" % (len(edges), len(grid)))
    return edges, grid


def make_snapper(edges, grid, seg_total):
    def snap(la, lo, cutoff_m):
        """Nearest segment + km. Returns (seg, km, dist_m) or None.

        When two segments run on the same streets (valcarlos/frances at SJPP
        and Roncesvalles, link/epilogos at Fisterra and Muxía) and their
        distances differ by less than TIE_M, the earlier segment in SEG_ORDER
        wins, so shared-corridor features stay on the main line.
        """
        kx = 111320.0 * math.cos(math.radians(la))
        ky = 110540.0
        px, py = lo * kx, la * ky
        ccx = int(math.floor(la / CELL))
        ccy = int(math.floor(lo / CELL))
        best = {}   # seg -> (d, km)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for eid in grid.get((ccx + dx, ccy + dy), ()):
                    la1, lo1, la2, lo2, c1, c2, name = edges[eid]
                    ax, ay = lo1 * kx, la1 * ky
                    bx, by = lo2 * kx, la2 * ky
                    ddx, ddy = bx - ax, by - ay
                    L2 = ddx * ddx + ddy * ddy
                    if L2 <= 0.0:
                        t = 0.0
                    else:
                        t = ((px - ax) * ddx + (py - ay) * ddy) / L2
                        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                    qx, qy = ax + t * ddx, ay + t * ddy
                    ex, ey = px - qx, py - qy
                    d = math.sqrt(ex * ex + ey * ey)
                    cur = best.get(name)
                    if cur is None or d < cur[0]:
                        best[name] = (d, c1 + t * (c2 - c1))
        if not best:
            return None
        dmin = min(d for d, _ in best.values())
        if dmin > cutoff_m:
            return None
        for name in SEG_ORDER:            # tie-break toward main segments
            if name in best and best[name][0] <= dmin + TIE_M:
                d, km = best[name]
                return name, min(km, seg_total[name]), d
        return None
    return snap


# --------------------------------------------------------------- Overpass tiles

def make_tiles(segs):
    tiles = []
    for name in SEG_ORDER:
        s = segs.get(name)
        if not s:
            continue
        pts = s["points"]
        cum = s["cum_km"]
        n = len(pts)
        start = 0
        idx = 0
        while start < n - 1:
            base = cum[start]
            end = start
            while end < n - 1 and cum[end + 1] - base <= TILE_KM:
                end += 1
            if end == start:
                end = start + 1
            chunk = pts[start:end + 1]
            lats = [p[0] for p in chunk]
            lons = [p[1] for p in chunk]
            mid = 0.5 * (min(lats) + max(lats))
            plat = PAD_M / 111320.0
            plon = PAD_M / (111320.0 * math.cos(math.radians(mid)))
            tiles.append((name, idx,
                          (min(lats) - plat, min(lons) - plon,
                           max(lats) + plat, max(lons) + plon)))
            idx += 1
            start = end
    rep("TILES: %d bbox tiles (~%.0f km of track each, pad %.0f m)"
        % (len(tiles), TILE_KM, PAD_M))
    return tiles


def fetch_tiles(tiles, refresh):
    elems = {}    # (type, id) -> {lat, lon, tags}
    places = {}   # node id -> {lat, lon, tags}
    for i, (seg, idx, (s, w, n, e)) in enumerate(tiles):
        b = "%.5f,%.5f,%.5f,%.5f" % (s, w, n, e)
        q = QUERY_TMPL % {"A": AMENITY_RE, "S": SHOP_RE, "T": TOURISM_RE,
                          "P": PLACE_RE, "b": b}
        j = overpass(q, "poi_%s_t%02d" % (seg, idx), refresh)
        new = 0
        for el in j.get("elements", []):
            et = el.get("type")
            tags = el.get("tags") or {}
            if et == "node":
                la, lo = el.get("lat"), el.get("lon")
            else:
                c = el.get("center") or {}
                la, lo = c.get("lat"), c.get("lon")
            if la is None or lo is None:
                continue
            key = (et, el["id"])
            if key not in elems:
                elems[key] = {"lat": la, "lon": lo, "tags": tags}
                new += 1
            if et == "node" and tags.get("place") in PLACE_TYPES:
                places[el["id"]] = {"lat": la, "lon": lo, "tags": tags}
        log("  tile %2d/%d [%s#%02d]: +%d new elements (running total %d)"
            % (i + 1, len(tiles), seg, idx, new, len(elems)))
    rep("FETCH: %d unique OSM elements, %d place-node candidates"
        % (len(elems), len(places)))
    return elems, places


# --------------------------------------------------------------- classification

def classify(tags, stats):
    """Return list of category dicts [{'t':..., 'np':1?, 'alb':1?}] for one element."""
    cats = []
    am = tags.get("amenity")
    sh = tags.get("shop")
    to = tags.get("tourism")
    nat = tags.get("natural")
    dw = tags.get("drinking_water")
    name = tags.get("name", "")

    if dw == "no" and (am in ("drinking_water", "fountain") or nat == "spring"):
        stats["water_excluded_dw_no"] += 1
    elif am == "drinking_water":
        cats.append({"t": "water"})
    elif am == "fountain":
        if dw == "yes":
            cats.append({"t": "water"})
        else:
            stats["fountain_excluded_no_dw_yes"] += 1
            if nat == "spring":
                cats.append({"t": "water", "np": 1})
    elif nat == "spring":
        cats.append({"t": "water", "np": 1})

    if am == "pharmacy":
        cats.append({"t": "pharmacy"})
    if am == "atm" or (am == "bank" and tags.get("atm") == "yes"):
        cats.append({"t": "atm"})
    elif am == "bank":
        stats["bank_without_atm_yes"] += 1
    if sh in SHOPS:
        cats.append({"t": "shop"})
    if am in FOODS:
        cats.append({"t": "food"})
    if to in SLEEPS:
        c = {"t": "sleep"}
        if to == "hostel" or ALB_RE.search(name):
            c["alb"] = 1
        cats.append(c)
    return cats


def build_poi_records(elems, snap, seg_total):
    stats = Counter()
    recs = []
    for (et, eid), el in sorted(elems.items()):
        cats = classify(el["tags"], stats)
        if not cats:
            stats["no_category"] += 1
            continue
        sn = snap(el["lat"], el["lon"], POI_MAX_M)
        if sn is None:
            stats["outside_400m"] += 1
            continue
        seg, km, _d = sn
        name = el["tags"].get("name")
        for c in cats:
            r = {"t": c["t"]}
            if name:
                r["n"] = name
            r["lat"] = round(el["lat"], 5)
            r["lon"] = round(el["lon"], 5)
            r["seg"] = seg
            r["km"] = round(km, 2)
            if c.get("np"):
                r["np"] = 1
            if c.get("alb"):
                r["alb"] = 1
            r["_id"] = "%s%d" % (et[0], eid)
            recs.append(r)
            stats["cat_" + c["t"]] += 1
    return recs, stats


def dedupe_pois(recs):
    """Same category within 40 m -> keep one; named first, then albergue-flagged."""
    order = sorted(recs, key=lambda p: (0 if p.get("n") else 1,
                                        0 if p.get("alb") else 1,
                                        SEG_IDX[p["seg"]], p["km"], p["_id"]))
    grid = {}
    kept = []
    dropped = Counter()
    for p in order:
        cx = int(math.floor(p["lat"] / CELL_S))
        cy = int(math.floor(p["lon"] / CELL_S))
        dup = False
        for dx in (-1, 0, 1):
            if dup:
                break
            for dy in (-1, 0, 1):
                for q in grid.get((p["t"], cx + dx, cy + dy), ()):
                    if hav((p["lat"], p["lon"]), (q["lat"], q["lon"])) <= DEDUP_M:
                        dup = True
                        break
                if dup:
                    break
        if dup:
            dropped[p["t"]] += 1
        else:
            kept.append(p)
            grid.setdefault((p["t"], cx, cy), []).append(p)
    kept.sort(key=lambda p: (SEG_IDX[p["seg"]], p["km"], p["t"], p.get("n", "")))
    for p in kept:
        del p["_id"]
    return kept, dropped


# --------------------------------------------------------------- localities

def build_localities(places, snap, pois):
    cands = []
    skipped_noname = 0
    outside = 0
    for pid in sorted(places):
        el = places[pid]
        tags = el["tags"]
        name = tags.get("name")
        if not name:
            skipped_noname += 1
            continue
        sn = snap(el["lat"], el["lon"], PLACE_MAX_M)
        if sn is None:
            outside += 1
            continue
        seg, km, d = sn
        cands.append({"name": name, "lat": round(el["lat"], 5),
                      "lon": round(el["lon"], 5), "seg": seg,
                      "km": round(km, 2), "place": tags["place"],
                      "pop": parse_pop(tags.get("population")),
                      "rank": RANK[tags["place"]]})
    rep("PLACES: %d candidates in corridor (1500 m); %d outside; %d nameless skipped"
        % (len(cands), outside, skipped_noname))

    cands.sort(key=lambda c: (-c["rank"], -(c["pop"] or 0), c["name"]))
    kept = []
    merged = []
    for c in cands:
        winner = None
        for k in kept:
            if hav((c["lat"], c["lon"]), (k["lat"], k["lon"])) <= PLACE_MERGE_M:
                winner = k
                break
        if winner is None:
            kept.append(c)
        else:
            merged.append("%s (%s) -> %s (%s)"
                          % (c["name"], c["place"], winner["name"], winner["place"]))
    if merged:
        rep("  merged %d places within %.0f m of a higher rank:" % (len(merged), PLACE_MERGE_M))
        for m in merged:
            rep("    - %s" % m)

    out = []
    for L in kept:
        w = f = s = ph = atm = sl = alb = 0
        for P in pois:
            near = (P["seg"] == L["seg"] and abs(P["km"] - L["km"]) <= WINDOW_KM)
            if not near:
                if (abs(P["lat"] - L["lat"]) < 0.012 and abs(P["lon"] - L["lon"]) < 0.016
                        and hav((P["lat"], P["lon"]), (L["lat"], L["lon"])) <= SERVICE_R_M):
                    near = True
            if not near:
                continue
            t = P["t"]
            if t == "water":
                w += 1
            elif t == "food":
                f += 1
            elif t == "shop":
                s += 1
            elif t == "pharmacy":
                ph += 1
            elif t == "atm":
                atm += 1
            elif t == "sleep":
                sl += 1
                if P.get("alb"):
                    alb += 1
        r = {"name": L["name"], "lat": L["lat"], "lon": L["lon"], "seg": L["seg"],
             "km": L["km"], "place": L["place"]}
        if L["pop"] is not None:
            r["pop"] = L["pop"]
        r.update({"w": w, "f": f, "s": s, "ph": ph, "atm": atm, "sl": sl, "alb": alb})
        out.append(r)
    out.sort(key=lambda r: (SEG_IDX[r["seg"]], r["km"], r["name"]))
    return out


# --------------------------------------------------------------- validation

EXPECTED_FRANCES = [
    ("Roncesvalles", 23), ("Zubiri", 45), ("Pamplona", 65),
    ("Puente la Reina", 89), ("Estella", 110), ("Los Arcos", 131),
    ("Logroño", 158), ("Nájera", 186), ("Burgos", 278),
    ("Carrión de los Condes", 361), ("Sahagún", 397), ("León", 454),
    ("Astorga", 502), ("Ponferrada", 554), ("O Cebreiro", 604),
    ("Sarria", 642), ("Portomarín", 664), ("Santiago de Compostela", None),
]

# Towns in the first ~160 km that guidebooks (Gronze/Brierley) list with at
# least one albergue — used only for the OSM-gap spot check, never to add data.
ALBERGUE_TOWNS_160 = [
    "roncesvalles", "burguete", "auritz", "espinal", "aurizberri",
    "bizkarreta", "viscarret", "lintzoain", "zubiri", "larrasoana",
    "zabaldika", "irotz", "trinidad de arre", "villava", "atarrabia",
    "burlada", "pamplona", "cizur menor", "zariquiegui", "uterga",
    "muruzabal", "obanos", "puente la reina", "gares", "maneru", "cirauqui",
    "lorca", "villatuerta", "estella", "lizarra", "ayegui", "azqueta",
    "villamayor de monjardin", "los arcos", "sansol", "torres del rio",
    "viana", "logrono",
]


def find_locality(locs, wanted, expected_km):
    wn = nrm(wanted)
    cands = []
    for L in locs:
        parts = name_parts(L["name"])
        exact = wn in parts
        sub = any(wn in p or p in wn for p in parts if len(p) >= 4)
        if exact or sub:
            cands.append((0 if exact else 1, L))
    if not cands:
        return None
    if expected_km is not None:
        cands.sort(key=lambda c: (c[0], abs(c[1]["km"] - expected_km)
                                  + (0 if c[1]["seg"] == "frances" else 1000)))
    else:
        cands.sort(key=lambda c: (c[0], -c[1]["km"]))
    return cands[0][1]


def validate(segs, pois, locs, stats, dropped):
    anomalies = []
    rep("=" * 78)
    rep("VALIDATION")

    # -- locality counts ------------------------------------------------------
    per_seg = Counter(L["seg"] for L in locs)
    by_type = {}
    for L in locs:
        by_type.setdefault(L["seg"], Counter())[L["place"]] += 1
    rep("localities per segment:")
    for s in SEG_ORDER:
        if per_seg.get(s):
            rep("  %-20s %4d   %s" % (s, per_seg[s], dict(sorted(by_type[s].items()))))
    nf = per_seg.get("frances", 0)
    ok = 120 <= nf <= 260
    rep("frances locality count = %d (expected roughly 120-260) -> %s"
        % (nf, "OK" if ok else "OUT OF RANGE"))
    if not ok:
        anomalies.append("frances locality count %d outside 120-260" % nf)

    # -- expected towns table -------------------------------------------------
    fr_end = segs["frances"]["km_total"]
    rep("-" * 78)
    rep("expected towns (guidebook km; OSM track is ~1%% shorter):")
    rep("  %-26s %8s %8s %7s  %-8s %-19s %s" %
        ("town", "exp_km", "km", "delta", "seg", "place/pop", "sl/alb"))
    for wanted, exp in EXPECTED_FRANCES:
        L = find_locality(locs, wanted, exp)
        expv = exp if exp is not None else fr_end
        if L is None:
            rep("  %-26s %8s %8s %7s  MISSING from localities.json" %
                (wanted, expv, "-", "-"))
            anomalies.append("expected town missing: %s" % wanted)
            continue
        delta = L["km"] - expv
        mark = "" if abs(delta) <= 8 and L["seg"] == "frances" else "  <-- CHECK"
        if mark:
            anomalies.append("%s found at %s km %.1f (expected ~%s)"
                             % (wanted, L["seg"], L["km"], expv))
        rep("  %-26s %8.0f %8.2f %+7.2f  %-8s %-19s %d/%d%s"
            % (L["name"][:26], expv, L["km"], delta, L["seg"],
               "%s/%s" % (L["place"], L.get("pop", "-")), L["sl"], L["alb"], mark))

    # -- dry gap Carrión -> Calzadilla de la Cueza ----------------------------
    rep("-" * 78)
    carrion = find_locality(locs, "Carrión de los Condes", 361)
    calzadilla = find_locality(locs, "Calzadilla de la Cueza", 378)
    if carrion and calzadilla and carrion["seg"] == calzadilla["seg"] == "frances":
        a, b = carrion["km"] + WINDOW_KM, calzadilla["km"] - WINDOW_KM
        inside = [p for p in pois
                  if p["seg"] == "frances" and a < p["km"] < b]
        cnt = Counter(p["t"] for p in inside)
        rep("dry gap Carrión (km %.2f) -> Calzadilla de la Cueza (km %.2f), %.1f km:"
            % (carrion["km"], calzadilla["km"], calzadilla["km"] - carrion["km"]))
        rep("  POIs strictly inside (excluding the towns' own ±%.1f km): %s"
            % (WINDOW_KM, dict(sorted(cnt.items())) or "NONE"))
        for p in inside:
            rep("    - %-8s km %7.2f  %s%s" %
                (p["t"], p["km"], p.get("n", "(unnamed)"),
                 " [np]" if p.get("np") else ""))
        nfs = cnt.get("food", 0) + cnt.get("shop", 0)
        rep("  food+shop in gap = %d (guidebooks: famous 17 km with no services)" % nfs)
        if nfs > 2:
            anomalies.append("dry gap Carrión->Calzadilla has %d food/shop POIs" % nfs)
    else:
        rep("dry gap check SKIPPED — Carrión or Calzadilla not found on frances")
        anomalies.append("dry-gap towns not found")

    # -- category x segment counts -------------------------------------------
    rep("-" * 78)
    cats = ["water", "food", "shop", "sleep", "pharmacy", "atm"]
    mat = {}
    for p in pois:
        mat.setdefault(p["seg"], Counter())[p["t"]] += 1
    rep("POI counts per category per segment:")
    rep("  %-20s %6s %6s %6s %6s %6s %6s %7s %6s %6s" %
        ("segment", "water", "food", "shop", "sleep", "pharm", "atm", "TOTAL", "alb", "np"))
    for s in SEG_ORDER:
        if s not in mat:
            continue
        c = mat[s]
        alb = sum(1 for p in pois if p["seg"] == s and p.get("alb"))
        npn = sum(1 for p in pois if p["seg"] == s and p.get("np"))
        rep("  %-20s %6d %6d %6d %6d %6d %6d %7d %6d %6d" %
            (s, c["water"], c["food"], c["shop"], c["sleep"], c["pharmacy"],
             c["atm"], sum(c.values()), alb, npn))
    tot = Counter(p["t"] for p in pois)
    rep("  %-20s %6d %6d %6d %6d %6d %6d %7d %6d %6d" %
        ("TOTAL", tot["water"], tot["food"], tot["shop"], tot["sleep"],
         tot["pharmacy"], tot["atm"], len(pois),
         sum(1 for p in pois if p.get("alb")),
         sum(1 for p in pois if p.get("np"))))

    # -- albergue OSM-gap spot check, frances km 0-160 ------------------------
    rep("-" * 78)
    zero = [L for L in locs
            if L["seg"] == "frances" and L["km"] <= 160.0
            and L["sl"] == 0 and L["alb"] == 0]
    known = []
    for L in zero:
        parts = name_parts(L["name"])
        if any(any(k in p or p in k for p in parts if len(p) >= 4)
               for k in ALBERGUE_TOWNS_160):
            known.append(L)
    rep("frances km 0-160: %d localities with sl=0 AND alb=0 (of %d)"
        % (len(zero), sum(1 for L in locs if L["seg"] == "frances" and L["km"] <= 160)))
    if known:
        rep("  of these, guidebooks DO list albergues in (OSM data gap, NOT fabricated):")
        for L in known:
            rep("    - %-28s km %7.2f  place=%s" % (L["name"], L["km"], L["place"]))
        anomalies.append("%d localities km 0-160 have guidebook albergues but sl=alb=0 in OSM: %s"
                         % (len(known), ", ".join(L["name"] for L in known)))
    else:
        rep("  none of them is a known guidebook albergue town — no OSM gap detected here")
    others = [L["name"] for L in zero if L not in known]
    if others:
        rep("  (remaining zero-service localities, plausible: %s)" % ", ".join(others))

    # -- classification stats -------------------------------------------------
    rep("-" * 78)
    rep("classification stats:")
    for k in sorted(stats):
        rep("  %-34s %6d" % (k, stats[k]))
    rep("dedupe (<=%.0f m, same category) removed: %s"
        % (DEDUP_M, dict(sorted(dropped.items())) or "none"))
    return anomalies


# --------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ignore tools/cache")
    args = ap.parse_args()
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()

    segs = load_track()
    seg_total = {k: v["km_total"] for k, v in segs.items()}
    edges, grid = build_index(segs)
    snap = make_snapper(edges, grid, seg_total)
    tiles = make_tiles(segs)
    elems, places = fetch_tiles(tiles, args.refresh)

    raw, stats = build_poi_records(elems, snap, seg_total)
    pois, dropped = dedupe_pois(raw)
    rep("POIS: %d records after dedupe (%d before, %d elements had no category, "
        "%d matched elements outside 400 m)"
        % (len(pois), len(raw), stats["no_category"], stats["outside_400m"]))

    locs = build_localities(places, snap, pois)

    meta_common = {
        "built": time.strftime("%Y-%m-%d"),
        "source": "OpenStreetMap, © OpenStreetMap contributors, ODbL",
    }
    pois_out = {"meta": dict(meta_common,
                             corridor_m=int(POI_MAX_M),
                             fields="t n? lat lon seg km np? alb?"),
                "pois": pois}
    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois_out, f, separators=(",", ":"), ensure_ascii=False)
    locs_out = {"meta": dict(meta_common,
                             corridor_m=int(PLACE_MAX_M),
                             service_rule="POIs with same seg and |km diff|<=0.8, "
                                          "OR within 1000 m of the place node",
                             fields="name lat lon seg km place pop? w f s ph atm sl alb"),
                "localities": locs}
    with open(LOC_PATH, "w", encoding="utf-8") as f:
        json.dump(locs_out, f, separators=(",", ":"), ensure_ascii=False)

    anomalies = validate(segs, pois, locs, stats, dropped)

    rep("=" * 78)
    rep("WROTE %s  (%.1f KB, %d records)"
        % (POIS_PATH, os.path.getsize(POIS_PATH) / 1024.0, len(pois)))
    rep("WROTE %s  (%.1f KB, %d records)"
        % (LOC_PATH, os.path.getsize(LOC_PATH) / 1024.0, len(locs)))
    rep("ANOMALIES (%d):" % len(anomalies))
    for a in anomalies:
        rep("  ! %s" % a)
    if not anomalies:
        rep("  none")
    rep("elapsed %.1f s. Rerun: python %s  (add --refresh to refetch Overpass; "
        "warm cache in tools/cache/op_poi_*.json makes reruns offline)"
        % (time.time() - t0, os.path.abspath(__file__)))

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(REPORT) + "\n")
    log("report copy: %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
