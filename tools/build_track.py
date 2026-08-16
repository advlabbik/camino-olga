#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_track.py — build data/track.json for the Camino de Santiago companion app.

Pulls from OpenStreetMap (Overpass API):
  * frances            — Camino Francés main line, SJPP -> Santiago (numbered
                         section relations "Camino Francés - NN", umbrella 66261)
  * valcarlos          — day-1 bad-weather variant SJPP -> Roncesvalles via
                         Arnéguy / Valcarlos-Luzaide / Puerto de Ibañeta
  * epilogo_fisterra   — Santiago -> Fisterra (+ spur to the Faro) from
                         relation 385098 "Camiño de Fisterra-Muxía"
  * epilogo_muxia      — the Hospital -> Muxía branch of the same relation
  * link_fisterra_muxia (extra, nullable) — coastal Fisterra -> Muxía link

Method: fetch relations + member ways with geometry, split ways at T-junctions,
cluster endpoints (30 m), build a graph, route with Dijkstra through via
anchors (main-role ways preferred; "alternative"/"variant" members are used
only when needed or for the valcarlos segment). Gaps <=150 m are bridged and
counted; larger gaps are bridged too but FLAGGED. Lines are Douglas-Peucker
simplified (12 m), elevation added from the Open-Meteo Elevation API,
cumulative km computed with haversine.

Usage (any cwd):
    python C:/CoworkClaude/camino-olga/tools/build_track.py
    python .../build_track.py --discover        # discovery queries only
    python .../build_track.py --refresh         # ignore tools/cache, refetch
    python .../build_track.py --skip-elevation  # debug: no elevation calls
    python .../build_track.py --only frances,valcarlos

All network responses are cached in tools/cache/ — a rerun with a warm cache
is offline and deterministic. Output: data/track.json, plus a copy of the
build report in tools/cache/build_report.txt.

Data © OpenStreetMap contributors, ODbL. Elevation © Open-Meteo (Copernicus DEM).
"""

import argparse
import hashlib
import heapq
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(BASE, "tools", "cache")
DATA_DIR = os.path.join(BASE, "data")
OUT_PATH = os.path.join(DATA_DIR, "track.json")
REPORT_PATH = os.path.join(CACHE_DIR, "build_report.txt")

OVERPASS_ENDPOINTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
ELEV_URL = "https://api.open-meteo.com/v1/elevation"
USER_AGENT = "camino-olga-track-builder/1.0 (personal Camino companion app)"

OVERPASS_GAP_S = 4.0     # politeness gap between Overpass queries
ELEV_GAP_S = 1.0         # gap between elevation batches
MATCH_TOL_M = 30.0       # endpoint clustering tolerance
BRIDGE_MAX_M = 150.0     # bridges up to this are "normal" (counted)
DP_TOL_M = 12.0          # Douglas-Peucker tolerance
ANCHOR_MAX_M = 1500.0    # a via anchor further than this from any node is skipped
ELEV_BUDGET = 12000      # above this many total points, thin elevation sampling
INF = float("inf")

UMBRELLA_FRANCES = 66261
REL_FISTERRA_MUXIA = 385098
MAIN_ROLES = {"", "main", "forward", "backward"}
SECTION_RE = re.compile(r"[Cc]ami[nñ]o\s+[Ff]ranc[eé]s\s*[-–—]\s*(\d+)")

ANCHORS = {
    "sjpp": (43.1632, -1.2380),
    "orisson": (43.1320, -1.2880),
    "lepoeder": (43.0220, -1.3050),
    "roncesvalles": (43.0093, -1.3199),
    "pamplona": (42.8125, -1.6458),
    "logrono": (42.4660, -2.4450),
    "burgos": (42.3409, -3.7003),
    "leon": (42.5987, -5.5671),
    "sarria": (42.7810, -7.4140),
    "santiago": (42.8806, -8.5446),
    "arneguy": (43.1153, -1.2843),
    "valcarlos": (43.0930, -1.2900),
    "ibaneta": (43.0207, -1.3212),
    "negreira": (42.9090, -8.7350),
    "cee": (42.9550, -9.1890),
    "fisterra_town": (42.9046, -9.2634),
    "faro_fisterra": (42.8820, -9.2710),
    "muxia": (43.1080, -9.2185),
    "lires": (42.99818, -9.24397),   # Lires hamlet (OSM place node)
    "hospital_ref": (42.9900, -9.0600),   # reporting only: expected Muxía split area
}

FRANCES_VIAS = ["sjpp", "orisson", "lepoeder", "roncesvalles", "pamplona",
                "logrono", "burgos", "leon", "sarria", "santiago"]
VALCARLOS_VIAS = ["sjpp", "arneguy", "valcarlos", "ibaneta", "roncesvalles"]
FISTERRA_VIAS = ["santiago", "negreira", "cee", "fisterra_town"]
LINK_VIAS = ["fisterra_town", "lires", "muxia"]
FRANCES_CHECKPOINTS = ["roncesvalles", "pamplona", "logrono", "burgos", "leon", "sarria"]

REPORT_LINES = []


def log(msg):
    line = time.strftime("[%H:%M:%S] ") + msg
    print(line, flush=True)


def rep(msg):
    """Log AND keep for the final report file."""
    REPORT_LINES.append(msg)
    log(msg)


# ----------------------------------------------------------------------------- geometry

R_EARTH = 6371000.0


def hav(a, b):
    la1, lo1 = a[0], a[1]
    la2, lo2 = b[0], b[1]
    p1 = math.radians(la1)
    p2 = math.radians(la2)
    dp = p2 - p1
    dl = math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(h)))


def poly_len(pts):
    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def prethin(pts, min_m=2.0):
    """Drop consecutive near-duplicate vertices before DP (speed)."""
    out = [pts[0]]
    for p in pts[1:]:
        if hav(out[-1], p) >= min_m:
            out.append(p)
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def dp_simplify(pts, tol_m):
    """Iterative Douglas-Peucker on an equirectangular local projection."""
    n = len(pts)
    if n < 3:
        return pts[:]
    lat0 = pts[n // 2][0]
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    P = [(p[1] * kx, p[0] * ky) for p in pts]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tol_m * tol_m
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = P[i]
        bx, by = P[j]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        dmax = -1.0
        imax = -1
        for k in range(i + 1, j):
            px, py = P[k]
            if L2 == 0.0:
                ex, ey = px - ax, py - ay
                d2 = ex * ex + ey * ey
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / L2
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                qx, qy = ax + t * dx, ay + t * dy
                ex, ey = px - qx, py - qy
                d2 = ex * ex + ey * ey
            if d2 > dmax:
                dmax = d2
                imax = k
        if dmax > tol2:
            keep[imax] = True
            stack.append((i, imax))
            stack.append((imax, j))
    return [p for p, k in zip(pts, keep) if k]


def min_dist_to_line(pts, target):
    """Min distance (m) from target to the polyline (point-to-segment)."""
    tla, tlo = target
    kx = 111320.0 * math.cos(math.radians(tla))
    ky = 110540.0
    tx, ty = tlo * kx, tla * ky
    best = INF
    ax, ay = pts[0][1] * kx, pts[0][0] * ky
    for i in range(1, len(pts)):
        bx, by = pts[i][1] * kx, pts[i][0] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 <= 0.0:
            ex, ey = tx - ax, ty - ay
            d2 = ex * ex + ey * ey
        else:
            t = ((tx - ax) * dx + (ty - ay) * dy) / L2
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0
            qx, qy = ax + t * dx, ay + t * dy
            ex, ey = tx - qx, ty - qy
            d2 = ex * ex + ey * ey
        if d2 < best:
            best = d2
        ax, ay = bx, by
    return math.sqrt(best)


# ----------------------------------------------------------------------------- network

_last_overpass = [0.0]
_last_elev = [0.0]


def overpass(query, tag, refresh=False):
    h = hashlib.md5(query.encode("utf-8")).hexdigest()[:10]
    cf = os.path.join(CACHE_DIR, "op_%s_%s.json" % (tag, h))
    if not refresh and os.path.exists(cf):
        with open(cf, encoding="utf-8") as f:
            return json.load(f)
    for attempt in range(6):
        ep = OVERPASS_ENDPOINTS[min(attempt // 2, 1)]
        gap = OVERPASS_GAP_S - (time.time() - _last_overpass[0])
        if gap > 0:
            time.sleep(gap)
        log("  Overpass [%s] via %s (attempt %d)" % (tag, ep.split("/")[2], attempt + 1))
        try:
            body = urllib.parse.urlencode({"data": query}).encode("utf-8")
            req = urllib.request.Request(ep, data=body, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
            _last_overpass[0] = time.time()
            j = json.loads(raw.decode("utf-8"))
            if "elements" not in j:
                raise ValueError("response has no elements")
            with open(cf, "w", encoding="utf-8") as f:
                json.dump(j, f)
            log("    ok, %d elements (%.1f MB)" % (len(j["elements"]), len(raw) / 1e6))
            return j
        except Exception as e:
            _last_overpass[0] = time.time()
            code = getattr(e, "code", None)
            wait = [15, 30, 20, 60, 120, 180][attempt]
            log("    FAIL (%s) — backoff %ds" % (code or repr(e)[:120], wait))
            time.sleep(wait)
    raise RuntimeError("Overpass gave up on query tag=%s" % tag)


def fetch_elev_batch(coords, refresh=False):
    """coords: list of (lat, lon) — max 100. Returns list of floats/None."""
    key_src = ";".join("%.5f,%.5f" % (la, lo) for la, lo in coords)
    key = hashlib.md5(key_src.encode()).hexdigest()[:14]
    cf = os.path.join(CACHE_DIR, "ele_%s.json" % key)
    if not refresh and os.path.exists(cf):
        with open(cf, encoding="utf-8") as f:
            return json.load(f)
    url = (ELEV_URL + "?latitude=" + ",".join("%.5f" % la for la, lo in coords)
           + "&longitude=" + ",".join("%.5f" % lo for la, lo in coords))
    for attempt in range(4):
        gap = ELEV_GAP_S - (time.time() - _last_elev[0])
        if gap > 0:
            time.sleep(gap)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            _last_elev[0] = time.time()
            j = json.loads(raw.decode("utf-8"))
            ele = j.get("elevation")
            if isinstance(ele, list) and len(ele) == len(coords):
                with open(cf, "w", encoding="utf-8") as f:
                    json.dump(ele, f)
                return ele
            raise ValueError("bad elevation payload")
        except Exception as e:
            _last_elev[0] = time.time()
            wait = [3, 8, 20, 30][attempt]
            log("    elevation batch FAIL (%s) — backoff %ds" % (repr(e)[:100], wait))
            time.sleep(wait)
    return [None] * len(coords)


# ----------------------------------------------------------------------------- OSM parsing

def q_rel_full(rid):
    return "[out:json][timeout:180];relation(%d);out body;way(r);out geom;" % rid


Q_DISCOVER = """[out:json][timeout:180];
(
  relation["route"="hiking"]["name"~"[Cc]ami[nñ]o [Ff]ranc"];
  relation["route"="hiking"]["name"~"Fisterra|Finisterre|Mux[ií]a"];
  relation["route"="hiking"]["name"~"Valcarlos|Luzaide"];
);
out tags;"""


def discover(refresh):
    j = overpass(Q_DISCOVER, "discover", refresh)
    matches = [(e["id"], (e.get("tags") or {}).get("name", ""))
               for e in j.get("elements", []) if e.get("type") == "relation"]
    ju = overpass("[out:json][timeout:180];relation(%d);out body;" % UMBRELLA_FRANCES,
                  "umbrella_body", refresh)
    umb = None
    for e in ju.get("elements", []):
        if e.get("type") == "relation" and e.get("id") == UMBRELLA_FRANCES:
            umb = e
    umb_members = [m["ref"] for m in (umb or {}).get("members", [])
                   if m.get("type") == "relation"]

    sections = {}
    for rid, name in matches:
        m = SECTION_RE.search(name or "")
        if m:
            sections[rid] = (int(m.group(1)), name)
    ordered_sections = [rid for rid, _v in
                        sorted(sections.items(), key=lambda kv: (kv[1][0], kv[0]))]

    valcarlos_rels = [rid for rid, name in matches
                      if rid not in sections and re.search(r"Valcarlos|Luzaide", name or "")]
    alt_rels = [rid for rid, name in matches
                if rid not in sections and rid not in valcarlos_rels
                and re.search(r"[Aa]lternativ|[Vv]ariante", name or "")
                and re.search(r"[Cc]ami[nñ]o [Ff]ranc", name or "")]
    fisterra_rels = [rid for rid, name in matches
                     if re.search(r"Fisterra|Finisterre|Mux", name or "")]

    rep("DISCOVERY")
    rep("  umbrella %d: %s — %d relation members: %s" % (
        UMBRELLA_FRANCES,
        (umb or {}).get("tags", {}).get("name", "«not found»"),
        len(umb_members), umb_members))
    rep("  name matches (%d):" % len(matches))
    for rid, name in sorted(matches):
        klass = ("SECTION %02d" % sections[rid][0]) if rid in sections else (
            "valcarlos?" if rid in valcarlos_rels else (
                "ALT-POOL" if rid in alt_rels else (
                    "fisterra?" if rid in fisterra_rels else "other")))
        rep("    %-10d %-11s %s" % (rid, klass, name))
    rep("  ordered sections: %s" % ordered_sections)
    return {
        "matches": matches,
        "sections": ordered_sections,
        "valcarlos_rels": valcarlos_rels,
        "alt_rels": alt_rels,
        "fisterra_rels": fisterra_rels,
        "umbrella_members": umb_members,
    }


def add_relation_ways(store, rid, main_rel, refresh, relnames):
    """Fetch relation rid (body + member way geometries) into store."""
    j = overpass(q_rel_full(rid), "rel_%d_full" % rid, refresh)
    rel = None
    for e in j.get("elements", []):
        if e.get("type") == "relation" and e.get("id") == rid:
            rel = e
    name = (rel or {}).get("tags", {}).get("name", "?")
    relnames[rid] = name
    roles = {}
    role_count = {}
    for m in (rel or {}).get("members", []):
        if m.get("type") == "way":
            role = m.get("role", "")
            roles.setdefault(m["ref"], set()).add(role)
            role_count[role] = role_count.get(role, 0) + 1
    nways = 0
    for e in j.get("elements", []):
        if e.get("type") != "way" or "geometry" not in e:
            continue
        geom = [(p["lat"], p["lon"]) for p in e["geometry"] if p]
        if len(geom) < 2:
            continue
        rset = roles.get(e["id"], {""})
        w = store.get(e["id"])
        if w is None:
            w = {"id": e["id"], "geom": geom, "tags": e.get("tags", {}) or {},
                 "roles": set(), "rels": set(), "main": False}
            store[e["id"]] = w
        w["roles"] |= rset
        w["rels"].add(rid)
        if main_rel and (rset & MAIN_ROLES):
            w["main"] = True
        nways += 1
    rep("  rel %d '%s': %d member ways with geometry; roles: %s%s" % (
        rid, name, nways,
        {k if k else "«blank»": v for k, v in sorted(role_count.items())},
        "" if main_rel else "  [loaded as ALT pool]"))
    return rel


# ----------------------------------------------------------------------------- graph

def _cellkey(p, cell_deg):
    return (int(math.floor(p[0] / cell_deg)),
            int(math.floor(p[1] * math.cos(math.radians(p[0])) / cell_deg)))


def split_at_junctions(store):
    """Split member ways at interior vertices that touch another way's endpoint
    (T-junctions where OSM did not split the through-way)."""
    cell_deg = MATCH_TOL_M / 111320.0
    grid = {}
    for w in store.values():
        for p in (w["geom"][0], w["geom"][-1]):
            grid.setdefault(_cellkey(p, cell_deg), []).append((p, w["id"]))
    subways = []
    nsplits = 0
    for w in store.values():
        g = w["geom"]
        cuts = {0, len(g) - 1}
        for k in range(1, len(g) - 1):
            p = g[k]
            gx, gy = _cellkey(p, cell_deg)
            hit = False
            for dx in (-1, 0, 1):
                if hit:
                    break
                for dy in (-1, 0, 1):
                    for (q, wid) in grid.get((gx + dx, gy + dy), ()):
                        if wid != w["id"] and hav(p, q) <= MATCH_TOL_M:
                            hit = True
                            break
                    if hit:
                        break
            if hit:
                cuts.add(k)
        cuts = sorted(cuts)
        if len(cuts) > 2:
            nsplits += len(cuts) - 2
        for a, b in zip(cuts, cuts[1:]):
            if b > a:
                subways.append({"wid": w["id"], "geom": g[a:b + 1], "main": w["main"],
                                "roles": w["roles"], "rels": w["rels"], "tags": w["tags"]})
    log("  split %d ways into %d sub-ways (%d T-junction cuts)"
        % (len(store), len(subways), nsplits))
    return subways


def build_graph(subways):
    pts = []
    for w in subways:
        pts.append(w["geom"][0])
        pts.append(w["geom"][-1])
    n = len(pts)
    parent = list(range(n))

    def find(x):
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    cell_deg = MATCH_TOL_M / 111320.0
    grid = {}
    for i, p in enumerate(pts):
        grid.setdefault(_cellkey(p, cell_deg), []).append(i)
    for (gx, gy), members in grid.items():
        for dx, dy in ((0, 0), (0, 1), (1, -1), (1, 0), (1, 1)):
            other = grid.get((gx + dx, gy + dy))
            if not other:
                continue
            for i in members:
                for jj in other:
                    if (dx, dy) == (0, 0) and jj <= i:
                        continue
                    if hav(pts[i], pts[jj]) <= MATCH_TOL_M:
                        union(i, jj)

    root_to_nid = {}
    acc = []
    ep_node = [0] * n
    for i in range(n):
        r = find(i)
        nid = root_to_nid.get(r)
        if nid is None:
            nid = len(acc)
            root_to_nid[r] = nid
            acc.append([0.0, 0.0, 0])
        ep_node[i] = nid
        acc[nid][0] += pts[i][0]
        acc[nid][1] += pts[i][1]
        acc[nid][2] += 1
    nodes = [(a / c, b / c) for a, b, c in acc]

    g = {"nodes": nodes, "edges": [], "adj": {}}

    def add_edge(u, v, kind, length, w=None):
        eid = len(g["edges"])
        g["edges"].append({"u": u, "v": v, "kind": kind, "len": length, "w": w})
        g["adj"].setdefault(u, []).append(eid)
        if v != u:
            g["adj"].setdefault(v, []).append(eid)
        return eid

    g["add_edge"] = add_edge

    have = set()
    for i, w in enumerate(subways):
        u = ep_node[2 * i]
        v = ep_node[2 * i + 1]
        add_edge(u, v, "way", poly_len(w["geom"]), w)
        have.add((min(u, v), max(u, v)))

    # candidate bridges between nearby (but unconnected) nodes
    ncell_deg = BRIDGE_MAX_M / 111320.0
    ngrid = {}
    for nid, p in enumerate(nodes):
        ngrid.setdefault(_cellkey(p, ncell_deg), []).append(nid)
    nbridges = 0
    for (gx, gy), members in ngrid.items():
        for dx, dy in ((0, 0), (0, 1), (1, -1), (1, 0), (1, 1)):
            other = ngrid.get((gx + dx, gy + dy))
            if not other:
                continue
            for u in members:
                for v in other:
                    if (dx, dy) == (0, 0) and v <= u:
                        continue
                    key = (min(u, v), max(u, v))
                    if key in have:
                        continue
                    d = hav(nodes[u], nodes[v])
                    if d <= BRIDGE_MAX_M:
                        add_edge(u, v, "bridge", d)
                        have.add(key)
                        nbridges += 1
    log("  graph: %d nodes, %d way-edges, %d candidate bridges"
        % (len(nodes), len(subways), nbridges))
    return g


def edge_cost(e, allow_alt, alt_pen):
    if e["kind"] == "way":
        if e["w"]["main"]:
            return e["len"]
        if not allow_alt:
            return None
        return e["len"] * alt_pen
    # bridge / bigbridge: heavy penalty so they are last resort
    return e["len"] * 5.0 + 200.0


def dijkstra(g, src, targets, allow_alt, alt_pen=1.2):
    dist = {src: 0.0}
    prev = {}
    pq = [(0.0, src)]
    done = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in done:
            continue
        done.add(u)
        if u in targets:
            npath = [u]
            epath = []
            cur = u
            while cur != src:
                p, e = prev[cur]
                epath.append(e)
                npath.append(p)
                cur = p
            npath.reverse()
            epath.reverse()
            return npath, epath
        for eid in g["adj"].get(u, ()):
            e = g["edges"][eid]
            w = edge_cost(e, allow_alt, alt_pen)
            if w is None:
                continue
            v = e["v"] if e["u"] == u else e["u"]
            if v == u:
                continue
            nd = d + w
            if nd < dist.get(v, INF):
                dist[v] = nd
                prev[v] = (u, eid)
                heapq.heappush(pq, (nd, v))
    return None


def reachable(g, src, allow_alt):
    seen = {src}
    stack = [src]
    while stack:
        u = stack.pop()
        for eid in g["adj"].get(u, ()):
            e = g["edges"][eid]
            if edge_cost(e, allow_alt, 1.0) is None:
                continue
            v = e["v"] if e["u"] == u else e["u"]
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return seen


def closest_pair(g, A, B):
    nodes = g["nodes"]
    La = list(A)
    Lb = list(B)
    best = (None, None, INF)
    # pragmatic sampling if the component pair is huge, then local refine
    sa = La[::max(1, len(La) // 3000)] if len(La) > 3000 else La
    sb = Lb[::max(1, len(Lb) // 3000)] if len(Lb) > 3000 else Lb
    for a in sa:
        pa = nodes[a]
        for b in sb:
            d = hav(pa, nodes[b])
            if d < best[2]:
                best = (a, b, d)
    # local refine around approx best
    if best[0] is not None and (len(sa) < len(La) or len(sb) < len(Lb)):
        pa0 = nodes[best[0]]
        pb0 = nodes[best[1]]
        near_a = [a for a in La if hav(nodes[a], pa0) < 5000]
        near_b = [b for b in Lb if hav(nodes[b], pb0) < 5000]
        for a in near_a:
            pa = nodes[a]
            for b in near_b:
                d = hav(pa, nodes[b])
                if d < best[2]:
                    best = (a, b, d)
    return best


def route_leg(g, a, b, allow_alt, alt_pen, seg, label=""):
    r = dijkstra(g, a, {b}, allow_alt, alt_pen)
    if r:
        return r
    if not allow_alt:
        r = dijkstra(g, a, {b}, True, alt_pen)
        if r:
            seg["alt_fallback_legs"] += 1
            seg.setdefault("fallback_leg_names", []).append(label)
            return r
    # graph is disconnected between a and b: connect components with flagged bridges
    for _ in range(8):
        ra = reachable(g, a, True)
        if b in ra:
            break
        rb = reachable(g, b, True)
        u, v, d = closest_pair(g, ra, rb)
        if u is None:
            return None
        g["add_edge"](u, v, "bigbridge", d)
        seg["forced_bridges"].append(
            {"m": round(d, 1), "from": [round(g["nodes"][u][0], 5), round(g["nodes"][u][1], 5)],
             "to": [round(g["nodes"][v][0], 5), round(g["nodes"][v][1], 5)]})
    return dijkstra(g, a, {b}, True, alt_pen)


def new_seg_report(name):
    return {"name": name, "anchors": [], "skipped_vias": [], "alt_fallback_legs": 0,
            "forced_bridges": [], "gaps_small": [], "gaps_big": [], "fail": None}


def nearest_node(g, pt):
    best = (None, INF)
    for nid, p in enumerate(g["nodes"]):
        d = hav(p, pt)
        if d < best[1]:
            best = (nid, d)
    return best


def assemble(g, via_names, allow_alt, alt_pen, seg, required=()):
    vias = []
    for nm in via_names:
        nid, d = nearest_node(g, ANCHORS[nm])
        seg["anchors"].append((nm, round(d, 1)))
        if d > ANCHOR_MAX_M:
            seg["skipped_vias"].append((nm, round(d)))
            if nm in required:
                seg["fail"] = "required via '%s' not on graph (nearest node %.0f m away)" % (nm, d)
                return None
            continue
        if not vias or vias[-1][1] != nid:
            vias.append((nm, nid))
    if len(vias) < 2:
        seg["fail"] = "fewer than 2 anchored vias"
        return None
    full_n = []
    full_e = []
    for (nma, a), (nmb, b) in zip(vias, vias[1:]):
        r = route_leg(g, a, b, allow_alt, alt_pen, seg, label="%s->%s" % (nma, nmb))
        if r is None:
            seg["fail"] = "no path between vias %s->%s (nodes %d -> %d)" % (nma, nmb, a, b)
            return None
        npath, epath = r
        if not full_n:
            full_n = npath
            full_e = epath
        else:
            # trim out-and-back spurs at the junction with the previous leg
            while full_e and epath and full_e[-1] == epath[0]:
                full_e.pop()
                full_n.pop()
                epath.pop(0)
                npath.pop(0)
            full_n.extend(npath[1:])
            full_e.extend(epath)
    return full_n, full_e


def path_points(g, npath, epath, seg):
    """Concatenate way geometries along the path. Returns (points, used_subways)."""
    pts = []
    used = []
    alt_run = None   # current run of consecutive non-main ways
    for i, eid in enumerate(epath):
        e = g["edges"][eid]
        u = npath[i]
        if e["kind"] != "way":
            entry = {"m": round(e["len"], 1),
                     "at": [round(g["nodes"][u][0], 5), round(g["nodes"][u][1], 5)]}
            if e["len"] <= BRIDGE_MAX_M:
                seg["gaps_small"].append(entry)
            else:
                seg["gaps_big"].append(entry)
            continue
        geo = e["w"]["geom"]
        if e["u"] == u:
            seq = geo
        elif e["v"] == u:
            seq = geo[::-1]
        else:
            continue
        used.append(e["w"])
        if not e["w"]["main"]:
            if alt_run is None:
                mid = geo[len(geo) // 2]
                alt_run = {"m": 0.0, "near": [round(mid[0], 5), round(mid[1], 5)],
                           "rels": set()}
                seg.setdefault("alt_chains", []).append(alt_run)
            alt_run["m"] += e["len"]
            alt_run["rels"] |= e["w"]["rels"]
        else:
            alt_run = None
        if pts and hav(pts[-1], seq[0]) < 0.5:
            pts.extend(seq[1:])
        else:
            pts.extend(seq)
    for run in seg.get("alt_chains", ()):
        run["m"] = round(run["m"], 0)
        run["rels"] = sorted(run["rels"])
    return pts, used


# ----------------------------------------------------------------------------- pipeline helpers

def finish_line(raw_pts):
    """prethin -> DP simplify -> round 5dp -> dedupe -> cumulative meters."""
    p = prethin(raw_pts, 2.0)
    p = dp_simplify(p, DP_TOL_M)
    rounded = []
    for la, lo in p:
        q = (round(la, 5), round(lo, 5))
        if not rounded or rounded[-1] != q:
            rounded.append(q)
    cums = [0.0]
    for i in range(1, len(rounded)):
        cums.append(cums[-1] + hav(rounded[i - 1], rounded[i]))
    return rounded, cums


def add_elevation(segs, refresh, skip):
    """segs: dict name -> {pts, cums, ...}. Adds 'ele' list + stats in place."""
    total = sum(len(s["pts"]) for s in segs.values())
    stride = 1 if total <= ELEV_BUDGET else (2 if total <= 2 * ELEV_BUDGET + 2000 else 3)
    rep("ELEVATION: %d total points, sampling stride %d%s"
        % (total, stride, " (SKIPPED by flag)" if skip else ""))
    for name, s in segs.items():
        n = len(s["pts"])
        if skip:
            s["ele"] = [None] * n
            s["ele_stats"] = "skipped"
            continue
        idx = list(range(0, n, stride))
        if idx[-1] != n - 1:
            idx.append(n - 1)
        sampled = [None] * n
        ok = 0
        for b0 in range(0, len(idx), 100):
            chunk = idx[b0:b0 + 100]
            coords = [s["pts"][i] for i in chunk]
            ele = fetch_elev_batch(coords, refresh)
            for i, v in zip(chunk, ele):
                if v is not None:
                    sampled[i] = float(v)
                    ok += 1
        filled, n_src = interp_fill(sampled, s["cums"])
        s["ele"] = filled
        s["ele_stats"] = ("%d/%d sampled points fetched (%.1f%%), %d/%d final points interpolated"
                          % (ok, len(idx), 100.0 * ok / max(1, len(idx)), n - ok, n))
        log("  %s: %s" % (name, s["ele_stats"]))


def interp_fill(eles, cums):
    n = len(eles)
    idx = [i for i, e in enumerate(eles) if e is not None]
    if not idx:
        return [None] * n, 0
    out = list(eles)
    first, last = idx[0], idx[-1]
    for i in range(0, first):
        out[i] = eles[first]
    for i in range(last + 1, n):
        out[i] = eles[last]
    for a, b in zip(idx, idx[1:]):
        if b - a > 1:
            ea, eb = eles[a], eles[b]
            ca, cb = cums[a], cums[b]
            for i in range(a + 1, b):
                t = 0.0 if cb == ca else (cums[i] - ca) / (cb - ca)
                out[i] = ea + (eb - ea) * t
    return [int(round(e)) for e in out], len(idx)


def seg_payload(s):
    pts = s["pts"]
    ele = s.get("ele") or [None] * len(pts)
    return {
        "km_total": round(s["cums"][-1] / 1000.0, 2),
        "points": [[la, lo, e] for (la, lo), e in zip(pts, ele)],
        "cum_km": [round(c / 1000.0, 2) for c in s["cums"]],
    }


def describe_seg(name, s, seg, checkpoints=()):
    km = s["cums"][-1] / 1000.0
    rep("SEGMENT %s" % name)
    rep("  km_total = %.2f km, %d points (after DP %.0f m)" % (km, len(s["pts"]), DP_TOL_M))
    rep("  start %.5f,%.5f — end %.5f,%.5f" % (s["pts"][0] + s["pts"][-1]))
    rep("  via anchors (name, dist m): %s" % seg["anchors"])
    if seg["skipped_vias"]:
        rep("  ! skipped vias (too far from graph): %s" % seg["skipped_vias"])
    if seg["alt_fallback_legs"]:
        rep("  ! legs that needed alternative/variant ways: %d %s"
            % (seg["alt_fallback_legs"], seg.get("fallback_leg_names", [])))
    for run in seg.get("alt_chains", ()):
        rep("    borrowed non-main chain: %.0f m near %s (rels %s)"
            % (run["m"], run["near"], run["rels"]))
    rep("  gaps bridged <=%.0f m: %d (total %.0f m)"
        % (BRIDGE_MAX_M, len(seg["gaps_small"]), sum(x["m"] for x in seg["gaps_small"])))
    if seg["gaps_big"]:
        rep("  ! FLAGGED gaps >%.0f m: %s" % (BRIDGE_MAX_M, seg["gaps_big"]))
    else:
        rep("  gaps >%.0f m: none" % BRIDGE_MAX_M)
    if seg["forced_bridges"]:
        rep("  ! component-connecting bridges added: %s" % seg["forced_bridges"])
    for nm in checkpoints:
        d = min_dist_to_line(s["pts"], ANCHORS[nm])
        flag = "" if d < 1000 else "   <-- OUTSIDE 1 km!"
        rep("  checkpoint %-14s min dist to line %6.0f m%s" % (nm, d, flag))
    if s.get("ele") and s["ele"][0] is not None:
        rep("  elevation: min %d m, max %d m; %s"
            % (min(s["ele"]), max(s["ele"]), s.get("ele_stats", "")))


def dropped_report(g, all_used_ids, relnames, label):
    """Report member ways not used by any accepted segment, grouped in chains."""
    unused_edges = [e for e in g["edges"]
                    if e["kind"] == "way" and id(e["w"]) not in all_used_ids]
    if not unused_edges:
        rep("DROPPED (%s): none — every member way used" % label)
        return
    adj = {}
    for e in unused_edges:
        adj.setdefault(e["u"], []).append(e)
        adj.setdefault(e["v"], []).append(e)
    seen = set()
    comps = []
    for e0 in unused_edges:
        if id(e0) in seen:
            continue
        comp = []
        stack = [e0]
        seen.add(id(e0))
        nodes_in = set()
        while stack:
            e = stack.pop()
            comp.append(e)
            for nd in (e["u"], e["v"]):
                if nd in nodes_in:
                    continue
                nodes_in.add(nd)
                for e2 in adj.get(nd, ()):
                    if id(e2) not in seen:
                        seen.add(id(e2))
                        stack.append(e2)
        comps.append((sum(e["len"] for e in comp), comp, nodes_in))
    comps.sort(reverse=True, key=lambda c: c[0])
    tot_km = sum(c[0] for c in comps) / 1000.0
    rep("DROPPED branches (%s): %d chains, %.1f km total not used in output" %
        (label, len(comps), tot_km))
    for L, comp, nodes_in in comps[:12]:
        if L < 2000:
            break
        roles = {}
        names = set()
        rels = set()
        for e in comp:
            for r in e["w"]["roles"]:
                roles[r if r else "«blank»"] = roles.get(r if r else "«blank»", 0) + 1
            nm = e["w"]["tags"].get("name")
            if nm:
                names.add(nm)
            rels |= e["w"]["rels"]
        some = g["nodes"][min(nodes_in)]
        rep("  - %.1f km chain near %.4f,%.4f — roles %s — rels %s%s" % (
            L / 1000.0, some[0], some[1], roles, sorted(rels),
            (" — e.g. " + " / ".join(sorted(names)[:3])) if names else ""))


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ignore caches")
    ap.add_argument("--discover", action="store_true", help="discovery only")
    ap.add_argument("--skip-elevation", action="store_true")
    ap.add_argument("--only", default="", help="comma list: frances,valcarlos,epilogo_fisterra,epilogo_muxia,link")
    args = ap.parse_args()
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    only = set(x.strip() for x in args.only.split(",") if x.strip()) or None

    def want(s):
        return only is None or s in only

    disc = discover(args.refresh)
    if args.discover:
        return

    relnames = {}
    segments = {}      # name -> finished seg dict or None
    seg_reports = {}   # name -> routing report
    null_reasons = {}

    # ---------------- Francés (+ Valcarlos) ----------------
    g_fr = None
    if want("frances") or want("valcarlos"):
        store_fr = {}
        rep("FETCH Camino Francés sections")
        section_ids = disc["sections"]
        if len(section_ids) < 3 and disc["umbrella_members"]:
            rep("  ! fewer than 3 numbered sections found — falling back to umbrella member order")
            section_ids = disc["umbrella_members"]
        for rid in section_ids:
            add_relation_ways(store_fr, rid, True, args.refresh, relnames)
        for rid in disc["valcarlos_rels"] + disc["alt_rels"]:
            add_relation_ways(store_fr, rid, False, args.refresh, relnames)
        # Voie du Puy (GR65) descends SJPP -> Valcarlos -> Roncesvalles on the same
        # roads as the pilgrim winter variant; use its ways (bbox-limited) as an
        # extra ALT source to close the hole between SJPP and the 4625660 chain.
        REL_VOIE_DU_PUY = 3526652
        jv = overpass("[out:json][timeout:180];relation(%d);way(r)(42.98,-1.40,43.17,-1.20);out geom;"
                      % REL_VOIE_DU_PUY, "voiedupuy_bbox", args.refresh)
        nv = 0
        for e in jv.get("elements", []):
            if e.get("type") != "way" or "geometry" not in e:
                continue
            geom = [(p["lat"], p["lon"]) for p in e["geometry"] if p]
            if len(geom) < 2:
                continue
            w = store_fr.get(e["id"])
            if w is None:
                store_fr[e["id"]] = {"id": e["id"], "geom": geom,
                                     "tags": e.get("tags", {}) or {},
                                     "roles": {"gr65"}, "rels": {REL_VOIE_DU_PUY},
                                     "main": False}
                nv += 1
            else:
                w["rels"].add(REL_VOIE_DU_PUY)
        relnames[REL_VOIE_DU_PUY] = "Voie du Puy (bbox extract, ALT pool)"
        rep("  rel %d 'Voie du Puy' bbox extract: %d new ways  [loaded as ALT pool]"
            % (REL_VOIE_DU_PUY, nv))
        sub_fr = split_at_junctions(store_fr)
        g_fr = build_graph(sub_fr)

        if want("frances"):
            seg = new_seg_report("frances")
            r = assemble(g_fr, FRANCES_VIAS, False, 3.0, seg, required=("sjpp", "santiago"))
            if r is None:
                raise RuntimeError("FRANCES failed: %s" % seg["fail"])
            pts, used = path_points(g_fr, r[0], r[1], seg)
            rounded, cums = finish_line(pts)
            segments["frances"] = {"pts": rounded, "cums": cums, "used": used}
            seg_reports["frances"] = seg

        if want("valcarlos"):
            seg = new_seg_report("valcarlos")
            r = assemble(g_fr, VALCARLOS_VIAS, True, 1.0, seg, required=("valcarlos",))
            if r is None:
                segments["valcarlos"] = None
                null_reasons["valcarlos"] = seg["fail"]
            else:
                pts, used = path_points(g_fr, r[0], r[1], seg)
                rounded, cums = finish_line(pts)
                km = cums[-1] / 1000.0
                d_arn = min_dist_to_line(rounded, ANCHORS["arneguy"])
                d_val = min_dist_to_line(rounded, ANCHORS["valcarlos"])
                if not (20.0 <= km <= 32.0):
                    segments["valcarlos"] = None
                    null_reasons["valcarlos"] = "assembled but km_total %.1f outside 20-32 window" % km
                elif seg["gaps_big"]:
                    segments["valcarlos"] = None
                    null_reasons["valcarlos"] = "assembled but needed gaps >150 m: %s" % seg["gaps_big"]
                elif d_arn > 1000 or d_val > 1000:
                    segments["valcarlos"] = None
                    null_reasons["valcarlos"] = ("assembled line misses the valley towns "
                                                 "(Arnéguy %.0f m, Valcarlos %.0f m) — not the "
                                                 "Valcarlos route" % (d_arn, d_val))
                else:
                    segments["valcarlos"] = {"pts": rounded, "cums": cums, "used": used}
            seg_reports["valcarlos"] = seg

    # ---------------- Fisterra / Muxía ----------------
    g_fi = None
    fisterra_nodepath = None
    if want("epilogo_fisterra") or want("epilogo_muxia") or want("link"):
        store_fi = {}
        rep("FETCH Camiño de Fisterra-Muxía (relation %d)" % REL_FISTERRA_MUXIA)
        add_relation_ways(store_fi, REL_FISTERRA_MUXIA, True, args.refresh, relnames)
        sub_fi = split_at_junctions(store_fi)
        g_fi = build_graph(sub_fi)

        if want("epilogo_fisterra"):
            seg = new_seg_report("epilogo_fisterra")
            r = assemble(g_fi, FISTERRA_VIAS, False, 3.0, seg,
                         required=("santiago", "fisterra_town"))
            if r is None:
                raise RuntimeError("EPILOGO_FISTERRA failed: %s" % seg["fail"])
            npath, epath = r
            # optional spur to the Faro (km 0)
            faro_nid, faro_d = nearest_node(g_fi, ANCHORS["faro_fisterra"])
            if faro_d <= ANCHOR_MAX_M and faro_nid != npath[-1]:
                r2 = route_leg(g_fi, npath[-1], faro_nid, False, 3.0, seg, label="fisterra_town->faro")
                if r2:
                    n2, e2 = r2
                    extra = sum(g_fi["edges"][e]["len"] for e in e2)
                    if extra <= 6000:
                        while epath and e2 and epath[-1] == e2[0]:
                            epath.pop()
                            npath.pop()
                            e2.pop(0)
                            n2.pop(0)
                        npath.extend(n2[1:])
                        epath.extend(e2)
                        seg["anchors"].append(("faro_fisterra", round(faro_d, 1)))
                    else:
                        rep("  faro spur skipped: %.1f km is implausibly long" % (extra / 1000))
            else:
                rep("  faro spur not available (nearest node %.0f m)" % faro_d)
            fisterra_nodepath = npath
            pts, used = path_points(g_fi, npath, epath, seg)
            rounded, cums = finish_line(pts)
            segments["epilogo_fisterra"] = {"pts": rounded, "cums": cums, "used": used}
            seg_reports["epilogo_fisterra"] = seg

        if want("epilogo_muxia"):
            seg = new_seg_report("epilogo_muxia")
            mux_nid, mux_d = nearest_node(g_fi, ANCHORS["muxia"])
            seg["anchors"].append(("muxia", round(mux_d, 1)))
            if mux_d > ANCHOR_MAX_M:
                segments["epilogo_muxia"] = None
                null_reasons["epilogo_muxia"] = "Muxía anchor %.0f m from any graph node" % mux_d
            elif not fisterra_nodepath:
                segments["epilogo_muxia"] = None
                null_reasons["epilogo_muxia"] = "fisterra path not built"
            else:
                targets = set(fisterra_nodepath)
                r = dijkstra(g_fi, mux_nid, targets, False, 3.0)
                if r is None:
                    r = dijkstra(g_fi, mux_nid, targets, True, 3.0)
                    if r:
                        seg["alt_fallback_legs"] += 1
                if r is None:
                    segments["epilogo_muxia"] = None
                    null_reasons["epilogo_muxia"] = "no path from Muxía to the Fisterra line"
                else:
                    npath, epath = r
                    split_node = npath[-1]
                    sp = g_fi["nodes"][split_node]
                    seg["split_at"] = [round(sp[0], 5), round(sp[1], 5)]
                    seg["split_dist_hospital_ref_m"] = round(hav(sp, ANCHORS["hospital_ref"]), 0)
                    npath.reverse()
                    epath.reverse()
                    pts, used = path_points(g_fi, npath, epath, seg)
                    rounded, cums = finish_line(pts)
                    km = cums[-1] / 1000.0
                    if not (20.0 <= km <= 35.0):
                        segments["epilogo_muxia"] = None
                        null_reasons["epilogo_muxia"] = "assembled but km_total %.1f outside 20-35" % km
                    elif seg["gaps_big"]:
                        segments["epilogo_muxia"] = None
                        null_reasons["epilogo_muxia"] = "needed gaps >150 m: %s" % seg["gaps_big"]
                    else:
                        segments["epilogo_muxia"] = {"pts": rounded, "cums": cums,
                                                     "used": used, "split": seg["split_at"]}
            seg_reports["epilogo_muxia"] = seg

        if want("link"):
            seg = new_seg_report("link_fisterra_muxia")
            r = assemble(g_fi, LINK_VIAS, True, 1.0, seg, required=("lires",))
            if r is None:
                segments["link_fisterra_muxia"] = None
                null_reasons["link_fisterra_muxia"] = seg["fail"]
            else:
                npath, epath = r
                pts, used = path_points(g_fi, npath, epath, seg)
                rounded, cums = finish_line(pts)
                km = cums[-1] / 1000.0
                mux_seg = segments.get("epilogo_muxia")
                thru_split = False
                if mux_seg and mux_seg.get("split"):
                    thru_split = min_dist_to_line(rounded, tuple(mux_seg["split"])) < 300
                d_lires = min_dist_to_line(rounded, ANCHORS["lires"])
                if km > 40.0 or thru_split or d_lires > 1200:
                    segments["link_fisterra_muxia"] = None
                    null_reasons["link_fisterra_muxia"] = (
                        "path is not the coastal link (km=%.1f, via inland split=%s, "
                        "Lires dist %.0f m)" % (km, thru_split, d_lires))
                elif seg["gaps_big"]:
                    segments["link_fisterra_muxia"] = None
                    null_reasons["link_fisterra_muxia"] = "needed gaps >150 m: %s" % seg["gaps_big"]
                else:
                    segments["link_fisterra_muxia"] = {"pts": rounded, "cums": cums, "used": used}
            seg_reports["link_fisterra_muxia"] = seg

    # ---------------- elevation ----------------
    built = {k: v for k, v in segments.items() if v}
    add_elevation(built, args.refresh, args.skip_elevation)

    # ---------------- describe + validate ----------------
    rep("=" * 70)
    if "frances" in built:
        describe_seg("frances", built["frances"], seg_reports["frances"], FRANCES_CHECKPOINTS)
        s = built["frances"]
        km = s["cums"][-1] / 1000.0
        d_start = hav(s["pts"][0], ANCHORS["sjpp"])
        d_end = hav(s["pts"][-1], ANCHORS["santiago"])
        rep("  start dist to SJPP centre: %.0f m; end dist to cathedral: %.0f m" % (d_start, d_end))
        if not (740 <= km <= 790):
            rep("  ! ANOMALY: frances km %.1f outside 740-790" % km)
        if s.get("ele") and s["ele"][0] is not None:
            i30 = 0
            for i, c in enumerate(s["cums"]):
                if c <= 35000:
                    i30 = i
            mx = max(s["ele"][:i30 + 1])
            rep("  max elevation in first 35 km: %d m (Route Napoleon expects ~1430)" % mx)
            if mx < 1300:
                rep("  ! ANOMALY: first-day max elevation < 1300 m — may NOT be the Napoleon line")
    for nm, checks in (("valcarlos", ["arneguy", "valcarlos", "ibaneta"]),
                       ("epilogo_fisterra", ["negreira", "cee", "fisterra_town", "faro_fisterra"]),
                       ("epilogo_muxia", ["muxia"]),
                       ("link_fisterra_muxia", ["lires"])):
        if nm in built:
            describe_seg(nm, built[nm], seg_reports[nm], checks)
            if nm == "valcarlos":
                s = built[nm]
                if s.get("ele") and s["ele"][0] is not None and max(s["ele"]) > 1250:
                    rep("  ! ANOMALY: valcarlos max ele %d m > 1250 — looks like the Napoleon line!" % max(s["ele"]))
                rep("  end dist to Roncesvalles: %.0f m" % hav(s["pts"][-1], ANCHORS["roncesvalles"]))
            if nm == "epilogo_muxia":
                sr = seg_reports[nm]
                rep("  branch split at %s (%.1f km from expected Hospital area)" % (
                    sr.get("split_at"), sr.get("split_dist_hospital_ref_m", -1) / 1000.0))
        elif nm in null_reasons:
            rep("SEGMENT %s = null — %s" % (nm, null_reasons[nm]))

    # dropped branches
    used_fr = set()
    used_fi = set()
    for nm, s in built.items():
        tgt = used_fr if nm in ("frances", "valcarlos") else used_fi
        for w in s["used"]:
            tgt.add(id(w))
    if g_fr is not None:
        dropped_report(g_fr, used_fr, relnames, "Francés graph")
    if g_fi is not None:
        dropped_report(g_fi, used_fi, relnames, "Fisterra-Muxía graph")

    # ---------------- write ----------------
    used_rels = set()
    for s in built.values():
        for w in s["used"]:
            used_rels |= w["rels"]
    out = {
        "meta": {
            "built": time.strftime("%Y-%m-%d"),
            "source": ("OpenStreetMap, © OpenStreetMap contributors, ODbL — relations "
                       + ", ".join(str(r) for r in sorted(used_rels))),
            "elevation": "Open-Meteo Elevation API (Copernicus DEM)",
            "crs": "WGS84, points [lat, lon, ele_m] rounded to 5 decimals / 1 m; cum_km rounded to 2 decimals",
        },
    }
    for nm in ("frances", "valcarlos", "epilogo_fisterra", "epilogo_muxia", "link_fisterra_muxia"):
        if nm in built:
            out[nm] = seg_payload(built[nm])
        elif nm in segments:  # attempted but rejected
            out[nm] = None
        elif only is not None:
            continue  # not requested this run: leave key out entirely
        else:
            out[nm] = None
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(OUT_PATH)
    rep("=" * 70)
    rep("WROTE %s  (%.2f MB)" % (OUT_PATH, size / 1e6))
    rep("relations in meta.source: %s" % sorted(used_rels))
    for nm, reason in null_reasons.items():
        rep("NULL %s: %s" % (nm, reason))

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(REPORT_LINES) + "\n")
    log("report copy: %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
