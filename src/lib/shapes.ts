/**
 * Recognizes a hand-drawn stroke as a line, triangle, quadrilateral or ellipse
 * and returns clean replacement points (flat x,y,p), or null if it is none.
 */

type P = [number, number];

function pathLength(p: P[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function distToSeg(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** Ramer–Douglas–Peucker simplification. */
function rdp(points: P[], eps: number): P[] {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSeg(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(points.slice(0, idx + 1), eps);
  const right = rdp(points.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

function sampleSegment(out: number[], a: P, b: P, p: number, step = 2) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  for (let k = 0; k < n; k++) {
    const t = k / n;
    out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, p);
  }
}

function polygonPoints(corners: P[], p: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < corners.length; i++) sampleSegment(out, corners[i], corners[(i + 1) % corners.length], p);
  out.push(corners[0][0], corners[0][1], p);
  return out;
}

function meanDistToPolygon(points: P[], corners: P[]): number {
  let sum = 0;
  for (const pt of points) {
    let best = Infinity;
    for (let i = 0; i < corners.length; i++) best = Math.min(best, distToSeg(pt, corners[i], corners[(i + 1) % corners.length]));
    sum += best;
  }
  return sum / points.length;
}

export function recognizeShape(flat: number[]): number[] | null {
  const pts: P[] = [];
  let pSum = 0;
  for (let i = 0; i < flat.length; i += 3) {
    pts.push([flat[i], flat[i + 1]]);
    pSum += flat[i + 2];
  }
  if (pts.length < 4) return null;
  const pressure = Math.max(0.35, Math.min(0.8, pSum / pts.length));
  const L = pathLength(pts);
  if (L < 12) return null;

  const start = pts[0], end = pts[pts.length - 1];
  const gap = Math.hypot(end[0] - start[0], end[1] - start[1]);

  // Straight line
  if (gap > L * 0.8) {
    const maxDev = Math.max(...pts.map((p) => distToSeg(p, start, end)));
    if (maxDev < Math.max(3, L * 0.07)) {
      const out: number[] = [];
      sampleSegment(out, start, end, pressure);
      out.push(end[0], end[1], pressure);
      return out;
    }
    return null;
  }

  const closed = gap < Math.max(18, L * 0.18);
  if (!closed) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX, h = maxY - minY;
  if (w < 6 || h < 6) return null;
  const size = (w + h) / 2;

  // Polygons: simplify the closed path and look for 3 or 4 corners.
  const ring = pts.concat([start]);
  let corners = rdp(ring, size * 0.12);
  corners = corners.slice(0, -1); // drop duplicated closing point
  // merge corners that are very close (start/end overlap)
  corners = corners.filter((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return Math.hypot(c[0] - n[0], c[1] - n[1]) > size * 0.12;
  });
  if (corners.length === 3 || corners.length === 4) {
    const err = meanDistToPolygon(pts, corners);
    if (err < size * 0.06) {
      if (corners.length === 4) corners = squareUp(corners);
      return polygonPoints(corners, pressure);
    }
  }

  // Ellipse fit (axis aligned to the bounding box)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2, ry = h / 2;
  let err = 0;
  for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  err /= pts.length;
  if (err < 0.13) {
    // snap near-circles to circles
    let ex = rx, ey = ry;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) ex = ey = (rx + ry) / 2;
    const out: number[] = [];
    const n = 72;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      out.push(cx + ex * Math.cos(a), cy + ey * Math.sin(a), pressure);
    }
    return out;
  }
  return null;
}

/** If a quadrilateral is nearly axis-aligned, make it a clean rectangle. */
function squareUp(c: P[]): P[] {
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const tol = Math.max(maxX - minX, maxY - minY) * 0.12;
  const nearBox = c.every(
    (p) => (Math.abs(p[0] - minX) < tol || Math.abs(p[0] - maxX) < tol) && (Math.abs(p[1] - minY) < tol || Math.abs(p[1] - maxY) < tol),
  );
  if (!nearBox) return c;
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}
