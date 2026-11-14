import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { db } from './db';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL('pdfjs/', document.baseURI).href;

function docParams(data: Uint8Array) {
  return {
    data,
    cMapUrl: assetBase + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assetBase + 'standard_fonts/',
    wasmUrl: assetBase + 'wasm/',
    iccUrl: assetBase + 'iccs/',
    isEvalSupported: false,
  };
}

/** Opens a PDF from raw bytes. The buffer is copied because pdf.js transfers it to the worker. */
export function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument(docParams(new Uint8Array(bytes.slice(0)))).promise;
}

export function destroyPdf(doc: PDFDocumentProxy) {
  void doc.loadingTask.destroy();
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

export function getPdfDoc(fileId: string): Promise<PDFDocumentProxy> {
  let p = docCache.get(fileId);
  if (!p) {
    p = db.getFile(fileId).then((f) => {
      if (!f) throw new Error('PDF file missing from storage');
      return openPdf(f.data);
    });
    p.catch(() => docCache.delete(fileId));
    docCache.set(fileId, p);
  }
  return p;
}

export async function closeAllPdfDocs() {
  const docs = [...docCache.values()];
  docCache.clear();
  for (const d of docs) d.then(destroyPdf).catch(() => {});
}

export interface PdfPageInfo {
  index: number;
  width: number;
  height: number;
  transform: number[];
}

export async function readPdfPages(doc: PDFDocumentProxy, onProgress?: (done: number, total: number) => void): Promise<PdfPageInfo[]> {
  const out: PdfPageInfo[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    out.push({ index: i, width: vp.width, height: vp.height, transform: Array.from(vp.transform) });
    page.cleanup();
    onProgress?.(i + 1, doc.numPages);
  }
  return out;
}

// Limit concurrent page renders so fast scrolling doesn't swamp the worker.
let active = 0;
const queue: (() => void)[] = [];
function acquire(): Promise<void> {
  if (active < 2) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => queue.push(() => (active++, r())));
}
function release() {
  active--;
  queue.shift()?.();
}

export interface RenderHandle {
  promise: Promise<HTMLCanvasElement | null>;
  cancel: () => void;
}

/**
 * Renders a PDF page into a fresh canvas at `scale` device pixels per page unit.
 * Resolves null if cancelled.
 */
export function renderPdfPage(fileId: string, index: number, scale: number): RenderHandle {
  let cancelled = false;
  let task: RenderTask | null = null;
  const promise = (async () => {
    await acquire();
    try {
      if (cancelled) return null;
      const doc = await getPdfDoc(fileId);
      const page = await doc.getPage(index + 1);
      if (cancelled) return null;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      task = page.render({ canvas, viewport: vp });
      try {
        await task.promise;
      } catch (e) {
        releaseCanvas(canvas);
        if (cancelled) return null;
        throw e;
      }
      if (cancelled) {
        releaseCanvas(canvas);
        return null;
      }
      return canvas;
    } finally {
      release();
    }
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** Safari keeps canvas memory around until the canvas is shrunk. */
export function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 1;
  c.height = 1;
}

/** Largest canvas we create per page, in pixels (Safari has a strict canvas memory budget). */
export const MAX_CANVAS_PIXELS = 7_000_000;

export function cappedScale(width: number, height: number, desired: number): number {
  const px = width * height * desired * desired;
  return px > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (width * height)) : desired;
}
