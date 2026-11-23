import { useRef } from 'react';
import { ClipboardCopy, Scissors, Sparkles, Trash2, X } from 'lucide-react';
import type { Page } from '../lib/types';
import { translateStroke, unionBounds } from '../lib/geometry';
import { tapProps } from '../ui/tap';
import { toast } from '../ui/overlay';
import { useAsk, addSelectionToAsk } from '../ask/store';
import { useEditor, type Selection } from './store';
import { useTools } from './tools';
import { copyStrokes } from './clipboard';

/**
 * Dashed box around a lasso selection plus its action bar.
 * Ink selections can be dragged, recoloured, copied, cut and deleted; any
 * selection (including a circled area with no ink, e.g. printed PDF text) can
 * be sent to the assistant with Ask.
 */
export function SelectionBox({ page, selection, scale }: { page: Page; selection: Selection; scale: number }) {
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const penPalette = useTools((s) => s.penPalette);
  const askAvailable = useAsk((s) => s.available === true);
  const trayCount = useAsk((s) => s.tray.length);
  const ids = new Set(selection.ids);
  const strokes = page.strokes.filter((s) => ids.has(s.id));
  const hasInk = strokes.length > 0;
  const b = hasInk ? unionBounds(strokes) : (selection.area ?? null);
  if (!b) return null;
  const pad = 6 / scale;
  const left = (b.x - pad + selection.dx) * scale;
  const top = (b.y - pad + selection.dy) * scale;
  const w = (b.w + 2 * pad) * scale;
  const h = (b.h + 2 * pad) * scale;
  const pageW = page.width * scale, pageH = page.height * scale;

  const ed = useEditor.getState;

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!hasInk) return;
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
    const area = sel.area && { ...sel.area, x: sel.area.x + sel.dx, y: sel.area.y + sel.dy };
    ed().select({ ...sel, dx: 0, dy: 0, area });
  };

  const selected = () => ed().pages[page.id].strokes.filter((s) => ids.has(s.id));
  const remove = () => {
    const cur = ed().pages[page.id];
    ed().setStrokes(page.id, cur.strokes.filter((s) => !ids.has(s.id)));
    ed().select(null);
  };
  const copy = () => {
    copyStrokes(selected());
    toast('Copied. Tap a page with the lasso to paste');
  };
  const cut = () => {
    copyStrokes(selected());
    remove();
    toast('Cut. Tap a page with the lasso to paste');
  };
  const recolor = (c: string) => {
    const cur = ed().pages[page.id];
    ed().setStrokes(page.id, cur.strokes.map((s) => (ids.has(s.id) && s.t === 'pen' ? { ...s, c } : s)));
  };
  const ask = () => void addSelectionToAsk(ed().selection ?? selection);

  const barAbove = top > 52;
  const barTop = barAbove ? top - 48 : Math.min(top + h + 8, pageH - 46);
  const barLeft = Math.max(150, Math.min(pageW - 150, left + w / 2));
  return (
    <>
      <div
        className={`selection-box ${hasInk ? '' : 'region'}`}
        style={{ left, top, width: w, height: h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="selection-bar" style={{ left: barLeft, top: barTop }} onPointerDown={(e) => e.stopPropagation()}>
        {hasInk && (
          <>
            {penPalette.map((c) => (
              <button key={c} className="swatch small" style={{ background: c }} {...tapProps(() => recolor(c))} aria-label={`Color ${c}`} />
            ))}
            <span className="bar-sep" />
            <button className="icon-btn" {...tapProps(copy)} aria-label="Copy" title="Copy">
              <ClipboardCopy size={18} />
            </button>
            <button className="icon-btn" {...tapProps(cut)} aria-label="Cut" title="Cut">
              <Scissors size={18} />
            </button>
            <button className="icon-btn danger" {...tapProps(remove)} aria-label="Delete selection" title="Delete">
              <Trash2 size={18} />
            </button>
          </>
        )}
        {askAvailable && (
          <button className="ask-btn" {...tapProps(ask)} aria-label="Ask about this">
            <Sparkles size={16} />
            {trayCount ? `Add [${trayCount + 1}]` : 'Ask'}
          </button>
        )}
        {!hasInk && !askAvailable && <span className="hint">No ink here</span>}
        <button className="icon-btn" {...tapProps(() => ed().select(null))} aria-label="Deselect">
          <X size={18} />
        </button>
      </div>
    </>
  );
}
