// Capsule-vs-triangle-soup collision with a uniform grid broadphase.
// Works in GL space (Y up). Zone geometry only — placed objects (torches, grass,
// bone piles) are decorative and would otherwise snag the player constantly.

const CELL = 48;

export class CollisionWorld {
  constructor(batches) {
    const tris = [];
    for (const b of batches) {
      if (b.isObject || b.isNpc) continue;
      // Water surfaces and other blended materials are walk-through.
      if (b.material.mode !== 0x01 && b.material.mode !== 0x13 && b.material.mode !== 0x553) continue;
      for (let i = 0; i < b.indices.length; i += 3) {
        const a = b.indices[i] * 3, c = b.indices[i + 1] * 3, d = b.indices[i + 2] * 3;
        tris.push([
          b.positions[a], b.positions[a + 1], b.positions[a + 2],
          b.positions[c], b.positions[c + 1], b.positions[c + 2],
          b.positions[d], b.positions[d + 1], b.positions[d + 2],
        ]);
      }
    }
    this.tris = tris;
    this.grid = new Map();
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      const minX = Math.min(tri[0], tri[3], tri[6]), maxX = Math.max(tri[0], tri[3], tri[6]);
      const minZ = Math.min(tri[2], tri[5], tri[8]), maxZ = Math.max(tri[2], tri[5], tri[8]);
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const key = cx * 73856093 ^ cz * 19349663;
          let bucket = this.grid.get(key);
          if (!bucket) this.grid.set(key, (bucket = []));
          bucket.push(t);
        }
      }
    }
  }

  *near(x, z, radius) {
    const seen = new Set();
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
        const bucket = this.grid.get(cx * 73856093 ^ cz * 19349663);
        if (!bucket) continue;
        for (const t of bucket) {
          if (seen.has(t)) continue;
          seen.add(t);
          yield this.tris[t];
        }
      }
    }
  }

  /**
   * Generic ray cast against the soup. Returns distance to the nearest hit, or
   * `maxDist` if the ray reaches that far unobstructed.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = maxDist;
    // Step along the ray so the grid lookup stays local rather than scanning
    // every cell in the ray's bounding box.
    const step = CELL * 0.75;
    for (let t = 0; t < maxDist; t += step) {
      const px = ox + dx * t, pz = oz + dz * t;
      for (const tri of this.near(px, pz, step)) {
        const d = rayTriangle(ox, oy, oz, dx, dy, dz, tri);
        if (d !== null && d >= 0 && d < best) best = d;
      }
      if (best < t) break; // already found a hit closer than we've marched
    }
    return best;
  }

  /** Nearest floor below (x, y, z); returns null if nothing is hit within maxDrop. */
  floorAt(x, y, z, maxDrop = 4096) {
    let best = null;
    for (const t of this.near(x, z, 2)) {
      const hit = rayTriangleDown(x, y, z, t);
      if (hit !== null && hit <= y + 0.01 && y - hit <= maxDrop) {
        if (best === null || hit > best) best = hit;
      }
    }
    return best;
  }

  /**
   * Pushes a vertical capsule out of any triangle it intersects.
   * `pos` is the capsule's bottom-centre (feet). Returns { pos, grounded }.
   */
  resolve(pos, radius, height) {
    const p = [pos[0], pos[1], pos[2]];
    let grounded = false;
    const segBottom = radius, segTop = height - radius;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const t of this.near(p[0], p[2], radius + 2)) {
        // Closest point between the capsule's core segment and this triangle.
        const [near, onSeg] = closestSegmentTriangle(
          p[0], p[1] + segBottom, p[2],
          p[0], p[1] + segTop, p[2], t);
        const dx = onSeg[0] - near[0], dy = onSeg[1] - near[1], dz = onSeg[2] - near[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= radius * radius || distSq < 1e-12) continue;
        const dist = Math.sqrt(distSq);
        const push = radius - dist;
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        p[0] += nx * push; p[1] += ny * push; p[2] += nz * push;
        if (ny > 0.5) grounded = true;
        moved = true;
      }
      if (!moved) break;
    }
    return { pos: p, grounded };
  }
}

/** Möller–Trumbore, double-sided. Returns distance along the ray or null. */
function rayTriangle(ox, oy, oz, dx, dy, dz, t) {
  const ax = t[0], ay = t[1], az = t[2];
  const e1x = t[3] - ax, e1y = t[4] - ay, e1z = t[5] - az;
  const e2x = t[6] - ax, e2y = t[7] - ay, e2z = t[8] - az;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-9) return null;
  const f = 1 / a;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return null;
  return f * (e2x * qx + e2y * qy + e2z * qz);
}

function rayTriangleDown(px, py, pz, t) {
  // Ray origin (px,py,pz) pointing (0,-1,0).
  const ax = t[0], ay = t[1], az = t[2];
  const e1x = t[3] - ax, e1y = t[4] - ay, e1z = t[5] - az;
  const e2x = t[6] - ax, e2y = t[7] - ay, e2z = t[8] - az;
  // h = dir x e2, with dir = (0,-1,0)
  const hx = -1 * e2z - 0 * e2y;
  const hy = 0 * e2x - 0 * e2z;
  const hz = 0 * e2y - -1 * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-9) return null;
  const f = 1 / a;
  const sx = px - ax, sy = py - ay, sz = pz - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (0 * qx + -1 * qy + 0 * qz);
  if (v < 0 || u + v > 1) return null;
  const dist = f * (e2x * qx + e2y * qy + e2z * qz);
  return dist >= 0 ? py - dist : null;
}

function closestPointOnTriangle(px, py, pz, t) {
  const ax = t[0], ay = t[1], az = t[2];
  const bx = t[3], by = t[4], bz = t[5];
  const cx = t[6], cy = t[7], cz = t[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

/** Samples the capsule segment to find the closest (triangle point, segment point) pair. */
function closestSegmentTriangle(x0, y0, z0, x1, y1, z1, t) {
  let bestD = Infinity, bestTri = null, bestSeg = null;
  const STEPS = 6;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    const px = x0 + (x1 - x0) * s, py = y0 + (y1 - y0) * s, pz = z0 + (z1 - z0) * s;
    const q = closestPointOnTriangle(px, py, pz, t);
    const dx = px - q[0], dy = py - q[1], dz = pz - q[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; bestTri = q; bestSeg = [px, py, pz]; }
  }
  return [bestTri, bestSeg];
}
