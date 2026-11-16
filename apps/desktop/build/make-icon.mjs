import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const svg = readFileSync(new URL("../../../packages/web/public/odin.svg", import.meta.url), "utf8");
const outPath = new URL("./icon.ico", import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256];

function ico(images) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const parts = [header];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const at = 6 + i * 16;
    header[at] = img.size >= 256 ? 0 : img.size;
    header[at + 1] = img.size >= 256 ? 0 : img.size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(img.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
    parts.push(img.png);
  }
  return Buffer.concat(parts);
}

const browser = await chromium.launch();
const images = [];
for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
  );
  images.push({ size, png: await page.screenshot({ type: "png", omitBackground: true }) });
  await page.close();
}
await browser.close();
const file = ico(images);
writeFileSync(outPath, file);
console.log(`wrote ${outPath.pathname} (${file.length} bytes)`);
