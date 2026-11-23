import { create } from 'zustand';

export type Tool = 'pen' | 'hl' | 'eraser' | 'lasso';
export type PenStyle = 'ball' | 'fountain';
export type EraserMode = 'stroke' | 'precise';

export const PEN_COLORS = ['#1a1a1a', '#1f4fbf', '#d0312d', '#1d8a4a', '#7b3fbf'];
export const HL_COLORS = ['#ffe23d', '#7ee081', '#ff8fc7', '#7cc8ff', '#ffb35c'];
export const PEN_SIZES = [1.4, 2.4, 4];
export const HL_SIZES = [9, 15, 24];
export const ERASER_SIZES = [5, 12, 24];

interface ToolState {
  tool: Tool;
  pen: { color: string; size: number; style: PenStyle };
  hl: { color: string; size: number };
  eraser: { mode: EraserMode; size: number };
  penPalette: string[];
  hlPalette: string[];
  shapeSnap: boolean;
  fingerDraw: boolean;
  /** floating pen/eraser switch (stands in for Pencil double-tap, which Safari doesn't expose) */
  quickSwitch: boolean;
  /** tool to return to from the eraser */
  lastInk: 'pen' | 'hl';
  setTool: (t: Tool) => void;
  toggleEraser: () => void;
  set: (patch: Partial<Omit<ToolState, 'set' | 'setTool' | 'toggleEraser'>>) => void;
}

const KEY = 'inkfold.tools.v1';

function loadSaved(): Partial<ToolState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export const useTools = create<ToolState>((set, get) => ({
  tool: 'pen',
  pen: { color: PEN_COLORS[0], size: PEN_SIZES[1], style: 'ball' },
  hl: { color: HL_COLORS[0], size: HL_SIZES[1] },
  eraser: { mode: 'stroke', size: ERASER_SIZES[1] },
  penPalette: PEN_COLORS,
  hlPalette: HL_COLORS,
  shapeSnap: true,
  fingerDraw: false,
  quickSwitch: true,
  lastInk: 'pen',
  ...loadSaved(),
  setTool: (tool) => set(tool === 'pen' || tool === 'hl' ? { tool, lastInk: tool } : { tool }),
  toggleEraser: () => {
    const s = get();
    set(s.tool === 'eraser' ? { tool: s.lastInk } : { tool: 'eraser', lastInk: s.tool === 'hl' ? 'hl' : s.tool === 'pen' ? 'pen' : s.lastInk });
  },
  set: (patch) => set(patch),
}));

useTools.subscribe((s) => {
  const { tool, pen, hl, eraser, penPalette, hlPalette, shapeSnap, fingerDraw, quickSwitch, lastInk } = s;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tool, pen, hl, eraser, penPalette, hlPalette, shapeSnap, fingerDraw, quickSwitch, lastInk }));
  } catch {
    /* storage full or blocked */
  }
});
