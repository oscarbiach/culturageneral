/**
 * Genera los iconos de la PWA a partir de un unico SVG.
 *
 * El dibujo son dos cunias enfrentadas — el "versus" del mano a mano — con el
 * trazo grueso y los colores planos del resto de la app. No usa tipografia a
 * proposito: una letra a 48px en el cajon de aplicaciones no se lee, dos formas
 * si.
 *
 * Uso: npm run icons
 */

import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../public/', import.meta.url).pathname;

const INK = '#101014';
const CREAM = '#fff3dd';
const LIME = '#c9f227';
const PINK = '#ff4d9d';

/** @param {{bleed:boolean}} opts bleed = icono maskable, con margen de recorte. */
function svg({ bleed }) {
  // El contenido respira dentro del cuadrado; en maskable se achica todavia mas
  // para sobrevivir al recorte circular que aplican Android y compania.
  const s = bleed ? 0.46 : 0.60;
  const c = 256;
  const half = 256 * s;
  const gap = 26 * s;
  const stroke = 22;

  const left = `M ${c - half} ${c - half} L ${c - gap} ${c} L ${c - half} ${c + half} Z`;
  const right = `M ${c + half} ${c - half} L ${c + gap} ${c} L ${c + half} ${c + half} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${bleed ? 0 : 108}" fill="${bleed ? LIME : CREAM}"/>
  ${bleed ? '' : `<rect x="10" y="10" width="492" height="492" rx="98" fill="none" stroke="${INK}" stroke-width="20"/>`}
  <path d="${left}" fill="${bleed ? CREAM : LIME}" stroke="${INK}" stroke-width="${stroke}" stroke-linejoin="round"/>
  <path d="${right}" fill="${bleed ? INK : PINK}" stroke="${INK}" stroke-width="${stroke}" stroke-linejoin="round"/>
</svg>`;
}

function chromium() {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const bin = join(root, dir, 'chrome-linux', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return null;
}

const browser = chromium();
writeFileSync(join(OUT, 'icon.svg'), svg({ bleed: false }));

if (!browser) {
  console.log('Sin Chromium a mano: se escribio icon.svg, faltan los PNG.');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'icons-'));

/**
 * En headless el viewport no mide lo mismo que `--window-size`: sobra el alto de
 * la barra del navegador. En vez de adivinar cuanto, lo medimos una vez y
 * compensamos, asi el script no se rompe cuando cambie la version de Chromium.
 */
function viewportOffset() {
  const probe = join(work, 'probe.html');
  writeFileSync(
    probe,
    '<!doctype html><meta charset="utf-8"><body><script>' +
      'document.body.textContent = "WH:" + innerWidth + "x" + innerHeight;' +
      '</script>',
  );
  const dom = execFileSync(
    browser,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', '--window-size=800,800', probe],
    { encoding: 'utf8' },
  );
  const match = dom.match(/WH:(\d+)x(\d+)/);
  if (!match) return { dx: 0, dy: 0 };
  return { dx: 800 - Number(match[1]), dy: 800 - Number(match[2]) };
}

const offset = viewportOffset();
console.log(`Viewport headless: faltan ${offset.dx}x${offset.dy} px, se compensan.`);
/* ---------- Recorte de PNG sin dependencias ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Recorta la esquina superior izquierda de un PNG RGB/RGBA de 8 bits. */
function cropPng(png, width, height) {
  let pos = 8;
  let head = null;
  const idat = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') head = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + length;
  }
  if (!head) throw new Error('PNG sin IHDR.');

  const srcW = head.readUInt32BE(0);
  const srcH = head.readUInt32BE(4);
  const depth = head[8];
  const colorType = head[9];
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`PNG inesperado: bitDepth ${depth}, colorType ${colorType}.`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const srcStride = srcW * channels;

  // Deshacemos los filtros por linea para poder recortar pixeles.
  const raw = inflateSync(Buffer.concat(idat));
  const flat = Buffer.alloc(srcH * srcStride);
  for (let y = 0; y < srcH; y += 1) {
    const filter = raw[y * (srcStride + 1)];
    const line = raw.subarray(y * (srcStride + 1) + 1, (y + 1) * (srcStride + 1));
    for (let x = 0; x < srcStride; x += 1) {
      const a = x >= channels ? flat[y * srcStride + x - channels] : 0;
      const b = y > 0 ? flat[(y - 1) * srcStride + x] : 0;
      const c = x >= channels && y > 0 ? flat[(y - 1) * srcStride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      flat[y * srcStride + x] = value & 0xff;
    }
  }

  const outW = Math.min(width, srcW);
  const outH = Math.min(height, srcH);
  const outStride = outW * channels;
  const out = Buffer.alloc(outH * (outStride + 1));
  for (let y = 0; y < outH; y += 1) {
    out[y * (outStride + 1)] = 0; // sin filtro: el deflate ya comprime bien
    flat.copy(out, y * (outStride + 1) + 1, y * srcStride, y * srcStride + outStride);
  }

  const ihdr = Buffer.from(head);
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);

  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: 'icon-192.png', size: 192, bleed: false },
  { file: 'icon-512.png', size: 512, bleed: false },
  { file: 'apple-touch-icon.png', size: 180, bleed: false },
  { file: 'maskable-512.png', size: 512, bleed: true },
];

for (const target of targets) {
  const page = join(work, `${target.file}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:transparent;overflow:hidden;
                 width:${target.size}px;height:${target.size}px}
       svg{display:block;width:${target.size}px;height:${target.size}px}
     </style>${svg({ bleed: target.bleed })}`,
  );
  const shot = join(work, target.file);
  execFileSync(browser, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--screenshot=${shot}`,
    `--window-size=${target.size + offset.dx},${target.size + offset.dy}`,
    page,
  ]);
  // La captura mide lo que la ventana, no lo que el viewport, asi que sobra una
  // franja vacia abajo: la recortamos para dejar el icono cuadrado.
  writeFileSync(join(OUT, target.file), cropPng(readFileSync(shot), target.size, target.size));
  console.log(`✓ ${target.file}`);
}
