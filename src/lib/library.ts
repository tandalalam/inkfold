import { create } from 'zustand';
import { db, uid } from './db';
import type { Folder, Notebook, Page, Paper, PaperSizeKey, Template } from './types';
import { PAPER_SIZES } from './types';
import { destroyPdf, openPdf, readPdfPages } from './pdf';
import { renderThumbnail } from './thumbnails';

interface LibraryState {
  loaded: boolean;
  folders: Record<string, Folder>;
  notebooks: Record<string, Notebook>;
  load: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createNotebook: (opts: NewNotebookOptions) => Promise<Notebook>;
  importPdf: (file: File, folderId: string | null, onProgress?: (d: number, t: number) => void) => Promise<Notebook>;
  renameNotebook: (id: string, title: string) => Promise<void>;
  moveNotebook: (id: string, folderId: string | null) => Promise<void>;
  duplicateNotebook: (id: string) => Promise<Notebook>;
  deleteNotebook: (id: string) => Promise<void>;
  /** Called by the editor when it saves. */
  patchNotebook: (nb: Notebook) => void;
}

export interface NewNotebookOptions {
  title: string;
  folderId: string | null;
  template: Template;
  paper: Paper;
  size: PaperSizeKey;
  pages?: number;
}

export function blankPage(notebookId: string, template: Template, paper: Paper, width: number, height: number): Page {
  return { id: uid(), notebookId, width, height, template, paper, strokes: [] };
}

/** Folder ids of `id` and all its descendants. */
export function descendantFolderIds(folders: Record<string, Folder>, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const f of Object.values(folders)) if (f.parentId === out[i]) out.push(f.id);
  }
  return out;
}

export function folderPath(folders: Record<string, Folder>, id: string | null): Folder[] {
  const path: Folder[] = [];
  let cur = id ? folders[id] : undefined;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? folders[cur.parentId] : undefined;
  }
  return path;
}

/** Deletes pages and any PDF files no longer referenced by another page. */
async function deletePagesAndOrphans(pages: Page[]) {
  const fileIds = [...new Set(pages.map((p) => p.fileId).filter(Boolean) as string[])];
  await db.deletePages(pages.map((p) => p.id));
  const orphans: string[] = [];
  for (const f of fileIds) if ((await db.fileUseCount(f)) === 0) orphans.push(f);
  await db.deleteFiles(orphans);
}

/** Renders and stores the cover thumbnail in the background. */
function generateCover(nb: Notebook, first: Page | undefined) {
  if (!first) return;
  renderThumbnail(first, 260)
    .then(async (cover) => {
      const latest = useLibrary.getState().notebooks[nb.id];
      if (!latest || latest.cover) return;
      const updated = { ...latest, cover };
      await db.putNotebooks([updated]);
      useLibrary.getState().patchNotebook(updated);
    })
    .catch((e) => console.warn('cover failed', e));
}

export const useLibrary = create<LibraryState>((set, get) => ({
  loaded: false,
  folders: {},
  notebooks: {},

  load: async () => {
    const [folders, notebooks] = await Promise.all([db.allFolders(), db.allNotebooks()]);
    set({
      loaded: true,
      folders: Object.fromEntries(folders.map((f) => [f.id, f])),
      notebooks: Object.fromEntries(notebooks.map((n) => [n.id, n])),
    });
    // Repair covers that went stale (e.g. the app was closed mid-edit).
    for (const nb of notebooks.filter((n) => n.coverStale || !n.cover)) {
      const pages = await db.pagesOf(nb.id);
      const first = pages.find((p) => p.id === nb.pageIds[0]);
      if (!first) continue;
      try {
        const cover = await renderThumbnail(first, 260);
        const latest = get().notebooks[nb.id];
        if (!latest) continue;
        const updated = { ...latest, cover, coverStale: false };
        await db.putNotebooks([updated]);
        get().patchNotebook(updated);
      } catch (e) {
        console.warn('cover repair failed', e);
      }
    }
  },

  createFolder: async (name, parentId) => {
    const f: Folder = { id: uid(), name: name.trim() || 'Untitled Folder', parentId, createdAt: Date.now() };
    await db.putFolders([f]);
    set((s) => ({ folders: { ...s.folders, [f.id]: f } }));
    return f;
  },

  renameFolder: async (id, name) => {
    const f = { ...get().folders[id], name: name.trim() || 'Untitled Folder' };
    await db.putFolders([f]);
    set((s) => ({ folders: { ...s.folders, [id]: f } }));
  },

  moveFolder: async (id, parentId) => {
    const { folders } = get();
    if (parentId && descendantFolderIds(folders, id).includes(parentId)) throw new Error("A folder can't be moved into itself.");
    const f = { ...folders[id], parentId };
    await db.putFolders([f]);
    set((s) => ({ folders: { ...s.folders, [id]: f } }));
  },

  deleteFolder: async (id) => {
    const { folders, notebooks } = get();
    const ids = new Set(descendantFolderIds(folders, id));
    const nbs = Object.values(notebooks).filter((n) => n.folderId && ids.has(n.folderId));
    for (const nb of nbs) await get().deleteNotebook(nb.id);
    await db.deleteFolders([...ids]);
    set((s) => {
      const next = { ...s.folders };
      for (const i of ids) delete next[i];
      return { folders: next };
    });
  },

  createNotebook: async ({ title, folderId, template, paper, size, pages = 1 }) => {
    const { width, height } = PAPER_SIZES[size];
    const id = uid();
    const pageList = Array.from({ length: pages }, () => blankPage(id, template, paper, width, height));
    const now = Date.now();
    const nb: Notebook = { id, title: title.trim() || 'Untitled Notebook', folderId, pageIds: pageList.map((p) => p.id), createdAt: now, updatedAt: now };
    await db.putPages(pageList);
    await db.putNotebooks([nb]);
    set((s) => ({ notebooks: { ...s.notebooks, [id]: nb } }));
    generateCover(nb, pageList[0]);
    return nb;
  },

  importPdf: async (file, folderId, onProgress) => {
    const bytes = await file.arrayBuffer();
    const doc = await openPdf(bytes);
    try {
      const infos = await readPdfPages(doc, onProgress);
      const fileId = uid();
      const id = uid();
      const pages: Page[] = infos.map((info) => ({
        id: uid(),
        notebookId: id,
        width: info.width,
        height: info.height,
        template: 'blank',
        paper: 'white',
        pdf: { fileId, index: info.index, transform: info.transform },
        fileId,
        strokes: [],
      }));
      const now = Date.now();
      const nb: Notebook = {
        id,
        title: file.name.replace(/\.pdf$/i, '') || 'Untitled PDF',
        folderId,
        pageIds: pages.map((p) => p.id),
        createdAt: now,
        updatedAt: now,
      };
      await db.putFiles([{ id: fileId, name: file.name, data: bytes }]);
      await db.putPages(pages);
      await db.putNotebooks([nb]);
      set((s) => ({ notebooks: { ...s.notebooks, [id]: nb } }));
      generateCover(nb, pages[0]);
      return nb;
    } finally {
      destroyPdf(doc);
    }
  },

  renameNotebook: async (id, title) => {
    const nb = { ...get().notebooks[id], title: title.trim() || 'Untitled Notebook', updatedAt: Date.now() };
    await db.putNotebooks([nb]);
    set((s) => ({ notebooks: { ...s.notebooks, [id]: nb } }));
  },

  moveNotebook: async (id, folderId) => {
    const nb = { ...get().notebooks[id], folderId };
    await db.putNotebooks([nb]);
    set((s) => ({ notebooks: { ...s.notebooks, [id]: nb } }));
  },

  duplicateNotebook: async (id) => {
    const src = get().notebooks[id];
    const pages = await db.pagesOf(id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const newId = uid();
    const copies: Page[] = src.pageIds.map((pid) => byId.get(pid)).filter(Boolean).map((p) => ({ ...p!, id: uid(), notebookId: newId }));
    const now = Date.now();
    const nb: Notebook = { ...src, id: newId, title: `${src.title} copy`, pageIds: copies.map((p) => p.id), createdAt: now, updatedAt: now };
    await db.putPages(copies);
    await db.putNotebooks([nb]);
    set((s) => ({ notebooks: { ...s.notebooks, [newId]: nb } }));
    return nb;
  },

  deleteNotebook: async (id) => {
    const pages = await db.pagesOf(id);
    await deletePagesAndOrphans(pages);
    await db.deleteNotebooks([id]);
    set((s) => {
      const next = { ...s.notebooks };
      delete next[id];
      return { notebooks: next };
    });
  },

  patchNotebook: (nb) => set((s) => ({ notebooks: { ...s.notebooks, [nb.id]: nb } })),
}));

export { deletePagesAndOrphans };
