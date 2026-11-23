import { create } from 'zustand';
import type { Stroke } from '../lib/types';
import { translateStroke, unionBounds } from '../lib/geometry';
import { uid } from '../lib/db';
import { useEditor } from './store';
import { toast } from '../ui/overlay';

/**
 * In-app clipboard for ink. Strokes are stored relative to their bounding box
 * so they can be pasted anywhere, on any page of any notebook. It is kept in
 * localStorage so it survives switching notebooks and relaunching the app.
 */
interface Clip {
  strokes: Stroke[];
  w: number;
  h: number;
}

const KEY = 'inkfold.clipboard.v1';

function load(): Clip | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && Array.isArray(v.strokes) && v.strokes.length ? v : null;
  } catch {
    return null;
  }
}

export const useClipboard = create<{ clip: Clip | null }>(() => ({ clip: load() }));

export function copyStrokes(strokes: Stroke[]) {
  const b = unionBounds(strokes);
  if (!b) return;
  const clip: Clip = { strokes: strokes.map((s) => translateStroke(s, -b.x, -b.y)), w: b.w, h: b.h };
  useClipboard.setState({ clip });
  try {
    localStorage.setItem(KEY, JSON.stringify(clip));
  } catch {
    /* too large for storage: still works until the app is closed */
  }
}

/** Pastes the clipboard centred on (cx, cy) of a page and selects the pasted ink. */
export function pasteStrokes(pageId: string, cx: number, cy: number): boolean {
  const clip = useClipboard.getState().clip;
  const ed = useEditor.getState();
  const page = ed.pages[pageId];
  if (!clip || !page) return false;
  // Keep the pasted ink on the page.
  const x = Math.max(0, Math.min(page.width - clip.w, cx - clip.w / 2));
  const y = Math.max(0, Math.min(page.height - clip.h, cy - clip.h / 2));
  const copies = clip.strokes.map((s) => ({ ...translateStroke(s, x, y), id: uid() }));
  ed.setStrokes(pageId, [...page.strokes, ...copies]);
  ed.select({ pageId, ids: copies.map((c) => c.id), dx: 0, dy: 0 });
  toast('Pasted');
  return true;
}
