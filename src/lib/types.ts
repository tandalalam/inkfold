export type Template = 'blank' | 'lined' | 'grid' | 'dotted';
export type Paper = 'white' | 'cream';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface Notebook {
  id: string;
  title: string;
  folderId: string | null;
  pageIds: string[];
  createdAt: number;
  updatedAt: number;
  /** JPEG data URL of the first page. */
  cover?: string;
  /** first page changed since the cover was rendered */
  coverStale?: boolean;
}

export type ToolKind = 'pen' | 'hl';

/**
 * A single ink stroke. Coordinates are in page units (PDF points, origin
 * top-left). `pts` is a flat array: x0, y0, p0, x1, y1, p1, ...
 */
export interface Stroke {
  id: string;
  t: ToolKind;
  c: string;
  w: number;
  /** pen style: ballpoint or fountain (pressure sensitive) */
  s?: 'ball' | 'fountain';
  pts: number[];
}

export interface PdfRef {
  fileId: string;
  index: number;
  /** pdf.js viewport transform at scale 1 (PDF user space -> page units). */
  transform: number[];
}

export interface Page {
  id: string;
  notebookId: string;
  width: number;
  height: number;
  template: Template;
  paper: Paper;
  pdf?: PdfRef;
  /** duplicated from pdf.fileId so it can be indexed */
  fileId?: string;
  strokes: Stroke[];
}

export interface StoredFile {
  id: string;
  name: string;
  data: ArrayBuffer;
}

export const PAPER_SIZES = {
  'a4-portrait': { label: 'A4 Portrait', width: 595, height: 842 },
  'a4-landscape': { label: 'A4 Landscape', width: 842, height: 595 },
  'letter-portrait': { label: 'Letter Portrait', width: 612, height: 792 },
  'square': { label: 'Square', width: 700, height: 700 },
} as const;
export type PaperSizeKey = keyof typeof PAPER_SIZES;
