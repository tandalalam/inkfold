import type { Page } from './types';
import { drawStrokesToCanvas } from './ink';
import { drawTemplateToCanvas } from './templates';
import { releaseCanvas, renderPdfPage } from './pdf';

/** Renders a page (background + ink) to a JPEG data URL `widthPx` wide. */
export async function renderThumbnail(page: Page, widthPx = 240): Promise<string> {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = (widthPx * dpr) / page.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(page.width * scale);
  canvas.height = Math.round(page.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.pdf) {
    try {
      const bg = await renderPdfPage(page.pdf.fileId, page.pdf.index, scale).promise;
      if (bg) {
        ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
        releaseCanvas(bg);
      }
    } catch {
      /* draw ink anyway */
    }
  }
  ctx.save();
  ctx.scale(scale, scale);
  if (!page.pdf) drawTemplateToCanvas(ctx, page.template, page.paper, page.width, page.height);
  drawStrokesToCanvas(ctx, page.strokes);
  ctx.restore();
  const url = canvas.toDataURL('image/jpeg', 0.78);
  releaseCanvas(canvas);
  return url;
}
