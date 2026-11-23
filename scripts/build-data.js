#!/usr/bin/env node
// Builds data/parks.json from OpenStreetMap so the page can load it in one request
// instead of every visitor querying Overpass. Run by .github/workflows/update-parks.yml.
//   node scripts/build-data.js
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../parkdata.js');

const OUT_DIR = path.join(__dirname, '..', 'data');
const MIN_ENTITIES = 3000; // sanity check: never publish a broken partial download

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  console.log('Boundaries of', P.MUNIS.length, 'municipalities…');
  const boundary = await P.overpass(P.boundaryQuery());
  console.log('  ', boundary.elements.length, 'relations');

  const chunks = [];
  for (const [i, c] of P.CHUNKS.entries()) {
    await sleep(3000); // be polite to the public Overpass servers
    console.log(`Chunk ${i + 1}/${P.CHUNKS.length}: ${c.label}…`);
    const j = await P.overpass(P.chunkQuery(c.b));
    console.log('  ', j.elements.length, 'elements');
    chunks.push(j.elements);
  }

  const data = P.processData(boundary.elements, chunks);
  const kinds = data.entities.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {});
  console.log('Entities:', data.entities.length, kinds);
  if (data.entities.length < MIN_ENTITIES) throw new Error(`Only ${data.entities.length} entities; expected at least ${MIN_ENTITIES}. Not writing.`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(OUT_DIR, 'parks.json'), json);
  fs.writeFileSync(path.join(OUT_DIR, 'version.json'), JSON.stringify({ v: data.v, fetchedAt: data.fetchedAt, count: data.entities.length, bytes: json.length }) + '\n');
  console.log(`Wrote data/parks.json (${(json.length / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch(err => { console.error(err); process.exit(1); });
