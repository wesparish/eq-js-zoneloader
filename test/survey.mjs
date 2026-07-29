// Runs the full parse+build pipeline over every zone archive in an EQ client dir.
import { readFileSync, existsSync, readdirSync } from 'fs';
import { readPFS } from '/home/wes/workspace/eq-js-zoneloader/src/pfs.js';
import { buildZone } from '/home/wes/workspace/eq-js-zoneloader/src/zone.js';
const DIR = process.argv[2] || '/home/wes/Games/eq-quarm-20251002/client';
const names = readdirSync(DIR).filter(f=>/\.s3d$/.test(f) && !/_obj|_chr|_2_obj/.test(f))
  .map(f=>f.replace('.s3d',''));
const ok=[], fail=[];
for (const z of names) {
  try {
    const arc = readPFS(new Uint8Array(readFileSync(`${DIR}/${z}.s3d`)));
    const hasWld = [...arc.keys()].some(n=>n.endsWith('.wld'));
    if (!hasWld) { fail.push([z,'no .wld (not a zone archive)']); continue; }
    const objs=[];
    for (const suf of ['_obj','_2_obj']) {
      const p=`${DIR}/${z}${suf}.s3d`;
      if (existsSync(p)) objs.push(readPFS(new Uint8Array(readFileSync(p))));
    }
    const t0=Date.now();
    const r = buildZone(arc, objs);
    let tris=0; for(const b of r.batches) tris+=b.indices.length/3;
    if (tris===0) { fail.push([z,'built 0 triangles']); continue; }
    ok.push({z, tris, batches:r.batches.length, tex:r.textures.size,
             objs:r.stats.objectInstances, miss:r.stats.missingActors.size, ms:Date.now()-t0});
  } catch(e) { fail.push([z, e.message]); }
}
console.log(`WORKS: ${ok.length}/${names.length}`);
console.log(`total triangles across all zones: ${ok.reduce((s,r)=>s+r.tris,0).toLocaleString()}`);
const big = [...ok].sort((a,b)=>b.tris-a.tris).slice(0,8);
console.log('\nlargest zones:');
for(const r of big) console.log(`  ${r.z.padEnd(14)} ${String(r.tris).padStart(7)} tris  ${String(r.batches).padStart(4)} batches  ${String(r.objs).padStart(4)} objs  ${r.ms}ms`);
const withMissing = ok.filter(r=>r.miss>0);
console.log(`\nzones with unresolved actordefs: ${withMissing.length}`, withMissing.slice(0,8).map(r=>`${r.z}(${r.miss})`).join(' '));
console.log(`\nFAILED: ${fail.length}`);
for(const [z,m] of fail) console.log(`  ${z.padEnd(14)} ${m}`);
