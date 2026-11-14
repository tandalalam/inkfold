import { getStroke } from 'perfect-freehand';
import type { Stroke } from './types';

/** Opacity used for the highlighter group (applied once, so overlaps don't darken). */
export const HL_OPACITY = 0.38;

function penOptions(stroke: Pick<Stroke, 'w' | 's'>, last: boolean) {
  const fountain = stroke.s === 'fountain';
  return {
    size: stroke.w,
    thinning: fountain ? 0.62 : 0.18,
    smoothing: 0.55,
    streamline: 0.32,
    simulatePressure: false,
    easing: (t: number) => t,
    start: { taper: fountain ? 6 : 0, cap: true },
    end: { taper: fountain ? 8 : 0, cap: true },
    last,
  };
}

/** Converts flat [x,y,p,...] to the [[x,y,p],...] shape perfect-freehand wants. */
export function toPointTuples(pts: number[]): number[][] {
  const out: number[][] = new Array(pts.length / 3);
  for (let i = 0, j = 0; i < pts.length; i += 3, j++) out[j] = [pts[i], pts[i + 1], pts[i + 2]];
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Outline polygon -> smooth closed SVG path (quadratic midpoints). */
export function outlineToPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) {
    if (!len) return '';
    // tiny dot
    const [x, y] = points[0];
    return `M${r2(x)},${r2(y)}Z`;
  }
  // Explicit Q commands (no T shorthand) so PDF export parses it identically.
  const mid = (i: number) => {
    const a = points[i % len], b = points[(i + 1) % len];
    return `${r2((a[0] + b[0]) / 2)},${r2((a[1] + b[1]) / 2)}`;
  };
  let d = `M${mid(0)}`;
  for (let i = 1; i <= len; i++) {
    const p = points[i % len];
    d += `Q${r2(p[0])},${r2(p[1])} ${mid(i)}`;
  }
  return d + 'Z';
}

/** Centerline path for constant-width strokes (highlighter). */
export function centerlinePath(pts: number[]): string {
  const n = pts.length / 3;
  if (n === 0) return '';
  if (n === 1) return `M${r2(pts[0])},${r2(pts[1])}l0.01,0`;
  let d = `M${r2(pts[0])},${r2(pts[1])}`;
  if (n === 2) return d + `L${r2(pts[3])},${r2(pts[4])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1];
    const nx = pts[(i + 1) * 3], ny = pts[(i + 1) * 3 + 1];
    d += `Q${r2(x)},${r2(y)} ${r2((x + nx) / 2)},${r2((y + ny) / 2)}`;
  }
  const li = (n - 1) * 3;
  return d + `L${r2(pts[li])},${r2(pts[li + 1])}`;
}

/** SVG path for a pen stroke outline (filled). */
export function penPath(stroke: Pick<Stroke, 'w' | 's' | 'pts'>, last = true): string {
  return outlineToPath(getStroke(toPointTuples(stroke.pts), penOptions(stroke, last)));
}

const pathCache = new WeakMap<Stroke, string>();

/** Cached SVG path for a committed stroke. Strokes are immutable, so caching by identity is safe. */
export function strokePath(stroke: Stroke): string {
  let d = pathCache.get(stroke);
  if (d === undefined) {
    d = stroke.t === 'hl' ? centerlinePath(stroke.pts) : penPath(stroke);
    pathCache.set(stroke, d);
  }
  return d;
}

/** Pencil pressure is often light; lift it a little so ink isn't too thin. */
export function shapePressure(p: number, pointerType: string): number {
  if (pointerType !== 'pen' || !p) return 0.5;
  return Math.min(1, Math.max(0.05, Math.pow(p, 0.75)));
}

/** Draws strokes on a 2D canvas (thumbnails). ctx must already be scaled to page units. */
export function drawStrokesToCanvas(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  const hls = strokes.filter((s) => s.t === 'hl');
  if (hls.length) {
    ctx.save();
    ctx.globalAlpha = HL_OPACITY;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of hls) {
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.w;
      ctx.stroke(new Path2D(strokePath(s)));
    }
    ctx.restore();
  }
  for (const s of strokes) {
    if (s.t !== 'pen') continue;
    ctx.fillStyle = s.c;
    ctx.fill(new Path2D(strokePath(s)));
  }
}
