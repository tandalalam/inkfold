import { useRef } from 'react';
import {
  ChevronLeft,
  Eraser,
  Highlighter,
  Lasso,
  MoreHorizontal,
  PanelLeft,
  PenLine,
  Plus,
  Redo2,
  Share,
  Shapes,
  Sparkles,
  ClipboardPaste,
  Undo2,
} from 'lucide-react';
import { useAsk } from '../ask/store';
import { useClipboard } from './clipboard';
import { ERASER_SIZES, HL_SIZES, PEN_SIZES, useTools, type Tool } from './tools';
import { useEditor } from './store';

function ToolButton({ tool, label, children }: { tool: Tool; label: string; children: React.ReactNode }) {
  const active = useTools((s) => s.tool === tool);
  return (
    <button
      className={`tool-btn ${active ? 'active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      onClick={() => {
        useTools.getState().setTool(tool);
        if (tool !== 'lasso') useEditor.getState().select(null);
      }}
    >
      {children}
    </button>
  );
}

function SizeDots({ sizes, value, onChange, scale }: { sizes: number[]; value: number; onChange: (n: number) => void; scale: number }) {
  return (
    <div className="size-group" role="radiogroup" aria-label="Size">
      {sizes.map((s) => (
        <button key={s} className={`size-btn ${Math.abs(value - s) < 0.01 ? 'active' : ''}`} onClick={() => onChange(s)} aria-label={`Size ${s}`}>
          <span className="size-dot" style={{ width: Math.min(22, 4 + s * scale), height: Math.min(22, 4 + s * scale) }} />
        </button>
      ))}
    </div>
  );
}

function Palette({ colors, value, onChange, onCustom }: { colors: string[]; value: string; onChange: (c: string) => void; onCustom: (c: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const custom = !colors.includes(value);
  return (
    <div className="palette">
      {colors.map((c) => (
        <button key={c} className={`swatch ${c === value ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={`Color ${c}`} />
      ))}
      <label className={`swatch custom ${custom ? 'active' : ''}`} style={custom ? { background: value } : undefined} aria-label="Custom color">
        <input ref={input} type="color" value={value} onChange={(e) => onCustom(e.target.value)} />
      </label>
    </div>
  );
}

function ToolOptions() {
  const t = useTools();
  if (t.tool === 'pen')
    return (
      <>
        <Palette
          colors={t.penPalette}
          value={t.pen.color}
          onChange={(color) => t.set({ pen: { ...t.pen, color } })}
          onCustom={(color) => t.set({ pen: { ...t.pen, color } })}
        />
        <SizeDots sizes={PEN_SIZES} value={t.pen.size} scale={3} onChange={(size) => t.set({ pen: { ...t.pen, size } })} />
        <div className="seg">
          <button className={t.pen.style === 'ball' ? 'active' : ''} onClick={() => t.set({ pen: { ...t.pen, style: 'ball' } })}>
            Ballpoint
          </button>
          <button className={t.pen.style === 'fountain' ? 'active' : ''} onClick={() => t.set({ pen: { ...t.pen, style: 'fountain' } })}>
            Fountain
          </button>
        </div>
      </>
    );
  if (t.tool === 'hl')
    return (
      <>
        <Palette
          colors={t.hlPalette}
          value={t.hl.color}
          onChange={(color) => t.set({ hl: { ...t.hl, color } })}
          onCustom={(color) => t.set({ hl: { ...t.hl, color } })}
        />
        <SizeDots sizes={HL_SIZES} value={t.hl.size} scale={0.8} onChange={(size) => t.set({ hl: { ...t.hl, size } })} />
      </>
    );
  if (t.tool === 'eraser')
    return (
      <>
        <div className="seg">
          <button className={t.eraser.mode === 'stroke' ? 'active' : ''} onClick={() => t.set({ eraser: { ...t.eraser, mode: 'stroke' } })}>
            Whole stroke
          </button>
          <button className={t.eraser.mode === 'precise' ? 'active' : ''} onClick={() => t.set({ eraser: { ...t.eraser, mode: 'precise' } })}>
            Precise
          </button>
        </div>
        <SizeDots sizes={ERASER_SIZES} value={t.eraser.size} scale={0.7} onChange={(size) => t.set({ eraser: { ...t.eraser, size } })} />
      </>
    );
  return <span className="hint">Circle ink to move, copy or ask about it. Tap a page to paste</span>;
}

export function Toolbar({
  title,
  onBack,
  onRename,
  onToggleSidebar,
  sidebarOpen,
  onAddPage,
  onShare,
  onMore,
  onPaste,
}: {
  title: string;
  onBack: () => void;
  onRename: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  onAddPage: (anchor: HTMLElement) => void;
  onShare: (anchor: HTMLElement) => void;
  onMore: (anchor: HTMLElement) => void;
  onPaste: () => void;
}) {
  const askAvailable = useAsk((s) => s.available === true);
  const askOpen = useAsk((s) => s.panelOpen);
  const askPending = useAsk((s) => s.tray.length);
  const hasClip = useClipboard((s) => !!s.clip);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const shapeSnap = useTools((s) => s.shapeSnap);
  return (
    <header className="editor-toolbar">
      <div className="toolbar-row">
        <button className="icon-btn" onClick={onBack} aria-label="Back to library">
          <ChevronLeft size={24} />
        </button>
        <button className={`icon-btn ${sidebarOpen ? 'active' : ''}`} onClick={onToggleSidebar} aria-label="Pages">
          <PanelLeft size={21} />
        </button>
        <button className="title-btn" onClick={onRename} dir="auto">
          {title}
        </button>
        <div className="spacer" />
        <button className="icon-btn" disabled={!canUndo} onClick={() => useEditor.getState().undo()} aria-label="Undo">
          <Undo2 size={21} />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={() => useEditor.getState().redo()} aria-label="Redo">
          <Redo2 size={21} />
        </button>
        {hasClip && (
          <button className="icon-btn" onClick={onPaste} aria-label="Paste" title="Paste (or tap a page with the lasso)">
            <ClipboardPaste size={20} />
          </button>
        )}
        {askAvailable && (
          <button
            className={`icon-btn ask-toggle ${askOpen ? 'active' : ''}`}
            onClick={() => useAsk.setState({ panelOpen: !askOpen })}
            aria-label="Ask"
            aria-pressed={askOpen}
          >
            <Sparkles size={20} />
            {askPending > 0 && <span className="dot-count">{askPending}</span>}
          </button>
        )}
        <button className="icon-btn" onClick={(e) => onAddPage(e.currentTarget)} aria-label="Add page">
          <Plus size={22} />
        </button>
        <button className="icon-btn" onClick={(e) => onShare(e.currentTarget)} aria-label="Export">
          <Share size={20} />
        </button>
        <button className="icon-btn" onClick={(e) => onMore(e.currentTarget)} aria-label="More">
          <MoreHorizontal size={22} />
        </button>
      </div>
      <div className="toolbar-row tools-row">
        <div className="tool-group">
          <ToolButton tool="pen" label="Pen">
            <PenLine size={21} />
          </ToolButton>
          <ToolButton tool="hl" label="Highlighter">
            <Highlighter size={21} />
          </ToolButton>
          <ToolButton tool="eraser" label="Eraser">
            <Eraser size={21} />
          </ToolButton>
          <ToolButton tool="lasso" label="Lasso">
            <Lasso size={21} />
          </ToolButton>
          <button
            className={`tool-btn ${shapeSnap ? 'active-soft' : ''}`}
            aria-label="Shape snapping"
            aria-pressed={shapeSnap}
            title="Hold at the end of a stroke to snap it to a shape"
            onClick={() => useTools.getState().set({ shapeSnap: !shapeSnap })}
          >
            <Shapes size={20} />
          </button>
        </div>
        <span className="bar-sep" />
        <div className="tool-options">
          <ToolOptions />
        </div>
      </div>
    </header>
  );
}
