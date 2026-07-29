import { readFileSync } from 'fs';
import zlib from 'zlib';
import { readPFS } from '/home/wes/workspace/eq-js-zoneloader/src/pfs.js';
const D='/home/wes/workspace/eq-js-zoneloader/data/';

// Reference implementation using node zlib, mirroring the same chunk walk.
function refPFS(buf){
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  const dirOff=dv.getUint32(0,true), n=dv.getUint32(dirOff,true);
  const ents=[]; let nameE=null;
  for(let i=0;i<n;i++){const p=dirOff+4+i*12;const e={crc:dv.getUint32(p,true),offset:dv.getUint32(p+4,true),size:dv.getUint32(p+8,true)};if(e.crc===0x61580ac9)nameE=e;else ents.push(e);}
  const inf=(off,total)=>{const parts=[];let w=0,p=off;while(w<total){const dl=dv.getUint32(p,true);p+=8;const c=zlib.inflateSync(Buffer.from(buf.buffer,buf.byteOffset+p,dl));parts.push(c);w+=c.length;p+=dl;}return Buffer.concat(parts);};
  const nb=inf(nameE.offset,nameE.size); const ndv=new DataView(nb.buffer,nb.byteOffset,nb.byteLength);
  const cnt=ndv.getUint32(0,true); const names=[]; let np=4;
  for(let i=0;i<cnt;i++){const l=ndv.getUint32(np,true);np+=4;names.push(nb.subarray(np,np+l-1).toString('latin1').toLowerCase());np+=l;}
  ents.sort((a,b)=>a.offset-b.offset);
  const m=new Map(); ents.forEach((e,i)=>m.set(names[i],inf(e.offset,e.size)));
  return m;
}

let totalBytes=0, files=0, mismatches=0;
for (const a of ['blackburrow.s3d','blackburrow_obj.s3d','blackburrow_2_obj.s3d','blackburrow_chr.s3d']) {
  const raw = new Uint8Array(readFileSync(D+a));
  const t0=process.hrtime.bigint();
  const mine = readPFS(raw);
  const t1=process.hrtime.bigint();
  const ref = refPFS(raw);
  const t2=process.hrtime.bigint();
  let bad=[];
  for (const [k,v] of ref) {
    const m = mine.get(k);
    if (!m || m.length!==v.length || Buffer.compare(Buffer.from(m),v)!==0) bad.push(k);
    else { totalBytes+=v.length; files++; }
  }
  mismatches+=bad.length;
  console.log(`${a}: ${ref.size} files, mine=${Number(t1-t0)/1e6}ms zlib=${Number(t2-t1)/1e6}ms, mismatches=${bad.length}`, bad.slice(0,4));
}
console.log(`\n${files} files / ${(totalBytes/1048576).toFixed(1)} MiB verified identical, ${mismatches} mismatches`);
