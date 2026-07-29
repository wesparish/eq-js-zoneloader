// Decoders for the two texture containers EQ ships inside .s3d archives:
// Windows BMP (almost always 8-bit palettized, bottom-up) and DDS (DXT1/3/5).
// Both return { width, height, rgba: Uint8Array, keyed } where `keyed` means the
// image carried a magenta/black color-key in palette slot 0.

function decodeBMP(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== 0x4d42) return null; // 'BM'
  const pixelOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  let height = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  if (compression !== 0) return null; // RLE is never used by EQ art
  const flip = height > 0; // positive height = bottom-up
  height = Math.abs(height);

  const rgba = new Uint8Array(width * height * 4);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  let keyed = false;

  if (bpp === 8) {
    let paletteCount = dv.getUint32(46, true);
    if (paletteCount === 0) paletteCount = 256;
    const palOffset = 14 + headerSize;
    const pal = new Uint8Array(256 * 4);
    for (let i = 0; i < paletteCount; i++) {
      // BMP palettes are BGRX
      pal[i * 4 + 0] = buf[palOffset + i * 4 + 2];
      pal[i * 4 + 1] = buf[palOffset + i * 4 + 1];
      pal[i * 4 + 2] = buf[palOffset + i * 4 + 0];
      pal[i * 4 + 3] = 255;
    }
    // EQ marks cutout textures by putting the key color in slot 0.
    const r0 = pal[0], g0 = pal[1], b0 = pal[2];
    keyed = (r0 > 200 && g0 < 60 && b0 > 200) || (r0 === 0 && g0 === 0 && b0 === 0);

    for (let y = 0; y < height; y++) {
      const srcRow = pixelOffset + (flip ? height - 1 - y : y) * rowSize;
      for (let x = 0; x < width; x++) {
        const idx = buf[srcRow + x];
        const d = (y * width + x) * 4;
        rgba[d + 0] = pal[idx * 4 + 0];
        rgba[d + 1] = pal[idx * 4 + 1];
        rgba[d + 2] = pal[idx * 4 + 2];
        rgba[d + 3] = keyed && idx === 0 ? 0 : 255;
      }
    }
  } else if (bpp === 24 || bpp === 32) {
    const stride = bpp / 8;
    for (let y = 0; y < height; y++) {
      const srcRow = pixelOffset + (flip ? height - 1 - y : y) * rowSize;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * stride;
        const d = (y * width + x) * 4;
        rgba[d + 0] = buf[s + 2];
        rgba[d + 1] = buf[s + 1];
        rgba[d + 2] = buf[s + 0];
        rgba[d + 3] = bpp === 32 ? buf[s + 3] : 255;
      }
    }
  } else {
    return null;
  }
  return { width, height, rgba, keyed };
}

// --- DXT ---------------------------------------------------------------------

function dxtColors(dv, off, out) {
  const c0 = dv.getUint16(off, true);
  const c1 = dv.getUint16(off + 2, true);
  const r = [((c0 >> 11) & 31) * 255 / 31, ((c1 >> 11) & 31) * 255 / 31];
  const g = [((c0 >> 5) & 63) * 255 / 63, ((c1 >> 5) & 63) * 255 / 63];
  const b = [(c0 & 31) * 255 / 31, (c1 & 31) * 255 / 31];
  out[0] = [r[0], g[0], b[0], 255];
  out[1] = [r[1], g[1], b[1], 255];
  if (c0 > c1) {
    out[2] = [(2 * r[0] + r[1]) / 3, (2 * g[0] + g[1]) / 3, (2 * b[0] + b[1]) / 3, 255];
    out[3] = [(r[0] + 2 * r[1]) / 3, (g[0] + 2 * g[1]) / 3, (b[0] + 2 * b[1]) / 3, 255];
  } else {
    out[2] = [(r[0] + r[1]) / 2, (g[0] + g[1]) / 2, (b[0] + b[1]) / 2, 255];
    out[3] = [0, 0, 0, 0]; // DXT1 1-bit alpha
  }
  return dv.getUint32(off + 4, true);
}

function decodeDDS(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) return null; // 'DDS '
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const fourCC = dv.getUint32(84, true);
  const FMT = { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 };
  const dxt = FMT[fourCC];
  const rgba = new Uint8Array(width * height * 4);
  let p = 128;

  if (!dxt) {
    // Uncompressed A8R8G8B8 fallback.
    const bpp = dv.getUint32(88, true);
    if (bpp !== 32) return null;
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4 + 0] = buf[p + i * 4 + 2];
      rgba[i * 4 + 1] = buf[p + i * 4 + 1];
      rgba[i * 4 + 2] = buf[p + i * 4 + 0];
      rgba[i * 4 + 3] = buf[p + i * 4 + 3];
    }
    return { width, height, rgba, keyed: false };
  }

  const colors = [null, null, null, null];
  const blocksW = Math.max(1, width >> 2), blocksH = Math.max(1, height >> 2);
  for (let by = 0; by < blocksH; by++) {
    for (let bx = 0; bx < blocksW; bx++) {
      let alpha = null, alphaBits = null, a0 = 0, a1 = 0;
      if (dxt === 3) { alpha = p; p += 8; }
      else if (dxt === 5) {
        a0 = buf[p]; a1 = buf[p + 1];
        alphaBits = buf.subarray(p + 2, p + 8);
        p += 8;
      }
      const bits = dxtColors(dv, p, colors);
      p += 8;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const i = py * 4 + px;
          const c = colors[(bits >> (i * 2)) & 3];
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const d = (y * width + x) * 4;
          rgba[d] = c[0]; rgba[d + 1] = c[1]; rgba[d + 2] = c[2];
          let a = c[3];
          if (dxt === 3) {
            const nib = buf[alpha + (i >> 1)];
            a = ((i & 1) ? (nib >> 4) : (nib & 15)) * 17;
          } else if (dxt === 5) {
            const shift = i * 3;
            const byteIdx = shift >> 3, bitIdx = shift & 7;
            let code = (alphaBits[byteIdx] >> bitIdx) & 7;
            if (bitIdx > 5) code |= (alphaBits[byteIdx + 1] << (8 - bitIdx)) & 7;
            if (code === 0) a = a0;
            else if (code === 1) a = a1;
            else if (a0 > a1) a = ((8 - code) * a0 + (code - 1) * a1) / 7;
            else if (code === 6) a = 0;
            else if (code === 7) a = 255;
            else a = ((6 - code) * a0 + (code - 1) * a1) / 5;
          }
          rgba[d + 3] = a;
        }
      }
    }
  }
  return { width, height, rgba, keyed: false };
}

// Dispatch on the magic, not the extension: the Quarm/TAKP repack stores DDS
// payloads under .bmp filenames, so the WLD-declared name lies about the format.
export function decodeImage(name, buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x44 && buf[1] === 0x44 && buf[2] === 0x53 && buf[3] === 0x20) return decodeDDS(buf);
  if (buf[0] === 0x42 && buf[1] === 0x4d) return decodeBMP(buf);
  return null;
}
