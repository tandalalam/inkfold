import { create } from 'zustand';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Imperative dialogs, menus and toasts                                */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** renders a separator before this item */
  separator?: boolean;
}

interface DialogBase {
  id: number;
}
interface PromptDialog extends DialogBase {
  kind: 'prompt';
  title: string;
  initial: string;
  placeholder?: string;
  okLabel: string;
  resolve: (v: string | null) => void;
}
interface ConfirmDialog extends DialogBase {
  kind: 'confirm';
  title: string;
  message?: string;
  okLabel: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
interface CustomDialog extends DialogBase {
  kind: 'custom';
  render: (close: () => void) => ReactNode;
}
type Dialog = PromptDialog | ConfirmDialog | CustomDialog;

interface MenuState {
  anchor: DOMRect;
  items: MenuItem[];
  header?: ReactNode;
}

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

interface OverlayState {
  dialogs: Dialog[];
  menu: MenuState | null;
  toasts: Toast[];
  busy: string | null;
}

const useOverlay = create<OverlayState>(() => ({ dialogs: [], menu: null, toasts: [], busy: null }));
let nextId = 1;

function pushDialog(d: Dialog) {
  useOverlay.setState((s) => ({ dialogs: [...s.dialogs, d] }));
}
function removeDialog(id: number) {
  useOverlay.setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
}

export function askText(title: string, initial = '', opts: { placeholder?: string; okLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) =>
    pushDialog({ kind: 'prompt', id: nextId++, title, initial, placeholder: opts.placeholder, okLabel: opts.okLabel ?? 'Save', resolve }),
  );
}

export function confirmAction(title: string, opts: { message?: string; okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) =>
    pushDialog({ kind: 'confirm', id: nextId++, title, message: opts.message, okLabel: opts.okLabel ?? 'OK', danger: opts.danger, resolve }),
  );
}

export function showDialog(render: (close: () => void) => ReactNode) {
  const id = nextId++;
  pushDialog({ kind: 'custom', id, render: () => render(() => removeDialog(id)) });
}

export function openMenu(anchor: Element | DOMRect, items: MenuItem[], header?: ReactNode) {
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  useOverlay.setState({ menu: { anchor: rect, items, header } });
}
export function closeMenu() {
  useOverlay.setState({ menu: null });
}

export function toast(text: string, error = false) {
  const id = nextId++;
  useOverlay.setState((s) => ({ toasts: [...s.toasts, { id, text, error }] }));
  setTimeout(() => useOverlay.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), error ? 5000 : 2600);
}

export function setBusy(text: string | null) {
  useOverlay.setState({ busy: text });
}

/** Runs an async action with a busy indicator and error toast. */
export async function withBusy<T>(text: string, fn: () => Promise<T>): Promise<T | undefined> {
  setBusy(text);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast((e as Error)?.message || 'Something went wrong', true);
    return undefined;
  } finally {
    setBusy(null);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function PromptView({ d }: { d: PromptDialog }) {
  const [value, setValue] = useState(d.initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = (v: string | null) => {
    removeDialog(d.id);
    d.resolve(v);
  };
  return (
    <Modal title={d.title} onClose={() => done(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          done(value);
        }}
      >
        <input ref={ref} className="text-input" dir="auto" value={value} placeholder={d.placeholder} onChange={(e) => setValue(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {d.okLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmView({ d }: { d: ConfirmDialog }) {
  const done = (v: boolean) => {
    removeDialog(d.id);
    d.resolve(v);
  };
  return (
    <Modal title={d.title} onClose={() => done(false)}>
      {d.message && <p className="modal-message">{d.message}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={() => done(false)}>
          Cancel
        </button>
        <button className={`btn ${d.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)} autoFocus>
          {d.okLabel}
        </button>
      </div>
    </Modal>
  );
}

function MenuView({ menu }: { menu: MenuState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = menu.anchor.left + menu.anchor.width / 2 - width / 2;
    left = Math.max(8, Math.min(vw - width - 8, left));
    let top = menu.anchor.bottom + 6;
    if (top + height > vh - 8) top = Math.max(8, menu.anchor.top - height - 6);
    setPos({ left, top });
  }, [menu]);
  return (
    <div className="menu-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeMenu()}>
      <div ref={ref} className="menu" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }} role="menu">
        {menu.header}
        {menu.items.map((it, i) => (
          <div key={i}>
            {it.separator && <div className="menu-sep" />}
            <button
              className={`menu-item ${it.danger ? 'danger' : ''}`}
              disabled={it.disabled}
              role="menuitem"
              onClick={() => {
                closeMenu();
                it.onSelect?.();
              }}
            >
              <span className="menu-icon">{it.checked ? <Check size={17} /> : it.icon}</span>
              <span>{it.label}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OverlayRoot() {
  const { dialogs, menu, toasts, busy } = useOverlay();
  return (
    <>
      {dialogs.map((d) =>
        d.kind === 'prompt' ? <PromptView key={d.id} d={d} /> : d.kind === 'confirm' ? <ConfirmView key={d.id} d={d} /> : <div key={d.id}>{d.render(() => {})}</div>,
      )}
      {menu && <MenuView menu={menu} />}
      {busy && (
        <div className="busy">
          <div className="busy-box">
            <div className="spinner" />
            <span>{busy}</span>
          </div>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
