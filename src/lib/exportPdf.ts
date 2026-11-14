import { BlendMode, LineCapStyle, PDFDocument, PDFPage, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib';
import type { Page } from './types';
import { db } from './db';
import { strokePath } from './ink';
import { HL_OPACITY } from './ink';
import { PAPER_COLORS, templateGeometry } from './templates';

function hexToRgb(hex: string) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Inverse of a 2D affine matrix [a,b,c,d,e,f]. */
function invert([a, b, c, d, e, f]: number[]): number[] {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** m1 then m2 (row-vector convention used by PDF: p' = p * M). */
function multiply(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/**
 * Draws page content given in page units (top-left origin). `toPdf` maps page
 * units to PDF user space. pdf-lib's drawSvgPath flips y itself, so we
 * pre-compensate with a flip.
 */
function drawInk(pdfPage: PDFPage, page: Page, toPdf: number[]) {
  if (!page.strokes.length) return;
  const flip = [1, 0, 0, -1, 0, 0];
  const m = multiply(flip, toPdf);
  pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  for (const s of page.strokes) {
    if (s.t !== 'hl') continue;
    pdfPage.drawSvgPath(strokePath(s), {
      x: 0,
      y: 0,
      borderColor: hexToRgb(s.c),
      borderWidth: s.w,
      borderOpacity: HL_OPACITY,
      borderLineCap: LineCapStyle.Round,
      blendMode: BlendMode.Multiply,
    });
  }
  for (const s of page.strokes) {
    if (s.t !== 'pen') continue;
    pdfPage.drawSvgPath(strokePath(s), { x: 0, y: 0, color: hexToRgb(s.c) });
  }
  pdfPage.pushOperators(popGraphicsState());
}

function drawTemplate(pdfPage: PDFPage, page: Page) {
  const h = page.height;
  pdfPage.drawRectangle({ x: 0, y: 0, width: page.width, height: h, color: hexToRgb(PAPER_COLORS[page.paper]) });
  const g = templateGeometry(page.template, page.width, h);
  for (const l of g.lines)
    pdfPage.drawLine({ start: { x: l.x1, y: h - l.y1 }, end: { x: l.x2, y: h - l.y2 }, thickness: l.width, color: hexToRgb(l.color) });
  for (const d of g.dots) pdfPage.drawCircle({ x: d.x, y: h - d.y, size: d.r, color: hexToRgb(d.color) });
}

/** Builds a PDF of the given pages (in order) with ink flattened onto them. */
export async function exportPagesToPdf(pages: Page[], title: string): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setProducer('Inkfold');
  const sources = new Map<string, PDFDocument>();

  for (const page of pages) {
    if (page.pdf) {
      let src = sources.get(page.pdf.fileId);
      if (!src) {
        const file = await db.getFile(page.pdf.fileId);
        if (!file) throw new Error('A PDF used by this notebook is missing.');
        src = await PDFDocument.load(file.data, { ignoreEncryption: true, updateMetadata: false });
        sources.set(page.pdf.fileId, src);
      }
      const [copied] = await out.copyPages(src, [page.pdf.index]);
      out.addPage(copied);
      drawInk(copied, page, invert(page.pdf.transform));
    } else {
      const p = out.addPage([page.width, page.height]);
      drawTemplate(p, page);
      // page units -> PDF space: flip y
      drawInk(p, page, [1, 0, 0, -1, 0, page.height]);
    }
  }
  return out.save();
}
