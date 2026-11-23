// Tests for selection actions (Pencil taps, copy/paste), the pen/eraser switch
// and the Ask feature, against a local bridge that uses tests/fake-t3.mjs.
//
// Usage: node tests/ask.mjs [baseUrl]   (default http://127.0.0.1:4173/)
// Starts its own bridge on 127.0.0.1:8471 in test mode.
import { webkit } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const TMP = resolve(OUT, 'bridge');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const PORT = 8471;
const API = `http://127.0.0.1:${PORT}/api/`;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else {
    failures++;
    console.log('  ✗', msg);
  }
}
const step = (s) => console.log(`\n▸ ${s}`);

function startBridge() {
  const origin = new URL(BASE).origin;
  const cfg = {
    threadId: 'test-thread',
    allowedOrigins: [origin],
    stateDir: resolve(TMP, 'state'),
    clipDir: resolve(TMP, 'clips'),
    t3Bin: resolve(HERE, 'fake-t3.mjs'),
    testPort: PORT,
  };
  writeFileSync(resolve(TMP, 'config.json'), JSON.stringify(cfg));
  const child = spawn(process.execPath, [resolve(HERE, '../server/bridge.mjs')], {
    env: { ...process.env, INKFOLD_BRIDGE_CONFIG: resolve(TMP, 'config.json'), FAKE_T3_DIR: TMP, FAKE_T3_DELAY: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[bridge] ' + d));
  return new Promise((res) => child.stdout.on('data', (d) => String(d).includes('test mode') && res(child)));
}

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Lemma ${i}. Every neutral mechanism has distortion at least 15.`, { x: 60, y: 700, size: 14, font });
    p.drawText('Proof sketch: consider the family of profiles below.', { x: 60, y: 600, size: 12, font });
  }
  return doc.save();
}

/** Synthetic Apple Pencil stroke on page `index`; points are page fractions. */
async function pen(page, index, points) {
  await page.evaluate(
    async ({ index, points }) => {
      const el = document.querySelector(`.page[data-page-index="${index}"]`);
      const r = el.getBoundingClientRect();
      const at = ([u, v]) => ({ clientX: r.left + u * r.width, clientY: r.top + v * r.height });
      const base = { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true, pressure: 0.5 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...at(points[0]), buttons: 1 }));
      for (const p of points.slice(1)) {
        el.dispatchEvent(new PointerEvent('pointermove', { ...base, ...at(p), buttons: 1 }));
        await new Promise((r) => setTimeout(r, 3));
      }
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...at(points[points.length - 1]), buttons: 0 }));
    },
    { index, points },
  );
  await page.waitForTimeout(80);
}

/** A Pencil tap on an element: pointer events only, no click (as on iPad inside the canvas). */
async function pencilTap(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no ' + sel);
    const r = el.getBoundingClientRect();
    const o = { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  }, selector);
  await page.waitForTimeout(120);
}

const line = (x0, y0, x1, y1, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const loop = (cx, cy, rx, ry, n = 40) => Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)]);
const ed = (page, fn) => page.evaluate(fn);
const strokesOn = (page, i) => page.evaluate((i) => {
  const s = window.__inkfold.useEditor.getState();
  return s.pages[s.order[i]].strokes;
}, i);

async function main() {
  const bridge = await startBridge();
  const pdfPath = resolve(OUT, 'ask-input.pdf');
  writeFileSync(pdfPath, await makePdf());

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.addInitScript((api) => localStorage.setItem('inkfold.askApi', api), API);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => {
    errors.push('unexpected dialog: ' + d.message());
    void d.dismiss();
  });

  step('Import a PDF');
  await page.goto(BASE);
  await page.waitForSelector('.library');
  const chooser = page.waitForEvent('filechooser');
  await page.click('.new-btn');
  await page.locator('.menu-item', { hasText: 'Import PDF' }).click();
  await (await chooser).setFiles(pdfPath);
  await page.waitForSelector('.editor .page canvas.pdf-canvas', { timeout: 15000 });
  await page.waitForSelector('.ask-toggle', { timeout: 8000 });
  check(true, 'Ask button appears when the bridge is reachable');

  step('Selection bar works with Pencil taps');
  await pen(page, 0, line(0.15, 0.4, 0.6, 0.42));
  await pen(page, 0, line(0.15, 0.45, 0.6, 0.47));
  await page.click('[aria-label="Lasso"]');
  await pen(page, 0, loop(0.38, 0.44, 0.3, 0.08));
  let sel = await ed(page, () => window.__inkfold.useEditor.getState().selection);
  check(sel?.ids.length === 2, 'lasso selected both strokes');
  await pencilTap(page, '.selection-bar .swatch:nth-of-type(3)');
  let s0 = await strokesOn(page, 0);
  check(s0.every((s) => s.c === '#d0312d'), 'Pencil tap on a colour recolours the selection');

  step('Copy and paste onto another page');
  await pencilTap(page, '.selection-bar [aria-label="Copy"]');
  check(await ed(page, () => !!JSON.parse(localStorage.getItem('inkfold.clipboard.v1'))?.strokes?.length), 'Copy puts the ink on the clipboard');
  check(await page.locator('[aria-label="Paste"]').isVisible(), 'Paste button appears in the toolbar');
  await pencilTap(page, '.selection-bar [aria-label="Deselect"]');
  await ed(page, () => window.__inkfold.useEditor.getState().scrollToPage(1));
  await page.waitForSelector('.page[data-page-index="1"]');
  await page.waitForTimeout(300);
  await pen(page, 1, [[0.5, 0.7], [0.501, 0.7]]); // lasso tap
  check(await page.locator('.paste-bubble').isVisible(), 'tapping a page with the lasso offers Paste');
  await pencilTap(page, '.paste-bubble');
  let s1 = await strokesOn(page, 1);
  check(s1.length === 2 && s1.every((s) => s.c === '#d0312d'), 'pasted 2 strokes onto page 2');
  const ys = s1.map((s) => s.pts[1]);
  check(ys.every((y) => Math.abs(y - 0.7 * 792) < 60), 'pasted where the page was tapped');
  sel = await ed(page, () => window.__inkfold.useEditor.getState().selection);
  check(sel?.ids.length === 2, 'pasted ink is selected (ready to drag)');
  await page.click('[aria-label="Undo"]');
  check((await strokesOn(page, 1)).length === 0, 'undo removes the paste');
  await page.click('[aria-label="Paste"]');
  check((await strokesOn(page, 1)).length === 2, 'toolbar Paste puts ink in the visible page');

  step('Cut');
  await pen(page, 1, loop(0.5, 0.5, 0.45, 0.45));
  await pencilTap(page, '.selection-bar [aria-label="Cut"]');
  check((await strokesOn(page, 1)).length === 0, 'Cut removes the ink');
  await page.click('[aria-label="Undo"]');

  step('Pen / eraser quick switch');
  await page.click('[aria-label="Pen"]');
  await page.click('.quick-switch');
  check((await ed(page, () => window.__inkfold.useEditor && JSON.parse(localStorage.getItem('inkfold.tools.v1')).tool)) === 'eraser', 'switch goes to the eraser');
  await page.click('.quick-switch');
  check((await ed(page, () => JSON.parse(localStorage.getItem('inkfold.tools.v1')).tool)) === 'pen', 'and back to the pen');
  await page.click('[aria-label="Highlighter"]');
  await page.keyboard.press('e');
  await page.keyboard.press('e');
  check((await ed(page, () => JSON.parse(localStorage.getItem('inkfold.tools.v1')).tool)) === 'hl', 'E key toggles and returns to the highlighter');

  step('Ask about printed PDF text (region with no ink)');
  await ed(page, () => window.__inkfold.useEditor.getState().scrollToPage(0));
  await page.waitForTimeout(300);
  await page.click('[aria-label="Lasso"]');
  await pen(page, 0, loop(0.45, 0.115, 0.4, 0.04));
  sel = await ed(page, () => window.__inkfold.useEditor.getState().selection);
  check(sel && sel.ids.length === 0 && sel.area, 'circling printed text selects the region');
  await pencilTap(page, '.selection-bar .ask-btn');
  await page.waitForSelector('.ask-panel .tray-clip', { timeout: 8000 });
  check((await page.locator('.tray-clip').count()) === 1, 'clip [1] added to the question tray, panel opened');

  step('Add a second selection, from another page');
  await ed(page, () => window.__inkfold.useEditor.getState().scrollToPage(1));
  await page.waitForTimeout(300);
  await pen(page, 1, loop(0.38, 0.44, 0.3, 0.08));
  check((await page.locator('.selection-bar .ask-btn').textContent()).includes('[2]'), 'bar says Add [2]');
  await pencilTap(page, '.selection-bar .ask-btn');
  await page.waitForFunction(() => document.querySelectorAll('.tray-clip').length === 2);
  check(true, 'two clips in the tray');
  await page.locator('.chip', { hasText: 'Why does this hold?' }).click();
  check((await page.inputValue('.ask-input')) === 'Why does this hold?', 'quick prompt fills the question');
  await page.screenshot({ path: `${OUT}/ask-01-compose.png` });

  step('Send and get an answer with LaTeX');
  await page.click('.send-btn');
  await page.waitForSelector('.ask-card .ask-pending', { timeout: 5000 });
  check(true, 'card shows a pending state');
  await page.waitForSelector('.ask-card .answer', { timeout: 20000 });
  const answer = await page.locator('.ask-card .answer').innerText();
  check(answer.includes('with 2 clip(s)') && !answer.includes('MISSING'), 'bridge sent both clip images to the thread');
  check((await page.locator('.ask-card .answer .katex').count()) >= 3, 'inline, display and $…$ math typeset by KaTeX');
  check((await page.locator('.ask-card .answer .katex-display, .ask-card .answer .math-display').count()) >= 1, 'display math rendered as a block');
  check((await page.locator('.ask-card .answer script').count()) === 0 && answer.includes('<script>'), 'raw HTML in answers is shown as text, never run');
  check((await page.locator('.ask-card .answer strong').count()) === 1, 'Markdown bold rendered');
  await page.screenshot({ path: `${OUT}/ask-02-answer.png` });

  step('What the thread received');
  const sent = await (await fetch(API + 'status')).json();
  check(sent.thread?.title === 'Fake research thread', 'status reports the thread title');
  const { readFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(resolve(TMP, 'fake-t3-state.json'), 'utf8'));
  const msg = state.messages.find((m) => m.role === 'user').text;
  check(msg.includes('Lemma 1. Every neutral mechanism'), 'message includes the PDF text under the selection');
  check(/\[1\] .*\.png \(page 1 of "ask-input"\)/.test(msg), 'message names the PDF and page of each clip');
  check(msg.includes('My question: Why does this hold?') && msg.includes('be brief'), 'question and "be brief" instruction included');

  step('Markers on the page and jumping back');
  await ed(page, () => window.__inkfold.useEditor.getState().scrollToPage(0));
  await page.waitForTimeout(400);
  check((await page.locator('.page[data-page-index="0"] .ask-badge').count()) === 1, 'a marker sits where the question was asked');
  await page.locator('.ask-card .clip-thumb').nth(1).click();
  await page.waitForSelector('.page[data-page-index="1"] .clip-flash', { timeout: 3000 });
  check(true, 'tapping a clip thumbnail scrolls to it and highlights it');

  step('Persistence and idempotent retry');
  await page.reload();
  await page.waitForSelector('.ask-toggle', { timeout: 8000 });
  await page.click('.ask-toggle');
  await page.waitForSelector('.ask-card .answer .katex', { timeout: 8000 });
  check(true, 'asks and answers survive a reload');
  const id = await page.locator('.ask-card').getAttribute('data-ask-id');
  const again = await (
    await fetch(API + 'ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askId: id, question: 'dup' }) })
  ).json();
  const after = JSON.parse(readFileSync(resolve(TMP, 'fake-t3-state.json'), 'utf8'));
  check(again.ask?.status === 'completed' && after.runs === 1, 're-sending the same ask does not message the thread twice');

  step('Bridge rejects other origins');
  const bad = await fetch(API + 'status', { headers: { origin: 'https://evil.example' } });
  check(bad.status === 403, 'unknown origin gets 403');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  bridge.kill();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll ask checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
