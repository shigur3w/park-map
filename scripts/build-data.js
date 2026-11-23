#!/usr/bin/env node
// Builds the prebuilt park data for every region (data/parks.json for Tokyo, data/ningbo.json for Ningbo)
// so the page loads one file instead of every visitor querying Overpass.
// Run by .github/workflows/update-parks.yml.
//   node scripts/build-data.js            all regions
//   node scripts/build-data.js ningbo     one region
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../parkdata.js');

const OUT_DIR = path.join(__dirname, '..', 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function buildRegion(region) {
  const t0 = Date.now();
  console.log(`== ${region.label}: boundaries of ${region.munis.length} districts…`);
  const boundary = await P.overpass(P.boundaryQuery(region));
  console.log('  ', boundary.elements.length, 'relations');

  const chunks = [];
  for (const [i, c] of region.chunks.entries()) {
    await sleep(3000); // be polite to the public Overpass servers
    console.log(`Chunk ${i + 1}/${region.chunks.length}: ${c.label}…`);
    const j = await P.overpass(P.chunkQuery(c.b, region));
    console.log('  ', j.elements.length, 'elements');
    chunks.push(j.elements);
  }

  const data = P.processData(boundary.elements, chunks, region);
  const kinds = data.entities.reduce((a, e) => (a[e.unnamed ? 'unnamed' : e.kind] = (a[e.unnamed ? 'unnamed' : e.kind] || 0) + 1, a), {});
  console.log('Entities:', data.entities.length, kinds);
  // sanity check: never publish a broken partial download
  if (data.entities.length < region.minEntities) throw new Error(`${region.label}: only ${data.entities.length} entities; expected at least ${region.minEntities}. Not writing.`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(OUT_DIR, region.file), json);
  fs.writeFileSync(path.join(OUT_DIR, region.versionFile), JSON.stringify({ v: data.v, region: region.id, fetchedAt: data.fetchedAt, count: data.entities.length, bytes: json.length }) + '\n');
  console.log(`Wrote data/${region.file} (${(json.length / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function main() {
  const only = process.argv[2];
  const regions = Object.values(P.REGIONS).filter(r => !only || r.id === only);
  if (!regions.length) throw new Error('Unknown region: ' + only);
  let failed = 0;
  for (const r of regions) {
    try { await buildRegion(r); }
    catch (err) { failed++; console.error(`!! ${r.label} failed, keeping its previous data:`, err.message || err); }
  }
  if (failed === regions.length) process.exit(1); // nothing built at all
}

main().catch(err => { console.error(err); process.exit(1); });
