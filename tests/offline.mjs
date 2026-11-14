// Verifies the installed app works with no network (service worker cache).
import { webkit } from 'playwright';
const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const b = await webkit.launch();
const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
const page = await ctx.newPage();
await page.goto(BASE);
await page.waitForSelector('.library');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload(); // let the service worker take control
await page.waitForSelector('.library');
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('.library', { timeout: 10000 });
await page.locator('.btn', { hasText: 'New notebook' }).click();
await page.click('.modal .btn-primary');
await page.waitForSelector('.editor .page');
const workerOk = await page.evaluate(async () => (await fetch(new URL('pdfjs/standard_fonts/FoxitSerif.pfb', document.baseURI))).ok).catch(() => false);
console.log(controlled ? '✓ service worker controls the page' : '✗ no service worker');
console.log('✓ app loads and opens a notebook while offline');
console.log(workerOk ? '✓ pdf.js assets available offline' : '✗ pdf.js assets missing offline');
await b.close();
process.exit(controlled && workerOk ? 0 : 1);
