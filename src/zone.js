// Turns parsed WLD data into render-ready batches.
//
// EQ is Z-up; WebGL here is Y-up. We map (x, y, z)eq -> (x, z, -y)gl, which is a
// -90 degree rotation about X and therefore preserves winding/handedness.

import { parseWLD, materialTextures } from './wld.js';
import { decodeImage } from './textures.js';
import { buildCharacters, variantMaterial } from './skeleton.js';

export const RENDER = {
  INVISIBLE: 0x00,
  OPAQUE: 0x01,
  TRANSPARENT_50: 0x05,
  TRANSPARENT_75: 0x09,
  TRANSPARENT_25: 0x0a,
  MASKED: 0x13,
};

function renderModeOf(material) {
  return material ? material.renderMethod & 0x7fffffff : RENDER.OPAQUE;
}

/** Per-material accumulator that merges many small meshes into a few big buffers. */
class BatchBuilder {
  constructor() { this.batches = new Map(); }

  get(key, meta) {
    let b = this.batches.get(key);
    if (!b) {
      b = { key, ...meta, positions: [], uvs: [], normals: [], colors: [], indices: [], vertexCount: 0 };
      this.batches.set(key, b);
    }
    return b;
  }

  /**
   * Appends one material-run of `mesh` into its batch, optionally transformed.
   * `xform` is a 4x4 column-major matrix or null.
   */
  addRun(batch, mesh, firstTri, triCount, xform, normalXform, vertexColors) {
    const remap = new Map();
    const idx = (vi) => {
      let n = remap.get(vi);
      if (n !== undefined) return n;
      n = batch.vertexCount++;
      remap.set(vi, n);
      let x = mesh.positions[vi * 3], y = mesh.positions[vi * 3 + 1], z = mesh.positions[vi * 3 + 2];
      let nx = mesh.normals[vi * 3], ny = mesh.normals[vi * 3 + 1], nz = mesh.normals[vi * 3 + 2];
      if (xform) {
        const tx = xform[0] * x + xform[4] * y + xform[8] * z + xform[12];
        const ty = xform[1] * x + xform[5] * y + xform[9] * z + xform[13];
        const tz = xform[2] * x + xform[6] * y + xform[10] * z + xform[14];
        x = tx; y = ty; z = tz;
        const mx = normalXform[0] * nx + normalXform[4] * ny + normalXform[8] * nz;
        const my = normalXform[1] * nx + normalXform[5] * ny + normalXform[9] * nz;
        const mz = normalXform[2] * nx + normalXform[6] * ny + normalXform[10] * nz;
        nx = mx; ny = my; nz = mz;
      }
      // EQ -> GL axis swap
      batch.positions.push(x, z, -y);
      batch.normals.push(nx, nz, -ny);
      // V is used as-is. The textures decode with row 0 = the image's top row, and
      // GL maps data row 0 to t=0, so EQ's D3D-style "v=0 is the top" already lines
      // up. Negating v here (the usual D3D->GL correction) renders every sign,
      // banner and shield in the game upside down.
      batch.uvs.push(mesh.uvs[vi * 2] || 0, mesh.uvs[vi * 2 + 1] || 0);
      // Placed objects carry their baked lighting per instance (0x32), not in the
      // shared mesh, so prefer the instance list when one was supplied.
      const src = vertexColors && vi * 4 + 3 < vertexColors.length ? vertexColors : mesh.colors;
      batch.colors.push(
        src[vi * 4] / 255, src[vi * 4 + 1] / 255,
        src[vi * 4 + 2] / 255, src[vi * 4 + 3] / 255);
      return n;
    };
    for (let t = firstTri; t < firstTri + triCount; t++) {
      // polyFlags bit 0x10 marks a "permeable"/non-solid poly; still drawn.
      const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
      batch.indices.push(idx(a), idx(b), idx(c));
    }
  }
}

function makeTransform(pos, rot, scale) {
  // Rotation about Z (heading) only; pitch/roll are unused by EQ placements.
  const cz = Math.cos(rot[2]), sz = Math.sin(rot[2]);
  const s = scale[0];
  return [
    cz * s, sz * s, 0, 0,
    -sz * s, cz * s, 0, 0,
    0, 0, s, 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

function normalMatrixOf(m) {
  // Uniform scale + rotation, so the rotation part is its own normal matrix.
  const s = Math.hypot(m[0], m[1], m[2]) || 1;
  return [m[0] / s, m[1] / s, m[2] / s, 0, m[4] / s, m[5] / s, m[6] / s, 0, m[8] / s, m[9] / s, m[10] / s, 0, 0, 0, 0, 1];
}

/** Resolves each material in a list to a texture key, registering images as needed. */
function resolveMaterials(wld, matListFrag, archives, textures) {
  const out = [];
  if (!matListFrag) return out;
  for (const ref of matListFrag.materialRefs) {
    const mat = wld.fragments[ref];
    if (!mat) { out.push(null); continue; }
    const info = materialTextures(wld, mat);
    const frames = [];
    for (const file of info.files) {
      if (!textures.has(file)) {
        let bytes = null;
        for (const arc of archives) if (arc.has(file)) { bytes = arc.get(file); break; }
        const img = bytes ? decodeImage(file, bytes) : null;
        textures.set(file, img);
      }
      if (textures.get(file)) frames.push(file);
    }
    out.push({
      name: mat.name,
      mode: renderModeOf(mat),
      frames,
      animated: info.animated && frames.length > 1,
      delayMs: info.delayMs || 200,
    });
  }
  return out;
}

/**
 * Builds all draw batches for a zone.
 * @param zoneArchive  Map from blackburrow.s3d
 * @param objArchives  array of Maps from blackburrow_obj.s3d / _2_obj.s3d
 */
export function buildZone(zoneArchive, objArchives, opts = {}) {
  const textures = new Map();
  const objectPositions = [];
  const builder = new BatchBuilder();
  const stats = {
    zoneMeshes: 0, zoneTris: 0, objectInstances: 0, objectTris: 0,
    objectsWithBakedLight: 0, missingActors: new Set(),
  };

  const zoneWldName = [...zoneArchive.keys()].find((n) => n.endsWith('.wld') && n !== 'objects.wld' && n !== 'lights.wld');
  const zoneWld = parseWLD(zoneArchive.get(zoneWldName));
  const allArchives = [zoneArchive, ...objArchives];

  // --- static zone geometry ---
  const zoneMatLists = new Map();
  for (const mesh of zoneWld.byType.get(0x36) || []) {
    if (!mesh.positions || !mesh.indices.length) continue;
    let mats = zoneMatLists.get(mesh.materialListRef);
    if (!mats) {
      mats = resolveMaterials(zoneWld, zoneWld.fragments[mesh.materialListRef], allArchives, textures);
      zoneMatLists.set(mesh.materialListRef, mats);
    }
    stats.zoneMeshes++;
    let tri = 0;
    for (const run of mesh.polyRuns) {
      const mat = mats[run.material];
      if (mat && mat.mode === RENDER.INVISIBLE) { tri += run.count; continue; }
      if (!mat || !mat.frames.length) { tri += run.count; continue; }
      const batch = builder.get(`z:${mat.name}`, { material: mat });
      builder.addRun(batch, mesh, tri, run.count, null, null);
      stats.zoneTris += run.count;
      tri += run.count;
    }
  }

  // --- placed objects ---
  // Actor definitions live in the _obj archives; placements live in the zone's objects.wld.
  const actorMeshes = new Map(); // ACTORDEF name -> { mesh, materials }
  for (const arc of objArchives) {
    const wldName = [...arc.keys()].find((n) => n.endsWith('.wld'));
    if (!wldName) continue;
    const w = parseWLD(arc.get(wldName));
    for (const actor of w.byType.get(0x14) || []) {
      // 0x14 -> 0x2D (mesh reference) -> 0x36 (mesh)
      for (const ref of actor.refs) {
        const meshRef = w.fragments[ref];
        if (!meshRef) continue;
        const mesh = meshRef.type === 0x2d ? w.fragments[meshRef.ref] : meshRef;
        if (!mesh || mesh.type !== 0x36 || !mesh.positions) continue;
        actorMeshes.set(actor.name, {
          mesh,
          materials: resolveMaterials(w, w.fragments[mesh.materialListRef], [arc, ...allArchives], textures),
        });
        break;
      }
    }
  }

  if (opts.objects !== false && zoneArchive.has('objects.wld')) {
    const placeWld = parseWLD(zoneArchive.get('objects.wld'));
    for (const inst of placeWld.byType.get(0x15) || []) {
      const actor = actorMeshes.get(inst.actorDef);
      if (!actor) { stats.missingActors.add(inst.actorDef); continue; }
      const xform = makeTransform(inst.position, inst.rotation, inst.scale);
      const nxform = normalMatrixOf(xform);
      stats.objectInstances++;
      // Kept for spawn selection: placements cluster where a zone's content is.
      objectPositions.push(inst.position[0], inst.position[2], -inst.position[1]);
      // 0x15 -> 0x33 -> 0x32: this instance's baked vertex lighting.
      const colorRef = placeWld.fragments[inst.vertexColorRef];
      const colorList = colorRef && colorRef.type === 0x33 ? placeWld.fragments[colorRef.ref] : null;
      const instColors = colorList && colorList.colors ? colorList.colors : null;
      if (instColors) stats.objectsWithBakedLight++;
      let tri = 0;
      const { mesh, materials } = actor;
      for (const run of mesh.polyRuns) {
        const mat = materials[run.material];
        if (!mat || !mat.frames.length || mat.mode === RENDER.INVISIBLE) { tri += run.count; continue; }
        const batch = builder.get(`o:${mat.name}`, { material: mat, isObject: true });
        builder.addRun(batch, mesh, tri, run.count, xform, nxform, instColors);
        stats.objectTris += run.count;
        tri += run.count;
      }
    }
  }

  const batches = [...builder.batches.values()].map((b) => ({
    material: b.material,
    isObject: !!b.isObject,
    positions: new Float32Array(b.positions),
    uvs: new Float32Array(b.uvs),
    normals: new Float32Array(b.normals),
    colors: new Float32Array(b.colors),
    indices: new Uint32Array(b.indices),
  }));

  // Sort opaque first so alpha blending composites correctly.
  batches.sort((a, b) => (a.material.mode === RENDER.OPAQUE ? 0 : 1) - (b.material.mode === RENDER.OPAQUE ? 0 : 1));

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of batches) {
    if (b.isObject) continue;
    for (let i = 0; i < b.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        bounds.min[k] = Math.min(bounds.min[k], b.positions[i + k]);
        bounds.max[k] = Math.max(bounds.max[k], b.positions[i + k]);
      }
    }
  }

  return { batches, textures, bounds, stats, zoneWld, objectPositions: new Float32Array(objectPositions) };
}

/**
 * Builds batches for NPC spawns. `chrArchive` is the zone's _chr.s3d, `spawns`
 * the entries from data/<zone>_npcs.json. Characters are drawn in their bind
 * pose — no skeletal animation — and are decorative only (no collision).
 */
export function buildNPCs(chrArchive, spawns, textures) {
  const wldName = [...chrArchive.keys()].find((n) => n.endsWith('.wld'));
  if (!wldName) return { batches: [], stats: { placed: 0, missing: new Set() } };
  const wld = parseWLD(chrArchive.get(wldName));
  const models = buildCharacters(wld, [chrArchive], textures);

  const builder = new BatchBuilder();
  const labels = [];
  const stats = { placed: 0, tris: 0, missing: new Set(), byModel: {} };
  const matCache = new Map();
  const metrics = new Map();

  // The spawn table's Z is the model *origin* (mid-body), not the feet — the
  // measured median gap from spawn Z to the local floor is 3.8, which is the
  // gnoll's own origin-to-foot distance. Offsetting by footZ on top of that
  // lifted every NPC a body-height off the ground.
  const metricsFor = (model) => {
    let m = metrics.get(model.code);
    if (m) return m;
    let lo = Infinity, hi = -Infinity;
    for (const entry of model.meshes) {
      const p = entry.mesh.positions;
      for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    }
    m = { footZ: lo, height: Math.max(hi - lo, 0.001) };
    metrics.set(model.code, m);
    return m;
  };

  // EQ's `size` is a multiplier against a nominal base of 6 (default human
  // size), not an absolute height. Deriving scale from the model's own bounding
  // box instead makes long, flat models explode — a snake's Z extent is ~1.3,
  // so size 6 would scale it 4.6x into a 70-unit serpent.
  const BASE_SIZE = 6;

  for (const spawn of spawns) {
    const model = models.get(spawn.model);
    if (!model) { stats.missing.add(spawn.model); continue; }
    const { footZ } = metricsFor(model);
    const scale = (spawn.size || BASE_SIZE) / BASE_SIZE;

    // The spawn table carries no heading, so derive a stable pseudo-heading
    // from the position — better than every NPC facing due north.
    const heading = ((Math.sin(spawn.x * 12.9898 + spawn.y * 78.233) * 43758.5453) % 1 + 1) % 1 * Math.PI * 2;
    const c = Math.cos(heading) * scale, s = Math.sin(heading) * scale;
    const xform = [
      c, s, 0, 0,
      -s, c, 0, 0,
      0, 0, scale, 0,
      spawn.x, spawn.y, spawn.z, 1,
    ];
    const nxform = normalMatrixOf(xform);

    // Body plus one head variant; models with several heads pick by texture.
    const heads = model.meshes.filter((m) => /HE\d\d_DMSPRITEDEF$/.test(m.name));
    const head = heads.length ? heads[Math.min(spawn.texture || 0, heads.length - 1)] : null;
    const parts = model.meshes.filter((m) => !heads.includes(m)).concat(head ? [head] : []);

    stats.placed++;
    stats.byModel[spawn.model] = (stats.byModel[spawn.model] || 0) + 1;

    // Nameplate anchor: just above the model's crown, in GL space.
    const { height } = metricsFor(model);
    const topZ = spawn.z + (footZ + height) * scale + 0.6;
    labels.push({
      name: spawn.name,
      level: spawn.level,
      // Proper-named NPCs (no leading article) are the rare/named mobs.
      named: !/^(a|an|the)\s/i.test(spawn.name),
      pos: [spawn.x, topZ, -spawn.y],
    });

    for (const part of parts) {
      const key = `${part.materialListRef}:${spawn.texture}`;
      let mats = matCache.get(key);
      if (!mats) {
        mats = resolveMaterials(wld, wld.fragments[part.materialListRef], [chrArchive], textures)
          .map((mat) => {
            if (!mat) return mat;
            // Swap in the NPC's texture variant when that material exists.
            const alt = variantMaterial(mat.name, spawn.texture);
            if (alt === mat.name) return mat;
            const altFrag = wld.byName.get(alt);
            if (!altFrag) return mat;
            const info = materialTextures(wld, altFrag);
            const frames = info.files.filter((f) => textures.get(f));
            return frames.length ? { ...mat, name: alt, frames } : mat;
          });
        matCache.set(key, mats);
      }
      let tri = 0;
      for (const run of part.mesh.polyRuns) {
        const mat = mats[run.material];
        if (!mat || !mat.frames.length || mat.mode === RENDER.INVISIBLE) { tri += run.count; continue; }
        const batch = builder.get(`n:${mat.name}`, { material: mat, isNpc: true });
        builder.addRun(batch, part.mesh, tri, run.count, xform, nxform, null);
        stats.tris += run.count;
        tri += run.count;
      }
    }
  }

  const batches = [...builder.batches.values()].map((b) => ({
    material: b.material,
    isObject: false,
    isNpc: true,
    positions: new Float32Array(b.positions),
    uvs: new Float32Array(b.uvs),
    normals: new Float32Array(b.normals),
    colors: new Float32Array(b.colors),
    indices: new Uint32Array(b.indices),
  }));
  return { batches, labels, stats };
}
