"""One-off probe: can Overture Maps places (open licence) name Ningbo's unnamed OpenStreetMap parks,
and which parks does Overture have that OSM lacks? Prints a summary only."""
import json, math, time, urllib.parse, urllib.request
import duckdb

DISTRICTS = ['海曙区', '江北区', '鄞州区', '镇海区', '北仑区', '奉化区']
S, W, N, E = 29.40, 121.20, 30.10, 122.20
RELEASE = '2026-11-18.0'
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']

def overpass(q):
    for i in range(8):
        url = OVERPASS[i % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'park-checkin-map probe'})
            return json.load(urllib.request.urlopen(req, timeout=200))
        except Exception as e:
            print('  overpass attempt', i + 1, url.split('/')[2], 'failed:', e); time.sleep(5 * (i + 1))
    raise SystemExit('Overpass unavailable')

def ring_ok(r): return len(r) > 3 and r[0] == r[-1]
def join(ways):
    rest = [w[:] for w in ways if len(w) > 1]; rings = []
    while rest:
        ring = rest.pop(0)
        for _ in range(5000):
            if ring[0] == ring[-1]: break
            end = ring[-1]; k = next((j for j, w in enumerate(rest) if w[0] == end or w[-1] == end), None)
            if k is None: break
            w = rest.pop(k); w = w if w[0] == end else w[::-1]; ring += w[1:]
        rings.append(ring)
    return rings
def inside(lat, lon, r):
    c = False; j = len(r) - 1
    for i in range(len(r)):
        yi, xi = r[i]; yj, xj = r[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi: c = not c
        j = i
    return c
def area(r):
    kx = 111320 * math.cos(math.radians(r[0][0])); ky = 110540
    return abs(sum((r[j][1]*kx)*(r[i][0]*ky) - (r[i][1]*kx)*(r[j][0]*ky) for i, j in zip(range(len(r)), [len(r)-1] + list(range(len(r)-1))))) / 2
def dist(a, b): return math.hypot((a[0]-b[0])*110540, (a[1]-b[1])*111320*math.cos(math.radians(a[0])))
def near_ring(lat, lon, r, m):  # within m metres of the outline (cheap check on vertices + edges)
    kx = 111320 * math.cos(math.radians(lat)); ky = 110540
    for (a0, a1), (b0, b1) in zip(r[:-1], r[1:]):
        ax, ay, bx, by = (a1-lon)*kx, (a0-lat)*ky, (b1-lon)*kx, (b0-lat)*ky
        dx, dy = bx-ax, by-ay; L = dx*dx + dy*dy; t = 0 if L == 0 else max(0, min(1, -(ax*dx + ay*dy)/L))
        if math.hypot(ax + t*dx, ay + t*dy) < m: return True
    return False

print('OSM district boundaries and parks…')
bnd = overpass('[out:json][timeout:180];rel["boundary"="administrative"]["name"~"^(%s)$"](%s,%s,%s,%s);out geom;' % ('|'.join(DISTRICTS), S, W, N, E))['elements']
drings = {e['tags']['name']: [r for r in join([[(p['lat'], p['lon']) for p in m['geometry'] if p] for m in e.get('members', []) if m['type'] == 'way' and m.get('geometry') and m.get('role') != 'inner']) if ring_ok(r)] for e in bnd}
def district(lat, lon): return next((d for d, rs in drings.items() if any(inside(lat, lon, r) for r in rs)), None)
time.sleep(3)
els = overpass('[out:json][timeout:180];(way["leisure"="park"](%s,%s,%s,%s);rel["leisure"="park"](%s,%s,%s,%s););out geom;' % (S, W, N, E, S, W, N, E))['elements']
parks = []
for e in els:
    if e['type'] == 'way': rings = [[(p['lat'], p['lon']) for p in e.get('geometry', []) if p]]
    else: rings = join([[(p['lat'], p['lon']) for p in m['geometry'] if p] for m in e.get('members', []) if m['type'] == 'way' and m.get('geometry') and m.get('role') in ('outer', '')])
    rings = [r for r in rings if ring_ok(r)]
    if not rings: continue
    big = max(rings, key=area); c = (sum(p[0] for p in big)/len(big), sum(p[1] for p in big)/len(big))
    d = district(*c)
    if not d: continue
    parks.append({'id': e['type'] + '/' + str(e['id']), 'name': e.get('tags', {}).get('name'), 'rings': rings, 'district': d, 'ha': sum(area(r) for r in rings)/1e4,
                  'bb': (min(p[0] for r in rings for p in r), min(p[1] for r in rings for p in r), max(p[0] for r in rings for p in r), max(p[1] for r in rings for p in r))})
unnamed = [p for p in parks if not p['name']]
print('  OSM parks in the six districts:', len(parks), 'unnamed:', len(unnamed))

print('Overture places (release %s)…' % RELEASE)
con = duckdb.connect(); con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
rows = con.execute(f"""
  SELECT names.primary AS name, taxonomy.primary AS cat, confidence,
         (bbox.ymin + bbox.ymax)/2 AS lat, (bbox.xmin + bbox.xmax)/2 AS lon,
         list_transform(sources, s -> s.dataset) AS src
  FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*', hive_partitioning=1)
  WHERE bbox.xmin BETWEEN {W} AND {E} AND bbox.ymin BETWEEN {S} AND {N}
""").fetchall()
print('  places in bbox:', len(rows))
cats = {}
for r in rows: cats[r[1]] = cats.get(r[1], 0) + 1
parkish = sorted([c for c in cats if c and any(k in c for k in ('park', 'garden', 'playground', 'greenway', 'trail', 'plaza'))], key=lambda c: -cats[c])
print('  park-like categories:', {c: cats[c] for c in parkish})
cand = [r for r in rows if r[1] in parkish and r[0] and district(r[3], r[4])]
print('  park-like places inside the six districts:', len(cand), 'by source:', {k: sum(1 for r in cand if k in (r[5] or [])) for k in set(s for r in cand for s in (r[5] or []))})

# 1) name unnamed OSM parks: a park-like place inside (or within 30 m of) the polygon
named_now = []
for p in unnamed:
    s0, w0, n0, e0 = p['bb']; hits = []
    for r in cand:
        lat, lon = r[3], r[4]
        if not (s0 - .0004 < lat < n0 + .0004 and w0 - .0004 < lon < e0 + .0004): continue
        if any(inside(lat, lon, rg) or near_ring(lat, lon, rg, 30) for rg in p['rings']): hits.append(r)
    if hits:
        best = max(hits, key=lambda r: (r[1] == 'park', r[2] or 0))
        named_now.append((p['district'], round(p['ha'], 2), best[0], best[1], round(best[2] or 0, 2)))
print(f'Unnamed OSM parks that get a name from Overture: {len(named_now)} of {len(unnamed)}')
for x in sorted(named_now, key=lambda x: -x[1])[:40]: print('   ', x)

# 2) parks Overture has that OSM lacks entirely (category park, not inside/near any OSM park)
missing = []
for r in cand:
    if r[1] != 'park': continue
    lat, lon = r[3], r[4]
    if any(p['bb'][0] - .0005 < lat < p['bb'][2] + .0005 and p['bb'][1] - .0005 < lon < p['bb'][3] + .0005 and any(inside(lat, lon, rg) or near_ring(lat, lon, rg, 60) for rg in p['rings']) for p in parks): continue
    missing.append((district(lat, lon), r[0], round(r[2] or 0, 2)))
print(f'Overture "park" places with no OSM park nearby: {len(missing)}  (confidence >= 0.7: {sum(1 for m in missing if m[2] >= 0.7)})')
by_d = {}
for m in missing: by_d[m[0]] = by_d.get(m[0], 0) + 1
print('   by district:', by_d)
for m in sorted(missing, key=lambda m: -m[2])[:40]: print('   ', m)
