// Price-scale toggles (% / log / auto) in the corner cell where the price axis
// meets the time axis, so they never cover the plot, the volume bars or a
// price label. The cell is at least PRICE_AXIS_W_MIN wide and TIME_AXIS_H
// tall, so the toggles use compact glyphs (% · L · A) on an opaque axis
// background, with full accessible names and tooltips.
//
// State: every writer changes the scale through `context.setScaleMode()`, and
// the toggles follow `context.scaleChanged`, so aria-pressed tells the truth
// after clicks, `load()`, axis drags, double-click resets and API calls. Until
// every legacy writer is routed through the setter (W2-02 adds the lint that
// forbids direct writes), the bar also reconciles after chart interactions
// and data changes; syncing is idempotent and touches the DOM only on change.

import type { ChartContext, ScaleModePatch } from "../core/context";
import { readScaleState } from "../core/context";
import { PRICE_AXIS_W_MIN, TIME_AXIS_H } from "../engine/layout";
import { t } from "../i18n";
import { attachTooltip, type TooltipHandle } from "./kit/Tooltip";
import { enableToolbarKeyboardNavigation } from "./popup";
import { adoptStylesOnConnect, defineStyles, TOKEN_STYLES, type StyleChunk } from "./styles";

/**
 * Clearance kept above the toggles so the lowest price label (painted down to
 * a few pixels below the plot) never touches them.
 */
const LABEL_CLEARANCE = 4;

export const SCALE_BAR_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "scale-bar",
  `.raze-chart-scale-bar{position:absolute;right:0;bottom:0;z-index:4;box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:1px;` +
  `height:${TIME_AXIS_H - LABEL_CLEARANCE}px;max-width:${PRICE_AXIS_W_MIN - 1}px;padding:1px 2px 2px;` +
  "background:var(--raze-scale-bar-background,var(--tv-color-pane-background,#131722));color:var(--raze-scale-bar-text,var(--raze-toolbar-text));" +
  "font-size:var(--raze-font-size-sm);line-height:1;user-select:none;-webkit-user-select:none;pointer-events:auto}" +
  ":where(.raze-chart-scale-btn){appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;box-sizing:border-box;" +
  "min-width:15px;height:100%;margin:0;padding:0 3px;border:0;border-radius:var(--raze-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}" +
  "@media (hover:hover){:where(.raze-chart-scale-btn):hover{background:var(--raze-toolbar-hover)}}" +
  ":where(.raze-chart-scale-btn)[aria-pressed=\"true\"]{background:var(--raze-active);color:var(--raze-accent);font-weight:600}" +
  ".raze-chart-scale-btn.raze-chart-focusable:focus-visible{outline-offset:-1px}",
);

type ToggleId = "percent" | "log" | "auto";

/** Interactions after which a legacy writer may have changed the scale. */
const HOST_EVENTS = ["pointerdown", "pointerup", "dblclick", "keydown", "click"] as const;

export class ScaleBar {
  readonly el: HTMLDivElement;
  private pctBtn: HTMLButtonElement;
  private logBtn: HTMLButtonElement;
  private autoBtn: HTMLButtonElement;
  private removeKeyboardNavigation: () => void;
  private stopStyles: () => void;
  private tooltips: TooltipHandle[] = [];
  private host: Element | null = null;
  private reconcileQueued = false;
  private destroyed = false;
  private readonly owner = {};
  private readonly scheduleSync = (): void => {
    if (this.reconcileQueued || this.destroyed) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      if (!this.destroyed) this.sync();
    });
  };

  constructor(
    private readonly context: ChartContext,
    private readonly onChange: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-scale-bar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", t("scaleBar.label", "Price scale"));
    this.el.setAttribute("aria-orientation", "horizontal");

    this.pctBtn = this.mk("%", t("scaleBar.percent", "Percent scale"));
    this.logBtn = this.mk(t("scaleBar.log.short", "L"), t("scaleBar.log", "Logarithmic scale"));
    this.autoBtn = this.mk(t("scaleBar.auto.short", "A"), t("scaleBar.auto", "Auto-scale price (double-click axis)"));
    this.bind(this.pctBtn, "percent");
    this.bind(this.logBtn, "log");
    this.bind(this.autoBtn, "auto");

    this.el.append(this.pctBtn, this.logBtn, this.autoBtn);
    this.stopStyles = adoptStylesOnConnect(this.el, [TOKEN_STYLES, SCALE_BAR_STYLES]);
    this.removeKeyboardNavigation = enableToolbarKeyboardNavigation(this.el, "horizontal");
    this.subscribe();
    this.sync();
    // The widget appends the bar right after constructing it; watch the chart
    // it belongs to from then on.
    queueMicrotask(() => this.watchHost());
  }

  private mk(glyph: string, name: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = glyph;
    b.setAttribute("aria-label", name);
    b.setAttribute("aria-pressed", "false");
    b.className = "raze-chart-scale-btn raze-chart-focusable";
    this.tooltips.push(attachTooltip(b, name, { placement: "top" }));
    return b;
  }

  private bind(button: HTMLButtonElement, id: ToggleId): void {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle(id);
    });
  }

  /** Apply one toggle through the reason-tagged setter. */
  private toggle(id: ToggleId): void {
    const state = readScaleState(this.context);
    let patch: ScaleModePatch;
    if (id === "percent") patch = { mode: state.mode === "percent" ? "normal" : "percent", autoScale: true };
    else if (id === "log") patch = { mode: state.mode === "log" ? "normal" : "log", autoScale: true };
    else patch = { autoScale: true };
    this.context.setScaleMode(patch, "scale-bar");
    this.sync();
    this.onChange();
  }

  private subscribe(): void {
    const sync = this.scheduleSync as (...args: never[]) => void;
    this.context.scaleChanged?.subscribe(this.owner, (() => this.sync()) as (...args: never[]) => void);
    this.context.dataChanged?.subscribe(this.owner, sync);
    this.context.viewportChanged?.subscribe(this.owner, sync);
  }

  /**
   * Reconcile after interactions anywhere in the widget (legacy direct
   * writers). Bubble phase, so the chart's own handlers have run first.
   */
  private watchHost(): void {
    if (this.destroyed || this.host) return;
    const host = this.el.closest(".raze-chart-root") ?? this.el.parentElement;
    if (!host) return;
    this.host = host;
    for (const type of HOST_EVENTS) host.addEventListener(type, this.scheduleSync);
    this.sync();
  }

  /** Reflect the context's scale state (and the axis colours) on the toggles. */
  sync(): void {
    const theme = this.context.theme;
    if (theme) {
      setVar(this.el, "--raze-scale-bar-background", theme.scaleBackground);
      setVar(this.el, "--raze-scale-bar-text", theme.scaleText);
    }
    const state = readScaleState(this.context);
    setPressed(this.pctBtn, state.mode === "percent");
    setPressed(this.logBtn, state.mode === "log");
    setPressed(this.autoBtn, state.autoScale && !state.priceRange);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.context.scaleChanged?.unsubscribeAll(this.owner);
    this.context.dataChanged?.unsubscribeAll(this.owner);
    this.context.viewportChanged?.unsubscribeAll(this.owner);
    if (this.host) {
      for (const type of HOST_EVENTS) this.host.removeEventListener(type, this.scheduleSync);
      this.host = null;
    }
    for (const tooltip of this.tooltips) tooltip.destroy();
    this.tooltips = [];
    this.stopStyles();
    this.removeKeyboardNavigation();
    this.el.remove();
  }
}

function setPressed(button: HTMLButtonElement, on: boolean): void {
  const value = String(on);
  if (button.getAttribute("aria-pressed") !== value) button.setAttribute("aria-pressed", value);
}

function setVar(el: HTMLElement, name: string, value: string | undefined): void {
  if (value && el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}
