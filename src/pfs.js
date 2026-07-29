// PFS (.s3d) archive reader.
//
// Layout:
//   uint32 directoryOffset
//   char[4] "PFS "
//   uint32 version (0x00020000)
//   ... file data ...
//   at directoryOffset:
//     uint32 entryCount
//     entryCount * { uint32 crc, uint32 dataOffset, uint32 inflatedSize }
//
// Each blob is a run of chunks: { uint32 deflatedLen, uint32 inflatedLen, byte[deflatedLen] }
// repeated until inflatedSize bytes have been produced.
//
// The entry with crc 0x61580AC9 is not a file: it holds the filename table
// (uint32 count, then count * { uint32 len, char[len] } including a trailing NUL).
// Real entries pair up with those names in ascending dataOffset order.

import { inflateInto } from './inflate.js';

const FILENAME_CRC = 0x61580ac9;

function inflateChunks(buf, dv, offset, inflatedSize) {
  const out = new Uint8Array(inflatedSize);
  let written = 0;
  let p = offset;
  while (written < inflatedSize) {
    const deflatedLen = dv.getUint32(p, true);
    const chunkLen = dv.getUint32(p + 4, true);
    p += 8;
    written += inflateInto(buf, p, out, written);
    p += deflatedLen;
    if (chunkLen === 0) break;
  }
  return out;
}

/** Reads an .s3d and returns a Map of lowercased filename -> Uint8Array. */
export function readPFS(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dirOffset = dv.getUint32(0, true);
  const magic = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  if (magic !== 'PFS ') throw new Error(`not a PFS archive (magic "${magic}")`);

  const count = dv.getUint32(dirOffset, true);
  const entries = [];
  let nameEntry = null;
  for (let i = 0; i < count; i++) {
    const p = dirOffset + 4 + i * 12;
    const e = {
      crc: dv.getUint32(p, true),
      offset: dv.getUint32(p + 4, true),
      size: dv.getUint32(p + 8, true),
    };
    if (e.crc === FILENAME_CRC) nameEntry = e;
    else entries.push(e);
  }
  if (!nameEntry) throw new Error('PFS archive has no filename table');

  const nameBlob = inflateChunks(buf, dv, nameEntry.offset, nameEntry.size);
  const ndv = new DataView(nameBlob.buffer);
  const nameCount = ndv.getUint32(0, true);
  const decoder = new TextDecoder('latin1');
  const names = [];
  let np = 4;
  for (let i = 0; i < nameCount; i++) {
    const len = ndv.getUint32(np, true);
    np += 4;
    names.push(decoder.decode(nameBlob.subarray(np, np + len - 1)).toLowerCase());
    np += len;
  }

  entries.sort((a, b) => a.offset - b.offset);
  const files = new Map();
  for (let i = 0; i < entries.length; i++) {
    files.set(names[i] ?? `unnamed_${i}`, inflateChunks(buf, dv, entries[i].offset, entries[i].size));
  }
  return files;
}
