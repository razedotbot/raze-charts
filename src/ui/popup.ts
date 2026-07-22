// Shared floating-popup container. Every menu the chrome opens (context menu,
// Indicators panel, chart-type picker, interval "more" dropdown) uses this so
// styling, stacking, viewport clamping and dismissal (outside pointerdown or
// Esc) stay consistent — and are implemented once.

export interface PopupOptions {
  fontFamily: string;
  /** Class name for tests / host-app styling hooks. */
  className?: string;
  minWidth?: number;
  /** Container padding (rows carry their own side padding). */
  padding?: string;
  /** Element to place beside; clicks inside it don't count as "outside". */
  anchor?: HTMLElement;
  /** Placement relative to the anchor. */
  place?: "right-start" | "below-start";
  /** Fixed viewport coords (used when no anchor is given). */
  x?: number;
  y?: number;
  onClose?: () => void;
}

export interface PopupHandle {
  el: HTMLDivElement;
  close: () => void;
  /** Re-clamp into the viewport (call after mutating contents). */
  reposition: () => void;
}

/** Coarse pointer (touch device) → bigger tap targets across the chrome.
 *  maxTouchPoints covers environments where the media query isn't emulated
 *  (and hybrids, where finger-sized targets are the safe choice). */
export function isCoarsePointer(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    if (window.matchMedia?.("(any-pointer: coarse)").matches) return true;
    return (navigator.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

/** One-time stylesheet for bits inline styles can't express (scrollbar hiding). */
export function ensureBaseStyles(): void {
  if (typeof document === "undefined" || document.getElementById("raze-chart-base-css")) return;
  const style = document.createElement("style");
  style.id = "raze-chart-base-css";
  style.textContent =
    ".raze-chart-left-sidebar{scrollbar-width:none}" +
    ".raze-chart-left-sidebar::-webkit-scrollbar{display:none}" +
    ".raze-chart-toolbar-scroll{scrollbar-width:none}" +
    ".raze-chart-toolbar-scroll::-webkit-scrollbar{display:none}";
  document.head.appendChild(style);
}

export function openPopup(opts: PopupOptions): PopupHandle {
  const el = document.createElement("div");
  if (opts.className) el.className = opts.className;
  el.style.cssText = [
    "position:fixed",
    `min-width:${opts.minWidth ?? 140}px`,
    `padding:${opts.padding ?? "4px 0"}`,
    "border-radius:6px",
    "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
    "background:var(--tv-color-popup-background, var(--tv-color-pane-background, #1e222d))",
    "box-shadow:0 12px 24px -10px rgba(0,0,0,0.6)",
    "z-index:2147483640",
    `font-family:${opts.fontFamily}`,
    "font-size:12px",
    "color:var(--tv-color-popup-element-text, #d1d4dc)",
  ].join(";");
  document.body.appendChild(el);

  const reposition = (): void => {
    let left = opts.x ?? 0;
    let top = opts.y ?? 0;
    const pw = el.offsetWidth || opts.minWidth || 140;
    const ph = el.offsetHeight || 100;
    if (opts.anchor) {
      const r = opts.anchor.getBoundingClientRect();
      if ((opts.place ?? "right-start") === "right-start") {
        left = r.right + 6;
        top = r.top;
        if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 6);
      } else {
        left = r.left;
        top = r.bottom + 4;
        if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
      }
    } else {
      if (left + pw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - pw - 4);
    }
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
    el.remove();
    opts.onClose?.();
  };
  const onAway = (e: PointerEvent): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (el.contains(target)) return;
    if (opts.anchor?.contains(target)) return; // let the anchor's own toggle run
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  // Defer so the opening click doesn't immediately dismiss.
  window.setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  reposition();
  return { el, close, reposition };
}

/** Standard hover-highlighted popup row. ≥40px tall on touch devices. */
export function popupRow(html: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.innerHTML = html;
  row.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:8px",
    "width:100%",
    "border:0",
    "background:transparent",
    "color:inherit",
    isCoarsePointer() ? "padding:12px 14px" : "padding:7px 12px",
    "cursor:pointer",
    "text-align:left",
    "font:inherit",
    "border-radius:3px",
    "white-space:nowrap",
    "box-sizing:border-box",
    "touch-action:manipulation",
  ].join(";");
  row.addEventListener("mouseenter", () => {
    row.style.background = "var(--tv-color-popup-element-background-hover, rgba(255,255,255,0.08))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "transparent";
  });
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return row;
}
