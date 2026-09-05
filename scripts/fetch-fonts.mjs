/**
 * Baja las tipografias de Google Fonts al repo.
 *
 * Alojarlas nosotros tiene dos motivos: la app instalada abre sin depender de un
 * tercero (que es de lo que se trata una PWA), y el look no se cae a una
 * tipografia del sistema cuando la red esta lenta, que en un juego de mesa se
 * nota enseguida.
 *
 * Los .woff2 caen en src/styles/fonts/ y no en public/ a proposito: asi Vite les
 * pone un hash en el nombre, los sirve bajo el base path correcto de GitHub
 * Pages y el navegador puede cachearlos para siempre.
 *
 * Uso: npm run fonts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../src/styles/fonts/', import.meta.url).pathname;
const CSS_OUT = new URL('../src/styles/fonts.css', import.meta.url).pathname;

// Google sirve archivos distintos segun el user agent; este pide woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const SOURCE =
  'https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@400..700&display=swap';

mkdirSync(OUT, { recursive: true });

const css = await (await fetch(SOURCE, { headers: { 'user-agent': UA } })).text();

/** Nos quedamos solo con latin y latin-ext: el resto es peso muerto en español. */
const blocks = css
  .split('@font-face')
  .slice(1)
  .map((block) => `@font-face${block.slice(0, block.indexOf('}') + 1)}`)
  .filter((block) => /U\+0000-00FF|U\+0100-02BA/.test(block));

let out = `/* Generado por scripts/fetch-fonts.mjs — no editar a mano. */\n`;
let count = 0;

for (const block of blocks) {
  const url = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
  if (!url) continue;
  const family = block.match(/font-family:\s*'([^']+)'/)?.[1] ?? 'font';
  const slug = `${family.toLowerCase().replace(/\s+/g, '-')}-${count++}.woff2`;
  const bytes = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
  writeFileSync(join(OUT, slug), bytes);
  out += `${block.replace(url, `./fonts/${slug}`).trim()}\n`;
  console.log(`✓ ${slug} (${(bytes.length / 1024).toFixed(1)} kB)`);
}

writeFileSync(CSS_OUT, out);
console.log(`✓ src/styles/fonts.css con ${count} archivos`);
