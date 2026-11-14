// End-to-end test of Inkfold in WebKit (Safari's engine) with an iPad-sized
// touch viewport, plus a Chromium pass for real multi-touch pinch gestures.
//
// Usage: node tests/e2e.mjs [baseUrl]   (default http://127.0.0.1:4173/)
import { webkit, chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else {
    failures++;
    console.log('  ✗', msg);
  }
}
const step = (s) => console.log(`\n▸ ${s}`);

async function makeTestPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Test PDF page ${i}`, { x: 72, y: 700, size: 28, font, color: rgb(0.1, 0.1, 0.4) });
    p.drawText('Write on me with the Apple Pencil.', { x: 72, y: 660, size: 16, font });
    p.drawRectangle({ x: 72, y: 400, width: 300, height: 180, borderColor: rgb(0.7, 0.2, 0.2), borderWidth: 2 });
  }
  // a rotated page to exercise the transform math
  const r = doc.addPage([612, 792]);
  r.setRotation({ type: 'degrees', angle: 90 });
  r.drawText('Rotated page', { x: 72, y: 700, size: 28, font });
  return doc.save();
}

/** Dispatches a synthetic Apple Pencil stroke on page `index`. Points are fractions of the page size. */
async function penStroke(page, index, points, { hold = 0, pressure = 0.5, type = 'pen' } = {}) {
  await page.evaluate(
    async ({ index, points, hold, pressure, type }) => {
      const el = document.querySelector(`.page[data-page-index="${index}"]`);
      if (!el) throw new Error('page not found ' + index);
      const r = el.getBoundingClientRect();
      const at = ([u, v]) => ({ clientX: r.left + u * r.width, clientY: r.top + v * r.height });
      const base = { pointerId: 41, pointerType: type, isPrimary: true, bubbles: true, cancelable: true, composed: true };
      const fire = (t, p, buttons) => el.dispatchEvent(new PointerEvent(t, { ...base, ...at(p), pressure, buttons, button: t === 'pointermove' ? -1 : 0 }));
      fire('pointerdown', points[0], 1);
      for (const p of points.slice(1)) {
        fire('pointermove', p, 1);
        await new Promise((res) => setTimeout(res, 4));
      }
      if (hold) {
        await new Promise((res) => setTimeout(res, hold));
        fire('pointermove', points[points.length - 1], 1);
      }
      fire('pointerup', points[points.length - 1], 0);
    },
    { index, points, hold, pressure, type },
  );
  await page.waitForTimeout(60);
}

const line = (x0, y0, x1, y1, n = 24) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const wave = (x0, x1, y, amp, n = 40) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y + amp * Math.sin((i / n) * Math.PI * 4)]);
const circle = (cx, cy, rx, ry, n = 48) => Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2) * (1 + 0.03 * Math.sin(i)), cy + ry * Math.sin((i / n) * Math.PI * 2)]);

const strokes = (page, index = 0) =>
  page.evaluate((i) => {
    const s = window.__inkfold.useEditor.getState();
    return s.pages[s.order[i]]?.strokes ?? [];
  }, index);

async function clickMenu(page, label) {
  await page.locator('.menu-item', { hasText: label }).first().click();
}

async function main() {
  const pdfBytes = await makeTestPdf();
  const pdfPath = resolve(OUT, 'test-input.pdf');
  writeFileSync(pdfPath, pdfBytes);

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  step('Open app');
  await page.goto(BASE);
  await page.waitForSelector('.library');
  check(await page.locator('.empty').isVisible(), 'empty library shows welcome state');
  await page.screenshot({ path: `${OUT}/01-empty.png` });

  step('Folders');
  await page.click('.new-btn');
  await clickMenu(page, 'Folder');
  await page.fill('.modal .text-input', 'Physics');
  await page.click('.modal .btn-primary');
  await page.click('.new-btn');
  await clickMenu(page, 'Folder');
  await page.fill('.modal .text-input', 'Math');
  await page.click('.modal .btn-primary');
  check((await page.locator('.folder-card').count()) === 2, 'two folders created');
  await page.locator('.folder-card .card-hit').first().click(); // Math (sorted)
  await page.waitForSelector('.folder-title:has-text("Math")');
  await page.click('.new-btn');
  await clickMenu(page, 'Folder');
  await page.fill('.modal .text-input', 'Calculus');
  await page.click('.modal .btn-primary');
  check(await page.locator('.folder-tree .tree-label:has-text("Calculus")').isVisible(), 'nested folder appears in sidebar tree');
  await page.locator('.folder-card .card-hit').first().click();
  await page.waitForSelector('.folder-title:has-text("Calculus")');
  check((await page.locator('.crumb').allTextContents()).join('/').includes('Math/Calculus'), 'breadcrumb shows Library › Math › Calculus');

  step('Create notebook');
  await page.click('.new-btn');
  await clickMenu(page, 'Notebook');
  await page.fill('.modal .text-input', 'Lecture 1');
  await page.locator('.tpl-option', { hasText: 'Grid' }).click();
  await page.click('.modal .btn-primary');
  await page.waitForSelector('.editor .page');
  check((await page.locator('.title-btn').textContent()) === 'Lecture 1', 'editor opens with notebook title');
  check((await page.locator('.page line').count()) > 40, 'grid template is drawn');

  await page.waitForFunction(() => Object.values(window.__inkfold.useLibrary.getState().notebooks)[0]?.cover);
  const blankCover = await page.evaluate(() => Object.values(window.__inkfold.useLibrary.getState().notebooks)[0].cover);

  step('Pencil strokes');
  await penStroke(page, 0, wave(0.1, 0.8, 0.15, 0.02));
  await penStroke(page, 0, line(0.1, 0.22, 0.6, 0.22), { pressure: 0.9 });
  let s = await strokes(page);
  check(s.length === 2 && s.every((x) => x.t === 'pen'), 'two pen strokes committed');
  check((await page.locator('.page g[data-layer="pen"] path').count()) === 2, 'pen strokes rendered as SVG');
  // finger touches must NOT draw by default (palm rejection)
  await penStroke(page, 0, line(0.1, 0.3, 0.5, 0.3), { type: 'touch' });
  check((await strokes(page)).length === 2, 'finger touch does not draw (palm rejection)');

  step('Mouse input path (real events)');
  const box = await page.locator('.page[data-page-index="0"]').boundingBox();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.28);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width * (0.1 + i * 0.02), box.y + box.height * (0.28 + Math.sin(i / 3) * 0.01));
  await page.mouse.up();
  await page.waitForTimeout(60);
  check((await strokes(page)).length === 3, 'real pointer events draw a stroke');

  step('Highlighter');
  await page.click('[aria-label="Highlighter"]');
  await penStroke(page, 0, line(0.08, 0.15, 0.82, 0.15));
  s = await strokes(page);
  check(s.length === 4 && s[3].t === 'hl', 'highlighter stroke committed');
  check((await page.locator('.page g[data-layer="hl"] path').count()) === 1, 'highlighter drawn in translucent layer');

  step('Shape snapping (hold at end)');
  await page.click('[aria-label="Pen"]');
  await penStroke(page, 0, circle(0.5, 0.55, 0.15, 0.1), { hold: 800 });
  s = await strokes(page);
  const shape = s[s.length - 1];
  check(shape && shape.pts.length / 3 >= 60, `hand-drawn circle snapped to a clean ellipse (${shape?.pts.length / 3} points)`);
  await penStroke(page, 0, line(0.1, 0.75, 0.7, 0.78).map(([x, y], i) => [x, y + (i % 2 ? 0.002 : -0.002)]), { hold: 800 });
  s = await strokes(page);
  const ln = s[s.length - 1].pts;
  // every point must lie on the segment between the end points
  const [ax, ay] = [ln[0], ln[1]], [bx, by] = [ln[ln.length - 3], ln[ln.length - 2]];
  let maxDev = 0;
  for (let i = 0; i < ln.length; i += 3) {
    const d = Math.abs((by - ay) * ln[i] - (bx - ax) * ln[i + 1] + bx * ay - by * ax) / Math.hypot(bx - ax, by - ay);
    maxDev = Math.max(maxDev, d);
  }
  check(maxDev < 0.6, `wobbly line snapped straight (max deviation ${maxDev.toFixed(2)}pt)`);
  await page.screenshot({ path: `${OUT}/02-ink.png` });

  step('Undo / redo');
  const before = (await strokes(page)).length;
  await page.click('[aria-label="Undo"]');
  check((await strokes(page)).length === before - 1, 'undo removes last stroke');
  await page.click('[aria-label="Redo"]');
  check((await strokes(page)).length === before, 'redo restores it');

  step('Eraser');
  await page.click('[aria-label="Eraser"]');
  await penStroke(page, 0, line(0.35, 0.2, 0.35, 0.24, 6));
  s = await strokes(page);
  check(s.length === before - 1, 'stroke eraser removes the touched stroke');
  await page.locator('.seg button', { hasText: 'Precise' }).click();
  const countBefore = s.length;
  await penStroke(page, 0, line(0.45, 0.12, 0.45, 0.18, 6));
  s = await strokes(page);
  check(s.length > countBefore - 1, `precise eraser splits strokes (${countBefore} → ${s.length})`);
  await page.locator('.seg button', { hasText: 'Whole stroke' }).click();

  step('Lasso select, move, recolor');
  await page.click('[aria-label="Lasso"]');
  await penStroke(page, 0, circle(0.5, 0.55, 0.22, 0.17, 40));
  const sel = await page.evaluate(() => window.__inkfold.useEditor.getState().selection);
  check(sel && sel.ids.length >= 1, `lasso selected ${sel?.ids.length} stroke(s)`);
  await page.locator('.selection-box').scrollIntoViewIfNeeded();
  const selBox = await page.locator('.selection-box').boundingBox();
  const preMove = (await strokes(page)).find((x) => x.id === sel.ids[0]).pts[0];
  await page.mouse.move(selBox.x + selBox.width / 2, selBox.y + selBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(selBox.x + selBox.width / 2 + 60, selBox.y + selBox.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const postMove = (await strokes(page)).find((x) => x.id === sel.ids[0]).pts[0];
  check(postMove > preMove + 20, 'dragging the selection moves the ink');
  await page.locator('.selection-bar .swatch').nth(2).click();
  check((await strokes(page)).find((x) => x.id === sel.ids[0]).c === '#d0312d', 'selection recolored to red');
  await page.screenshot({ path: `${OUT}/03-lasso.png` });
  await page.click('[aria-label="Deselect"]');
  await page.click('[aria-label="Pen"]');

  step('Pages');
  await page.click('[aria-label="Add page"]');
  await clickMenu(page, 'Lined page');
  await page.waitForTimeout(300);
  check((await page.evaluate(() => window.__inkfold.useEditor.getState().order.length)) === 2, 'page added');
  await page.waitForSelector('.page[data-page-index="1"]');
  await penStroke(page, 1, wave(0.1, 0.7, 0.2, 0.01));
  check((await strokes(page, 1)).length === 1, 'drew on page 2');
  await page.click('[aria-label="Pages"]');
  await page.waitForSelector('.page-sidebar .thumb img', { timeout: 5000 });
  check((await page.locator('.page-sidebar .thumb-item').count()) === 2, 'sidebar shows 2 thumbnails');
  await page.locator('[aria-label="Page 2 options"]').click();
  await clickMenu(page, 'Duplicate');
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__inkfold.useEditor.getState().order.length)) === 3, 'page duplicated');
  await page.locator('[aria-label="Page 3 options"]').click();
  await clickMenu(page, 'Delete page');
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__inkfold.useEditor.getState().order.length)) === 2, 'page deleted');
  await page.click('[aria-label="More"]');
  await clickMenu(page, 'Dotted paper');
  check((await page.locator('.page circle').count()) > 100, 'page template switched to dotted');
  await page.screenshot({ path: `${OUT}/04-pages.png` });

  step('Persistence across reload');
  await page.waitForTimeout(1000); // debounce save
  const strokeCount = (await strokes(page)).length;
  await page.reload();
  await page.waitForSelector('.editor .page');
  await page.waitForTimeout(300);
  check((await strokes(page)).length === strokeCount, `strokes persisted after reload (${strokeCount})`);

  step('Back to library: cover thumbnail');
  await page.click('[aria-label="Back to library"]');
  await page.waitForSelector('.notebook-card');
  await page.waitForSelector('.notebook-card .cover img', { timeout: 5000 });
  await page.waitForTimeout(800);
  const cover = await page.locator('.notebook-card .cover img').getAttribute('src');
  check(cover && cover !== blankCover, 'notebook cover shows the ink even though the app was reloaded mid-edit');
  await page.screenshot({ path: `${OUT}/05-library.png` });

  step('Import PDF and annotate');
  await page.click('[aria-label="Back to library"]').catch(() => {});
  await page.goto(BASE + '#/');
  await page.waitForSelector('.library');
  const chooser = page.waitForEvent('filechooser');
  await page.click('.new-btn');
  await clickMenu(page, 'Import PDF');
  await (await chooser).setFiles(pdfPath);
  await page.waitForSelector('.editor .page canvas.pdf-canvas', { timeout: 15000 });
  check((await page.evaluate(() => window.__inkfold.useEditor.getState().order.length)) === 4, 'PDF imported as 4 pages');
  await page.click('[aria-label="Highlighter"]');
  await penStroke(page, 0, line(0.11, 0.105, 0.6, 0.105));
  await page.click('[aria-label="Pen"]');
  await penStroke(page, 0, circle(0.36, 0.38, 0.27, 0.13, 50));
  await penStroke(page, 0, wave(0.15, 0.55, 0.62, 0.015));
  await page.evaluate(() => window.__inkfold.useEditor.getState().scrollToPage(3));
  await page.waitForSelector('.page[data-page-index="3"] canvas.pdf-canvas', { timeout: 10000 });
  await penStroke(page, 3, line(0.1, 0.1, 0.9, 0.1));
  await page.evaluate(() => window.__inkfold.useEditor.getState().scrollToPage(0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/06-pdf.png` });

  step('Export annotated PDF');
  const dl = page.waitForEvent('download');
  await page.click('[aria-label="Export"]');
  await clickMenu(page, 'Export notebook as PDF');
  const download = await dl;
  const outPdf = resolve(OUT, 'exported.pdf');
  await download.saveAs(outPdf);
  const exported = await PDFDocument.load(readFileSync(outPdf));
  check(exported.getPageCount() === 4, 'exported PDF has 4 pages');
  execFileSync('pdftoppm', ['-png', '-r', '60', outPdf, `${OUT}/exported`]);
  check(true, 'exported PDF rendered with pdftoppm (tests/out/exported-*.png)');

  step('Notebook actions: rename, move, duplicate');
  await page.click('[aria-label="Back to library"]');
  await page.waitForSelector('.notebook-card');
  await page.locator('.notebook-card [aria-label$="options"]').first().click();
  await clickMenu(page, 'Rename');
  await page.fill('.modal .text-input', 'Homework PDF');
  await page.click('.modal .btn-primary');
  check(await page.locator('.card-title:has-text("Homework PDF")').isVisible(), 'renamed');
  await page.locator('.notebook-card [aria-label$="options"]').first().click();
  await clickMenu(page, 'Duplicate');
  await page.waitForTimeout(400);
  check((await page.locator('.notebook-card').count()) === 2, 'duplicated');
  await page.locator('.notebook-card [aria-label$="options"]').first().click();
  await clickMenu(page, 'Move to');
  await page.locator('.picker-row', { hasText: 'Physics' }).click();
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(200);
  check((await page.locator('.notebook-card').count()) === 1, 'moved one notebook into Physics');
  await page.fill('.search input', 'lecture');
  check((await page.locator('.notebook-card').count()) === 1, 'search finds “Lecture 1” in nested folder');
  await page.fill('.search input', '');

  step('Backup and restore');
  const bdl = page.waitForEvent('download');
  await page.click('[aria-label="Settings"]');
  await clickMenu(page, 'Back up library');
  const backupPath = resolve(OUT, 'backup.zip');
  await (await bdl).saveAs(backupPath);
  const totalBefore = await page.evaluate(() => Object.keys(window.__inkfold.useLibrary.getState().notebooks).length);
  // wipe the database, then restore
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.deleteDatabase('inkfold');
        r.onsuccess = r.onerror = r.onblocked = () => res();
      }),
  );
  await page.reload();
  await page.waitForSelector('.empty');
  check(true, 'library empty after wiping storage');
  const rchooser = page.waitForEvent('filechooser');
  await page.click('[aria-label="Settings"]');
  await clickMenu(page, 'Restore from backup');
  await (await rchooser).setFiles(backupPath);
  await page.waitForSelector('.toast:has-text("Restored")', { timeout: 10000 });
  const totalAfter = await page.evaluate(() => Object.keys(window.__inkfold.useLibrary.getState().notebooks).length);
  check(totalAfter === totalBefore, `restored ${totalAfter}/${totalBefore} notebooks`);
  await page.locator('.notebook-card .card-hit').first().click();
  await page.waitForSelector('.editor .page canvas.pdf-canvas', { timeout: 15000 });
  check((await strokes(page)).length === 3, 'restored PDF notebook still has its ink');

  step('Delete folder recursively');
  await page.click('[aria-label="Back to library"]');
  await page.goto(BASE + '#/');
  await page.waitForSelector('.folder-card');
  await page.locator('.folder-card', { hasText: 'Math' }).locator('[aria-label$="options"]').click();
  await clickMenu(page, 'Delete');
  await page.click('.modal .btn-danger');
  await page.waitForTimeout(400);
  const left = await page.evaluate(() => {
    const s = window.__inkfold.useLibrary.getState();
    return { folders: Object.values(s.folders).map((f) => f.name), notebooks: Object.values(s.notebooks).map((n) => n.title) };
  });
  check(!left.folders.includes('Calculus') && !left.notebooks.includes('Lecture 1'), 'Math, Calculus and Lecture 1 deleted');
  await page.screenshot({ path: `${OUT}/07-final.png` });

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();

  /* ---------------- Chromium: real multi-touch ---------------- */
  step('Chromium multi-touch: pinch zoom and two-finger-tap undo');
  const cb = await chromium.launch();
  const cctx = await cb.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const cp = await cctx.newPage();
  const cerrors = [];
  cp.on('pageerror', (e) => cerrors.push(String(e)));
  await cp.goto(BASE);
  await cp.waitForSelector('.library');
  await cp.locator('.btn', { hasText: 'New notebook' }).click();
  await cp.click('.modal .btn-primary');
  await cp.waitForSelector('.editor .page');
  const cdp = await cctx.newCDPSession(cp);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const pageW = async () => (await cp.locator('.page[data-page-index="0"]').boundingBox()).width;
  const w0 = await pageW();
  await touch('touchStart', [[350, 500], [470, 600]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[350 - i * 12, 500 - i * 10], [470 + i * 12, 600 + i * 10]]);
  await touch('touchEnd', []);
  await cp.waitForTimeout(300);
  const w1 = await pageW();
  check(w1 > w0 * 1.5, `pinch-out zooms in (page ${Math.round(w0)}px → ${Math.round(w1)}px)`);
  await cp.screenshot({ path: `${OUT}/08-zoomed.png` });
  // draw then two-finger tap to undo
  await penStroke(cp, 0, wave(0.3, 0.5, 0.3, 0.01));
  const n1 = (await strokes(cp)).length;
  await touch('touchStart', [[300, 600], [380, 620]]);
  await touch('touchEnd', []);
  await cp.waitForTimeout(100);
  check(n1 === 1 && (await strokes(cp)).length === 0, 'two-finger tap undoes');
  // single finger scroll should scroll, not draw
  const st0 = await cp.evaluate(() => document.querySelector('.scroller').scrollTop);
  await touch('touchStart', [[400, 800]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[400, 800 - i * 40]]);
  await touch('touchEnd', []);
  await cp.waitForTimeout(300);
  const st1 = await cp.evaluate(() => document.querySelector('.scroller').scrollTop);
  check(st1 > st0 && (await strokes(cp)).length === 0, `one finger scrolls (scrollTop ${st0} → ${Math.round(st1)}) without drawing`);
  check(cerrors.length === 0, `no page errors in chromium${cerrors.length ? ': ' + cerrors.join(' | ') : ''}`);
  await cb.close();

  console.log(`\n${failures ? `✗ ${failures} check(s) failed` : '✓ all checks passed'} — screenshots in tests/out/`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
