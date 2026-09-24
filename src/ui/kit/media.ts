// Environment queries shared by chrome and the UI kit.

/** Viewport width (CSS px) below which menus and dialogs become bottom sheets. */
export const SHEET_BREAKPOINT = 520;

function matches(query: string, win: Window | undefined): boolean {
  try {
    return !!win?.matchMedia?.(query).matches;
  } catch {
    return false;
  }
}

function currentWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/** Coarse pointer (touch device) → bigger tap targets across the chrome.
 *  maxTouchPoints covers environments where the media query isn't emulated
 *  (and hybrids, where finger-sized targets are the safe choice). */
export function isCoarsePointer(): boolean {
  const win = currentWindow();
  if (!win) return false;
  try {
    if (matches("(pointer: coarse)", win) || matches("(any-pointer: coarse)", win)) return true;
    return (win.navigator?.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Whether overlays should render as bottom sheets: the PRIMARY pointer is
 * coarse (phones, tablets) or the viewport is narrower than
 * `SHEET_BREAKPOINT`. Touch-capable laptops with a mouse keep anchored menus.
 */
export function prefersSheet(win: Window | undefined = currentWindow()): boolean {
  if (!win) return false;
  if (matches("(pointer: coarse)", win)) return true;
  const width = win.innerWidth || win.document?.documentElement?.clientWidth || 0;
  return width > 0 && width < SHEET_BREAKPOINT;
}

/** The user asked the OS to minimise non-essential motion. */
export function prefersReducedMotion(win: Window | undefined = currentWindow()): boolean {
  return matches("(prefers-reduced-motion: reduce)", win);
}
