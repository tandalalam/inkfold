import type { Page, Rect } from '../lib/types';
import { drawStrokesToCanvas } from '../lib/ink';
import { drawTemplateToCanvas } from '../lib/templates';
import { cappedScale, getPdfDoc, releaseCanvas, renderPdfPage } from '../lib/pdf';
import { db } from '../lib/db';

/** Renders a region of a page (PDF/paper + ink) to a PNG for the assistant and a small JPEG thumbnail. */
export async function renderClip(page: Page, rect: Rect): Promise<{ png: string; thumb: string }> {
  // Enough resolution to read small print, without huge uploads.
  const want = Math.min(4, Math.max(1.5, 1600 / Math.max(rect.w, rect.h)));
  const s = cappedScale(page.width, page.height, want);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.w * s));
  out.height = Math.max(1, Math.round(rect.h * s));
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  if (page.pdf) {
    try {
      const bg = await renderPdfPage(page.pdf.fileId, page.pdf.index, s).promise;
      if (bg) {
        const k = bg.width / page.width;
        ctx.drawImage(bg, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, out.width, out.height);
        releaseCanvas(bg);
      }
    } catch {
      /* ink only */
    }
  }
  ctx.save();
  ctx.scale(s, s);
  ctx.translate(-rect.x, -rect.y);
  if (!page.pdf) drawTemplateToCanvas(ctx, page.template, page.paper, page.width, page.height);
  drawStrokesToCanvas(ctx, page.strokes);
  ctx.restore();
  const png = out.toDataURL('image/png');

  const tw = 220;
  const thumbCanvas = document.createElement('canvas');
  const ts = Math.min(1, tw / out.width);
  thumbCanvas.width = Math.max(1, Math.round(out.width * ts));
  thumbCanvas.height = Math.max(1, Math.round(out.height * ts));
  thumbCanvas.getContext('2d')!.drawImage(out, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = thumbCanvas.toDataURL('image/jpeg', 0.8);
  releaseCanvas(out);
  releaseCanvas(thumbCanvas);
  return { png, thumb };
}

/** Text printed in the PDF under a region (helps the assistant find the spot in its sources). */
export async function pdfTextInRect(page: Page, rect: Rect): Promise<string> {
  if (!page.pdf) return '';
  try {
    const doc = await getPdfDoc(page.pdf.fileId);
    const p = await doc.getPage(page.pdf.index + 1);
    const tc = await p.getTextContent();
    const [a, b, c, d, e, f] = page.pdf.transform;
    const parts: string[] = [];
    for (const item of tc.items) {
      if (!('str' in item) || !item.str) continue;
      const [, , tc2, td, tx, ty] = item.transform as number[];
      // baseline start in page units
      const x = a * tx + c * ty + e, y = b * tx + d * ty + f;
      const fh = Math.hypot(tc2, td) || 8;
      const w = item.width || fh * item.str.length * 0.5;
      const ix = Math.min(x, x + w), iy = y - fh;
      const overlap = ix < rect.x + rect.w && ix + Math.abs(w) > rect.x && iy < rect.y + rect.h && y > rect.y;
      if (overlap) parts.push(item.str + (item.hasEOL ? '\n' : ' '));
    }
    return parts.join('').replace(/[ \t]+/g, ' ').trim().slice(0, 2500);
  } catch {
    return '';
  }
}

const nameCache = new Map<string, string>();

/** File name of the PDF a page comes from (without extension). */
export async function pdfName(page: Page): Promise<string> {
  if (!page.pdf) return '';
  const id = page.pdf.fileId;
  if (!nameCache.has(id)) {
    const f = await db.getFile(id).catch(() => undefined);
    nameCache.set(id, (f?.name || '').replace(/\.pdf$/i, ''));
  }
  return nameCache.get(id)!;
}
