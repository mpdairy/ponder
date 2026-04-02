import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

const watch = process.argv.includes('--watch');

// --- Icon generation (simple colored squares as placeholders) ---

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

function createIcon(size) {
  const S = size;
  const raw = Buffer.alloc(S * (1 + S * 4)); // all zeros = transparent

  // Initialize filter bytes
  for (let y = 0; y < S; y++) raw[y * (1 + S * 4)] = 0;

  function setPixel(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= S || y < 0 || y >= S) return;
    const p = y * (1 + S * 4) + 1 + x * 4;
    const sa = a / 255, da = raw[p + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa > 0) {
      raw[p]   = Math.round((r * sa + raw[p]   * da * (1 - sa)) / oa);
      raw[p+1] = Math.round((g * sa + raw[p+1] * da * (1 - sa)) / oa);
      raw[p+2] = Math.round((b * sa + raw[p+2] * da * (1 - sa)) / oa);
      raw[p+3] = Math.round(oa * 255);
    }
  }

  const d = (x1,y1,x2,y2) => Math.sqrt((x1-x2)**2+(y1-y2)**2);
  const cx = S / 2;
  const bulbCy = S * 0.36, bulbR = S * 0.30;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const bd = d(x, y, cx, bulbCy);

      // Glow
      if (bd > bulbR && bd < bulbR * 1.35) {
        const ga = (1 - (bd - bulbR) / (bulbR * 0.35)) * 50;
        setPixel(x, y, 250, 220, 50, ga);
      }

      // Bulb
      if (bd <= bulbR) {
        const id = d(x, y, cx - bulbR*0.2, bulbCy - bulbR*0.2);
        const t = Math.min(1, id / (bulbR * 1.2));
        setPixel(x, y, 254-t*20|0, 240-t*55|0, 138-t*100|0, Math.min(255, (bulbR-bd+0.8)*400));
      }

      // Neck
      const nkTop = bulbCy + bulbR*0.78, nkBot = S*0.73, nkHW = S*0.14, bsHW = S*0.17;
      if (y >= nkTop && y < nkBot) {
        const t = (y - nkTop)/(nkBot - nkTop);
        if (Math.abs(x - cx) <= nkHW - t*(nkHW - bsHW*0.8))
          setPixel(x, y, 234, 179, 8, 255);
      }

      // Base (3 lines)
      if (y >= nkBot && y < S*0.87) {
        const lH = S*0.035, gH = S*0.015, slot = (y - nkBot)/(lH+gH);
        const li = Math.floor(slot);
        if (li < 3 && (slot-li) < lH/(lH+gH) && Math.abs(x-cx) <= bsHW)
          setPixel(x, y, 100, 116, 139, 255);
      }

      // Tip
      if (d(x, y, cx, S*0.89) <= S*0.04 && y >= S*0.87)
        setPixel(x, y, 100, 116, 139, 255);

      // --- Question mark ---
      const qR = bulbR*0.38, qCy = bulbCy - bulbR*0.05;
      const thick = Math.max(1.8, S*0.058);

      // Top arc
      const ad = d(x, y, cx, qCy);
      if (Math.abs(ad - qR) < thick) {
        const angle = Math.atan2(y - qCy, x - cx);
        if (angle > -Math.PI*0.85 && angle < Math.PI*0.15)
          setPixel(x, y, 55, 48, 163, 230);
      }

      // Descending stroke
      const stTop = qCy + qR*0.1, stBot = qCy + qR*1.1;
      if (y >= stTop && y <= stBot) {
        const t = (y - stTop)/(stBot - stTop);
        if (d(x, y, cx + qR*(1-t)*0.45, y) < thick)
          setPixel(x, y, 55, 48, 163, 230);
      }

      // Stem
      if (y >= stBot && y <= qCy + qR*1.5 && Math.abs(x-cx) < thick)
        setPixel(x, y, 55, 48, 163, 230);

      // Dot
      if (d(x, y, cx, qCy + qR*2.15) < thick*1.15)
        setPixel(x, y, 55, 48, 163, 230);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Build ---

const commonOptions = {
  bundle: true,
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

async function build() {
  // Generate icons
  mkdirSync('dist/icons', { recursive: true });
  for (const size of [16, 48, 128]) {
    writeFileSync(`dist/icons/icon-${size}.png`, createIcon(size));
  }

  // Build all entry points
  const entries = [
    { in: 'src/content.ts', out: 'dist/content.js', format: 'iife' },
    { in: 'src/background.ts', out: 'dist/background.js', format: 'iife' },
    { in: 'src/popup/popup.ts', out: 'dist/popup/popup.js', format: 'iife' },
    { in: 'src/results/results.ts', out: 'dist/results/results.js', format: 'iife' },
    { in: 'src/options/options.ts', out: 'dist/options/options.js', format: 'iife' },
  ];

  const builds = entries.map(e =>
    esbuild.build({ ...commonOptions, entryPoints: [e.in], outfile: e.out, format: e.format })
  );
  await Promise.all(builds);

  // Copy static files
  const statics = [
    ['manifest.json', 'dist/manifest.json'],
    ['src/popup/popup.html', 'dist/popup/popup.html'],
    ['src/popup/popup.css', 'dist/popup/popup.css'],
    ['src/results/results.html', 'dist/results/results.html'],
    ['src/results/results.css', 'dist/results/results.css'],
    ['src/options/options.html', 'dist/options/options.html'],
    ['src/options/options.css', 'dist/options/options.css'],
  ];
  for (const [src, dest] of statics) {
    const dir = dest.substring(0, dest.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    cpSync(src, dest);
  }

  console.log('Build complete → dist/');
}

if (watch) {
  // Simple watch: rebuild on changes
  const chokidar = await import('fs').then(fs => fs.watch);
  console.log('Watching for changes...');
  build();
  // For proper watch mode, install chokidar. For now, just build once.
  // A full watch setup would use esbuild's ctx.watch() API.
  // For dev, just re-run `node build.mjs` after changes.
} else {
  build().catch(e => { console.error(e); process.exit(1); });
}
