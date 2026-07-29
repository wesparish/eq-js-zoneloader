// WLD parser — old-format (version 0x00015500) only, which is what Trilogy/Quarm zones use.
//
// File header:
//   uint32 magic 0x54503D02
//   uint32 version
//   uint32 fragmentCount
//   uint32 bspRegionCount
//   uint32 unknown (0x000680D4)
//   uint32 stringHashSize
//   uint32 unknown
//   byte[stringHashSize] obfuscated string table
// Then fragmentCount records of:
//   uint32 size   (byte count following the type field)
//   uint32 type
//   byte[size] data, whose first 4 bytes are the nameRef
//
// A nameRef < 0 indexes the string table at (-nameRef); >= 0 means "no name".

const WLD_MAGIC = 0x54503d02;
const VERSION_OLD = 0x00015500;
const HASH_KEY = [0x95, 0x3a, 0xc5, 0x2a, 0x95, 0x7a, 0x95, 0x6a];

function decodeStringHash(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ HASH_KEY[i % 8];
  return out;
}

/** Strings inside 0x03 fragments use the same XOR key, restarting at index 0. */
function decodeEncodedString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] ^ HASH_KEY[i % 8];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

class Reader {
  constructor(buf, offset, length) {
    this.dv = new DataView(buf.buffer, buf.byteOffset + offset, length);
    this.buf = buf.subarray(offset, offset + length);
    this.p = 0;
  }
  i8() { return this.dv.getInt8(this.p++); }
  u8() { return this.dv.getUint8(this.p++); }
  i16() { const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  skip(n) { this.p += n; }
  get remaining() { return this.dv.byteLength - this.p; }
}

export function parseWLD(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== WLD_MAGIC) throw new Error(`bad WLD magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(4, true);
  if (version !== VERSION_OLD) throw new Error(`unsupported WLD version 0x${version.toString(16)}`);
  const fragmentCount = dv.getUint32(8, true);
  const hashSize = dv.getUint32(20, true);

  const stringTable = decodeStringHash(buf.subarray(28, 28 + hashSize));
  const nameAt = (ref) => {
    if (ref >= 0) return '';
    let i = -ref;
    let s = '';
    while (i < stringTable.length && stringTable[i] !== 0) s += String.fromCharCode(stringTable[i++]);
    return s;
  };

  // Pass 1: slice the fragment list. Indices are 1-based in cross-references.
  const raw = [];
  let p = 28 + hashSize;
  for (let i = 0; i < fragmentCount; i++) {
    const size = dv.getUint32(p, true);
    const type = dv.getUint32(p + 4, true);
    raw.push({ type, offset: p + 8, size });
    p += 8 + size;
    if (p > buf.length) throw new Error(`fragment ${i} overruns file`);
  }

  const wld = {
    version, nameAt,
    fragments: new Array(raw.length + 1).fill(null), // 1-based
    byType: new Map(),
    byName: new Map(),
  };

  for (let i = 0; i < raw.length; i++) {
    const { type, offset, size } = raw[i];
    const r = new Reader(buf, offset, size);
    const nameRef = r.i32();
    const frag = { index: i + 1, type, name: nameAt(nameRef), nameRef };
    const parse = PARSERS[type];
    if (parse) {
      try { parse(frag, r, wld); } catch (e) { frag.error = e.message; }
    }
    wld.fragments[i + 1] = frag;
    if (!wld.byType.has(type)) wld.byType.set(type, []);
    wld.byType.get(type).push(frag);
    if (frag.name) wld.byName.set(frag.name, frag);
  }
  return wld;
}

const PARSERS = {
  // 0x03 BitmapName — the actual texture filenames.
  0x03: (f, r) => {
    r.i32(); // count-1; unreliable, so read until the data runs out instead
    f.files = [];
    while (r.remaining >= 2) {
      const len = r.u16();
      if (len === 0 || len > r.remaining) break;
      f.files.push(decodeEncodedString(r.buf.subarray(r.p, r.p + len)).toLowerCase());
      r.skip(len);
    }
  },

  // 0x04 BitmapInfo — one or more 0x03 refs; >1 frame means an animated texture.
  0x04: (f, r) => {
    const flags = r.u32();
    const frameCount = r.u32();
    if (flags & 0x08) f.currentFrame = r.i32();
    if (flags & 0x04) f.animationDelayMs = r.i32();
    f.animated = (flags & 0x08) !== 0;
    f.bitmapRefs = [];
    for (let i = 0; i < frameCount; i++) f.bitmapRefs.push(r.i32());
  },

  // 0x05 BitmapInfoReference
  0x05: (f, r) => { f.ref = r.i32(); },

  // 0x30 Material
  0x30: (f, r) => {
    f.flags = r.u32();
    f.renderMethod = r.u32();
    f.rgbPen = r.u32();
    f.brightness = r.f32();
    f.scaledAmbient = r.f32();
    f.ref = r.i32(); // -> 0x05
  },

  // 0x31 MaterialList
  0x31: (f, r) => {
    r.u32(); // flags
    const count = r.u32();
    f.materialRefs = [];
    for (let i = 0; i < count; i++) f.materialRefs.push(r.i32());
  },

  // 0x36 Mesh
  0x36: (f, r) => {
    f.flags = r.u32();
    f.materialListRef = r.i32();
    f.animationRef = r.i32();
    r.i32(); r.i32(); // unused fragment refs
    f.center = [r.f32(), r.f32(), r.f32()];
    r.u32(); r.u32(); r.u32(); // params2
    f.maxDist = r.f32();
    f.min = [r.f32(), r.f32(), r.f32()];
    f.max = [r.f32(), r.f32(), r.f32()];

    const vertexCount = r.u16();
    const uvCount = r.u16();
    const normalCount = r.u16();
    const colorCount = r.u16();
    const polyCount = r.u16();
    const vertexPieceCount = r.u16();
    const polyTexCount = r.u16();
    const vertexTexCount = r.u16();
    r.u16(); // size9
    const scaleBits = r.u16();
    const scale = 1 / (1 << scaleBits);

    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3 + 0] = f.center[0] + r.i16() * scale;
      positions[i * 3 + 1] = f.center[1] + r.i16() * scale;
      positions[i * 3 + 2] = f.center[2] + r.i16() * scale;
    }
    const uvs = new Float32Array(vertexCount * 2);
    for (let i = 0; i < uvCount; i++) {
      uvs[i * 2 + 0] = r.i16() / 256;
      uvs[i * 2 + 1] = r.i16() / 256;
    }
    const normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < normalCount; i++) {
      normals[i * 3 + 0] = r.i8() / 127;
      normals[i * 3 + 1] = r.i8() / 127;
      normals[i * 3 + 2] = r.i8() / 127;
    }
    const colors = new Uint8Array(vertexCount * 4).fill(255);
    for (let i = 0; i < colorCount; i++) {
      // stored BGRA
      const b = r.u8(), g = r.u8(), rr = r.u8(), a = r.u8();
      colors[i * 4 + 0] = rr; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = a;
    }
    const indices = new Uint32Array(polyCount * 3);
    const polyFlags = new Uint16Array(polyCount);
    for (let i = 0; i < polyCount; i++) {
      polyFlags[i] = r.u16();
      indices[i * 3 + 0] = r.u16();
      indices[i * 3 + 1] = r.u16();
      indices[i * 3 + 2] = r.u16();
    }
    // Bone assignments: runs of vertices belonging to one skeleton piece.
    f.vertexPieces = [];
    for (let i = 0; i < vertexPieceCount; i++) {
      f.vertexPieces.push({ count: r.u16(), index: r.u16() });
    }
    // Material runs: consecutive triangles sharing one material index.
    f.polyRuns = [];
    for (let i = 0; i < polyTexCount; i++) {
      f.polyRuns.push({ count: r.u16(), material: r.u16() });
    }

    f.positions = positions;
    f.uvs = uvs;
    f.normals = normals;
    f.colors = colors;
    f.indices = indices;
    f.polyFlags = polyFlags;
    f.vertexCount = vertexCount;
    f.hasUVs = uvCount > 0;
  },

  // 0x2D MeshReference
  0x2d: (f, r) => { f.ref = r.i32(); },

  // 0x10 SkeletonHierarchy — the bone tree for a character model.
  0x10: (f, r) => {
    const flags = r.u32();
    const boneCount = r.u32();
    f.polyhedronRef = r.i32();
    if (flags & 0x01) { r.i32(); r.i32(); r.i32(); }
    if (flags & 0x02) f.boundingRadius = r.f32();
    f.bones = [];
    for (let i = 0; i < boneCount; i++) {
      const bone = {
        nameRef: r.i32(), flags: r.u32(),
        trackRef: r.i32(),   // -> 0x13 -> 0x12
        meshRef: r.i32(),    // -> 0x2D, when a mesh hangs off this bone
        children: [],
      };
      const childCount = r.u32();
      for (let c = 0; c < childCount; c++) bone.children.push(r.i32());
      f.bones.push(bone);
    }
    // Meshes belonging to this skeleton: body first, then head/variant meshes.
    f.meshRefs = [];
    if (flags & 0x200) {
      const count = r.u32();
      for (let i = 0; i < count; i++) f.meshRefs.push(r.i32());
    }
  },

  // 0x11 SkeletonHierarchyReference
  0x11: (f, r) => { f.ref = r.i32(); },

  // 0x12 TrackDef — animation frames. Frame 0 is the bind pose.
  0x12: (f, r) => {
    r.u32(); // flags
    const frameCount = r.u32();
    f.frames = [];
    for (let i = 0; i < frameCount; i++) {
      // Eight int16s. The trailing value is the shift denominator: ALL_TRACKDEF
      // has a zero there with a nonzero leading value, which only parses if the
      // rotation denominator comes first.
      const rw = r.i16(), rx = r.i16(), ry = r.i16(), rz = r.i16();
      const sx = r.i16(), sy = r.i16(), sz = r.i16(), sd = r.i16();
      const t = sd !== 0 ? 1 / sd : 0;
      f.frames.push({
        translation: [sx * t, sy * t, sz * t],
        rotation: [rx, ry, rz, rw], // normalized at use; (0,0,0,denom) is identity
      });
    }
  },

  // 0x13 TrackReference
  0x13: (f, r) => { f.ref = r.i32(); },

  // 0x32 VertexColorList — per-instance baked lighting for a placed object.
  0x32: (f, r) => {
    r.i32();
    const count = r.u32();
    r.i32(); r.i32(); r.i32();
    f.colorCount = count;
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const b = r.u8(), g = r.u8(), rr = r.u8(), a = r.u8();
      colors[i * 4] = rr; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = a;
    }
    f.colors = colors;
  },

  // 0x33 VertexColorReference
  0x33: (f, r) => { f.ref = r.i32(); },

  // 0x14 ActorDef — the named thing an 0x15 instance points at.
  0x14: (f, r, wld) => {
    const flags = r.u32();
    f.callbackRef = r.i32();
    const actionCount = r.u32();
    const fragRefCount = r.u32();
    f.boundsRef = r.i32();
    if (flags & 0x01) r.i32();
    if (flags & 0x02) r.skip(28);
    // Each action is a list of LOD entries: (fragment index, max render distance).
    for (let i = 0; i < actionCount; i++) {
      const lodCount = r.u32();
      for (let j = 0; j < lodCount; j++) { r.i32(); r.f32(); }
    }
    f.refs = [];
    for (let i = 0; i < fragRefCount; i++) f.refs.push(r.i32());
  },

  // 0x15 ActorInstance — object placement in the zone (60 bytes).
  // The instance itself is unnamed; the second field is a *string* ref naming the
  // ACTORDEF to spawn, which lives in the matching _obj.s3d.
  0x15: (f, r, wld) => {
    f.actorDef = wld.nameAt(r.i32());
    f.flags = r.u32();
    f.fragment1 = r.i32();
    f.position = [r.f32(), r.f32(), r.f32()];
    // Heading, stored as 512ths of a full turn about Z. Pitch/roll are present but
    // unused by every placement in the zones this targets.
    const rotZ = r.f32(), rotY = r.f32(), rotX = r.f32();
    const turn = (v) => (v / 512) * Math.PI * 2;
    f.rotation = [turn(rotX), turn(rotY), turn(rotZ)];
    r.f32(); // params1
    const scaleY = r.f32(), scaleX = r.f32();
    const s = scaleY || scaleX || 1;
    f.scale = [s, s, s];
    f.vertexColorRef = r.i32();
  },
};

/** Resolves a material fragment to its texture filename(s) and a usable render mode. */
export function materialTextures(wld, matFrag) {
  const out = { files: [], animated: false, delayMs: 0 };
  const bmpInfoRef = wld.fragments[matFrag.ref];
  if (!bmpInfoRef) return out;
  const bmpInfo = wld.fragments[bmpInfoRef.ref];
  if (!bmpInfo || !bmpInfo.bitmapRefs) return out;
  out.animated = bmpInfo.bitmapRefs.length > 1;
  out.delayMs = bmpInfo.animationDelayMs || 0;
  for (const ref of bmpInfo.bitmapRefs) {
    const names = wld.fragments[ref];
    if (names && names.files) out.files.push(...names.files);
  }
  return out;
}
