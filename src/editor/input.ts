/** Shared input state between the page drawing handlers and the zoom/scroll gestures. */
export interface ActiveInput {
  pointerType: string;
  cancel: () => void;
}

export const inputState: { active: ActiveInput | null; pinching: boolean } = {
  active: null,
  pinching: false,
};

/** Abort a finger stroke when a pinch starts (the Pencil is never interrupted). */
export function cancelFingerInput() {
  if (inputState.active && inputState.active.pointerType !== 'pen') {
    inputState.active.cancel();
    inputState.active = null;
  }
}

declare global {
  interface Touch {
    /** iOS Safari: 'stylus' for Apple Pencil, 'direct' for fingers */
    readonly touchType?: 'direct' | 'stylus';
  }
}
