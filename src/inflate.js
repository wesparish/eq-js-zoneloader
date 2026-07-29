// Synchronous DEFLATE (RFC 1951) decoder.
//
// The browser's DecompressionStream would also work, but a .s3d holds thousands
// of individually-compressed 8 KB chunks and one async stream per chunk turns a
// 200 ms load into tens of seconds. This is a straight port of the canonical
// "puff" algorithm, which is fast enough at these sizes and keeps loading sync.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman table: per-length symbol counts plus symbols in code order. */
function buildHuffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  return { counts, symbols };
}

class BitReader {
  constructor(data, pos) { this.d = data; this.p = pos; this.bit = 0; this.val = 0; }
  bits(need) {
    let val = this.val;
    while (this.bit < need) {
      val |= this.d[this.p++] << this.bit;
      this.bit += 8;
    }
    this.val = val >>> need;
    this.bit -= need;
    return val & ((1 << need) - 1);
  }
  decode(huff) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = huff.counts[len];
      if (code - first < count) return huff.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('invalid Huffman code');
  }
  align() { this.bit = 0; this.val = 0; }
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTables() {
  if (FIXED_LIT) return;
  const lit = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lit[i] = 8;
  for (let i = 144; i < 256; i++) lit[i] = 9;
  for (let i = 256; i < 280; i++) lit[i] = 7;
  for (let i = 280; i < 288; i++) lit[i] = 8;
  FIXED_LIT = buildHuffman(lit, 288);
  FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5), 30);
}

/**
 * Inflates a raw DEFLATE stream.
 * @param {Uint8Array} data
 * @param {number} pos      start offset
 * @param {Uint8Array} out  destination
 * @param {number} outPos   destination offset
 * @returns {number} number of bytes written
 */
export function inflateRawInto(data, pos, out, outPos) {
  const br = new BitReader(data, pos);
  const start = outPos;
  let last = 0;
  do {
    last = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = data[br.p] | (data[br.p + 1] << 8);
      br.p += 4; // skip LEN and NLEN
      out.set(data.subarray(br.p, br.p + len), outPos);
      br.p += len;
      outPos += len;
      continue;
    }

    let litHuff, distHuff;
    if (type === 1) {
      fixedTables();
      litHuff = FIXED_LIT; distHuff = FIXED_DIST;
    } else if (type === 2) {
      const nlen = br.bits(5) + 257;
      const ndist = br.bits(5) + 1;
      const ncode = br.bits(4) + 4;
      const clens = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) clens[CLEN_ORDER[i]] = br.bits(3);
      const clHuff = buildHuffman(clens, 19);
      const lengths = new Uint8Array(nlen + ndist);
      let i = 0;
      while (i < nlen + ndist) {
        const sym = br.decode(clHuff);
        if (sym < 16) lengths[i++] = sym;
        else if (sym === 16) {
          const prev = lengths[i - 1];
          for (let r = br.bits(2) + 3; r > 0; r--) lengths[i++] = prev;
        } else if (sym === 17) {
          for (let r = br.bits(3) + 3; r > 0; r--) lengths[i++] = 0;
        } else {
          for (let r = br.bits(7) + 11; r > 0; r--) lengths[i++] = 0;
        }
      }
      litHuff = buildHuffman(lengths.subarray(0, nlen), nlen);
      distHuff = buildHuffman(lengths.subarray(nlen), ndist);
    } else {
      throw new Error('invalid DEFLATE block type');
    }

    for (;;) {
      const sym = br.decode(litHuff);
      if (sym < 256) { out[outPos++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257;
      const len = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
      const di = br.decode(distHuff);
      const dist = DIST_BASE[di] + br.bits(DIST_EXTRA[di]);
      let from = outPos - dist;
      for (let k = 0; k < len; k++) out[outPos++] = out[from++];
    }
  } while (!last);
  return outPos - start;
}

/** Inflates a zlib-wrapped stream (2-byte header, 4-byte Adler trailer). */
export function inflateInto(data, pos, out, outPos) {
  const cmf = data[pos];
  // zlib header if the low nibble is 8 (deflate) and the check value works out.
  const isZlib = (cmf & 0x0f) === 8 && ((cmf << 8) | data[pos + 1]) % 31 === 0;
  return inflateRawInto(data, isZlib ? pos + 2 : pos, out, outPos);
}
