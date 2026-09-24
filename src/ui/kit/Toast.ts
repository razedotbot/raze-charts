// Transient notifications ("Layout saved", "Alert triggered", load errors).
// Toasts stack bottom-centre above the safe area inside a named region, are
// announced through persistent live regions (polite for info/success,
// assertive for warnings/errors), pause while hovered or focused, and can
// carry one action. At most three stay visible.

import { t } from "../../i18n";
import { defineStyles, type StyleChunk } from "../styles";
import { createPortal, portalContainerFor, type Portal } from "./portal";
import { button, ICON_CLOSE, iconButton, SURFACE_STYLES } from "./surface";

export const TOAST_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-toast",
  ".raze-kit-toasts{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);" +
  "display:flex;flex-direction:column;align-items:center;gap:8px;width:max-content;max-width:calc(100vw - 32px);pointer-events:none}" +
  ".raze-kit-toast-live{display:contents}" +
  ".raze-kit-toast{display:flex;align-items:center;gap:10px;min-height:40px;max-width:480px;padding:6px 6px 6px 14px;pointer-events:auto;" +
  "border-inline-start:3px solid var(--raze-toast-accent,var(--raze-accent,#2962ff));animation:raze-kit-toast-in .2s ease-out}" +
  ".raze-kit-toast[data-kind=success]{--raze-toast-accent:var(--raze-success,#089981)}" +
  ".raze-kit-toast[data-kind=warning]{--raze-toast-accent:var(--raze-warning,#f7a600)}" +
  ".raze-kit-toast[data-kind=error]{--raze-toast-accent:var(--raze-danger,#f23645)}" +
  ".raze-kit-toast-message{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}" +
  ".raze-kit-toast .raze-kit-button{min-height:28px;padding:0 10px}" +
  "@keyframes raze-kit-toast-in{from{opacity:0;transform:translateY(8px)}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-toast{animation:none}}",
);

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  /** Auto-dismiss after this many ms (default 5000; errors 8000). `0` keeps it until dismissed. */
  duration?: number;
  action?: { label: string; onAction(): void };
  /** Element inside the chart (portal root and theme). */
  anchor?: Element | null;
  themeRoot?: Element | null;
}

export interface ToastHandle {
  readonly el: HTMLElement;
  close(): void;
}

interface Region {
  portal: Portal;
  region: HTMLElement;
  polite: HTMLElement;
  assertive: HTMLElement;
  toasts: ToastHandle[];
}

const MAX_VISIBLE = 3;
const regions = new Set<Region>();

function regionFor(options: ToastOptions): { region: Region; fresh: boolean } {
  // One region per container (document body, fullscreen element or shadow
  // root); portals re-home on fullscreen changes, so match by current parent.
  const container = portalContainerFor(options.anchor ?? null);
  for (const region of regions) {
    if (region.portal.el.parentNode === container) return { region, fresh: false };
  }
  const portal = createPortal({ anchor: options.anchor, themeRoot: options.themeRoot });
  portal.adopt([SURFACE_STYLES, TOAST_STYLES]);
  const doc = portal.el.ownerDocument;
  const region = doc.createElement("section");
  region.className = "raze-kit-toasts";
  region.setAttribute("aria-label", t("kit.toast.region", "Notifications"));
  const live = (politeness: "polite" | "assertive"): HTMLElement => {
    const element = doc.createElement("div");
    element.className = "raze-kit-toast-live";
    element.setAttribute("aria-live", politeness);
    element.setAttribute("aria-relevant", "additions");
    return element;
  };
  const polite = live("polite");
  const assertive = live("assertive");
  region.append(polite, assertive);
  portal.el.appendChild(region);
  const created: Region = { portal, region, polite, assertive, toasts: [] };
  regions.add(created);
  return { region: created, fresh: true };
}

/** Show a notification. Returns a handle to close it early. */
export function showToast(message: string, options: ToastOptions = {}): ToastHandle {
  const kind = options.kind ?? "info";
  const { region, fresh } = regionFor(options);
  const doc = region.region.ownerDocument;
  const el = doc.createElement("div");
  el.className = "raze-kit-surface raze-kit-toast";
  el.dataset.kind = kind;
  const text = doc.createElement("span");
  text.className = "raze-kit-toast-message";
  text.textContent = message;
  el.appendChild(text);

  let closed = false;
  let timer = 0;
  let remaining = options.duration ?? (kind === "error" ? 8000 : 5000);
  let startedAt = 0;

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    el.remove();
    region.toasts = region.toasts.filter((toast) => toast !== handle);
    if (!region.toasts.length) {
      region.portal.destroy();
      regions.delete(region);
    }
  };
  const start = (): void => {
    if (closed || remaining <= 0 || !Number.isFinite(remaining)) return;
    startedAt = Date.now();
    timer = window.setTimeout(close, remaining);
  };
  const pause = (): void => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
    remaining = Math.max(1000, remaining - (Date.now() - startedAt));
  };

  if (options.action) {
    const { label, onAction } = options.action;
    const actionButton = button(doc, label, { variant: "ghost" });
    actionButton.addEventListener("click", () => {
      try {
        onAction();
      } finally {
        close();
      }
    });
    el.appendChild(actionButton);
  }
  const dismiss = iconButton(doc, t("kit.toast.dismiss", "Dismiss notification"), ICON_CLOSE);
  dismiss.addEventListener("click", close);
  el.appendChild(dismiss);
  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", start);
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", (event) => {
    if (!el.contains(event.relatedTarget as Node | null)) start();
  });

  const handle: ToastHandle = { el, close };
  region.toasts.push(handle);
  while (region.toasts.length > MAX_VISIBLE) region.toasts[0]!.close();

  const live = kind === "error" || kind === "warning" ? region.assertive : region.polite;
  const insert = (): void => {
    if (closed) return;
    live.appendChild(el);
    start();
  };
  // A live region must exist before content is added for it to be announced.
  if (fresh) window.setTimeout(insert, 50);
  else insert();
  return handle;
}
