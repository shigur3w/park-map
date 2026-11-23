#!/usr/bin/env node
// One-off probe: how many named parks / gardens / greenways OpenStreetMap has in
// Ningbo's six urban districts, plus the urban-core road network for checking
// which coordinate system other location data uses. Writes probe-out/ (uploaded
// as a workflow artifact, never committed).
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../parkdata.js');

const DISTRICTS = ['海曙区', '江北区', '鄞州区', '镇海区', '北仑区', '奉化区'];
const BBOX = [29.40, 121.20, 30.10, 122.20];  // s,w,n,e: all six districts (excludes 重庆 江北区)
const CORE = [29.70, 121.35, 30.00, 121.85];  // urban core, for the road network
const OUT = path.join(__dirname, '..', 'probe-out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bb = b => '(' + b.join(',') + ')';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log('District boundaries…');
  const bq = '[out:json][timeout:180];\nrel["boundary"="administrative"]["name"~"^(' + DISTRICTS.join('|') + ')$"]' + bb(BBOX) + ';\nout geom;';
  const bnd = (await P.overpass(bq)).elements;
  const rings = {};
  bnd.forEach(e => {
    const outer = (e.members || []).filter(m => m.type === 'way' && m.geometry && m.role !== 'inner').map(m => m.geometry.filter(Boolean).map(p => [p.lat, p.lon]));
    rings[e.tags.name] = P.joinRings(outer).filter(r => r.length > 3 && P.eq(r[0], r[r.length - 1]));
    console.log('  ', e.tags.name, 'admin_level', e.tags.admin_level, 'rings', rings[e.tags.name].length);
  });

  await sleep(3000);
  console.log('Parks, gardens and greenways…');
  const fq = '[out:json][timeout:180];\n(\n' +
    '  nwr["leisure"="park"]' + bb(BBOX) + ';\n' +
    '  nwr["leisure"="garden"]["access"!~"^(private|no)$"]' + bb(BBOX) + ';\n' +
    '  way["name"~"绿道|綠道"]["building"!~"."]' + bb(BBOX) + ';\n' +
    '  rel["name"~"绿道|綠道"]' + bb(BBOX) + ';\n' +
    ');\nout geom;';
  const feats = (await P.overpass(fq)).elements;
  console.log('  ', feats.length, 'elements');

  const stats = {}; DISTRICTS.forEach(d => stats[d] = { park: 0, garden: 0, greenway: 0, unnamedPark: 0, areaHa: 0 });
  const named = [];
  feats.forEach(e => {
    const tags = e.tags || {}, name = tags.name || tags['name:zh'];
    const g = P.geomsOf(e); if (!g.length) return;
    const pts = []; g.forEach(x => { if (x.t === 'pt') pts.push(x.c); else (x.r || x.c).forEach(p => pts.push(p)); });
    const c = P.bboxCenter(pts);
    const d = DISTRICTS.find(n => (rings[n] || []).some(r => P.inRing(c[0], c[1], r)));
    if (!d) return;
    const kind = name && /绿道|綠道/.test(name) ? 'greenway' : (tags.leisure === 'garden' ? 'garden' : (tags.leisure === 'park' ? 'park' : null));
    if (!kind) return;
    if (!name) { if (kind === 'park') stats[d].unnamedPark++; return; }
    let area = 0, len = 0; g.forEach(x => { if (x.t === 'poly') area += P.ringArea(x.r); if (x.t === 'line') len += P.lineLen(x.c); });
    stats[d][kind]++; stats[d].areaHa += area / 1e4;
    named.push({ name, kind, district: d, ha: +(area / 1e4).toFixed(1), km: +(len / 1000).toFixed(1), center: c, osm: e.type + '/' + e.id });
  });
  Object.values(stats).forEach(s => s.areaHa = Math.round(s.areaHa));
  // de-duplicate names for a readable count (several OSM pieces can share one park name)
  const uniq = new Set(named.map(n => n.kind + '|' + n.name + '|' + n.district));
  console.log('Per district:', JSON.stringify(stats));
  console.log('Named features:', named.length, 'distinct names:', uniq.size);
  const top = named.filter(n => n.kind !== 'greenway').sort((a, b) => b.ha - a.ha).slice(0, 25);
  console.log('Largest:', top.map(n => `${n.name}(${n.district},${n.ha}ha)`).join(' / '));
  console.log('Greenways:', named.filter(n => n.kind === 'greenway').map(n => `${n.name}(${n.km}km)`).slice(0, 40).join(' / '));
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ stats, named }, null, 1));

  await sleep(3000);
  console.log('Urban-core road network…');
  const rq = '[out:json][timeout:180];\nway["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"]' + bb(CORE) + ';\nout geom;';
  const roads = (await P.overpass(rq)).elements.filter(e => e.geometry).map(e => e.geometry.filter(Boolean).map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]));
  fs.writeFileSync(path.join(OUT, 'roads.json'), JSON.stringify(roads));
  console.log('  ', roads.length, 'road ways');
}

main().catch(err => { console.error(err); process.exit(1); });
