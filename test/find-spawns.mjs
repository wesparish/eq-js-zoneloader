// Picks a known-good spawn per zone and prints it as zones.json entries.
// Runs the real collision code, so a candidate is only accepted if the capsule
// solver leaves it essentially untouched — i.e. it's genuinely in free space.
import { readFileSync, existsSync } from 'fs';
import { readPFS } from '/home/wes/workspace/eq-js-zoneloader/src/pfs.js';
import { buildZone } from '/home/wes/workspace/eq-js-zoneloader/src/zone.js';
import { CollisionWorld } from '/home/wes/workspace/eq-js-zoneloader/src/collision.js';
const DIR = '/home/wes/workspace/eq-js-zoneloader/data';
const EYE = 5, PH = 6, PR = 2;

for (const z of process.argv.slice(2)) {
  const arc = readPFS(new Uint8Array(readFileSync(`${DIR}/${z}.s3d`)));
  const objs = [];
  for (const suf of ['_obj', '_2_obj']) {
    const p = `${DIR}/${z}${suf}.s3d`;
    if (existsSync(p)) objs.push(readPFS(new Uint8Array(readFileSync(p))));
  }
  const zd = buildZone(arc, objs);
  const col = new CollisionWorld(zd.batches);
  const op = zd.objectPositions;
  const n = op.length / 3;

  const rej = {noFloor:0, embedded:0, notGrounded:0, headroom:0, clearance:0, ok:0};
  const valid = [];
  let best = null;
  const stride = Math.max(1, Math.floor(n / 500));
  for (let i = 0; i < n; i += stride) {
    const cx = op[i*3], cy = op[i*3+1], cz = op[i*3+2];
    const floor = col.floorAt(cx, cy + 30, cz);
    if (floor === null) { rej.noFloor++; continue; }
    const pos = [cx, floor + 0.1, cz];
    // Reject anywhere the capsule solver has to shove us: that means embedded.
    const r = col.resolve(pos, PR, PH);
    const moved = Math.hypot(r.pos[0]-pos[0], r.pos[1]-pos[1], r.pos[2]-pos[2]);
    if (moved > 1.0) { rej.embedded++; continue; }
    if (!r.grounded) { rej.notGrounded++; continue; }

    const eye = floor + EYE;
    const head = Math.min(col.raycast(cx, eye, cz, 0, 1, 0, 200), 200);
    if (head < 14) { rej.headroom++; continue; }
    let minClear = Infinity, bestDir = 0, bestClear = 0;
    for (let d = 0; d < 12; d++) {
      const a = (d / 12) * Math.PI * 2;
      const c = col.raycast(cx, eye, cz, Math.sin(a), 0, -Math.cos(a), 300);
      minClear = Math.min(minClear, c);
      if (c > bestClear) { bestClear = c; bestDir = a; }
    }
    if (minClear < 12) { rej.clearance++; continue; }
    let density = 0;
    for (let j = 0; j < n; j++) {
      const dx = op[j*3]-cx, dz = op[j*3+2]-cz;
      if (dx*dx + dz*dz < 200*200) density++;
    }
    rej.ok++;
    const score = Math.min(minClear, 60) + Math.min(head, 60) * 0.5 + density * 3;
    valid.push({ score, pos, yaw: bestDir, head, minClear, density });
  }
  // Among the good candidates, take the lowest one: in a city the high-scoring
  // spots include rooftops, and the street below is the view you actually want.
  if (valid.length) {
    valid.sort((a, b) => b.score - a.score);
    const top = valid.slice(0, Math.max(1, Math.ceil(valid.length * 0.25)));
    top.sort((a, b) => a.pos[1] - b.pos[1]);
    best = top[0];
  }
  console.log(`${z}: candidates=${Math.ceil(n/stride)} valid=${valid.length}`, rej);
  if (!best) { console.log(`${z}: no candidate found`); continue; }
  // Back to EQ coordinates for the manifest.
  const eqx = best.pos[0], eqy = -best.pos[2], eqz = best.pos[1];
  console.log(`"spawn": [${eqx.toFixed(1)}, ${eqy.toFixed(1)}, ${eqz.toFixed(1)}, ${best.yaw.toFixed(2)}]   // ${z}: headroom ${best.head.toFixed(0)}, clearance ${best.minClear.toFixed(0)}, ${best.density} objects nearby`);
}
