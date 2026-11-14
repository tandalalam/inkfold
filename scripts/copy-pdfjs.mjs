// Copies pdf.js runtime assets (character maps, standard fonts, wasm decoders,
// ICC profiles) into public/ so they're served and precached for offline use.
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/pdfjs-dist');
const dest = resolve(root, 'public/pdfjs');
if (existsSync(dest)) rmSync(dest, { recursive: true });
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  if (existsSync(resolve(src, dir))) cpSync(resolve(src, dir), resolve(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
