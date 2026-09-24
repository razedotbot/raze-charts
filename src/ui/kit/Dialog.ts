// Modal dialog: the shared shell for chart, study and drawing settings,
// go-to, shortcuts and search surfaces.
//
// - `role="dialog"` + `aria-modal`, named by its title and optionally
//   described; Tab/Shift+Tab are trapped; Escape cancels; focus returns to
//   the opener.
// - Optional tab list (roving tabindex, arrow/Home/End, automatic activation)
//   with lazily rendered panels that keep their state across switches.
// - OK / Cancel and an optional "Reset to defaults" action; Enter in a field
//   submits; `onSubmit` may veto or run asynchronously.
// - Desktop: centred and draggable by its header. Coarse pointers or
//   viewports under 520px: a bottom sheet with a drag handle. With the
//   default `auto` presentation an open dialog switches between the two
//   when the viewport or primary pointer changes (a window resized across
//   520px, a tablet docked), keeping its content, state and focus.
// - Portalled into the fullscreen element or the chart's shadow root.

import { t } from "../../i18n";
import { defineStyles, type StyleChunk } from "../styles";
import { composedContains, deepActiveElement, focusWithoutScroll, uid } from "./dom";
import { lockScroll, tabbables, trapFocus, type FocusTrap } from "./focus";
import { pushLayer, type Layer } from "./layers";
import { watchSheetPreference } from "./media";
import { createPortal, type Portal } from "./portal";
import { resolvePresentation, type Presentation } from "./Popover";
import { createSheetFrame, SHEET_STYLES, type SheetFrame } from "./Sheet";
import { button, ICON_CLOSE, iconButton, SURFACE_STYLES } from "./surface";

export const DIALOG_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-dialog",
  ".raze-kit-dialog{display:flex;flex-direction:column;margin:0;min-height:0;font-size:var(--raze-font-size-lg,14px)}" +
  ".raze-kit-dialog-form{display:contents}" +
  ".raze-kit-dialog[data-presentation=dialog]{position:fixed;left:50%;top:50%;width:var(--raze-dialog-width,420px);" +
  "max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);" +
  "transform:translate(calc(-50% + var(--raze-dialog-dx,0px)),calc(-50% + var(--raze-dialog-dy,0px)));" +
  "animation:raze-kit-dialog-in var(--raze-duration,160ms) ease-out}" +
  ".raze-kit-dialog[data-presentation=sheet]{border:0;box-shadow:none;border-radius:0;background:transparent}" +
  ".raze-kit-backdrop[data-kind=dialog]{background:var(--raze-dialog-backdrop,rgba(0,0,0,.35))}" +
  ".raze-kit-dialog-header{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 20px;flex:0 0 auto;" +
  "touch-action:none;user-select:none;-webkit-user-select:none}" +
  ".raze-kit-dialog[data-presentation=dialog][data-draggable] .raze-kit-dialog-header{cursor:move}" +
  ".raze-kit-dialog[data-presentation=sheet] .raze-kit-dialog-header{padding-top:0}" +
  ".raze-kit-dialog-title{flex:1 1 auto;min-width:0;margin:0;font-size:16px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".raze-kit-dialog-description{margin:-4px 20px 8px;opacity:.72}" +
  ".raze-kit-tabs{display:flex;gap:4px;padding:0 16px;border-bottom:1px solid var(--raze-border,#363a45);overflow-x:auto;scrollbar-width:none;flex:0 0 auto}" +
  ".raze-kit-tab{position:relative;padding:8px 6px 10px;margin:0 2px;border:0;background:transparent;color:inherit;font:inherit;" +
  "opacity:.72;cursor:pointer;white-space:nowrap}" +
  ".raze-kit-tab:hover{opacity:1}" +
  ".raze-kit-tab[aria-selected=true]{opacity:1;font-weight:600}" +
  ".raze-kit-tab[aria-selected=true]::after{content:\"\";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px;background:var(--raze-accent,#2962ff)}" +
  ".raze-kit-tab:focus{outline:none}" +
  ".raze-kit-tab:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:-2px;border-radius:var(--raze-radius-sm,4px)}" +
  ".raze-kit-dialog-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 20px}" +
  ".raze-kit-dialog-panel{display:flex;flex-direction:column;gap:10px}" +
  ".raze-kit-dialog-footer{display:flex;align-items:center;gap:8px;padding:12px 20px 16px;flex:0 0 auto;border-top:1px solid var(--raze-border,#363a45)}" +
  ".raze-kit-dialog-footer-spacer{flex:1 1 auto}" +
  "@keyframes raze-kit-dialog-in{from{opacity:0}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-dialog{animation:none!important}}" +
  "@media (forced-colors:active){.raze-kit-tab[aria-selected=true]::after{background:Highlight}}",
);

export type DialogCloseReason = "ok" | "cancel" | "escape" | "backdrop" | "swipe" | "close-button" | "api";

export interface DialogTab {
  id: string;
  label: string;
  /** Render the panel the first time the tab is shown. */
  render(panel: HTMLElement): void;
}

export interface DialogOptions {
  /** Dialog title; also its accessible name. */
  title: string;
  /** Optional description announced with the title. */
  description?: string;
  /** Body content when there are no tabs. */
  content?: Node | string | ((body: HTMLElement) => void);
  tabs?: readonly DialogTab[];
  initialTab?: string;
  /** Footer actions (default `ok-cancel`). */
  actions?: "ok-cancel" | "ok" | "none";
  okLabel?: string;
  cancelLabel?: string;
  /** Show "Reset to defaults"; called when the user activates it. */
  onReset?(): void;
  /**
   * Called on OK / Enter. Return (or resolve) `false` to keep the dialog
   * open, e.g. after showing a validation message. While a returned promise
   * is pending the dialog is busy: Escape, Cancel, the close button, the
   * backdrop and swipes are ignored so a half-applied submit is never
   * reported as a cancel (`close()` from code still closes it).
   */
  onSubmit?(): boolean | void | Promise<boolean | void>;
  /** Called when the dialog is dismissed without OK. */
  onCancel?(reason: DialogCloseReason): void;
  /** Called after the dialog has closed, with the reason. */
  onClose?(reason: DialogCloseReason): void;
  /**
   * `auto` (default): bottom sheet on coarse pointers or viewports < 520px,
   * re-evaluated while open. `dialog`/`anchored` or `sheet` fix it.
   */
  presentation?: Presentation | "dialog";
  /** CSS width of the desktop dialog (default 420px). */
  width?: string;
  /** Allow dragging the desktop dialog by its header (default true). */
  draggable?: boolean;
  /**
   * Dismiss when the backdrop is clicked. Default: true for bottom sheets
   * (the mobile convention), false for desktop dialogs so a stray click
   * cannot discard edits.
   */
  closeOnBackdrop?: boolean;
  /** Element focused on open (default: first control in the body). */
  initialFocus?: HTMLElement;
  /** Element focused on close (default: the element focused before opening). */
  returnFocus?: HTMLElement | null;
  /** Anchor inside the chart (portal root, theme). */
  anchor?: Element | null;
  themeRoot?: Element | null;
  fontFamily?: string;
  className?: string;
}

export interface DialogHandle {
  /** The `role="dialog"` element. */
  readonly el: HTMLElement;
  /** Content element of the active tab (or the body without tabs). */
  readonly body: HTMLElement;
  /** Current presentation; with `auto` it follows viewport and pointer changes. */
  readonly presentation: "dialog" | "sheet";
  /** Resolves with the close reason. */
  readonly result: Promise<DialogCloseReason>;
  readonly closed: boolean;
  close(reason?: DialogCloseReason): void;
  selectTab(id: string, options?: { focus?: boolean }): void;
  /** Panel element for a tab (rendered on first request). */
  panel(id: string): HTMLElement | null;
  setTitle(title: string): void;
}

export function openDialog(options: DialogOptions): DialogHandle {
  const doc = options.anchor?.ownerDocument ?? document;
  const presentation = resolvePresentation(options.presentation === "dialog" ? "anchored" : options.presentation, options.anchor) === "sheet"
    ? "sheet"
    : "dialog";
  const active = deepActiveElement(doc);
  const returnFocus = options.returnFocus !== undefined
    ? options.returnFocus
    : active instanceof HTMLElement && active !== doc.body ? active : null;

  const portal = createPortal({
    anchor: options.anchor ?? returnFocus,
    themeRoot: options.themeRoot,
    fontFamily: options.fontFamily,
    className: options.className,
  });
  portal.adopt([SURFACE_STYLES, SHEET_STYLES, DIALOG_STYLES]);

  // Mounting runs caller code (the content and tab render callbacks) while
  // the dialog holds page-wide state. If any of it throws, that state is
  // released before the error propagates, so a failed open never leaves the
  // page scroll-locked, focus-trapped or covered by an empty portal.
  const held: HeldState = { trap: null, popLayer: null, unlockScroll: null };
  try {
    return mountDialog(options, { doc, presentation, returnFocus, portal, held });
  } catch (error) {
    const focusWasInside = composedContains(portal.el, deepActiveElement(doc));
    held.trap?.release({ restoreFocus: false });
    held.stopWatching?.();
    held.popLayer?.();
    held.unlockScroll?.();
    portal.destroy();
    if (focusWasInside && returnFocus?.isConnected) focusWithoutScroll(returnFocus);
    // Option validation (duplicate or unknown tab ids) already explains itself.
    if (error instanceof Error && error.message.startsWith("[raze-charts]")) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const failure = new Error(`[raze-charts] dialog content threw while opening "${options.title}"; the dialog was not opened. ${reason}`);
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
}

/** Page-wide state an opening dialog has taken (released if opening fails). */
interface HeldState {
  trap: FocusTrap | null;
  stopWatching?: (() => void) | null;
  popLayer: (() => void) | null;
  unlockScroll: (() => void) | null;
}

interface MountContext {
  doc: Document;
  presentation: "dialog" | "sheet";
  returnFocus: HTMLElement | null;
  portal: Portal;
  held: HeldState;
}

function mountDialog(options: DialogOptions, { doc, presentation: initialPresentation, returnFocus, portal, held }: MountContext): DialogHandle {
  let presentation = initialPresentation;
  // ARIA in HTML does not allow role="dialog" on <form>, so the dialog is a
  // div and a layout-neutral form inside it provides Enter-to-submit. The
  // submit event bubbles to the dialog, where it is handled.
  const dialog = doc.createElement("div");
  dialog.className = "raze-kit-surface raze-kit-dialog";
  dialog.dataset.presentation = presentation;
  dialog.tabIndex = -1;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (options.width) dialog.style.setProperty("--raze-dialog-width", options.width);
  const form = doc.createElement("form");
  form.className = "raze-kit-dialog-form";
  form.noValidate = true;
  dialog.appendChild(form);

  const titleId = uid("dialog-title");
  const header = doc.createElement("div");
  header.className = "raze-kit-dialog-header";
  const title = doc.createElement("h2");
  title.className = "raze-kit-dialog-title";
  title.id = titleId;
  title.textContent = options.title;
  const closeButton = iconButton(doc, t("kit.dialog.close", "Close"), ICON_CLOSE);
  header.append(title, closeButton);
  dialog.setAttribute("aria-labelledby", titleId);
  form.appendChild(header);

  if (options.description) {
    const description = doc.createElement("p");
    description.className = "raze-kit-dialog-description";
    description.id = uid("dialog-description");
    description.textContent = options.description;
    dialog.setAttribute("aria-describedby", description.id);
    form.appendChild(description);
  }

  const body = doc.createElement("div");
  body.className = "raze-kit-dialog-body";

  // ── Tabs ──────────────────────────────────────────────────────────────
  const tabs = options.tabs ?? [];
  const tabButtons = new Map<string, HTMLButtonElement>();
  const panels = new Map<string, HTMLElement>();
  let activeTab: string | null = null;
  let content: HTMLElement = body;

  const ensurePanel = (id: string): HTMLElement | null => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return null;
    let panel = panels.get(id);
    if (!panel) {
      panel = doc.createElement("div");
      panel.className = "raze-kit-dialog-panel";
      panel.id = uid("dialog-panel");
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tabButtons.get(id)!.id);
      panel.hidden = true;
      body.appendChild(panel);
      try {
        tab.render(panel);
      } catch (error) {
        panel.remove(); // no half-rendered panel; selecting the tab again retries
        throw error;
      }
      panels.set(id, panel);
      tabButtons.get(id)!.setAttribute("aria-controls", panel.id);
      portal.update(); // adopt styles of controls the panel rendered
    }
    return panel;
  };

  const selectTab = (id: string, selectOptions?: { focus?: boolean }): void => {
    if (!tabButtons.has(id)) {
      throw new RangeError(`[raze-charts] dialog has no tab "${id}"; expected one of: ${tabs.map((tab) => tab.id).join(", ")}.`);
    }
    // Render first: if the panel's render throws, the selection is unchanged.
    const next = ensurePanel(id)!;
    activeTab = id;
    for (const [tabId, tabButton] of tabButtons) {
      const selected = tabId === id;
      tabButton.setAttribute("aria-selected", String(selected));
      tabButton.tabIndex = selected ? 0 : -1;
      const panel = panels.get(tabId);
      if (panel) panel.hidden = !selected;
    }
    content = next;
    content.hidden = false;
    body.scrollTop = 0;
    if (selectOptions?.focus) focusWithoutScroll(tabButtons.get(id)!);
  };

  if (tabs.length) {
    const ids = new Set<string>();
    const tabList = doc.createElement("div");
    tabList.className = "raze-kit-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", options.title);
    for (const tab of tabs) {
      if (ids.has(tab.id)) throw new RangeError(`[raze-charts] duplicate dialog tab id "${tab.id}".`);
      ids.add(tab.id);
      const tabButton = doc.createElement("button");
      tabButton.type = "button";
      tabButton.className = "raze-kit-tab";
      tabButton.id = uid("dialog-tab");
      tabButton.setAttribute("role", "tab");
      tabButton.textContent = tab.label;
      tabButton.addEventListener("click", () => selectTab(tab.id));
      tabButtons.set(tab.id, tabButton);
      tabList.appendChild(tabButton);
    }
    tabList.addEventListener("keydown", (event) => {
      const order = tabs.map((tab) => tab.id);
      const current = activeTab ? order.indexOf(activeTab) : 0;
      const rtl = portal.el.dir === "rtl";
      let next = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + (rtl && event.key === "ArrowRight" ? -1 : 1) + order.length) % order.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current + (rtl && event.key === "ArrowLeft" ? 1 : -1) + order.length) % order.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = order.length - 1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(order[next]!, { focus: true });
    });
    form.appendChild(tabList);
  } else if (typeof options.content === "function") {
    options.content(body);
  } else if (options.content) {
    body.append(options.content); // strings render as text
  }
  form.appendChild(body);

  // ── Footer ────────────────────────────────────────────────────────────
  const actions = options.actions ?? "ok-cancel";
  let okButton: HTMLButtonElement | null = null;
  let cancelButton: HTMLButtonElement | null = null;
  if (actions !== "none" || options.onReset) {
    const footer = doc.createElement("div");
    footer.className = "raze-kit-dialog-footer";
    if (options.onReset) {
      const reset = button(doc, t("kit.dialog.reset", "Reset to defaults"), { variant: "ghost" });
      reset.addEventListener("click", () => {
        try {
          options.onReset?.();
        } catch (error) {
          console.error("[raze-charts] dialog onReset threw.", error);
        }
      });
      footer.appendChild(reset);
    }
    const spacer = doc.createElement("span");
    spacer.className = "raze-kit-dialog-footer-spacer";
    footer.appendChild(spacer);
    if (actions === "ok-cancel") {
      cancelButton = button(doc, options.cancelLabel ?? t("kit.dialog.cancel", "Cancel"));
      cancelButton.addEventListener("click", () => dismiss("cancel"));
      footer.appendChild(cancelButton);
    }
    if (actions !== "none") {
      okButton = button(doc, options.okLabel ?? t("kit.dialog.ok", "OK"), { variant: "primary", type: "submit" });
      footer.appendChild(okButton);
    }
    form.appendChild(footer);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  const layer: Layer = { el: portal.el, modal: true };
  const popLayer = (held.popLayer = pushLayer(layer));
  const unlockScroll = (held.unlockScroll = lockScroll(doc));
  let frame: SheetFrame | null = null;
  let backdrop: HTMLElement | null = null;
  let resetDrag: (() => void) | null = null;
  let closed = false;
  let submitting = false;
  let resolveResult!: (reason: DialogCloseReason) => void;
  const result = new Promise<DialogCloseReason>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (reason: DialogCloseReason): void => {
    if (closed) return;
    closed = true;
    held.stopWatching?.();
    trap.release({ restoreFocus: false });
    frame?.destroy();
    popLayer();
    unlockScroll();
    portal.destroy();
    options.onClose?.(reason);
    resolveResult(reason);
    if (returnFocus?.isConnected) focusWithoutScroll(returnFocus);
  };

  /**
   * Close without OK. User dismissals are refused (returning false) while a
   * submit is pending; `force` is the programmatic `close()` path.
   */
  const dismiss = (reason: DialogCloseReason, force = false): boolean => {
    if (closed) return false;
    if (submitting && !force) return false;
    try {
      options.onCancel?.(reason);
    } catch (error) {
      console.error("[raze-charts] dialog onCancel threw.", error);
    }
    finish(reason);
    return true;
  };

  const setBusy = (busy: boolean): void => {
    submitting = busy;
    for (const control of [cancelButton, closeButton]) if (control) control.disabled = busy;
    if (busy) {
      dialog.setAttribute("aria-busy", "true");
      okButton?.setAttribute("aria-busy", "true");
    } else {
      dialog.removeAttribute("aria-busy");
      okButton?.removeAttribute("aria-busy");
    }
  };

  const submit = async (): Promise<void> => {
    if (closed || submitting) return;
    setBusy(true);
    let keepOpen = false;
    try {
      keepOpen = (await options.onSubmit?.()) === false;
    } catch (error) {
      keepOpen = true;
      console.error("[raze-charts] dialog onSubmit threw; the dialog stays open.", error);
    } finally {
      setBusy(false);
    }
    if (!keepOpen) finish("ok");
  };

  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (actions !== "none") void submit();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss("escape");
  });
  closeButton.addEventListener("click", () => dismiss("close-button"));

  // Presentation: the same dialog element (content, tab state, fields) is
  // framed either as a centred dialog over a backdrop or as a bottom sheet.
  const present = (mode: "dialog" | "sheet"): void => {
    presentation = mode;
    dialog.dataset.presentation = mode;
    if (mode === "sheet") {
      frame = createSheetFrame(portal.el, {
        content: dialog,
        scroller: body,
        onDismiss: (reason) => dismiss(reason === "handle" ? "close-button" : reason),
      });
      backdrop = frame.backdrop;
      if (options.closeOnBackdrop === false) {
        backdrop.addEventListener("click", (event) => event.stopImmediatePropagation(), true);
      }
      return;
    }
    const scrim = doc.createElement("div");
    scrim.className = "raze-kit-backdrop";
    scrim.dataset.kind = "dialog";
    scrim.addEventListener("mousedown", (event) => event.preventDefault());
    scrim.addEventListener("click", () => {
      if (options.closeOnBackdrop === true) dismiss("backdrop");
    });
    backdrop = scrim;
    portal.el.append(scrim, dialog);
  };
  const unpresent = (): void => {
    frame?.destroy();
    frame = null;
    backdrop?.remove();
    backdrop = null;
  };
  present(presentation);
  if (options.draggable !== false) resetDrag = enableDrag(dialog, header);

  // `auto` follows the environment while open: re-frame in place and keep
  // focus where it was (moving the element out of the DOM would drop it).
  const adaptive = options.presentation === undefined || options.presentation === "auto";
  if (adaptive) {
    held.stopWatching = watchSheetPreference((wantsSheet) => {
      const next = wantsSheet ? "sheet" : "dialog";
      if (closed || next === presentation) return;
      const active = deepActiveElement(doc);
      const hadFocus = !!active && composedContains(dialog, active);
      unpresent();
      resetDrag?.();
      present(next);
      portal.update();
      if (!hadFocus) return;
      focusWithoutScroll(active instanceof HTMLElement && active.isConnected ? active : tabbables(dialog)[0] ?? dialog);
    }, doc.defaultView ?? undefined);
  }

  portal.update();
  const trap = (held.trap = trapFocus(dialog, layer, returnFocus));
  if (tabs.length) selectTab(options.initialTab ?? tabs[0]!.id);
  focusWithoutScroll(options.initialFocus ?? tabbables(content)[0] ?? (tabs.length ? tabButtons.get(activeTab!)! : null) ?? okButton ?? dialog);

  return {
    el: dialog,
    get body() {
      return content;
    },
    get presentation() {
      return presentation;
    },
    result,
    get closed() {
      return closed;
    },
    close(reason = "api") {
      if (reason === "ok") finish("ok");
      else dismiss(reason, true);
    },
    selectTab,
    panel: (id) => ensurePanel(id),
    setTitle(next) {
      title.textContent = next;
      if (tabs.length) dialog.querySelector('[role="tablist"]')?.setAttribute("aria-label", next);
    },
  };
}

/**
 * Drag a centred dialog by its header, keeping the header on screen. Only the
 * dialog presentation drags; the returned function re-centres it.
 */
function enableDrag(dialog: HTMLElement, header: HTMLElement): () => void {
  dialog.dataset.draggable = "";
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let dx = 0;
  let dy = 0;
  let bounds: DOMRect | null = null;

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dialog.dataset.presentation !== "dialog") return;
    if ((event.target as Element).closest("button,input,select,textarea,a")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    baseX = dx;
    baseY = dy;
    bounds = dialog.getBoundingClientRect();
    try {
      header.setPointerCapture(event.pointerId);
    } catch {
      // No active pointer (synthetic event).
    }
    event.preventDefault();
  });
  header.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || !bounds) return;
    const view = dialog.ownerDocument.defaultView;
    const width = view?.innerWidth ?? Infinity;
    const height = view?.innerHeight ?? Infinity;
    let nextX = baseX + event.clientX - startX;
    let nextY = baseY + event.clientY - startY;
    // Keep at least 48px of the dialog and the whole header reachable.
    const left = bounds.left + (nextX - baseX);
    const top = bounds.top + (nextY - baseY);
    if (left + bounds.width < 48) nextX += 48 - (left + bounds.width);
    if (left > width - 48) nextX -= left - (width - 48);
    if (top < 0) nextY -= top;
    if (top > height - header.offsetHeight) nextY -= top - (height - header.offsetHeight);
    dx = nextX;
    dy = nextY;
    dialog.style.setProperty("--raze-dialog-dx", `${Math.round(dx)}px`);
    dialog.style.setProperty("--raze-dialog-dy", `${Math.round(dy)}px`);
  });
  const end = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    bounds = null;
  };
  header.addEventListener("pointerup", end);
  header.addEventListener("pointercancel", end);
  return () => {
    pointerId = null;
    bounds = null;
    dx = 0;
    dy = 0;
    dialog.style.removeProperty("--raze-dialog-dx");
    dialog.style.removeProperty("--raze-dialog-dy");
  };
}
