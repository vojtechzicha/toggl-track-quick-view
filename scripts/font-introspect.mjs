// Minimal readers for the parts of a TrueType/OpenType file the font checks
// assert on. Shared by scripts/check-fonts.ts and by a template pack's own
// checks, which make stricter claims about the specific cuts they embed.

import assert from 'node:assert/strict';

/** Offset of a table in the sfnt directory, or -1. */
export function sfntTable(font, tag) {
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) === tag) return font.readUInt32BE(rec + 8);
  }
  return -1;
}

/** Code points mapped by a font — a minimal cmap reader (formats 4 and 12). */
export function cmapCodepoints(font) {
  const cmapOff = sfntTable(font, 'cmap');
  assert.ok(cmapOff >= 0, 'font has a cmap table');
  const nSub = font.readUInt16BE(cmapOff + 2);
  const out = new Set();
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = font.readUInt16BE(rec);
    const encoding = font.readUInt16BE(rec + 2);
    // Unicode subtables only: platform 0, or Microsoft BMP/full (3,1) / (3,10).
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const sub = cmapOff + font.readUInt32BE(rec + 4);
    const format = font.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = font.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2; s += 2) {
        const end = font.readUInt16BE(ends + s);
        const start = font.readUInt16BE(starts + s);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) out.add(c);
      }
    } else if (format === 12) {
      const nGroups = font.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const grp = sub + 16 + g * 12;
        const start = font.readUInt32BE(grp);
        const end = font.readUInt32BE(grp + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

/** OS/2 usWeightClass — 400 regular, 500 medium, 600 semibold, 700 bold. */
export function weightClass(font) {
  const os2 = sfntTable(font, 'OS/2');
  assert.ok(os2 >= 0, 'font has an OS/2 table');
  return font.readUInt16BE(os2 + 4);
}

/** The full font name (name ID 4) from a Unicode/Microsoft name record. */
export function fullName(font) {
  const nameOff = sfntTable(font, 'name');
  assert.ok(nameOff >= 0, 'font has a name table');
  const count = font.readUInt16BE(nameOff + 2);
  const strings = nameOff + font.readUInt16BE(nameOff + 4);
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platform = font.readUInt16BE(rec);
    const nameId = font.readUInt16BE(rec + 6);
    if (nameId !== 4 || !(platform === 0 || platform === 3)) continue;
    const len = font.readUInt16BE(rec + 8);
    const off = strings + font.readUInt16BE(rec + 10);
    // Unicode name strings are UTF-16BE.
    let out = '';
    for (let b = 0; b < len; b += 2) out += String.fromCharCode(font.readUInt16BE(off + b));
    return out;
  }
  return '';
}

/** True when the buffer starts with a TrueType/OpenType signature. */
export function isFontFile(font) {
  const magic = font.subarray(0, 4).toString('hex');
  return magic === '00010000' || magic === '4f54544f' || magic === '74727565';
}
