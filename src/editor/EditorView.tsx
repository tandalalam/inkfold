import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FileDown, FileText, Hand, Maximize, Trash2, FilePlus2, LayoutTemplate } from 'lucide-react';
import type { Page, Template, Paper } from '../lib/types';
import { navigate } from '../lib/router';
import { db, uid } from '../lib/db';
import { blankPage, useLibrary } from '../lib/library';
import { openPdf, readPdfPages, closeAllPdfDocs, destroyPdf } from '../lib/pdf';
import { exportPagesToPdf } from '../lib/exportPdf';
import { pickFiles, safeFilename, shareOrDownload } from '../lib/share';
import { TEMPLATE_LABELS } from '../lib/templates';
import { askText, openMenu, toast, withBusy, type MenuItem } from '../ui/overlay';
import { useEditor, flush } from './store';
import { useTools } from './tools';
import { inputState, cancelFingerInput } from './input';
import { computeLayout, contentToPage, pageAt, pageToContent, MAX_ZOOM, MIN_ZOOM, type Layout } from './layout';
import { PageView } from './PageView';
import { Toolbar } from './Toolbar';
import { PageSidebar } from './PageSidebar';

const TEMPLATES: Template[] = ['blank', 'lined', 'grid', 'dotted'];

interface Anchor {
  index: number;
  u: number;
  v: number;
  sx: number;
  sy: number;
}

export function EditorView({ notebookId }: { notebookId: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const notebook = useEditor((s) => s.notebook);
  const order = useEditor((s) => s.order);
  const pagesMap = useEditor((s) => s.pages);
  const scrollRequest = useEditor((s) => s.scrollRequest);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('inkfold.sidebar') === '1' && window.innerWidth > 900);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [range, setRange] = useState<[number, number]>([0, 2]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<Anchor | null>(null);
  const lastAnchor = useRef<Anchor | null>(null);
  const restored = useRef(false);

  /* ---------------- open / close ---------------- */
  useEffect(() => {
    let alive = true;
    useEditor
      .getState()
      .open(notebookId)
      .then((ok) => alive && setStatus(ok ? 'ready' : 'missing'));
    return () => {
      alive = false;
      void useEditor
        .getState()
        .close()
        .then(() => closeAllPdfDocs());
    };
  }, [notebookId]);

  useEffect(() => localStorage.setItem('inkfold.sidebar', sidebarOpen ? '1' : '0'), [sidebarOpen]);

  /* ---------------- layout ---------------- */
  const pages = useMemo(() => order.map((id) => pagesMap[id]).filter(Boolean) as Page[], [order, pagesMap]);
  // Layout only depends on page sizes; avoid recomputing on every stroke.
  const sizeKey = pages.map((p) => `${p.width}x${p.height}`).join(',');
  const layout: Layout = useMemo(() => computeLayout(pages, viewport.w || 800, zoom), [sizeKey, viewport.w, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      setViewport((v) => {
        if (v.w === w && v.h === h) return v;
        // keep the reading position when the width changes (rotation, sidebar)
        if (v.w && v.w !== w && lastAnchor.current) pendingAnchor.current = { ...lastAnchor.current, sx: 0, sy: 0 };
        return { w, h };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  const updateRange = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const L = layoutRef.current;
    const top = el.scrollTop, h = el.clientHeight;
    const first = Math.max(0, pageAt(L, top - h * 0.75));
    const last = Math.min(L.tops.length - 1, pageAt(L, top + h * 1.75));
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
    const cur = Math.max(0, pageAt(L, top + h / 2));
    useEditor.getState().setCurrentPage(cur);
    const a = contentToPage(L, el.scrollLeft, top);
    lastAnchor.current = { index: a.index, u: a.u, v: a.v, sx: 0, sy: 0 };
  }, []);

  // After a zoom/resize, put the anchored page point back under the same screen point.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = pendingAnchor.current;
    if (content.current) content.current.style.transform = '';
    if (!el || !a || a.index >= layout.tops.length) {
      updateRange();
      return;
    }
    pendingAnchor.current = null;
    const c = pageToContent(layout, a.index, a.u, a.v);
    el.scrollLeft = c.x - a.sx;
    el.scrollTop = c.y - a.sy;
    updateRange();
  }, [layout, updateRange]);

  // Restore the last viewed page once.
  useLayoutEffect(() => {
    if (status !== 'ready' || restored.current || !viewport.w || !pages.length) return;
    restored.current = true;
    const saved = Number(localStorage.getItem(`inkfold.lastPage.${notebookId}`) || 0);
    if (saved > 0 && saved < pages.length && scroller.current) {
      scroller.current.scrollTop = layout.tops[saved] - 12;
      updateRange();
    }
  }, [status, viewport.w, pages.length, layout, notebookId, updateRange]);

  const currentPage = useEditor((s) => s.currentPage);
  useEffect(() => {
    if (status === 'ready') localStorage.setItem(`inkfold.lastPage.${notebookId}`, String(currentPage));
  }, [currentPage, status, notebookId]);

  useEffect(() => {
    if (!scrollRequest || !scroller.current) return;
    const i = Math.min(scrollRequest[0], layout.tops.length - 1);
    if (i >= 0) scroller.current.scrollTo({ top: layout.tops[i] - 12 });
  }, [scrollRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- gestures: pinch zoom, two/three finger tap ---------------- */
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let pinch: {
      d0: number;
      m0: { x: number; y: number };
      zoom0: number;
      anchor: Omit<Anchor, 'sx' | 'sy'>;
      scale: number;
      m: { x: number; y: number };
    } | null = null;
    let tap: { start: number; max: number; moved: boolean; x: number; y: number } | null = null;

    const fingers = (list: TouchList) => Array.from(list).filter((t) => t.touchType !== 'stylus');
    const local = (t: Touch) => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const startPinch = (f: Touch[]) => {
      const a = local(f[0]), b = local(f[1]);
      const m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const L = layoutRef.current;
      const cx = el.scrollLeft + m0.x, cy = el.scrollTop + m0.y;
      const anchor = contentToPage(L, cx, cy);
      pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), m0, zoom0: zoomRef.current, anchor, scale: 1, m: m0 };
      if (content.current) content.current.style.transformOrigin = `${cx}px ${cy}px`;
      inputState.pinching = true;
      cancelFingerInput();
    };

    const onStart = (e: TouchEvent) => {
      const stylus = Array.from(e.changedTouches).some((t) => t.touchType === 'stylus');
      if (stylus) {
        // Pencil never scrolls; it only draws.
        if (e.cancelable) e.preventDefault();
        return;
      }
      const f = fingers(e.touches);
      if (!tap && f.length === 1) tap = { start: e.timeStamp, max: 1, moved: false, x: f[0].clientX, y: f[0].clientY };
      if (tap) tap.max = Math.max(tap.max, f.length);
      if (f.length >= 2) {
        if (e.cancelable) e.preventDefault();
        if (!pinch) startPinch(f);
      } else if (useTools.getState().fingerDraw && (e.target as Element).closest?.('.page') && !(e.target as Element).closest('.selection-box, .selection-bar')) {
        if (e.cancelable) e.preventDefault();
      }
    };

    const onMove = (e: TouchEvent) => {
      if (Array.from(e.changedTouches).some((t) => t.touchType === 'stylus')) {
        if (e.cancelable) e.preventDefault();
        return;
      }
      const f = fingers(e.touches);
      if (tap && f[0] && Math.hypot(f[0].clientX - tap.x, f[0].clientY - tap.y) > 12) tap.moved = true;
      if (pinch && f.length >= 2) {
        if (e.cancelable) e.preventDefault();
        const a = local(f[0]), b = local(f[1]);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.zoom0 * d) / pinch.d0));
        pinch.scale = z / pinch.zoom0;
        pinch.m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (Math.abs(pinch.scale - 1) > 0.04) tap && (tap.moved = true);
        const tx = pinch.m.x - pinch.m0.x, ty = pinch.m.y - pinch.m0.y;
        if (content.current) content.current.style.transform = `translate(${tx}px, ${ty}px) scale(${pinch.scale})`;
      } else if (useTools.getState().fingerDraw && inputState.active) {
        if (e.cancelable) e.preventDefault();
      }
    };

    const onEnd = (e: TouchEvent) => {
      const f = fingers(e.touches);
      if (pinch && f.length < 2) {
        const p = pinch;
        pinch = null;
        inputState.pinching = false;
        const newZoom = p.zoom0 * p.scale;
        if (Math.abs(newZoom - zoomRef.current) < 0.001) {
          // Pure two-finger pan: translate scroll by the movement.
          if (content.current) content.current.style.transform = '';
          el.scrollLeft -= p.m.x - p.m0.x;
          el.scrollTop -= p.m.y - p.m0.y;
        } else {
          pendingAnchor.current = { ...p.anchor, sx: p.m.x, sy: p.m.y };
          setZoom(newZoom);
        }
      }
      if (tap && f.length === 0) {
        const t = tap;
        tap = null;
        if (!t.moved && e.timeStamp - t.start < 350) {
          if (t.max === 2) useEditor.getState().undo();
          else if (t.max === 3) useEditor.getState().redo();
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      // Trackpad pinch / ctrl+wheel (desktop) zooms around the pointer.
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const a = contentToPage(layoutRef.current, el.scrollLeft + sx, el.scrollTop + sy);
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * Math.exp(-e.deltaY * 0.01)));
      pendingAnchor.current = { ...a, sx, sy };
      setZoom(z);
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [status]);

  /* ---------------- keyboard shortcuts ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- page operations ---------------- */
  const insertPages = (newPages: Page[], at: number) => {
    const s = useEditor.getState();
    const next = [...s.order];
    next.splice(at, 0, ...newPages.map((p) => p.id));
    s.setOrder(next, newPages);
    setTimeout(() => useEditor.getState().scrollToPage(at), 30);
  };

  const addPageMenu = (anchor: HTMLElement, afterIndex = useEditor.getState().currentPage) => {
    const s = useEditor.getState();
    const ref = s.pages[s.order[afterIndex]] ?? s.pages[s.order[s.order.length - 1]];
    const w = ref?.width ?? 595, h = ref?.height ?? 842;
    const paper: Paper = ref?.paper ?? 'white';
    const make = (template: Template) => () => insertPages([blankPage(s.notebook!.id, template, paper, w, h)], afterIndex + 1);
    const items: MenuItem[] = TEMPLATES.map((t) => ({ label: `${TEMPLATE_LABELS[t]} page`, icon: <FilePlus2 size={17} />, onSelect: make(t) }));
    items.push({ label: 'Import PDF pages…', icon: <FileText size={17} />, separator: true, onSelect: () => importPdfPages(afterIndex + 1) });
    openMenu(anchor, items);
  };

  const importPdfPages = async (at: number) => {
    const [file] = await pickFiles('application/pdf,.pdf');
    if (!file) return;
    await withBusy('Importing PDF…', async () => {
      const bytes = await file.arrayBuffer();
      const doc = await openPdf(bytes);
      try {
        const infos = await readPdfPages(doc);
        const fileId = uid();
        await db.putFiles([{ id: fileId, name: file.name, data: bytes }]);
        const nbId = useEditor.getState().notebook!.id;
        const newPages: Page[] = infos.map((info) => ({
          id: uid(),
          notebookId: nbId,
          width: info.width,
          height: info.height,
          template: 'blank',
          paper: 'white',
          pdf: { fileId, index: info.index, transform: info.transform },
          fileId,
          strokes: [],
        }));
        insertPages(newPages, at);
        toast(`Added ${newPages.length} page${newPages.length === 1 ? '' : 's'}`);
      } finally {
        destroyPdf(doc);
      }
    });
  };

  const deletePage = async (index: number) => {
    const s = useEditor.getState();
    if (s.order.length <= 1) {
      toast('A notebook needs at least one page');
      return;
    }
    s.setOrder(s.order.filter((_, i) => i !== index));
    toast('Page deleted — tap undo to restore');
  };

  const movePage = (index: number, delta: number) => {
    const s = useEditor.getState();
    const j = index + delta;
    if (j < 0 || j >= s.order.length) return;
    const next = [...s.order];
    [next[index], next[j]] = [next[j], next[index]];
    s.setOrder(next);
  };

  const duplicatePage = (index: number) => {
    const s = useEditor.getState();
    const p = s.pages[s.order[index]];
    insertPages([{ ...p, id: uid(), strokes: [...p.strokes] }], index + 1);
  };

  const pageMenu = (index: number, anchor: HTMLElement) => {
    const n = useEditor.getState().order.length;
    openMenu(anchor, [
      { label: 'Insert page after', icon: <FilePlus2 size={17} />, onSelect: () => addPageMenu(anchor, index) },
      { label: 'Duplicate', icon: <Copy size={17} />, onSelect: () => duplicatePage(index) },
      { label: 'Move up', icon: <ArrowUp size={17} />, disabled: index === 0, onSelect: () => movePage(index, -1) },
      { label: 'Move down', icon: <ArrowDown size={17} />, disabled: index === n - 1, onSelect: () => movePage(index, 1) },
      { label: 'Export page as PDF', icon: <FileDown size={17} />, onSelect: () => exportPdf([index]) },
      { label: 'Delete page', icon: <Trash2 size={17} />, danger: true, separator: true, onSelect: () => deletePage(index) },
    ]);
  };

  const exportPdf = async (indices?: number[]) => {
    await flush();
    const s = useEditor.getState();
    const ids = indices ? indices.map((i) => s.order[i]) : s.order;
    const title = s.notebook?.title ?? 'Notebook';
    await withBusy('Creating PDF…', async () => {
      const bytes = await exportPagesToPdf(
        ids.map((id) => s.pages[id]),
        title,
      );
      const suffix = indices?.length === 1 ? ` - page ${indices[0] + 1}` : '';
      await shareOrDownload(bytes, `${safeFilename(title)}${suffix}.pdf`, 'application/pdf');
    });
  };

  const shareMenu = (anchor: HTMLElement) =>
    openMenu(anchor, [
      { label: 'Export notebook as PDF', icon: <FileDown size={17} />, onSelect: () => exportPdf() },
      { label: 'Export current page', icon: <FileText size={17} />, onSelect: () => exportPdf([useEditor.getState().currentPage]) },
    ]);

  const setTemplate = (template: Template | null, paper: Paper | null, all: boolean) => {
    const s = useEditor.getState();
    const targets = all ? s.order : [s.order[s.currentPage]];
    for (const id of targets) {
      const p = useEditor.getState().pages[id];
      if (!p || p.pdf) continue;
      useEditor.getState().updatePage({ ...p, template: template ?? p.template, paper: paper ?? p.paper });
    }
  };

  const moreMenu = (anchor: HTMLElement) => {
    const s = useEditor.getState();
    const cur = s.pages[s.order[s.currentPage]];
    const fingerDraw = useTools.getState().fingerDraw;
    const items: MenuItem[] = [];
    if (cur && !cur.pdf) {
      for (const t of TEMPLATES)
        items.push({ label: `${TEMPLATE_LABELS[t]} paper`, icon: <LayoutTemplate size={17} />, checked: cur.template === t, onSelect: () => setTemplate(t, null, false) });
      items.push({ label: 'White paper', checked: cur.paper === 'white', separator: true, onSelect: () => setTemplate(null, 'white', false) });
      items.push({ label: 'Cream paper', checked: cur.paper === 'cream', onSelect: () => setTemplate(null, 'cream', false) });
      items.push({ label: 'Use this style for all pages', onSelect: () => setTemplate(cur.template, cur.paper, true) });
    }
    items.push({
      label: fingerDraw ? 'Finger draws (on)' : 'Draw with finger',
      icon: <Hand size={17} />,
      checked: fingerDraw,
      separator: items.length > 0,
      onSelect: () => useTools.getState().set({ fingerDraw: !fingerDraw }),
    });
    items.push({ label: 'Fit to width', icon: <Maximize size={17} />, onSelect: () => fitWidth() });
    items.push({ label: 'Delete current page', icon: <Trash2 size={17} />, danger: true, separator: true, onSelect: () => deletePage(s.currentPage) });
    openMenu(anchor, items);
  };

  const fitWidth = () => {
    const el = scroller.current;
    if (!el) return;
    const a = contentToPage(layoutRef.current, el.scrollLeft, el.scrollTop + el.clientHeight / 2);
    pendingAnchor.current = { index: a.index, u: 0, v: a.v, sx: 0, sy: el.clientHeight / 2 };
    setZoom(1);
  };

  const rename = async () => {
    const t = await askText('Rename notebook', notebook?.title ?? '');
    if (t !== null) useEditor.getState().setTitle(t);
  };

  const back = () => {
    const folderId = useLibrary.getState().notebooks[notebookId]?.folderId ?? null;
    navigate({ name: 'library', folderId });
  };

  if (status === 'missing')
    return (
      <div className="splash">
        <p>This notebook no longer exists.</p>
        <button className="btn btn-primary" onClick={() => navigate({ name: 'library', folderId: null })}>
          Back to library
        </button>
      </div>
    );

  return (
    <div className="editor">
      <Toolbar
        title={notebook?.title ?? ''}
        onBack={back}
        onRename={rename}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onAddPage={(a) => addPageMenu(a)}
        onShare={shareMenu}
        onMore={moreMenu}
      />
      <div className="editor-body">
        {sidebarOpen && status === 'ready' && <PageSidebar onPageMenu={pageMenu} onAddPage={(a) => addPageMenu(a, useEditor.getState().order.length - 1)} />}
        <div className="scroller" ref={scroller} onScroll={updateRange}>
          {status === 'ready' && (
            <div ref={content} className="scroll-content" style={{ width: layout.contentW, height: layout.contentH }}>
              {pages.slice(range[0], range[1] + 1).map((p, k) => {
                const i = range[0] + k;
                if (i >= layout.tops.length) return null;
                return (
                  <PageView
                    key={p.id}
                    pageId={p.id}
                    index={i}
                    left={layout.lefts[i]}
                    top={layout.tops[i]}
                    width={layout.widths[i]}
                    height={layout.heights[i]}
                    scale={layout.scale}
                  />
                );
              })}
            </div>
          )}
        </div>
        {status === 'ready' && (
          <div className="page-indicator">
            {currentPage + 1} / {order.length}
          </div>
        )}
      </div>
    </div>
  );
}
