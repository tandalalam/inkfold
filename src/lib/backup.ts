import { strFromU8, strToU8, unzip, zip } from 'fflate';
import { db } from './db';
import type { Folder, Notebook, Page } from './types';

interface Manifest {
  app: 'inkfold';
  version: 1;
  exportedAt: number;
  folders: Folder[];
  notebooks: Notebook[];
  pages: Page[];
  files: { id: string; name: string }[];
}

/** Packs the whole library (including PDFs) into a single .zip. */
export async function createBackup(): Promise<Uint8Array> {
  const [folders, notebooks, pages, files] = await Promise.all([db.allFolders(), db.allNotebooks(), db.allPages(), db.allFiles()]);
  const manifest: Manifest = {
    app: 'inkfold',
    version: 1,
    exportedAt: Date.now(),
    folders,
    notebooks,
    pages,
    files: files.map((f) => ({ id: f.id, name: f.name })),
  };
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    'library.json': strToU8(JSON.stringify(manifest)),
  };
  // PDFs are already compressed; store them as-is.
  for (const f of files) entries[`files/${f.id}.pdf`] = [new Uint8Array(f.data), { level: 0 }];
  return new Promise((resolve, reject) => zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))));
}

/** Restores a backup, merging into the current library (same ids are overwritten). */
export async function restoreBackup(data: Uint8Array): Promise<{ notebooks: number; folders: number }> {
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(data, (err, d) => (err ? reject(err) : resolve(d))));
  const raw = files['library.json'];
  if (!raw) throw new Error('This file is not an Inkfold backup.');
  const m = JSON.parse(strFromU8(raw)) as Manifest;
  if (m.app !== 'inkfold') throw new Error('This file is not an Inkfold backup.');
  for (const f of m.files) {
    const bytes = files[`files/${f.id}.pdf`];
    if (bytes) await db.putFiles([{ id: f.id, name: f.name, data: bytes.slice().buffer }]);
  }
  await db.putPages(m.pages);
  await db.putFolders(m.folders);
  await db.putNotebooks(m.notebooks);
  return { notebooks: m.notebooks.length, folders: m.folders.length };
}
