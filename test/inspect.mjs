// Prints a summary of what the parsers extract from a zone. Usage: node test/inspect.mjs [zone]
import { readFileSync } from 'fs';
import { readPFS } from '/home/wes/workspace/eq-js-zoneloader/src/pfs.js';
import { buildZone } from '/home/wes/workspace/eq-js-zoneloader/src/zone.js';
const D='/home/wes/workspace/eq-js-zoneloader/data/';
const Z = process.argv[2] || 'blackburrow';
const zone = await readPFS(new Uint8Array(readFileSync(D+`${Z}.s3d`)));
const o1 = await readPFS(new Uint8Array(readFileSync(D+`${Z}_obj.s3d`)));
const o2 = await readPFS(new Uint8Array(readFileSync(D+`${Z}_2_obj.s3d`)));
const t0=Date.now();
const r = buildZone(zone,[o1,o2]);
console.log('build ms', Date.now()-t0);
console.log('stats', {...r.stats, missingActors:[...r.stats.missingActors]});
console.log('batches', r.batches.length, 'textures', r.textures.size);
let v=0,i=0; for(const b of r.batches){v+=b.positions.length/3;i+=b.indices.length/3;}
console.log('total verts',v,'tris',i);
console.log('bounds', r.bounds.min.map(n=>n.toFixed(1)), r.bounds.max.map(n=>n.toFixed(1)));
console.log('modes:', [...new Set(r.batches.map(b=>'0x'+b.material.mode.toString(16)))].join(' '));
console.log('animated:', r.batches.filter(b=>b.material.animated).map(b=>b.material.name+'('+b.material.frames.length+')').join(' '));
console.log('largest batches:', r.batches.map(b=>[b.material.name,b.indices.length/3]).sort((a,b)=>b[1]-a[1]).slice(0,8));
// sanity: any NaN?
let nan=0; for(const b of r.batches) for(const p of b.positions) if(!Number.isFinite(p)) nan++;
console.log('non-finite positions:', nan);
// UV range
let umin=1e9,umax=-1e9; for(const b of r.batches) for(const u of b.uvs){umin=Math.min(umin,u);umax=Math.max(umax,u);}
console.log('uv range', umin.toFixed(2), umax.toFixed(2));
// vertex color usage
let colored=0,total=0; for(const b of r.batches) for(let k=0;k<b.colors.length;k+=4){total++; if(b.colors[k]<0.99)colored++;}
console.log('verts with non-white color:', colored, '/', total);
