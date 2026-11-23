import { useMemo, useState } from 'react';
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileDown,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Library,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { askEnabled, setAskEnabled, probeAsk, useAsk } from '../ask/store';
import { useLibrary, folderPath } from '../lib/library';
import { navigate } from '../lib/router';
import type { Folder, Notebook } from '../lib/types';
import { askText, confirmAction, openMenu, toast, withBusy, setBusy } from '../ui/overlay';
import { openNewNotebookDialog, pickFolder } from './dialogs';
import { pickFiles, safeFilename, shareOrDownload } from '../lib/share';
import { db } from '../lib/db';
import { exportPagesToPdf } from '../lib/exportPdf';
import { createBackup, restoreBackup } from '../lib/backup';

type Sort = 'recent' | 'name';

function formatDate(t: number) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function FolderTree({ current }: { current: string | null }) {
  const folders = useLibrary((s) => s.folders);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('inkfold.collapsed') || '{}'));
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    localStorage.setItem('inkfold.collapsed', JSON.stringify(next));
  };
  const open = new Set(folderPath(folders, current).map((f) => f.id));
  const children = (parent: string | null) =>
    Object.values(folders)
      .filter((f) => f.parentId === parent)
      .sort((a, b) => a.name.localeCompare(b.name));
  const render = (parent: string | null, depth: number): React.ReactNode =>
    children(parent).map((f) => {
      const kids = children(f.id).length > 0;
      const isCollapsed = collapsed[f.id] && !open.has(f.id);
      return (
        <div key={f.id}>
          <div className={`tree-row ${current === f.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
            <button className="tree-caret" onClick={() => kids && toggle(f.id)} aria-label={isCollapsed ? 'Expand' : 'Collapse'} style={{ visibility: kids ? 'visible' : 'hidden' }}>
              {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            </button>
            <button className="tree-label" onClick={() => navigate({ name: 'library', folderId: f.id })}>
              <FolderIcon size={17} />
              <span dir="auto">{f.name}</span>
            </button>
          </div>
          {!isCollapsed && render(f.id, depth + 1)}
        </div>
      );
    });
  return (
    <nav className="folder-tree">
      <div className={`tree-row ${current === null ? 'active' : ''}`}>
        <button className="tree-label root" onClick={() => navigate({ name: 'library', folderId: null })}>
          <Library size={18} />
          <span>Library</span>
        </button>
      </div>
      {render(null, 1)}
    </nav>
  );
}

export function LibraryView({ folderId }: { folderId: string | null }) {
  const folders = useLibrary((s) => s.folders);
  const notebooks = useLibrary((s) => s.notebooks);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('inkfold.sort') as Sort) || 'recent');
  const lib = useLibrary.getState;

  const folder = folderId ? folders[folderId] : null;
  const path = folderPath(folders, folderId);
  const q = query.trim().toLowerCase();

  const { subfolders, items } = useMemo(() => {
    const sortNb = (a: Notebook, b: Notebook) => (sort === 'name' ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt);
    if (q) {
      return {
        subfolders: Object.values(folders).filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)),
        items: Object.values(notebooks).filter((n) => n.title.toLowerCase().includes(q)).sort(sortNb),
      };
    }
    return {
      subfolders: Object.values(folders)
        .filter((f) => f.parentId === folderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
      items: Object.values(notebooks)
        .filter((n) => n.folderId === folderId)
        .sort(sortNb),
    };
  }, [folders, notebooks, folderId, q, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of Object.values(folders)) if (f.parentId) c[f.parentId] = (c[f.parentId] ?? 0) + 1;
    for (const n of Object.values(notebooks)) if (n.folderId) c[n.folderId] = (c[n.folderId] ?? 0) + 1;
    return c;
  }, [folders, notebooks]);

  // If the folder was deleted (or bad link), go to the root.
  if (folderId && !folder) {
    queueMicrotask(() => navigate({ name: 'library', folderId: null }, true));
    return null;
  }

  const openNotebook = (id: string) => navigate({ name: 'notebook', id });

  const newFolder = async () => {
    const name = await askText('New folder', '', { placeholder: 'Folder name', okLabel: 'Create' });
    if (name !== null) await lib().createFolder(name, folderId);
  };

  const importPdf = async () => {
    const files = await pickFiles('application/pdf,.pdf', true);
    let last: string | null = null;
    for (const file of files) {
      await withBusy(`Importing ${file.name}…`, async () => {
        const nb = await lib().importPdf(file, folderId, (d, t) => setBusy(`Importing ${file.name}… ${d}/${t}`));
        last = nb.id;
      });
    }
    if (files.length === 1 && last) openNotebook(last);
    else if (files.length > 1) toast(`Imported ${files.length} PDFs`);
  };

  const newMenu = (anchor: HTMLElement) =>
    openMenu(anchor, [
      { label: 'Notebook', icon: <NotebookPen size={17} />, onSelect: () => openNewNotebookDialog(folderId, openNotebook) },
      { label: 'Import PDF', icon: <FileText size={17} />, onSelect: importPdf },
      { label: 'Folder', icon: <FolderPlus size={17} />, onSelect: newFolder },
    ]);

  const exportNotebook = async (nb: Notebook) => {
    await withBusy('Creating PDF…', async () => {
      const pages = await db.pagesOf(nb.id);
      const byId = new Map(pages.map((p) => [p.id, p]));
      const bytes = await exportPagesToPdf(nb.pageIds.map((id) => byId.get(id)!).filter(Boolean), nb.title);
      await shareOrDownload(bytes, `${safeFilename(nb.title)}.pdf`, 'application/pdf');
    });
  };

  const notebookMenu = (nb: Notebook, anchor: HTMLElement) =>
    openMenu(anchor, [
      {
        label: 'Rename',
        icon: <Pencil size={17} />,
        onSelect: async () => {
          const t = await askText('Rename notebook', nb.title);
          if (t !== null) await lib().renameNotebook(nb.id, t);
        },
      },
      {
        label: 'Move to…',
        icon: <FolderInput size={17} />,
        onSelect: async () => {
          const dest = await pickFolder(`Move “${nb.title}”`, nb.folderId);
          if (dest !== undefined) await lib().moveNotebook(nb.id, dest);
        },
      },
      { label: 'Duplicate', icon: <Copy size={17} />, onSelect: () => withBusy('Duplicating…', () => lib().duplicateNotebook(nb.id)) },
      { label: 'Export as PDF', icon: <FileDown size={17} />, onSelect: () => exportNotebook(nb) },
      {
        label: 'Delete',
        icon: <Trash2 size={17} />,
        danger: true,
        separator: true,
        onSelect: async () => {
          if (await confirmAction(`Delete “${nb.title}”?`, { message: 'This removes the notebook and its pages permanently.', okLabel: 'Delete', danger: true }))
            await lib().deleteNotebook(nb.id);
        },
      },
    ]);

  const folderMenu = (f: Folder, anchor: HTMLElement) =>
    openMenu(anchor, [
      {
        label: 'Rename',
        icon: <Pencil size={17} />,
        onSelect: async () => {
          const t = await askText('Rename folder', f.name);
          if (t !== null) await lib().renameFolder(f.id, t);
        },
      },
      {
        label: 'Move to…',
        icon: <FolderInput size={17} />,
        onSelect: async () => {
          const dest = await pickFolder(`Move “${f.name}”`, f.parentId, f.id);
          if (dest !== undefined) await withBusy('Moving…', () => lib().moveFolder(f.id, dest));
        },
      },
      {
        label: 'Delete',
        icon: <Trash2 size={17} />,
        danger: true,
        separator: true,
        onSelect: async () => {
          const n = counts[f.id] ?? 0;
          if (
            await confirmAction(`Delete folder “${f.name}”?`, {
              message: n ? 'Everything inside it (notebooks and subfolders) will be deleted permanently.' : undefined,
              okLabel: 'Delete',
              danger: true,
            })
          )
            await withBusy('Deleting…', () => lib().deleteFolder(f.id));
        },
      },
    ]);

  const settingsMenu = async (anchor: HTMLElement) => {
    let storageLine = '';
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      if (est?.usage !== undefined) storageLine = `${(est.usage / 1024 / 1024).toFixed(1)} MB used${persisted ? ' · protected' : ''}`;
    } catch {
      /* ignore */
    }
    openMenu(
      anchor,
      [
        {
          label: 'Back up library…',
          icon: <FileDown size={17} />,
          onSelect: () =>
            withBusy('Creating backup…', async () => {
              const data = await createBackup();
              const stamp = new Date().toISOString().slice(0, 10);
              await shareOrDownload(data, `Inkfold backup ${stamp}.zip`, 'application/zip');
            }),
        },
        {
          label: 'Restore from backup…',
          icon: <FolderInput size={17} />,
          onSelect: async () => {
            const [file] = await pickFiles('.zip,application/zip');
            if (!file) return;
            const res = await withBusy('Restoring…', async () => restoreBackup(new Uint8Array(await file.arrayBuffer())));
            if (res) {
              await lib().load();
              toast(`Restored ${res.notebooks} notebooks and ${res.folders} folders`);
            }
          },
        },
        {
          label: askEnabled() ? 'Assistant (Ask) is on' : 'Turn on assistant (Ask)…',
          icon: <Sparkles size={17} />,
          checked: askEnabled(),
          separator: true,
          onSelect: async () => {
            if (askEnabled()) {
              setAskEnabled(false);
              toast('Assistant turned off');
              return;
            }
            setAskEnabled(true);
            const ok = await probeAsk(true);
            if (ok) toast(`Connected to “${useAsk.getState().thread?.title ?? 'thread'}”`);
            else {
              setAskEnabled(false);
              toast('Could not reach the assistant. It only works on the owner’s tailnet.', true);
            }
          },
        },
      ],
      storageLine ? <div className="menu-header">{storageLine}</div> : undefined,
    );
  };

  const toggleSort = () => {
    const next: Sort = sort === 'recent' ? 'name' : 'recent';
    setSort(next);
    localStorage.setItem('inkfold.sort', next);
  };

  const empty = !subfolders.length && !items.length;

  return (
    <div className="library">
      <aside className="library-sidebar">
        <div className="brand">Inkfold</div>
        <FolderTree current={folderId} />
      </aside>
      <main className="library-main">
        <header className="library-header">
          <div className="crumbs">
            {folderId && (
              <button className="crumb" onClick={() => navigate({ name: 'library', folderId: folder?.parentId ?? null })} aria-label="Up one level">
                <ChevronRight size={18} style={{ transform: 'rotate(180deg)' }} />
              </button>
            )}
            <button className="crumb" onClick={() => navigate({ name: 'library', folderId: null })}>
              Library
            </button>
            {path.map((f) => (
              <span key={f.id} className="crumb-wrap">
                <ChevronRight size={16} className="crumb-sep" />
                <button className="crumb" dir="auto" onClick={() => navigate({ name: 'library', folderId: f.id })}>
                  {f.name}
                </button>
              </span>
            ))}
          </div>
          <div className="header-actions">
            <label className="search">
              <Search size={17} />
              <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} dir="auto" />
              {query && (
                <button className="icon-btn tiny" onClick={() => setQuery('')} aria-label="Clear search">
                  <X size={15} />
                </button>
              )}
            </label>
            <button className="icon-btn" onClick={toggleSort} aria-label={sort === 'recent' ? 'Sorted by date' : 'Sorted by name'} title={sort === 'recent' ? 'Sorted by date' : 'Sorted by name'}>
              {sort === 'recent' ? <Clock size={20} /> : <ArrowDownAZ size={20} />}
            </button>
            <button className="icon-btn" onClick={(e) => settingsMenu(e.currentTarget)} aria-label="Settings">
              <Settings size={20} />
            </button>
            <button className="btn btn-primary new-btn" onClick={(e) => newMenu(e.currentTarget)}>
              <Plus size={18} /> New
            </button>
          </div>
        </header>

        <h1 className="folder-title" dir="auto">
          {q ? `Results for “${query.trim()}”` : folder?.name ?? 'Library'}
        </h1>

        {empty ? (
          <div className="empty">
            {q ? (
              <p>Nothing matches your search.</p>
            ) : (
              <>
                <NotebookPen size={44} strokeWidth={1.4} />
                <p>{folderId ? 'This folder is empty.' : 'Welcome! Create a notebook or import a PDF to get started.'}</p>
                <div className="empty-actions">
                  <button className="btn btn-primary" onClick={() => openNewNotebookDialog(folderId, openNotebook)}>
                    <NotebookPen size={17} /> New notebook
                  </button>
                  <button className="btn" onClick={importPdf}>
                    <FileText size={17} /> Import PDF
                  </button>
                  <button className="btn" onClick={newFolder}>
                    <FolderPlus size={17} /> New folder
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid">
            {subfolders.map((f) => (
              <div key={f.id} className="card folder-card">
                <button className="card-hit" onClick={() => navigate({ name: 'library', folderId: f.id })}>
                  <div className="folder-art">
                    <FolderIcon size={64} strokeWidth={1.2} />
                  </div>
                </button>
                <div className="card-meta">
                  <div className="card-text">
                    <div className="card-title" dir="auto">
                      {f.name}
                    </div>
                    <div className="card-sub">{q ? folderPath(folders, f.parentId).map((p) => p.name).join(' › ') || 'Library' : `${counts[f.id] ?? 0} items`}</div>
                  </div>
                  <button className="icon-btn tiny" onClick={(e) => folderMenu(f, e.currentTarget)} aria-label={`${f.name} options`}>
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              </div>
            ))}
            {items.map((nb) => (
              <div key={nb.id} className="card notebook-card">
                <button className="card-hit" onClick={() => openNotebook(nb.id)} aria-label={`Open ${nb.title}`}>
                  <div className="cover">{nb.cover ? <img src={nb.cover} alt="" draggable={false} /> : <div className="cover-blank" />}</div>
                </button>
                <div className="card-meta">
                  <div className="card-text">
                    <div className="card-title" dir="auto">
                      {nb.title}
                    </div>
                    <div className="card-sub">
                      {q && nb.folderId ? `${folders[nb.folderId]?.name ?? ''} · ` : ''}
                      {formatDate(nb.updatedAt)} · {nb.pageIds.length} {nb.pageIds.length === 1 ? 'page' : 'pages'}
                    </div>
                  </div>
                  <button className="icon-btn tiny" onClick={(e) => notebookMenu(nb, e.currentTarget)} aria-label={`${nb.title} options`}>
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
