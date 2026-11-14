import type { Stroke } from './types';
import { uid } from './db';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function strokeBounds(s: Stroke): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.pts.length; i += 3) {
    const x = s.pts[i], y = s.pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = s.w / 2;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function unionBounds(strokes: Stroke[]): Rect | null {
  if (!strokes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const b = strokeBounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Does the eraser segment (a->b, radius r) touch the stroke? */
export function strokeHitBySegment(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const b = strokeBounds(s);
  const reach = r;
  if (Math.max(ax, bx) < b.x - reach || Math.min(ax, bx) > b.x + b.w + reach) return false;
  if (Math.max(ay, by) < b.y - reach || Math.min(ay, by) > b.y + b.h + reach) return false;
  const rr = (r + s.w / 2) ** 2;
  const p = s.pts;
  if (p.length === 3) return distToSegmentSq(p[0], p[1], ax, ay, bx, by) <= rr;
  for (let i = 0; i + 3 < p.length; i += 3) {
    // distance between eraser segment and stroke segment, approximated by sampling
    const x1 = p[i], y1 = p[i + 1], x2 = p[i + 3], y2 = p[i + 4];
    if (
      distToSegmentSq(x1, y1, ax, ay, bx, by) <= rr ||
      distToSegmentSq(ax, ay, x1, y1, x2, y2) <= rr ||
      distToSegmentSq(bx, by, x1, y1, x2, y2) <= rr ||
      segmentsIntersect(ax, ay, bx, by, x1, y1, x2, y2)
    )
      return true;
  }
  return false;
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Inserts points so consecutive points are at most `step` apart. */
function densify(pts: number[], step: number): number[] {
  const out: number[] = [pts[0], pts[1], pts[2]];
  for (let i = 3; i < pts.length; i += 3) {
    const x0 = pts[i - 3], y0 = pts[i - 2], p0 = pts[i - 1];
    const x1 = pts[i], y1 = pts[i + 1], p1 = pts[i + 2];
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(dist / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t);
    }
    out.push(x1, y1, p1);
  }
  return out;
}

/**
 * Precise erase: removes the parts of the stroke within the eraser path and
 * returns the remaining pieces (possibly none, possibly the original stroke).
 */
export function eraseFromStroke(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): Stroke[] {
  if (!strokeHitBySegment(s, ax, ay, bx, by, r)) return [s];
  const pts = densify(s.pts, Math.max(0.6, r / 3));
  const rr = (r + s.w * 0.35) ** 2;
  const pieces: Stroke[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 6) pieces.push({ ...s, id: uid(), pts: cur });
    cur = [];
  };
  for (let i = 0; i < pts.length; i += 3) {
    if (distToSegmentSq(pts[i], pts[i + 1], ax, ay, bx, by) <= rr) flush();
    else cur.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  flush();
  return pieces;
}

export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A stroke is lasso-selected when at least half its points fall inside. */
export function strokeInLasso(s: Stroke, poly: number[]): boolean {
  let inside = 0, total = 0;
  for (let i = 0; i < s.pts.length; i += 3) {
    total++;
    if (pointInPolygon(s.pts[i], s.pts[i + 1], poly)) inside++;
  }
  return total > 0 && inside / total >= 0.5;
}

export function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] += dx;
    pts[i + 1] += dy;
  }
  return { ...s, pts };
}

/** Rounds coordinates to keep stored data compact. */
export function compactPoints(pts: number[]): number[] {
  return pts.map((v, i) => (i % 3 === 2 ? Math.round(v * 1000) / 1000 : Math.round(v * 100) / 100));
}
