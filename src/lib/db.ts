import type { AskRecord, Folder, Notebook, Page, StoredFile } from './types';

const DB_NAME = 'inkfold';
const DB_VERSION = 2;

type StoreName = 'folders' | 'notebooks' | 'pages' | 'files' | 'asks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('notebookId', 'notebookId');
        pages.createIndex('fileId', 'fileId');
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('asks')) db.createObjectStore('asks', { keyPath: 'id' }).createIndex('notebookId', 'notebookId');
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema, let go of this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
}

async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).get(id) as IDBRequest<T | undefined>);
}

async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return txDone(tx);
}

async function deleteMany(store: StoreName, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const id of ids) os.delete(id);
  return txDone(tx);
}

async function getAllByIndex<T>(store: StoreName, index: string, key: string): Promise<T[]> {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).index(index).getAll(key) as IDBRequest<T[]>);
}

async function countByIndex(store: StoreName, index: string, key: string): Promise<number> {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).index(index).count(key));
}

export const db = {
  allFolders: () => getAll<Folder>('folders'),
  allNotebooks: () => getAll<Notebook>('notebooks'),
  allPages: () => getAll<Page>('pages'),
  allFiles: () => getAll<StoredFile>('files'),
  putFolders: (f: Folder[]) => putMany('folders', f),
  deleteFolders: (ids: string[]) => deleteMany('folders', ids),
  getNotebook: (id: string) => get<Notebook>('notebooks', id),
  putNotebooks: (n: Notebook[]) => putMany('notebooks', n),
  deleteNotebooks: (ids: string[]) => deleteMany('notebooks', ids),
  pagesOf: (notebookId: string) => getAllByIndex<Page>('pages', 'notebookId', notebookId),
  putPages: (p: Page[]) => putMany('pages', p),
  deletePages: (ids: string[]) => deleteMany('pages', ids),
  getFile: (id: string) => get<StoredFile>('files', id),
  putFiles: (f: StoredFile[]) => putMany('files', f),
  deleteFiles: (ids: string[]) => deleteMany('files', ids),
  fileUseCount: (fileId: string) => countByIndex('pages', 'fileId', fileId),
  allAsks: () => getAll<AskRecord>('asks'),
  putAsks: (a: AskRecord[]) => putMany('asks', a),
  deleteAsks: (ids: string[]) => deleteMany('asks', ids),
};

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
