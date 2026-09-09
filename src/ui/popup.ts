// Shared floating-popup container. Every menu the chrome opens (context menu,
// Indicators panel, chart-type picker) uses this so
// styling, stacking, viewport clamping, keyboard flow and dismissal stay
// consistent — and are implemented once.

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
  /** Accessible popup role. Menus are the backwards-compatible default. */
  role?: "menu" | "dialog";
  /** Accessible name announced when focus enters the popup. */
  label?: string;
  /** Move focus to the first interactive row after contents are appended. */
  initialFocus?: boolean;
  onClose?: () => void;
}

export interface PopupHandle {
  el: HTMLDivElement;
  /** Close the popup. Focus returns to the opener unless explicitly disabled. */
  close: (options?: { restoreFocus?: boolean }) => void;
  /** Re-clamp into the viewport (call after mutating contents). */
  reposition: () => void;
  /** Focus a row by index (clamped to the available interactive rows). */
  focusItem: (index?: number) => void;
}

let popupId = 0;

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

/** One-time stylesheet for behaviours inline styles cannot express. */
export function ensureBaseStyles(): void {
  if (typeof document === "undefined" || document.getElementById("raze-chart-base-css")) return;
  const style = document.createElement("style");
  style.id = "raze-chart-base-css";
  style.textContent =
    ".raze-chart-left-sidebar{scrollbar-width:none}" +
    ".raze-chart-left-sidebar::-webkit-scrollbar{display:none}" +
    ".raze-chart-toolbar-scroll{scrollbar-width:none}" +
    ".raze-chart-toolbar-scroll::-webkit-scrollbar{display:none}" +
    ".raze-chart-root,.raze-chart-canvas{user-select:none;-webkit-user-select:none}" +
    ".raze-chart-root input,.raze-chart-root textarea{user-select:text;-webkit-user-select:text}" +
    ".raze-chart-canvas:focus,.raze-chart-canvas:focus-visible{outline:none}" +
    ".raze-chart-focusable:focus{outline:none}" +
    ".raze-chart-focusable:focus-visible{outline:2px solid var(--tv-color-toolbar-button-text-hover,#2962ff);outline-offset:1px}" +
    "@media (forced-colors:active){.raze-chart-focusable:focus-visible{outline-color:Highlight}}" +
    "@media (prefers-reduced-motion:reduce){.raze-chart-loading-screen{transition:none!important}.raze-chart-loading-spinner{animation:none!important}}";
  document.head.appendChild(style);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

function popupItems(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([aria-disabled="true"]),' +
    '[role="menuitemcheckbox"]:not([aria-disabled="true"]),' +
    '[role="menuitemradio"]:not([aria-disabled="true"]),' +
    'button:not([disabled])',
  )).filter((item, index, all) => all.indexOf(item) === index);
}

export function openPopup(opts: PopupOptions): PopupHandle {
  const el = document.createElement("div");
  el.id = `raze-chart-popup-${++popupId}`;
  if (opts.className) el.className = opts.className;
  el.setAttribute("role", opts.role ?? "menu");
  el.setAttribute("aria-label", opts.label ?? "Chart menu");
  if ((opts.role ?? "menu") === "menu") el.setAttribute("aria-orientation", "vertical");
  el.tabIndex = -1;
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

  const activeElement = document.activeElement;
  const returnFocus = opts.anchor ?? (activeElement instanceof HTMLElement ? activeElement : null);
  if (opts.anchor) {
    opts.anchor.setAttribute("aria-haspopup", opts.role ?? "menu");
    opts.anchor.setAttribute("aria-expanded", "true");
    opts.anchor.setAttribute("aria-controls", el.id);
  }
  document.body.appendChild(el);

  const focusItem = (index = 0): void => {
    const items = popupItems(el);
    if (!items.length) {
      el.focus({ preventScroll: true });
      return;
    }
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    items[safeIndex]?.focus({ preventScroll: true });
  };

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
    } else if (left + pw > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - pw - 4);
    }
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  let closed = false;
  const close = (options?: { restoreFocus?: boolean }): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
    el.removeEventListener("keydown", onMenuKey);
    el.removeEventListener("focusout", onFocusOut);
    el.remove();
    if (opts.anchor) {
      opts.anchor.setAttribute("aria-expanded", "false");
      if (opts.anchor.getAttribute("aria-controls") === el.id) {
        opts.anchor.removeAttribute("aria-controls");
      }
    }
    opts.onClose?.();
    if (options?.restoreFocus !== false && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  };
  const onAway = (e: PointerEvent): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (el.contains(target)) return;
    if (opts.anchor?.contains(target)) return; // let the anchor's own toggle run
    close({ restoreFocus: false });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (!el.contains(document.activeElement) && document.activeElement !== opts.anchor) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onMenuKey = (e: KeyboardEvent): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (isEditableTarget(e.target)) return;
    const items = popupItems(el);
    if (!items.length) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = focused ? items.indexOf(focused) : -1;
    let next = current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };
  const onFocusOut = (): void => {
    queueMicrotask(() => {
      if (closed || el.contains(document.activeElement) || document.activeElement === opts.anchor) return;
      close({ restoreFocus: false });
    });
  };
  el.addEventListener("keydown", onMenuKey);
  el.addEventListener("focusout", onFocusOut);

  // Defer so the opening click doesn't immediately dismiss and callers have
  // time to append rows before the first one receives focus.
  window.setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("keydown", onKey, true);
    if (opts.initialFocus !== false) focusItem();
  }, 0);

  reposition();
  return { el, close, reposition, focusItem };
}

/** Standard hover-highlighted popup row. ≥40px tall on touch devices. */
export function popupRow(
  html: string,
  onClick: (e: MouseEvent) => void,
  options?: {
    role?: "menuitem" | "menuitemcheckbox" | "menuitemradio";
    checked?: boolean;
    label?: string;
  },
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.innerHTML = html;
  row.className = "raze-chart-focusable";
  row.setAttribute("role", options?.role ?? "menuitem");
  if (options?.checked !== undefined) row.setAttribute("aria-checked", String(options.checked));
  if (options?.label) row.setAttribute("aria-label", options.label);
  for (const svg of row.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
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

/** Add conventional arrow/Home/End navigation to a toolbar without changing Tab order. */
export function enableToolbarKeyboardNavigation(
  toolbar: HTMLElement,
  orientation: "horizontal" | "vertical",
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (![previousKey, nextKey, "Home", "End"].includes(e.key)) return;
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>(
      'button:not([disabled]),[role="button"][tabindex]:not([aria-disabled="true"])',
    ));
    if (!controls.length) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('button,[role="button"]') : null;
    const current = target ? controls.indexOf(target) : -1;
    if (current < 0) return;
    let next = current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = controls.length - 1;
    else if (e.key === nextKey) next = (current + 1) % controls.length;
    else next = (current - 1 + controls.length) % controls.length;
    e.preventDefault();
    controls[next]?.focus();
  };
  toolbar.addEventListener("keydown", onKey);
  return () => toolbar.removeEventListener("keydown", onKey);
}
