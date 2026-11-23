import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Page, Stroke } from '../lib/types';
import { HL_OPACITY, centerlinePath, penPath, shapePressure, strokePath } from '../lib/ink';
import { compactPoints, eraseFromStroke, polygonBounds, strokeHitBySegment, strokeInLasso } from '../lib/geometry';
import { recognizeShape } from '../lib/shapes';
import { PAPER_COLORS, templateGeometry } from '../lib/templates';
import { cappedScale, releaseCanvas, renderPdfPage } from '../lib/pdf';
import { uid } from '../lib/db';
import { useEditor, type Selection } from './store';
import { useTools } from './tools';
import { inputState } from './input';
import { SelectionBox } from './SelectionBox';
import { ClipboardPaste, Sparkles } from 'lucide-react';
import { useClipboard, pasteStrokes } from './clipboard';
import { tapProps } from '../ui/tap';
import { useAsk, isPending } from '../ask/store';

/** Elements on a page that handle their own input (the page must not draw under them). */
export const PAGE_UI = '.selection-box, .selection-bar, .paste-bubble, .ask-badge';

interface Props {
  pageId: string;
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** css px per page unit */
  scale: number;
}

const TemplateLayer = memo(function TemplateLayer({ page }: { page: Page }) {
  const g = useMemo(() => templateGeometry(page.template, page.width, page.height), [page.template, page.width, page.height]);
  return (
    <g>
      <rect width={page.width} height={page.height} fill={PAPER_COLORS[page.paper]} />
      {g.lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={l.width} />
      ))}
      {g.dots.map((d, i) => (
        <circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r} fill={d.color} />
      ))}
    </g>
  );
});

function StrokeEl({ s }: { s: Stroke }) {
  return s.t === 'hl' ? (
    <path d={strokePath(s)} fill="none" stroke={s.c} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" />
  ) : (
    <path d={strokePath(s)} fill={s.c} />
  );
}

const InkLayer = memo(function InkLayer({ strokes, selection }: { strokes: Stroke[]; selection: Selection | null }) {
  const sel = selection ? new Set(selection.ids) : null;
  const normal = sel ? strokes.filter((s) => !sel.has(s.id)) : strokes;
  const selected = sel ? strokes.filter((s) => sel.has(s.id)) : [];
  const hl = normal.filter((s) => s.t === 'hl');
  const pen = normal.filter((s) => s.t === 'pen');
  return (
    <>
      <g opacity={HL_OPACITY} data-layer="hl">
        {hl.map((s) => (
          <StrokeEl key={s.id} s={s} />
        ))}
      </g>
      <g data-layer="pen">
        {pen.map((s) => (
          <StrokeEl key={s.id} s={s} />
        ))}
      </g>
      {selected.length > 0 && (
        <g transform={`translate(${selection!.dx},${selection!.dy})`} className="selected-ink">
          <g opacity={HL_OPACITY}>
            {selected
              .filter((s) => s.t === 'hl')
              .map((s) => (
                <StrokeEl key={s.id} s={s} />
              ))}
          </g>
          {selected
            .filter((s) => s.t === 'pen')
            .map((s) => (
              <StrokeEl key={s.id} s={s} />
            ))}
        </g>
      )}
    </>
  );
});

function PdfBackground({ page, scale }: { page: Page; scale: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const current = useRef<{ canvas: HTMLCanvasElement; scale: number } | null>(null);
  const fileId = page.pdf!.fileId, index = page.pdf!.index;

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const want = cappedScale(page.width, page.height, scale * dpr);
    const have = current.current?.scale ?? 0;
    // Skip re-render if the existing bitmap is close enough.
    if (have && have >= want * 0.92 && have <= want * 1.6) return;
    let handle: ReturnType<typeof renderPdfPage> | null = null;
    const t = setTimeout(
      () => {
        handle = renderPdfPage(fileId, index, want);
        handle.promise
          .then((canvas) => {
            if (!canvas || !holder.current) return;
            canvas.className = 'pdf-canvas';
            const old = current.current;
            holder.current.appendChild(canvas);
            if (old) {
              old.canvas.remove();
              releaseCanvas(old.canvas);
            }
            current.current = { canvas, scale: want };
          })
          .catch((e) => console.warn('PDF render failed', e));
      },
      have ? 160 : 0,
    );
    return () => {
      clearTimeout(t);
      handle?.cancel();
    };
  }, [fileId, index, scale, page.width, page.height]);

  useEffect(
    () => () => {
      if (current.current) releaseCanvas(current.current.canvas);
    },
    [],
  );

  return <div ref={holder} className="pdf-bg" />;
}

export const PageView = memo(function PageView({ pageId, index, left, top, width, height, scale }: Props) {
  const page = useEditor((s) => s.pages[pageId]);
  const selection = useEditor((s) => (s.selection?.pageId === pageId ? s.selection : null));
  const rootRef = useRef<HTMLDivElement>(null);
  const livePen = useRef<SVGPathElement>(null);
  const liveHl = useRef<SVGPathElement>(null);
  const overlay = useRef<SVGPathElement>(null);
  const eraserCircle = useRef<SVGCircleElement>(null);
  const pendingClear = useRef(false);

  // Remove the live stroke only once React has painted the committed one.
  useLayoutEffect(() => {
    if (!pendingClear.current) return;
    pendingClear.current = false;
    livePen.current?.setAttribute('d', '');
    liveHl.current?.setAttribute('d', '');
  }, [page?.strokes]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let pointerId: number | null = null;
    let rect: DOMRect;
    let k = 1; // css px per page unit
    let mode: 'pen' | 'hl' | 'eraser' | 'lasso' | null = null;
    let pts: number[] = [];
    let snapped = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let anchorX = 0, anchorY = 0;
    let lastX = 0, lastY = 0;
    let eraseBefore: Stroke[] = [];
    let erasing: Stroke[] = [];
    let strokeProps: { w: number; c: string; s?: 'ball' | 'fountain' } = { w: 2, c: '#000' };

    const toLocal = (e: PointerEvent) => [(e.clientX - rect.left) / k, (e.clientY - rect.top) / k] as const;

    const clearOverlay = () => {
      overlay.current?.setAttribute('d', '');
      eraserCircle.current?.setAttribute('r', '0');
    };

    const renderLive = () => {
      if (mode === 'pen') livePen.current?.setAttribute('d', penPath({ w: strokeProps.w, s: strokeProps.s, pts }, false));
      else if (mode === 'hl') liveHl.current?.setAttribute('d', centerlinePath(pts));
    };

    const resetHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      if (mode !== 'pen' && mode !== 'hl') return;
      if (!useTools.getState().shapeSnap || snapped) return;
      holdTimer = setTimeout(() => {
        const shape = recognizeShape(pts);
        if (shape) {
          pts = shape;
          snapped = true;
          renderLive();
        }
      }, 550);
    };

    const end = (commit: boolean) => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      const m = mode;
      mode = null;
      pointerId = null;
      inputState.active = null;
      const ed = useEditor.getState();
      const current = ed.pages[pageId];
      if (!current) return;
      if (m === 'pen' || m === 'hl') {
        if (commit && pts.length >= 3) {
          const stroke: Stroke = { id: uid(), t: m, c: strokeProps.c, w: strokeProps.w, pts: compactPoints(pts) };
          if (m === 'pen') stroke.s = strokeProps.s;
          pendingClear.current = true;
          ed.setStrokes(pageId, [...current.strokes, stroke]);
        } else {
          livePen.current?.setAttribute('d', '');
          liveHl.current?.setAttribute('d', '');
        }
      } else if (m === 'eraser') {
        if (commit && erasing !== eraseBefore) ed.setStrokes(pageId, erasing, true, eraseBefore);
        else if (!commit) ed.setStrokes(pageId, eraseBefore, false);
      } else if (m === 'lasso' && commit) {
        const area = pts.length >= 2 ? polygonBounds(pts) : null;
        const tiny = !area || pts.length < 6 || (area.w < 8 && area.h < 8);
        if (tiny) {
          // A tap with the lasso: offer Paste there.
          if (useClipboard.getState().clip && area) ed.setPasteSpot({ pageId, x: area.x, y: area.y });
        } else {
          const ids = current.strokes.filter((s) => strokeInLasso(s, pts)).map((s) => s.id);
          if (ids.length) ed.select({ pageId, ids, dx: 0, dy: 0, area });
          // Circling an empty area (e.g. printed PDF text) selects the region so it can be asked about.
          else if (useAsk.getState().available && area.w > 12 && area.h > 12) ed.select({ pageId, ids: [], dx: 0, dy: 0, area });
        }
      }
      pts = [];
      clearOverlay();
    };

    const eraseSegment = (ax: number, ay: number, bx: number, by: number) => {
      const t = useTools.getState().eraser;
      const r = t.size / 2 + 1 / k;
      let changed = false;
      let next: Stroke[];
      if (t.mode === 'stroke') {
        next = erasing.filter((s) => {
          const hit = strokeHitBySegment(s, ax, ay, bx, by, r);
          if (hit) changed = true;
          return !hit;
        });
      } else {
        next = [];
        for (const s of erasing) {
          const pieces = eraseFromStroke(s, ax, ay, bx, by, r);
          if (pieces.length !== 1 || pieces[0] !== s) changed = true;
          next.push(...pieces);
        }
      }
      if (changed) {
        erasing = next;
        useEditor.getState().setStrokes(pageId, next, false);
      }
      eraserCircle.current?.setAttribute('cx', String(bx));
      eraserCircle.current?.setAttribute('cy', String(by));
      eraserCircle.current?.setAttribute('r', String(t.size / 2));
    };

    const onDown = (e: PointerEvent) => {
      if (inputState.pinching || pointerId !== null) return;
      // The selection box and its toolbar handle their own input.
      if ((e.target as Element).closest?.(PAGE_UI)) return;
      const tools = useTools.getState();
      const type = e.pointerType;
      if (!(type === 'pen' || type === 'mouse' || (type === 'touch' && tools.fingerDraw))) return;
      if (type === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer */
      }
      pointerId = e.pointerId;
      rect = root.getBoundingClientRect();
      k = rect.width / useEditor.getState().pages[pageId].width;
      const [x, y] = toLocal(e);
      lastX = x;
      lastY = y;
      anchorX = e.clientX;
      anchorY = e.clientY;
      snapped = false;
      const ed = useEditor.getState();
      if (ed.selection) ed.select(null);
      if (ed.pasteSpot) ed.setPasteSpot(null);
      mode = tools.tool;
      inputState.active = { pointerType: type, cancel: () => end(false) };
      if (mode === 'pen' || mode === 'hl') {
        strokeProps = mode === 'pen' ? { w: tools.pen.size, c: tools.pen.color, s: tools.pen.style } : { w: tools.hl.size, c: tools.hl.color };
        const live = mode === 'pen' ? livePen.current : liveHl.current;
        if (mode === 'pen') live?.setAttribute('fill', strokeProps.c);
        else {
          live?.setAttribute('stroke', strokeProps.c);
          live?.setAttribute('stroke-width', String(strokeProps.w));
        }
        pts = [x, y, shapePressure(e.pressure, type)];
        renderLive();
        resetHold();
      } else if (mode === 'eraser') {
        eraseBefore = ed.pages[pageId].strokes;
        erasing = eraseBefore;
        eraseSegment(x, y, x, y);
      } else if (mode === 'lasso') {
        pts = [x, y];
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || !mode) return;
      if (snapped) return;
      const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
      const minDist = 0.35 / k;
      for (const ev of events) {
        const [x, y] = toLocal(ev);
        if (Math.hypot(x - lastX, y - lastY) < minDist) continue;
        if (mode === 'pen' || mode === 'hl') pts.push(x, y, shapePressure(ev.pressure, ev.pointerType));
        else if (mode === 'eraser') eraseSegment(lastX, lastY, x, y);
        else if (mode === 'lasso') pts.push(x, y);
        lastX = x;
        lastY = y;
      }
      if (mode === 'pen' || mode === 'hl') {
        renderLive();
        if (Math.hypot(e.clientX - anchorX, e.clientY - anchorY) > 2.5) {
          anchorX = e.clientX;
          anchorY = e.clientY;
          resetHold();
        }
      } else if (mode === 'lasso') {
        let d = `M${pts[0]},${pts[1]}`;
        for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
        overlay.current?.setAttribute('d', d);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      end(true);
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
      if (holdTimer) clearTimeout(holdTimer);
    };
  }, [pageId]);

  if (!page) return null;
  return (
    <div ref={rootRef} className="page" data-page-index={index} style={{ left, top, width, height }}>
      {page.pdf && <PdfBackground page={page} scale={scale} />}
      <svg className="ink" viewBox={`0 0 ${page.width} ${page.height}`} width={width} height={height}>
        {!page.pdf && <TemplateLayer page={page} />}
        <InkLayer strokes={page.strokes} selection={selection} />
        <g opacity={HL_OPACITY}>
          <path ref={liveHl} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <path ref={livePen} />
        <path ref={overlay} className="lasso-path" fill="rgba(60,120,220,0.06)" stroke="#3c78dc" strokeWidth={1.2 / scale} strokeDasharray={`${5 / scale} ${4 / scale}`} />
        <circle ref={eraserCircle} r={0} className="eraser-cursor" strokeWidth={1 / scale} />
      </svg>
      <AskBadges pageId={pageId} scale={scale} />
      <Flash pageId={pageId} scale={scale} />
      {selection && <SelectionBox page={page} selection={selection} scale={scale} />}
      <PasteBubble pageId={pageId} scale={scale} />
    </div>
  );
});

function PasteBubble({ pageId, scale }: { pageId: string; scale: number }) {
  const spot = useEditor((s) => (s.pasteSpot?.pageId === pageId ? s.pasteSpot : null));
  if (!spot) return null;
  const paste = () => {
    useEditor.getState().setPasteSpot(null);
    pasteStrokes(pageId, spot.x, spot.y);
  };
  return (
    <button className="paste-bubble" style={{ left: spot.x * scale, top: spot.y * scale }} {...tapProps(paste)}>
      <ClipboardPaste size={16} /> Paste
    </button>
  );
}

function Flash({ pageId, scale }: { pageId: string; scale: number }) {
  const flash = useEditor((s) => (s.flash?.pageId === pageId ? s.flash : null));
  if (!flash) return null;
  const r = flash.rect;
  return <div key={flash.nonce} className="clip-flash" style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} />;
}

/** Small markers where questions were asked; tap to open the answer. */
function AskBadges({ pageId, scale }: { pageId: string; scale: number }) {
  const asks = useAsk((s) => s.asks);
  const available = useAsk((s) => s.available);
  const marks: { id: string; n: number; x: number; y: number; pending: boolean }[] = [];
  if (available !== false)
    for (const a of asks)
      a.clips.forEach((c, i) => {
        if (c.pageId === pageId) marks.push({ id: a.id, n: i + 1, x: c.rect.x + c.rect.w, y: c.rect.y, pending: isPending(a) });
      });
  if (!marks.length) return null;
  const open = (id: string) => useAsk.setState({ panelOpen: true, focusId: id });
  return (
    <>
      {marks.map((m) => (
        <button
          key={`${m.id}-${m.n}`}
          className={`ask-badge ${m.pending ? 'pending' : ''}`}
          style={{ left: m.x * scale - 11, top: m.y * scale - 11 }}
          aria-label="Show answer"
          {...tapProps(() => open(m.id))}
        >
          <Sparkles size={12} />
        </button>
      ))}
    </>
  );
}
