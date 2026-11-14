import { create } from 'zustand';
import type { Notebook, Page, Stroke } from '../lib/types';
import { db } from '../lib/db';
import { deletePagesAndOrphans, useLibrary } from '../lib/library';
import { renderThumbnail } from '../lib/thumbnails';

type HistoryEntry =
  | { kind: 'strokes'; pageId: string; before: Stroke[]; after: Stroke[] }
  | { kind: 'order'; before: string[]; after: string[] }
  | { kind: 'page'; pageId: string; before: Page; after: Page };

export interface Selection {
  pageId: string;
  ids: string[];
  dx: number;
  dy: number;
}

interface EditorState {
  notebook: Notebook | null;
  pages: Record<string, Page>;
  order: string[];
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  selection: Selection | null;
  currentPage: number;
  /** bumps when pages should scroll into view: [index, nonce] */
  scrollRequest: [number, number] | null;
  open: (id: string) => Promise<boolean>;
  close: () => Promise<void>;
  setStrokes: (pageId: string, strokes: Stroke[], record?: boolean, before?: Stroke[]) => void;
  setOrder: (order: string[], newPages?: Page[]) => void;
  updatePage: (page: Page) => void;
  undo: () => void;
  redo: () => void;
  select: (sel: Selection | null) => void;
  setTitle: (title: string) => void;
  setCurrentPage: (i: number) => void;
  scrollToPage: (i: number) => void;
}

const dirtyPages = new Set<string>();
let notebookDirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** page ids that were in the notebook when opened or were added later */
const knownPages = new Set<string>();
let firstPageAtOpen: string | null = null;
let coverDirty = false;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), 700);
}

let flushing: Promise<void> = Promise.resolve();

/** Writes pending changes to IndexedDB. */
export function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  flushing = flushing.then(async () => {
    const s = useEditor.getState();
    const nb = s.notebook;
    if (!nb) return;
    const pages = [...dirtyPages].filter((id) => s.order.includes(id)).map((id) => s.pages[id]);
    dirtyPages.clear();
    const save = notebookDirty || pages.length > 0;
    notebookDirty = false;
    if (!save) return;
    const cover = nb.cover ?? useLibrary.getState().notebooks[nb.id]?.cover;
    const updated: Notebook = { ...nb, cover, coverStale: coverDirty || nb.coverStale, pageIds: s.order, updatedAt: Date.now() };
    await db.putPages(pages);
    await db.putNotebooks([updated]);
    useEditor.setState({ notebook: updated });
    useLibrary.getState().patchNotebook(updated);
  });
  return flushing;
}

let coverTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCover() {
  if (coverTimer) clearTimeout(coverTimer);
  coverTimer = setTimeout(() => void updateCover(), 2500);
}

/** Re-renders the notebook cover from the first page and saves it. */
async function updateCover(): Promise<void> {
  if (coverTimer) clearTimeout(coverTimer);
  coverTimer = null;
  if (!coverDirty) return;
  coverDirty = false;
  const s = useEditor.getState();
  const first = s.pages[s.order[0]];
  if (!first || !s.notebook) return;
  try {
    const cover = await renderThumbnail(first, 260);
    await flushing;
    const nb = useEditor.getState().notebook;
    if (!nb || nb.id !== s.notebook.id) return;
    const updated = { ...nb, cover, coverStale: false };
    useEditor.setState({ notebook: updated });
    await db.putNotebooks([updated]);
    useLibrary.getState().patchNotebook(updated);
  } catch (e) {
    console.warn('cover render failed', e);
  }
}

function markDirty(pageId?: string) {
  if (pageId) {
    dirtyPages.add(pageId);
    if (pageId === useEditor.getState().order[0]) {
      coverDirty = true;
      scheduleCover();
    }
  }
  notebookDirty = true;
  scheduleSave();
}

function applyEntry(e: HistoryEntry, dir: 'undo' | 'redo') {
  const s = useEditor.getState();
  if (e.kind === 'strokes') {
    const page = s.pages[e.pageId];
    if (!page) return;
    useEditor.setState({ pages: { ...s.pages, [e.pageId]: { ...page, strokes: dir === 'undo' ? e.before : e.after } }, selection: null });
    markDirty(e.pageId);
  } else if (e.kind === 'page') {
    const p = dir === 'undo' ? e.before : e.after;
    useEditor.setState({ pages: { ...s.pages, [p.id]: p } });
    markDirty(p.id);
  } else {
    const order = dir === 'undo' ? e.before : e.after;
    useEditor.setState({ order, selection: null, currentPage: Math.min(s.currentPage, order.length - 1) });
    for (const id of order) if (!s.order.includes(id)) dirtyPages.add(id);
    coverDirty = true;
    scheduleCover();
    markDirty();
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  notebook: null,
  pages: {},
  order: [],
  undoStack: [],
  redoStack: [],
  selection: null,
  currentPage: 0,
  scrollRequest: null,

  open: async (id) => {
    const nb = await db.getNotebook(id);
    if (!nb) return false;
    const pages = await db.pagesOf(id);
    const map = Object.fromEntries(pages.map((p) => [p.id, p]));
    const order = nb.pageIds.filter((pid) => map[pid]);
    knownPages.clear();
    for (const p of pages) knownPages.add(p.id);
    dirtyPages.clear();
    notebookDirty = false;
    firstPageAtOpen = order[0] ?? null;
    coverDirty = !nb.cover || !!nb.coverStale;
    set({ notebook: nb, pages: map, order, undoStack: [], redoStack: [], selection: null, currentPage: 0, scrollRequest: null });
    return true;
  },

  close: async () => {
    await flush();
    const s = get();
    const nb = s.notebook;
    if (!nb) return;
    // Delete pages removed during this session.
    const removed = [...knownPages].filter((id) => !s.order.includes(id)).map((id) => s.pages[id]).filter(Boolean);
    if (removed.length) await deletePagesAndOrphans(removed);
    // Refresh the cover thumbnail.
    if (s.order[0] !== firstPageAtOpen) coverDirty = true;
    await updateCover();
    set({ notebook: null, pages: {}, order: [], undoStack: [], redoStack: [], selection: null });
  },

  setStrokes: (pageId, strokes, record = true, before) => {
    const s = get();
    const page = s.pages[pageId];
    if (!page) return;
    const prev = before ?? page.strokes;
    set({
      pages: { ...s.pages, [pageId]: { ...page, strokes } },
      ...(record ? { undoStack: [...s.undoStack.slice(-199), { kind: 'strokes' as const, pageId, before: prev, after: strokes }], redoStack: [] } : {}),
    });
    markDirty(pageId);
  },

  setOrder: (order, newPages = []) => {
    const s = get();
    const pages = { ...s.pages };
    for (const p of newPages) {
      pages[p.id] = p;
      knownPages.add(p.id);
      dirtyPages.add(p.id);
    }
    set({
      pages,
      order,
      selection: null,
      undoStack: [...s.undoStack.slice(-199), { kind: 'order', before: s.order, after: order }],
      redoStack: [],
    });
    coverDirty = true;
    scheduleCover();
    markDirty();
  },

  updatePage: (page) => {
    const s = get();
    const before = s.pages[page.id];
    set({
      pages: { ...s.pages, [page.id]: page },
      undoStack: [...s.undoStack.slice(-199), { kind: 'page', pageId: page.id, before, after: page }],
      redoStack: [],
    });
    markDirty(page.id);
  },

  undo: () => {
    const s = get();
    const e = s.undoStack[s.undoStack.length - 1];
    if (!e) return;
    set({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, e] });
    applyEntry(e, 'undo');
  },

  redo: () => {
    const s = get();
    const e = s.redoStack[s.redoStack.length - 1];
    if (!e) return;
    set({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, e] });
    applyEntry(e, 'redo');
  },

  select: (selection) => set({ selection }),

  setTitle: (title) => {
    const nb = get().notebook;
    if (!nb) return;
    set({ notebook: { ...nb, title: title.trim() || 'Untitled Notebook' } });
    markDirty();
  },

  setCurrentPage: (i) => {
    if (get().currentPage !== i) set({ currentPage: i });
  },

  scrollToPage: (i) => set({ scrollRequest: [i, Math.random()] }),
}));

// Persist when the app is backgrounded (iPad may kill it without warning).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flush().then(() => updateCover());
});
window.addEventListener('pagehide', () => void flush());
