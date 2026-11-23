import type React from 'react';

let lastPenTap = 0;
/** module-level so a re-render between down and up doesn't lose it (there is one Pencil) */
let down: { id: number; x: number; y: number; target: EventTarget } | null = null;

/**
 * Props for a button that works with Apple Pencil inside the page canvas.
 *
 * The canvas cancels Pencil touches (so the Pencil never scrolls), which on iOS
 * also suppresses the `click` that would normally follow. So a Pencil tap
 * activates on pointerup instead, and the click that may still follow is
 * ignored. Fingers and mice keep using the normal click.
 */
export function tapProps(onTap: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.pointerType === 'pen') down = { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.currentTarget };
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType !== 'pen' || !down || down.id !== e.pointerId || down.target !== e.currentTarget) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12;
      down = null;
      if (moved) return;
      lastPenTap = Date.now();
      e.preventDefault();
      onTap();
    },
    onClick: () => {
      if (Date.now() - lastPenTap < 600) return;
      onTap();
    },
  };
}
