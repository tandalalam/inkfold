import { create } from 'zustand';
import type { AskClip, AskRecord, Page, Rect } from '../lib/types';
import { db, uid } from '../lib/db';
import { clampRect, unionBounds, unionRects } from '../lib/geometry';
import { toast } from '../ui/overlay';
import { useEditor, type Selection } from '../editor/store';
import { askApi, type AskPayload, type ThreadInfo } from './api';
import { pdfName, pdfTextInRect, renderClip } from './clip';

/** A clip waiting in the composer, with everything needed to send it. */
export interface TrayClip extends AskClip {
  png: string;
  text: string;
  /** page number shown to the assistant (PDF page if the page comes from a PDF) */
  page: number;
  document: string;
}

interface AskState {
  /** null = not probed yet; false = bridge unreachable (feature hidden) */
  available: boolean | null;
  thread: ThreadInfo | null;
  panelOpen: boolean;
  tray: TrayClip[];
  draft: string;
  detail: 'short' | 'long';
  asks: AskRecord[];
  loaded: boolean;
  focusId: string | null;
  scope: 'notebook' | 'all';
  set: (patch: Partial<AskState>) => void;
}

export const useAsk = create<AskState>((set) => ({
  available: null,
  thread: null,
  panelOpen: false,
  tray: [],
  draft: '',
  detail: 'short',
  asks: [],
  loaded: false,
  focusId: null,
  scope: 'notebook',
  set: (patch) => set(patch),
}));

const PENDING = new Set(['sending', 'queued', 'running', 'recovering']);
export const isPending = (a: AskRecord) => PENDING.has(a.status);

/* ---------------- availability ---------------- */

const ENABLED_KEY = 'inkfold.ask.enabled';

/**
 * The assistant is opt-in, so the public app never contacts the private bridge
 * for other people. It is on by default only on the tailnet copy and in tests.
 */
export function askEnabled(): boolean {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    if (v !== null) return v === '1';
    return location.hostname.endsWith('.ts.net') || !!localStorage.getItem('inkfold.askApi');
  } catch {
    return false;
  }
}

export function setAskEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (!on) useAsk.setState({ available: false, panelOpen: false });
}

let probing: Promise<boolean> | null = null;

export function probeAsk(force = false): Promise<boolean> {
  if (!askEnabled()) {
    useAsk.setState({ available: false });
    return Promise.resolve(false);
  }
  const s = useAsk.getState();
  if (!force && s.available !== null) return Promise.resolve(s.available);
  if (probing) return probing;
  probing = askApi
    .status()
    .then((r) => {
      useAsk.setState({ available: !!r.ok, thread: r.thread ?? null });
      if (r.ok) void loadAsks();
      return !!r.ok;
    })
    .catch(() => {
      // keep it visible if it worked before (a flaky network shouldn't hide history)
      if (useAsk.getState().available !== true) useAsk.setState({ available: false });
      return false;
    })
    .finally(() => (probing = null));
  return probing;
}

export async function loadAsks() {
  if (useAsk.getState().loaded) return;
  const all = await db.allAsks();
  all.sort((a, b) => a.createdAt - b.createdAt);
  useAsk.setState({ asks: all, loaded: true });
  if (all.some(isPending)) startPolling();
}

function saveAsk(a: AskRecord) {
  useAsk.setState((s) => ({ asks: s.asks.some((x) => x.id === a.id) ? s.asks.map((x) => (x.id === a.id ? a : x)) : [...s.asks, a] }));
  void db.putAsks([a]);
}

/* ---------------- tray ---------------- */

/** The region an ask should show for a selection: what was circled plus the selected ink. */
export function selectionRect(page: Page, sel: Selection): Rect | null {
  const ids = new Set(sel.ids);
  const ink = unionBounds(page.strokes.filter((s) => ids.has(s.id)));
  let r = sel.area ?? null;
  if (ink) r = r ? unionRects(r, ink) : ink;
  if (!r) return null;
  const pad = 4;
  return clampRect({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }, page.width, page.height);
}

export async function addSelectionToAsk(sel: Selection) {
  const ed = useEditor.getState();
  const page = ed.pages[sel.pageId];
  if (!page) return;
  const rect = selectionRect(page, sel);
  if (!rect) return;
  const pageIndex = ed.order.indexOf(page.id);
  const [{ png, thumb }, text, docName] = await Promise.all([renderClip(page, rect), pdfTextInRect(page, rect), pdfName(page)]);
  const clip: TrayClip = {
    pageId: page.id,
    pageIndex,
    rect,
    thumb,
    png,
    text,
    page: page.pdf ? page.pdf.index + 1 : pageIndex + 1,
    document: docName || ed.notebook?.title || '',
  };
  const s = useAsk.getState();
  if (s.tray.length >= 8) {
    toast('Up to 8 selections per question', true);
    return;
  }
  useAsk.setState({ tray: [...s.tray, clip], panelOpen: true, focusId: null });
  ed.select(null);
}

export function removeTrayClip(i: number) {
  useAsk.setState((s) => ({ tray: s.tray.filter((_, j) => j !== i) }));
}

/* ---------------- sending ---------------- */

const pngCache = new Map<string, TrayClip[]>();

async function post(rec: AskRecord, clips: TrayClip[]) {
  const payload: AskPayload = {
    askId: rec.id,
    question: rec.question,
    detail: rec.detail,
    context: { notebook: rec.notebookTitle },
    clips: clips.map((c) => ({ image: c.png, page: c.page, document: c.document, text: c.text })),
  };
  try {
    const r = await askApi.send(payload);
    useAsk.setState({ thread: r.thread ?? useAsk.getState().thread, available: true });
    applyRemote(rec.id, r.ask);
    pngCache.delete(rec.id);
  } catch (e) {
    const offline = e instanceof TypeError || (e as Error).name === 'AbortError';
    saveAsk({
      ...rec,
      status: 'failed',
      error: offline ? 'Could not reach the assistant. Is Tailscale on?' : String((e as Error).message || e),
      updatedAt: Date.now(),
    });
  }
}

export async function sendAsk() {
  const s = useAsk.getState();
  const ed = useEditor.getState();
  const nb = ed.notebook;
  if (!nb) return;
  const question = s.draft.trim();
  if (!question && !s.tray.length) {
    toast('Circle something with the lasso, or type a question', true);
    return;
  }
  const clips = s.tray;
  const rec: AskRecord = {
    id: uid(),
    notebookId: nb.id,
    notebookTitle: nb.title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    question,
    detail: s.detail,
    clips: clips.map(({ pageId, pageIndex, rect, thumb }) => ({ pageId, pageIndex, rect, thumb })),
    status: 'sending',
    progress: [],
  };
  pngCache.set(rec.id, clips);
  saveAsk(rec);
  useAsk.setState({ tray: [], draft: '', focusId: rec.id });
  await post(rec, clips);
  startPolling();
}

/** Re-sends a failed ask (same id, so the bridge won't post it twice). */
export async function retryAsk(id: string) {
  const rec = useAsk.getState().asks.find((a) => a.id === id);
  if (!rec) return;
  let clips = pngCache.get(id);
  if (!clips) {
    // Re-render the clips from the notebook.
    const pages = rec.notebookId === useEditor.getState().notebook?.id ? useEditor.getState().pages : Object.fromEntries((await db.pagesOf(rec.notebookId)).map((p) => [p.id, p]));
    clips = [];
    for (const c of rec.clips) {
      const page = pages[c.pageId];
      if (!page) continue;
      const [{ png }, text, docName] = await Promise.all([renderClip(page, c.rect), pdfTextInRect(page, c.rect), pdfName(page)]);
      clips.push({ ...c, png, text, page: page.pdf ? page.pdf.index + 1 : c.pageIndex + 1, document: docName || rec.notebookTitle });
    }
  }
  const next = { ...rec, status: 'sending' as const, error: null, updatedAt: Date.now() };
  saveAsk(next);
  await post(next, clips);
  startPolling();
}

export function deleteAsk(id: string) {
  useAsk.setState((s) => ({ asks: s.asks.filter((a) => a.id !== id) }));
  void db.deleteAsks([id]);
}

function applyRemote(id: string, r: { status: AskRecord['status']; progress: string[]; answer: string | null; error: string | null }) {
  const rec = useAsk.getState().asks.find((a) => a.id === id);
  if (!rec) return;
  if (rec.status === r.status && rec.answer === r.answer && (rec.progress ?? []).join('\u0000') === r.progress.join('\u0000')) return;
  saveAsk({ ...rec, status: r.status, progress: r.progress, answer: r.answer, error: r.error, updatedAt: Date.now() });
}

/* ---------------- polling ---------------- */

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    pollTimer = null;
    const pending = useAsk.getState().asks.filter(isPending);
    if (!pending.length) {
      // One last look so the thread's busy flag clears once the bridge has caught up.
      setTimeout(() => void probeAsk(true), 8000);
      return;
    }
    if (document.visibilityState === 'visible') {
      try {
        const r = await askApi.poll(pending.map((a) => a.id));
        useAsk.setState({ thread: r.thread ?? useAsk.getState().thread, available: true });
        for (const remote of r.asks) applyRemote(remote.askId, remote);
      } catch {
        /* offline: try again later */
      }
    }
    pollTimer = setTimeout(tick, 3000);
  };
  pollTimer = setTimeout(tick, 1500);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (useAsk.getState().available !== true && askEnabled()) void probeAsk(true);
  if (useAsk.getState().asks.some(isPending)) startPolling();
});

/* ---------------- navigation ---------------- */

/** Scrolls to a clip of an ask in the open notebook and highlights it. */
export function revealClip(c: AskClip) {
  const ed = useEditor.getState();
  const i = ed.order.indexOf(c.pageId);
  if (i < 0) {
    toast('That page is no longer in this notebook', true);
    return;
  }
  ed.scrollToPage(i, c.rect.y + c.rect.h / 2);
  setTimeout(() => useEditor.getState().flashRect(c.pageId, c.rect), 250);
}
