import { useRef } from 'react';
import { Copy, Trash2, X } from 'lucide-react';
import type { Page } from '../lib/types';
import { translateStroke, unionBounds } from '../lib/geometry';
import { uid } from '../lib/db';
import { useEditor, type Selection } from './store';
import { useTools } from './tools';

/** Dashed box around lasso-selected strokes: drag to move, plus quick actions. */
export function SelectionBox({ page, selection, scale }: { page: Page; selection: Selection; scale: number }) {
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const penPalette = useTools((s) => s.penPalette);
  const ids = new Set(selection.ids);
  const strokes = page.strokes.filter((s) => ids.has(s.id));
  const b = unionBounds(strokes);
  if (!b) return null;
  const pad = 6 / scale;
  const left = (b.x - pad + selection.dx) * scale;
  const top = (b.y - pad + selection.dy) * scale;
  const w = (b.w + 2 * pad) * scale;
  const h = (b.h + 2 * pad) * scale;

  const ed = useEditor.getState;

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const sel = ed().selection;
    if (!sel) return;
    ed().select({ ...sel, dx: (e.clientX - d.x) / scale, dy: (e.clientY - d.y) / scale });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const sel = ed().selection;
    if (!sel || (!sel.dx && !sel.dy)) return;
    const cur = ed().pages[page.id];
    const next = cur.strokes.map((s) => (ids.has(s.id) ? translateStroke(s, sel.dx, sel.dy) : s));
    ed().setStrokes(page.id, next);
    ed().select({ ...sel, dx: 0, dy: 0 });
  };

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  const remove = () => {
    const cur = ed().pages[page.id];
    ed().setStrokes(page.id, cur.strokes.filter((s) => !ids.has(s.id)));
    ed().select(null);
  };
  const duplicate = () => {
    const cur = ed().pages[page.id];
    const copies = cur.strokes.filter((s) => ids.has(s.id)).map((s) => ({ ...translateStroke(s, 14, 14), id: uid() }));
    ed().setStrokes(page.id, [...cur.strokes, ...copies]);
    ed().select({ pageId: page.id, ids: copies.map((c) => c.id), dx: 0, dy: 0 });
  };
  const recolor = (c: string) => {
    const cur = ed().pages[page.id];
    ed().setStrokes(page.id, cur.strokes.map((s) => (ids.has(s.id) && s.t === 'pen' ? { ...s, c } : s)));
  };

  const barAbove = top > 52;
  return (
    <>
      <div
        className="selection-box"
        style={{ left, top, width: w, height: h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="selection-bar" style={{ left: left + w / 2, top: barAbove ? top - 48 : top + h + 8 }} onPointerDown={stop}>
        {penPalette.map((c) => (
          <button key={c} className="swatch small" style={{ background: c }} onClick={() => recolor(c)} aria-label={`Color ${c}`} />
        ))}
        <span className="bar-sep" />
        <button className="icon-btn" onClick={duplicate} aria-label="Duplicate">
          <Copy size={18} />
        </button>
        <button className="icon-btn danger" onClick={remove} aria-label="Delete selection">
          <Trash2 size={18} />
        </button>
        <button className="icon-btn" onClick={() => ed().select(null)} aria-label="Deselect">
          <X size={18} />
        </button>
      </div>
    </>
  );
}
