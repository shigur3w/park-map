/* parkdata.js — shared by the page (browser) and scripts/build-data.js (Node).
 * Downloads park, garden and greenway data for each region (Tokyo, Ningbo) from OpenStreetMap (Overpass API)
 * and turns it into the compact format the map uses. */
(function(root){
'use strict';
// ---------- Config ----------
// Tokyo mainland: 23 wards + Tama (islands are left out).
var MUNIS_23 = ['千代田区','中央区','港区','新宿区','文京区','台東区','墨田区','江東区','品川区','目黒区','大田区','世田谷区','渋谷区','中野区','杉並区','豊島区','北区','荒川区','板橋区','練馬区','足立区','葛飾区','江戸川区'];
var MUNIS_TAMA = ['八王子市','立川市','武蔵野市','三鷹市','青梅市','府中市','昭島市','調布市','町田市','小金井市','小平市','日野市','東村山市','国分寺市','国立市','福生市','狛江市','東大和市','清瀬市','東久留米市','武蔵村山市','多摩市','稲城市','羽村市','あきる野市','西東京市','瑞穂町','日の出町','檜原村','奥多摩町'];
var MUNIS = MUNIS_23.concat(MUNIS_TAMA);
var IS23 = {}; MUNIS_23.forEach(function(m){ IS23[m] = true; });
var TOKYO_BBOX = [35.48, 138.94, 35.91, 139.93]; // s,w,n,e
// Download in strips so each Overpass request stays small; dense wards get narrow strips.
var CHUNKS = [
  {label:'奥多摩・檜原・青梅一带', b:[35.64, 138.94, 35.91, 139.20]},
  {label:'八王子・町田西部一带',   b:[35.50, 139.20, 35.86, 139.38]},
  {label:'多摩中部（立川・日野・多摩）', b:[35.50, 139.38, 35.82, 139.50]},
  {label:'多摩东部（府中・小金井・三鷹）', b:[35.56, 139.50, 35.81, 139.60]},
  {label:'世田谷・杉並・練馬一带', b:[35.57, 139.60, 35.79, 139.68]},
  {label:'渋谷・新宿・板橋一带',   b:[35.52, 139.68, 35.80, 139.74]},
  {label:'都心・品川・北区一带',   b:[35.52, 139.74, 35.82, 139.80]},
  {label:'下町・江东・足立一带',   b:[35.55, 139.80, 35.82, 139.93]}
];
// The main server sometimes answers 502 when busy; it usually works a few seconds later, so it is retried between the mirrors.
var MAIN = 'https://overpass-api.de/api/interpreter';
var MAILRU = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
var ENDPOINTS = [MAIN, MAIN, 'https://overpass.kumi.systems/api/interpreter', MAILRU, MAIN, 'https://overpass.private.coffee/api/interpreter', MAILRU, MAIN];
var DATA_VER = 3;
// Ningbo: the six urban districts. Unnamed OSM parks are kept so people can name them when they check in.
var NINGBO = ['海曙区','江北区','鄞州区','镇海区','北仑区','奉化区'];
var NINGBO_BBOX = [29.40, 121.20, 30.10, 122.20];
var REGIONS = {
  tokyo:  {id:'tokyo', label:'东京', full:'东京 23区＋多摩', all:'全东京', groups:[['23区', MUNIS_23], ['多摩', MUNIS_TAMA]], munis:MUNIS,
           adminLevel:'7', bbox:TOKYO_BBOX, chunks:CHUNKS, wayRe:'緑道', unnamed:false, idPrefix:'', minEntities:3000,
           file:'parks.json', versionFile:'version.json', dbKey:'data', view:[[35.55, 139.0], [35.85, 139.92]]},
  ningbo: {id:'ningbo', label:'宁波', full:'宁波市区（6 区）', all:'宁波市区', groups:[['市区', NINGBO]], munis:NINGBO,
           adminLevel:'6', bbox:NINGBO_BBOX, chunks:[{label:'宁波市区', b:NINGBO_BBOX}], wayRe:'绿道|綠道', unnamed:true, idPrefix:'nb|', minEntities:150,
           exclude:'庄园|农场|度假村|山庄|酒店', file:'ningbo.json', versionFile:'ningbo-version.json', dbKey:'data:ningbo', view:[[29.70, 121.40], [30.00, 121.85]]}
};
// ---------- Geometry helpers ----------
function r5(x){ return Math.round(x * 1e5) / 1e5; }
function eq(a, b){ return a[0] === b[0] && a[1] === b[1]; }
function joinRings(ways){
  var rest = ways.filter(function(w){ return w.length > 1; }).map(function(w){ return w.slice(); });
  var rings = [];
  while(rest.length){
    var ring = rest.shift(), guard = 0;
    while(!eq(ring[0], ring[ring.length-1]) && guard++ < 5000){
      var end = ring[ring.length-1];
      var idx = rest.findIndex(function(w){ return eq(w[0], end) || eq(w[w.length-1], end); });
      if(idx < 0) break;
      var w = rest.splice(idx, 1)[0];
      if(!eq(w[0], end)) w.reverse();
      ring = ring.concat(w.slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
function ringArea(r){
  if(r.length < 3) return 0;
  var lat0 = r[0][0] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540, s = 0;
  for(var i = 0, j = r.length - 1; i < r.length; j = i++){ s += (r[j][1]*kx) * (r[i][0]*ky) - (r[i][1]*kx) * (r[j][0]*ky); }
  return Math.abs(s / 2);
}
function hav(a, b){
  var R = 6371000, p1 = a[0]*Math.PI/180, p2 = b[0]*Math.PI/180, dp = p2 - p1, dl = (b[1]-a[1])*Math.PI/180;
  var x = Math.sin(dp/2)*Math.sin(dp/2) + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
function lineLen(c){ var s = 0; for(var i = 1; i < c.length; i++) s += hav(c[i-1], c[i]); return s; }
function bboxOf(pts){
  var b = [Infinity, Infinity, -Infinity, -Infinity];
  pts.forEach(function(p){ if(p[0]<b[0])b[0]=p[0]; if(p[1]<b[1])b[1]=p[1]; if(p[0]>b[2])b[2]=p[0]; if(p[1]>b[3])b[3]=p[1]; });
  return b;
}
function bboxCenter(pts){ var b = bboxOf(pts); return [r5((b[0]+b[2])/2), r5((b[1]+b[3])/2)]; }
function inRing(lat, lon, r){
  var inside = false;
  for(var i = 0, j = r.length - 1; i < r.length; j = i++){
    var yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
    if(((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function simplify(c, minM){ // drop points closer than minM metres to the last kept point
  if(c.length < 4) return c;
  var out = [c[0]];
  for(var i = 1; i < c.length - 1; i++){ if(hav(out[out.length-1], c[i]) >= minM) out.push(c[i]); }
  out.push(c[c.length-1]); return out;
}
// ---------- Overpass ----------
function boundaryQuery(region){
  region = region || REGIONS.tokyo;
  return '[out:json][timeout:180];\nrel["boundary"="administrative"]["admin_level"="' + region.adminLevel + '"]["name"~"^(' + region.munis.join('|') + ')$"](' + region.bbox.join(',') + ');\nout geom;';
}
function chunkQuery(b, region){
  region = region || REGIONS.tokyo;
  var bb = '(' + b.join(',') + ')';
  return '[out:json][timeout:180];\n(\n' +
    '  nwr["leisure"="park"]' + (region.unnamed ? '' : '["name"]') + bb + ';\n' +
    '  nwr["leisure"="garden"]["name"]["access"!~"^(private|no)$"]' + bb + ';\n' +
    '  way["name"~"' + region.wayRe + '"]["building"!~"."]' + bb + ';\n' +
    '  rel["name"~"' + region.wayRe + '"]' + bb + ';\n' +
    ');\nout geom;';
}
var HEADERS = {'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'};
if(typeof window === 'undefined') HEADERS['User-Agent'] = 'tokyo-park-checkin-map data build (GitHub Actions)';
function overpass(q){
  var i = 0, lastErr = null;
  function next(){
    if(i >= ENDPOINTS.length) return Promise.reject(lastErr || new Error('没有可用的数据服务器'));
    var url = ENDPOINTS[i++], ctl = new AbortController(), t = setTimeout(function(){ ctl.abort(); }, 200000);
    return fetch(url, {method:'POST', body:'data=' + encodeURIComponent(q),
      headers:HEADERS, signal:ctl.signal})
      .then(function(res){ clearTimeout(t); if(!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function(j){ if(j.remark && /runtime error/i.test(j.remark)) throw new Error(j.remark); return j; })
      .catch(function(e){ clearTimeout(t); lastErr = e;
        if(typeof window === 'undefined') console.log('   attempt ' + i + ' ' + url.split('/')[2] + ' failed: ' + (e && e.name === 'AbortError' ? 'timeout' : (e && (e.message + (e.cause ? ' / ' + (e.cause.code || e.cause.message) : ''))) || e));
        return new Promise(function(r){ setTimeout(r, 4000 * Math.min(i, 4)); }).then(next); });
  }
  return next();
}

// ---------- Data processing ----------
function geomsOf(e){
  var tags = e.tags || {}, out = [];
  var isArea = !!tags.leisure || tags.area === 'yes';
  if(e.type === 'node'){ out.push({t:'pt', c:[e.lat, e.lon]}); }
  else if(e.type === 'way' && e.geometry){
    var c = e.geometry.filter(Boolean).map(function(p){ return [p.lat, p.lon]; });
    if(c.length < 2) return out;
    if(isArea && c.length > 3 && eq(c[0], c[c.length-1])) out.push({t:'poly', r:c}); else out.push({t:'line', c:c});
  } else if(e.type === 'relation' && e.members){
    var ways = e.members.filter(function(m){ return m.type === 'way' && m.geometry; });
    var outer = ways.filter(function(m){ return m.role === 'outer' || m.role === ''; }).map(function(m){ return m.geometry.filter(Boolean).map(function(p){ return [p.lat, p.lon]; }); });
    if(tags.type === 'multipolygon' || isArea){
      joinRings(outer).forEach(function(r){ if(r.length > 3 && eq(r[0], r[r.length-1])) out.push({t:'poly', r:r}); else if(r.length > 1) out.push({t:'line', c:r}); });
    } else {
      ways.forEach(function(m){ var c = m.geometry.filter(Boolean).map(function(p){ return [p.lat, p.lon]; }); if(c.length > 1) out.push({t:'line', c:c}); });
    }
  }
  return out;
}
// Municipality polygons for point-in-polygon lookups.
function buildMuniIndex(boundaryEls, munis){
  munis = munis || MUNIS;
  var idx = [], lines = [];
  boundaryEls.forEach(function(e){
    var name = e.tags && e.tags.name; if(munis.indexOf(name) < 0) return;
    var outer = (e.members || []).filter(function(m){ return m.type === 'way' && m.geometry && m.role !== 'inner'; })
      .map(function(m){ return m.geometry.filter(Boolean).map(function(p){ return [p.lat, p.lon]; }); });
    joinRings(outer).forEach(function(r){
      var s = simplify(r, 50).map(function(p){ return [r5(p[0]), r5(p[1])]; });
      if(s.length > 3 && eq(r[0], r[r.length-1])){ if(!eq(s[0], s[s.length-1])) s.push(s[0]); idx.push({name:name, r:s, b:bboxOf(s)}); }
      lines.push(s);
    });
  });
  return {rings:idx, lines:lines};
}
function extremes(all){ // centre plus the four outermost vertices: enough to tell which municipalities a place touches
  if(all.length < 3) return all;
  var b = bboxOf(all), out = [[(b[0]+b[2])/2, (b[1]+b[3])/2]], pick = [null, null, null, null];
  all.forEach(function(p){ if(!pick[0] || p[0] < pick[0][0]) pick[0] = p; if(!pick[1] || p[0] > pick[1][0]) pick[1] = p; if(!pick[2] || p[1] < pick[2][1]) pick[2] = p; if(!pick[3] || p[1] > pick[3][1]) pick[3] = p; });
  return out.concat(pick);
}
function munisAt(pts, mi){
  var hit = [];
  pts.forEach(function(p){
    mi.rings.forEach(function(x){
      if(hit.indexOf(x.name) >= 0) return;
      if(p[0] < x.b[0] || p[0] > x.b[2] || p[1] < x.b[1] || p[1] > x.b[3]) return;
      if(inRing(p[0], p[1], x.r)) hit.push(x.name);
    });
  });
  return hit;
}
function processData(boundaryEls, chunkEls, region){
  region = region || REGIONS.tokyo;
  var MU = region.munis, wayRx = new RegExp(region.wayRe), skipRx = region.exclude ? new RegExp(region.exclude) : null;
  var mi = buildMuniIndex(boundaryEls, MU);
  if(!mi.rings.length) throw new Error('没有拿到' + region.label + '各区的边界');
  var seen = new Set(), raw = [];
  chunkEls.forEach(function(els){ els.forEach(function(e){
    var key = e.type + '/' + e.id; if(seen.has(key)) return; seen.add(key);
    var tags = e.tags || {}, name = tags.name, unnamed = false;
    if(!name){ if(!(region.unnamed && tags.leisure === 'park' && e.type !== 'node')) return; unnamed = true; name = ''; }
    if(skipRx && skipRx.test(name)) return;
    var kind = !unnamed && wayRx.test(name) ? 'greenway' : (tags.leisure === 'garden' ? 'garden' : (tags.leisure === 'park' ? 'park' : null));
    if(!kind) return;
    var g = geomsOf(e); if(!g.length) return;
    var all = []; g.forEach(function(x){ if(x.t === 'pt') all.push(x.c); else (x.r || x.c).forEach(function(p){ all.push(p); }); });
    var pts = extremes(all);
    var munis = munisAt(pts, mi); if(!munis.length) return; // outside the region's districts
    var alts = [tags['name:ja'], tags.alt_name, tags.official_name, tags.old_name, tags['name:zh']].filter(Boolean);
    raw.push({osm:key, name:name, unnamed:unnamed, kind:kind, munis:munis, geoms:g, alts:alts, center:bboxCenter(pts)});
  }); });
  // Merge pieces of one place: same name and kind, near each other.
  var groups = new Map(), clusters = [];
  raw.sort(function(a, b){ return a.osm < b.osm ? -1 : 1; });
  raw.forEach(function(x){
    var gk = x.unnamed ? 'u|' + x.osm : x.kind + '|' + x.name, list = groups.get(gk); if(!list){ list = []; groups.set(gk, list); }
    var lim = x.kind === 'greenway' ? 2500 : 1200, target = null;
    for(var i = 0; i < list.length && !target; i++){ for(var j = 0; j < list[i].cs.length; j++){ if(hav(list[i].cs[j], x.center) < lim){ target = list[i]; break; } } }
    if(!target){ target = {name:x.name, unnamed:x.unnamed, kind:x.kind, munis:[], geoms:[], alts:[], osm:x.osm, cs:[]}; list.push(target); clusters.push(target); }
    target.cs.push(x.center);
    x.munis.forEach(function(m){ if(target.munis.indexOf(m) < 0) target.munis.push(m); });
    x.alts.forEach(function(a){ if(target.alts.indexOf(a) < 0) target.alts.push(a); });
    target.geoms = target.geoms.concat(x.geoms);
  });
  var entities = clusters.map(function(cl){
    var munis = cl.munis.sort(function(a, b){ return MU.indexOf(a) - MU.indexOf(b); });
    var e;
    if(cl.unnamed) e = {id:region.idPrefix + 'u|' + cl.osm, name:munis[0] + '·无名公园', unnamed:true, kind:'park', munis:munis, alts:[], osm:cl.osm};
    else {
      var list = groups.get(cl.kind + '|' + cl.name);
      e = {id:region.idPrefix + (cl.kind === 'greenway' ? 'g|' : 'p|') + cl.name + (list.length > 1 ? '|' + cl.osm : ''), name:cl.name, kind:cl.kind, munis:munis, alts:cl.alts, osm:cl.osm};
    }
    var area = 0, len = 0, longest = null, bigRing = null, allPts = [];
    cl.geoms.forEach(function(g){
      if(g.t === 'poly'){ var a = ringArea(g.r); area += a; if(!bigRing || a > bigRing.a) bigRing = {a:a, r:g.r}; }
      if(g.t === 'line'){ var l = lineLen(g.c); len += l; if(!longest || l > longest.l) longest = {l:l, c:g.c}; }
      if(g.t === 'pt') allPts.push(g.c);
    });
    if(cl.kind === 'greenway' && longest){ e.len = Math.round(len); var m = longest.c[Math.floor(longest.c.length/2)]; e.center = [r5(m[0]), r5(m[1])]; }
    else if(bigRing){ e.area = Math.round(area); e.center = bboxCenter(bigRing.r); }
    else e.center = [r5(allPts[0][0]), r5(allPts[0][1])];
    if(cl.kind === 'greenway' && !e.len && area) e.area = Math.round(area);
    e.geoms = cl.geoms.filter(function(g){ return g.t !== 'pt'; }).map(function(g){
      return g.t === 'poly' ? {t:'poly', r:simplify(g.r, 3).map(function(p){ return [r5(p[0]), r5(p[1])]; })} : {t:'line', c:simplify(g.c, 3).map(function(p){ return [r5(p[0]), r5(p[1])]; })};
    });
    var all = []; e.geoms.forEach(function(g){ (g.r || g.c).forEach(function(p){ all.push(p); }); });
    e.bb = all.length ? bboxOf(all) : null;
    return e;
  });
  return {v:DATA_VER, region:region.id, fetchedAt:new Date().toISOString(), boundaries:mi.lines, entities:entities};
}


var api = {REGIONS:REGIONS, MUNIS_23:MUNIS_23, MUNIS_TAMA:MUNIS_TAMA, MUNIS:MUNIS, IS23:IS23, TOKYO_BBOX:TOKYO_BBOX, CHUNKS:CHUNKS, MAIN:MAIN, ENDPOINTS:ENDPOINTS, DATA_VER:DATA_VER, r5:r5, eq:eq, joinRings:joinRings, ringArea:ringArea, hav:hav, lineLen:lineLen, bboxOf:bboxOf, bboxCenter:bboxCenter, inRing:inRing, simplify:simplify, boundaryQuery:boundaryQuery, chunkQuery:chunkQuery, overpass:overpass, geomsOf:geomsOf, buildMuniIndex:buildMuniIndex, extremes:extremes, munisAt:munisAt, processData:processData};
if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.ParkData = api;
})(typeof self !== 'undefined' ? self : this);
