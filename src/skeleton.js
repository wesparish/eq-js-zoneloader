// Character models: bind-pose skinning.
//
// Character mesh vertices are stored in *bone-local* space — every bone group's
// centroid sits at the origin — so a mesh rendered as-authored collapses into a
// ball. Each bone carries an animation track whose frame 0 is the bind pose;
// walking the bone tree and accumulating those transforms puts the model back
// together. Only frame 0 is used, so models stand in a static pose.

import { materialTextures } from './wld.js';
import { decodeImage } from './textures.js';

function quatToMatrix(q, t) {
  // Normalize: tracks store rotations as integers over a shared denominator.
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const x = q[0] / len, y = q[1] / len, z = q[2] / len, w = q[3] / len;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ];
}

function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                     a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Resolves a bone's track (0x13 -> 0x12) and returns its frame-0 transform. */
function boneLocalMatrix(wld, bone) {
  const trackRef = wld.fragments[bone.trackRef];
  const track = trackRef && trackRef.type === 0x13 ? wld.fragments[trackRef.ref] : trackRef;
  const frame = track && track.frames && track.frames[0];
  if (!frame) return IDENTITY.slice();
  return quatToMatrix(frame.rotation, frame.translation);
}

/** Accumulates world matrices for every bone by walking the tree from the root. */
export function bindPose(wld, skeleton) {
  const world = new Array(skeleton.bones.length).fill(null);
  const walk = (index, parent) => {
    const bone = skeleton.bones[index];
    if (!bone || world[index]) return;
    world[index] = multiply(parent, boneLocalMatrix(wld, bone));
    for (const child of bone.children) walk(child, world[index]);
  };
  walk(0, IDENTITY);
  for (let i = 0; i < world.length; i++) if (!world[i]) world[i] = IDENTITY.slice();
  return world;
}

function applyMatrix(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Returns a copy of `mesh` with vertices moved into model space using the
 * skeleton's bind pose. `vertexPieces` maps runs of vertices to bones.
 */
export function skinMesh(mesh, boneMatrices) {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  let v = 0;
  const pieces = mesh.vertexPieces.length
    ? mesh.vertexPieces
    : [{ count: mesh.vertexCount, index: 0 }];
  for (const piece of pieces) {
    const m = boneMatrices[piece.index] || IDENTITY;
    for (let k = 0; k < piece.count && v < mesh.vertexCount; k++, v++) {
      const p = applyMatrix(m, mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      positions[v * 3] = p[0]; positions[v * 3 + 1] = p[1]; positions[v * 3 + 2] = p[2];
      // Rotation only for normals — bind-pose transforms carry no scale.
      const n = mesh.normals;
      normals[v * 3] = m[0] * n[v * 3] + m[4] * n[v * 3 + 1] + m[8] * n[v * 3 + 2];
      normals[v * 3 + 1] = m[1] * n[v * 3] + m[5] * n[v * 3 + 1] + m[9] * n[v * 3 + 2];
      normals[v * 3 + 2] = m[2] * n[v * 3] + m[6] * n[v * 3 + 1] + m[10] * n[v * 3 + 2];
    }
  }
  return { ...mesh, positions, normals };
}

/**
 * Character material names are <RACE><PART><SET><PIECE>_MDF. The gnoll ships
 * four complete sets — gnnch0001..0003, gnnch0101..0103, gnnch0201..0203,
 * gnnch0301..0303 — and an NPC's `texture` field selects the *set*, not the
 * piece. Substituting the piece index instead silently renders every NPC in
 * set 00: Blackburrow's gnolls (texture 2, the dark blue set) come out in the
 * pale Splitpaw colours.
 */
export function variantMaterial(name, texture) {
  const m = /^([A-Z]{3})([A-Z]{2})(\d\d)(\d\d)_MDF$/.exec(name);
  if (!m || texture < 0) return name;
  return `${m[1]}${m[2]}${String(texture).padStart(2, '0')}${m[4]}_MDF`;
}

/** Loads every actor definition in a _chr archive, skinned into its bind pose. */
export function buildCharacters(wld, archives, textures) {
  const models = new Map(); // "GNN" -> { meshes: [{mesh, materials}], ... }

  for (const skeleton of wld.byType.get(0x10) || []) {
    if (!skeleton.bones || !skeleton.bones.length) continue;
    const code = skeleton.name.replace(/_HS_DEF$/, '');
    const bones = bindPose(wld, skeleton);

    // Meshes attached to the skeleton: the body plus head/variant meshes.
    const refs = [...skeleton.meshRefs];
    for (const bone of skeleton.bones) if (bone.meshRef) refs.push(bone.meshRef);

    const meshes = [];
    for (const ref of refs) {
      const frag = wld.fragments[ref];
      const mesh = frag && frag.type === 0x2d ? wld.fragments[frag.ref] : frag;
      if (!mesh || mesh.type !== 0x36 || !mesh.positions) continue;
      if (meshes.some((m) => m.mesh === mesh)) continue;
      meshes.push({ mesh: skinMesh(mesh, bones), name: mesh.name, materialListRef: mesh.materialListRef });
    }
    if (meshes.length) models.set(code, { code, meshes, boneCount: skeleton.bones.length });
  }

  // Register every character texture up front; variants are picked per NPC.
  for (const mat of wld.byType.get(0x30) || []) {
    for (const file of materialTextures(wld, mat).files) {
      if (textures.has(file)) continue;
      let bytes = null;
      for (const arc of archives) if (arc.has(file)) { bytes = arc.get(file); break; }
      textures.set(file, bytes ? decodeImage(file, bytes) : null);
    }
  }
  return models;
}
