import type { Paper, Template } from './types';

export const PAPER_COLORS: Record<Paper, string> = {
  white: '#ffffff',
  cream: '#fbf6e9',
};

export const TEMPLATE_LABELS: Record<Template, string> = {
  blank: 'Blank',
  lined: 'Lined',
  grid: 'Grid',
  dotted: 'Dotted',
};

export interface TemplateGeometry {
  lines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number }[];
  dots: { x: number; y: number; r: number; color: string }[];
}

const LINE = '#c5d3e6';
const MARGIN = '#efb2b2';
const GRID = '#dbe2ec';
const DOT = '#aab6c6';

/** Template drawn as explicit geometry so SVG, canvas and PDF export match exactly. */
export function templateGeometry(t: Template, w: number, h: number): TemplateGeometry {
  const g: TemplateGeometry = { lines: [], dots: [] };
  if (t === 'lined') {
    const top = 72, gap = 24;
    for (let y = top; y < h - 20; y += gap) g.lines.push({ x1: 0, y1: y, x2: w, y2: y, color: LINE, width: 0.75 });
    g.lines.push({ x1: 64, y1: 0, x2: 64, y2: h, color: MARGIN, width: 0.9 });
  } else if (t === 'grid') {
    const gap = 20;
    const ox = (w % gap) / 2, oy = (h % gap) / 2;
    for (let x = ox; x <= w; x += gap) g.lines.push({ x1: x, y1: 0, x2: x, y2: h, color: GRID, width: 0.6 });
    for (let y = oy; y <= h; y += gap) g.lines.push({ x1: 0, y1: y, x2: w, y2: y, color: GRID, width: 0.6 });
  } else if (t === 'dotted') {
    const gap = 20;
    const ox = (w % gap) / 2 || gap / 2, oy = (h % gap) / 2 || gap / 2;
    for (let x = ox; x < w; x += gap) for (let y = oy; y < h; y += gap) g.dots.push({ x, y, r: 0.9, color: DOT });
  }
  return g;
}

export function drawTemplateToCanvas(ctx: CanvasRenderingContext2D, t: Template, paper: Paper, w: number, h: number) {
  ctx.fillStyle = PAPER_COLORS[paper];
  ctx.fillRect(0, 0, w, h);
  const g = templateGeometry(t, w, h);
  for (const l of g.lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  for (const d of g.dots) {
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
