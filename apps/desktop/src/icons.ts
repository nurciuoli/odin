// Placeholder tray icons drawn in code, until the Odin raven mark exists at Windows sizes (plan "Open items").
// The two variants differ in shape, not only colour: a round dot when all is calm, a warning triangle with a notch
// when a session needs you.
import { crc32, deflateSync } from "node:zlib";

export type IconVariant = "normal" | "needs-you";

type Rgba = [number, number, number, number];

/** Encode an RGBA bitmap (row-major, 4 bytes per pixel) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Coverage (0..1) of the shape at a pixel centre, 4x4 supersampled. */
function draw(size: number, inside: (x: number, y: number) => boolean, colour: Rgba): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) if (inside((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size)) hits++;
      const i = (y * size + x) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = Math.round((colour[3] * hits) / (n * n));
    }
  return out;
}

// Unit-square shapes.
const dot = (x: number, y: number) => (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.36 ** 2;
const triangle = (x: number, y: number) => {
  // Apex at top centre, base along the bottom; minus an exclamation bar and point so it reads at 16 px.
  const inTri = y >= 0.08 && y <= 0.92 && Math.abs(x - 0.5) <= ((y - 0.08) / 0.84) * 0.46;
  const bar = Math.abs(x - 0.5) <= 0.06 && y >= 0.36 && y <= 0.66;
  const point = Math.abs(x - 0.5) <= 0.06 && y >= 0.74 && y <= 0.84;
  return inTri && !bar && !point;
};

export function iconPng(variant: IconVariant, size: number): Buffer {
  const bitmap =
    variant === "normal" ? draw(size, dot, [110, 120, 140, 255]) : draw(size, triangle, [230, 150, 20, 255]);
  return encodePng(size, size, bitmap);
}
