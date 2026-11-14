import type { Page } from '../lib/types';

export const PAGE_GAP = 18; // css px between pages (at zoom 1)
export const PAD_X = 16;
export const PAD_TOP = 16;
export const PAD_BOTTOM = 120;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 5;

export interface Layout {
  /** css px per page unit */
  scale: number;
  tops: number[];
  lefts: number[];
  widths: number[];
  heights: number[];
  contentW: number;
  contentH: number;
}

/** Fit-to-width scale at zoom 1. */
export function fitScale(pages: Page[], viewportW: number): number {
  const maxW = Math.max(1, ...pages.map((p) => p.width));
  return Math.max(0.2, (viewportW - PAD_X * 2) / maxW);
}

export function computeLayout(pages: Page[], viewportW: number, zoom: number): Layout {
  const scale = fitScale(pages, viewportW) * zoom;
  const widths = pages.map((p) => p.width * scale);
  const heights = pages.map((p) => p.height * scale);
  const maxW = Math.max(0, ...widths);
  const contentW = Math.max(viewportW, maxW + PAD_X * 2);
  const gap = PAGE_GAP * Math.max(0.6, Math.min(zoom, 2));
  const tops: number[] = [];
  let y = PAD_TOP;
  for (const h of heights) {
    tops.push(y);
    y += h + gap;
  }
  const lefts = widths.map((w) => (contentW - w) / 2);
  return { scale, tops, lefts, widths, heights, contentW, contentH: y - gap + PAD_BOTTOM };
}

/** Finds the page under a content-space point (nearest page by vertical position). */
export function pageAt(layout: Layout, y: number): number {
  const { tops, heights } = layout;
  if (!tops.length) return -1;
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  // If in the gap below page lo, pick the closer one.
  if (lo + 1 < tops.length && y > tops[lo] + heights[lo]) {
    const dBelow = tops[lo + 1] - y, dAbove = y - (tops[lo] + heights[lo]);
    if (dBelow < dAbove) return lo + 1;
  }
  return lo;
}

/** content point -> (page index, page-unit coords) */
export function contentToPage(layout: Layout, x: number, y: number) {
  const i = Math.max(0, pageAt(layout, y));
  return { index: i, u: (x - layout.lefts[i]) / layout.scale, v: (y - layout.tops[i]) / layout.scale };
}

export function pageToContent(layout: Layout, index: number, u: number, v: number) {
  return { x: layout.lefts[index] + u * layout.scale, y: layout.tops[index] + v * layout.scale };
}
