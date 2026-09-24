// Left toolbar — TV chrome parity, fully composable. The item list comes from
// `options.raze.sidebar` (builtin ids, "separator", custom buttons); the
// chart-type picker honours `options.raze.chart_types`. Hidden entirely when
// `left_toolbar` is in disabled_features (minimal/chrome-less).
//
// Styling is class-based (SIDEBAR_STYLES, adopted into the root that renders
// the sidebar), icons come from the shared set in ./icons, and every button
// gets a kit tooltip instead of a `title` attribute: after 500ms of hover, on
// keyboard focus, or on a touch long-press, placed to the right of the
// sidebar, with the keyboard shortcut when the action has one (also exposed as
// `aria-keyshortcuts`). Built-in buttons carry `data-raze-item="<id>"`, the
// stable selector for them now that names are translatable and there is no
// `title`.

import type {
  ChartStyleName,
  SidebarCustomItem,
  SidebarItem,
} from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import { t } from "../i18n";
import {
  createIcon,
  fillMenuRow,
  ICON_AREA,
  ICON_BARS,
  ICON_BASELINE,
  ICON_CAMERA,
  ICON_CANDLES,
  ICON_COLUMNS,
  ICON_CURSOR,
  ICON_EXTENDED_LINE,
  ICON_FIB,
  ICON_FIT,
  ICON_FULLSCREEN,
  ICON_HEIKIN_ASHI,
  ICON_HOLLOW_CANDLES,
  ICON_HORIZONTAL_LINE,
  ICON_INDICATORS,
  ICON_LINE,
  ICON_MEASURE,
  ICON_OBJECTS,
  ICON_RAY,
  ICON_RECTANGLE,
  ICON_TEXT,
  ICON_TREND_LINE,
  ICON_VERTICAL_LINE,
  MENU_ROW_STYLES,
  type IconDef,
} from "./icons";
import { attachTooltip, type TooltipHandle } from "./kit/Tooltip";
import {
  enableToolbarKeyboardNavigation,
  isCoarsePointer,
  openPopup,
  popupRow,
  type PopupHandle,
} from "./popup";
import { setMarkup, trustedMarkup } from "./kit/safe";
import { adoptStyles, defineStyles, type StyleChunk } from "./styles";

export const LEFT_SIDEBAR_W = 42;

/** Hover (and touch long-press) delay before a sidebar tooltip shows. */
const TOOLTIP_DELAY = 500;

/**
 * Sidebar chrome. Colours resolve through the widget's `--tv-color-*`
 * variables (set on the widget root), so themes and overrides apply.
 */
export const SIDEBAR_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "left-sidebar",
  `.raze-chart-left-sidebar{display:flex;flex-direction:column;align-items:center;width:${LEFT_SIDEBAR_W}px;min-width:${LEFT_SIDEBAR_W}px;` +
  "box-sizing:border-box;padding:6px 0;gap:2px;border-right:1px solid var(--tv-color-toolbar-divider-background,#363a45);" +
  "background:var(--tv-color-platform-background,#181615);color:var(--tv-color-toolbar-button-text,#d1d4dc);" +
  // Short containers scroll the toolbar instead of clipping it (the scrollbar
  // itself is hidden by the base stylesheet).
  "user-select:none;-webkit-user-select:none;z-index:2;overflow-y:auto;overflow-x:visible;position:relative}" +
  ".raze-chart-sidebar-button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;" +
  "flex:0 0 auto;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;" +
  "touch-action:manipulation;-webkit-touch-callout:none;transition:background-color var(--raze-duration,160ms)}" +
  ".raze-chart-left-sidebar[data-coarse] .raze-chart-sidebar-button{width:38px;height:38px}" +
  "@media (hover:hover){.raze-chart-sidebar-button:hover{background:var(--tv-color-toolbar-button-background-hover,rgba(255,255,255,.08))}}" +
  ".raze-chart-sidebar-button[aria-expanded=true]{background:var(--tv-color-toolbar-button-background-hover,rgba(255,255,255,.08))}" +
  ".raze-chart-sidebar-button[aria-pressed=true],.raze-chart-sidebar-button[aria-pressed=true]:hover{" +
  "background:var(--tv-color-toolbar-button-background-active,rgba(102,216,158,.18));color:var(--tv-color-toolbar-button-text-hover,#66d89e)}" +
  ".raze-chart-sidebar-separator{flex:0 0 auto;width:22px;height:1px;margin:4px 0;background:var(--tv-color-toolbar-divider-background,#363a45)}" +
  "@media (prefers-reduced-motion:reduce){.raze-chart-sidebar-button{transition:none}}" +
  "@media (forced-colors:active){.raze-chart-sidebar-button[aria-pressed=true]{outline:2px solid Highlight;outline-offset:-2px}}",
);

export interface LeftSidebarCallbacks {
  onTool(tool: DrawingTool): void;
  onIndicatorsClick(anchor: HTMLElement): void;
  onObjectsTreeClick?(anchor: HTMLElement): void;
  onFit(): void;
  onScreenshot(): void;
  onFullscreen(): void;
  onChartType(style: ChartStyleId): void;
}

export type ChartStyleId = ChartStyleName;

const TOOL_IDS: ReadonlySet<string> = new Set([
  "cursor", "trend_line", "horizontal_line", "vertical_line", "ray", "extended_line", "measure",
  "fib_retracement", "rectangle", "text",
]);

interface BuiltinItem {
  /** Accessible name and tooltip text (translated when the button is built). */
  label(): string;
  icon: IconDef;
  /** Keyboard shortcut shown after the label in the tooltip. */
  shortcut?: string;
}

/** Builtin item id → label + icon. */
const BUILTIN: Record<string, BuiltinItem> = {
  cursor: { label: () => t("sidebar.cursor", "Cursor / pan"), icon: ICON_CURSOR },
  trend_line: { label: () => t("sidebar.trendLine", "Trend line"), icon: ICON_TREND_LINE },
  horizontal_line: { label: () => t("sidebar.horizontalLine", "Horizontal line"), icon: ICON_HORIZONTAL_LINE },
  fib_retracement: { label: () => t("sidebar.fibRetracement", "Fib retracement"), icon: ICON_FIB },
  rectangle: { label: () => t("sidebar.rectangle", "Rectangle"), icon: ICON_RECTANGLE },
  text: { label: () => t("sidebar.text", "Text"), icon: ICON_TEXT },
  vertical_line: { label: () => t("sidebar.verticalLine", "Vertical line"), icon: ICON_VERTICAL_LINE },
  ray: { label: () => t("sidebar.ray", "Ray"), icon: ICON_RAY },
  extended_line: { label: () => t("sidebar.extendedLine", "Extended line"), icon: ICON_EXTENDED_LINE },
  measure: { label: () => t("sidebar.measure", "Measure"), icon: ICON_MEASURE },
  objects_tree: { label: () => t("sidebar.objectsTree", "Objects tree"), icon: ICON_OBJECTS },
  indicators: { label: () => t("sidebar.indicators", "Indicators"), icon: ICON_INDICATORS },
  // F fits the chart while the chart canvas has keyboard focus.
  fit: { label: () => t("sidebar.fit", "Fit content"), icon: ICON_FIT, shortcut: "F" },
  screenshot: { label: () => t("sidebar.screenshot", "Screenshot"), icon: ICON_CAMERA },
  fullscreen: { label: () => t("sidebar.fullscreen", "Fullscreen"), icon: ICON_FULLSCREEN },
  chart_type: { label: () => t("sidebar.chartType", "Chart type"), icon: ICON_CANDLES },
};

/** The stock layout — what you get with no `raze.sidebar` option. */
export const DEFAULT_SIDEBAR_ITEMS: SidebarItem[] = [
  "cursor", "trend_line", "horizontal_line", "vertical_line", "ray", "extended_line", "measure",
  "fib_retracement", "rectangle", "text",
  "separator",
  "indicators", "objects_tree",
  "separator",
  "fit", "screenshot", "fullscreen",
  "separator",
  "chart_type",
];

interface ChartStyleEntry {
  id: ChartStyleId;
  label(): string;
  icon: IconDef;
}

const ALL_CHART_STYLES: ChartStyleEntry[] = [
  { id: "candles", label: () => t("chartType.candles", "Candles"), icon: ICON_CANDLES },
  { id: "line", label: () => t("chartType.line", "Line"), icon: ICON_LINE },
  { id: "area", label: () => t("chartType.area", "Area"), icon: ICON_AREA },
  { id: "heikin_ashi", label: () => t("chartType.heikinAshi", "Heikin Ashi"), icon: ICON_HEIKIN_ASHI },
  { id: "bars", label: () => t("chartType.bars", "Bars"), icon: ICON_BARS },
  { id: "hollow_candles", label: () => t("chartType.hollowCandles", "Hollow candles"), icon: ICON_HOLLOW_CANDLES },
  { id: "baseline", label: () => t("chartType.baseline", "Baseline"), icon: ICON_BASELINE },
  { id: "columns", label: () => t("chartType.columns", "Columns"), icon: ICON_COLUMNS },
];

export class LeftSidebar {
  readonly el: HTMLDivElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private styleBtn: HTMLButtonElement | null = null;
  private stylePanel: PopupHandle | null = null;
  private activeTool: DrawingTool = "cursor";
  private chartStyle: ChartStyleId = "candles";
  private readonly chartStyles: ChartStyleEntry[];
  private readonly tooltips = new Map<HTMLButtonElement, TooltipHandle>();
  private removeKeyboardNavigation: () => void;

  constructor(
    private readonly context: ChartContext,
    private readonly cbs: LeftSidebarCallbacks,
    items: SidebarItem[] = DEFAULT_SIDEBAR_ITEMS,
    chartTypes?: ChartStyleName[],
  ) {
    this.chartStyles = chartTypes
      ? ALL_CHART_STYLES.filter((s) => chartTypes.includes(s.id))
      : ALL_CHART_STYLES;

    this.el = document.createElement("div");
    this.el.className = "raze-chart-left-sidebar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", t("sidebar.label", "Drawing and chart tools"));
    this.el.setAttribute("aria-orientation", "vertical");
    // Finger-sized buttons on touch-capable devices (decided once, like the
    // rest of the chrome's touch sizing).
    if (isCoarsePointer()) this.el.dataset.coarse = "";
    // Install the styles in the document now, and in the shadow root the
    // sidebar is mounted into once the caller has appended it.
    adoptStyles(document, SIDEBAR_STYLES);
    queueMicrotask(() => {
      if (this.el.isConnected) adoptStyles(this.el, SIDEBAR_STYLES);
    });

    for (const item of items) {
      this.appendItem(item);
    }

    this.setTool("cursor");
    this.setChartStyle("candles");
    this.removeKeyboardNavigation = enableToolbarKeyboardNavigation(this.el, "vertical");
  }

  private appendItem(item: SidebarItem): void {
    if (item === "separator") {
      this.addSep();
      return;
    }
    if (typeof item !== "string") {
      this.appendCustom(item);
      return;
    }
    const def = BUILTIN[item];
    if (!def) {
      console.warn(`[raze-charts] unknown sidebar item: ${item}`);
      return;
    }
    const label = def.label();
    const b = this.mkBtn(label, def.shortcut);
    // Locale-independent hook for code that needs a built-in button (the
    // accessible name is translated, so never select by aria-label).
    b.dataset.razeItem = item;
    b.appendChild(createIcon(def.icon));
    if (item === "chart_type") {
      this.styleBtn = b;
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.stylePanel) this.closeStylePanel();
        else this.openStylePanel();
      });
      this.el.appendChild(b);
      return;
    }
    this.toolBtns.set(item, b);
    if (item === "indicators") {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cbs.onIndicatorsClick(b);
      });
    } else if (item === "objects_tree") {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cbs.onObjectsTreeClick?.(b);
      });
    } else if (item === "fit") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFit(); });
    } else if (item === "screenshot") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onScreenshot(); });
    } else if (item === "fullscreen") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFullscreen(); });
    } else {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setTool(item as DrawingTool);
        this.cbs.onTool(item as DrawingTool);
      });
    }
    this.el.appendChild(b);
  }

  private appendCustom(item: SidebarCustomItem): void {
    const b = this.mkBtn(item.title);
    const icon = item.icon;
    if (typeof icon === "string") setMarkup(b, trustedMarkup(icon));
    else if ((icon as Node | null)?.nodeType === 1) b.appendChild(icon.cloneNode(true));
    else console.warn(`[raze-charts] sidebar item "${item.title}": icon must be SVG/HTML markup or an Element; the button has no icon.`);
    for (const svg of b.querySelectorAll("svg")) {
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
    }
    b.dataset.customId = item.id;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        item.onClick();
      } catch (err) {
        console.warn(`[raze-charts] sidebar item "${item.id}" onClick failed`, err);
      }
    });
    this.toolBtns.set(item.id, b);
    this.el.appendChild(b);
  }

  /** An icon button labelled `title`, with its tooltip (plus `shortcut`). */
  private mkBtn(title: string, shortcut?: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", title);
    b.className = "raze-chart-sidebar-button raze-chart-focusable";
    // The shortcut is exposed semantically as well as in the tooltip text.
    if (shortcut) b.setAttribute("aria-keyshortcuts", shortcut);
    // An em space keeps the shortcut visually apart (the tooltip collapses
    // ordinary runs of spaces); assistive technology reads "Fit content F".
    this.addTooltip(b, shortcut ? `${title}\u2003${shortcut}` : title);
    return b;
  }

  /**
   * Kit tooltip to the right of the sidebar. The kit covers hover (after
   * TOOLTIP_DELAY), keyboard focus, Escape and aria-describedby; touch gets a
   * long-press here, which shows the tooltip instead of activating the button.
   */
  private addTooltip(b: HTMLButtonElement, text: string): void {
    // No tooltip on top of the button's own open menu (registered before the
    // kit's listener so it can stop it).
    b.addEventListener("pointerenter", (e) => {
      if (b.getAttribute("aria-expanded") === "true") e.stopImmediatePropagation();
    });
    const tip = attachTooltip(b, text, { placement: "right", delay: TOOLTIP_DELAY });
    this.tooltips.set(b, tip);
    let timer = 0;
    let longPressed = false;
    const cancel = (): void => {
      window.clearTimeout(timer);
      timer = 0;
    };
    b.addEventListener("pointerdown", (e) => {
      cancel();
      longPressed = false;
      if (e.pointerType !== "touch") return;
      timer = window.setTimeout(() => {
        timer = 0;
        longPressed = true;
        tip.show();
      }, TOOLTIP_DELAY);
    });
    b.addEventListener("pointerup", cancel);
    b.addEventListener("pointercancel", cancel);
    // The press that revealed the tooltip neither opens the platform's
    // long-press menu nor activates the button.
    b.addEventListener("contextmenu", (e) => {
      if (longPressed || timer) e.preventDefault();
    });
    b.addEventListener("click", (e) => {
      if (!longPressed) return;
      longPressed = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  private addSep(): void {
    const s = document.createElement("div");
    s.className = "raze-chart-sidebar-separator";
    s.setAttribute("role", "separator");
    s.setAttribute("aria-orientation", "horizontal");
    this.el.appendChild(s);
  }

  setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    for (const [id, b] of this.toolBtns) {
      if (!TOOL_IDS.has(id)) continue;
      const on = id === tool;
      b.setAttribute("aria-pressed", String(on));
      b.dataset.active = on ? "1" : "0";
    }
  }

  getTool(): DrawingTool {
    return this.activeTool;
  }

  setChartStyle(style: ChartStyleId): void {
    this.chartStyle = style;
    if (!this.styleBtn) return;
    const def = this.chartStyles.find((s) => s.id === style) ?? ALL_CHART_STYLES.find((s) => s.id === style);
    if (!def) return;
    this.styleBtn.replaceChildren(createIcon(def.icon));
    const label = t("sidebar.chartTypeValue", "Chart type: {style}", { style: def.label() });
    this.styleBtn.setAttribute("aria-label", label);
    this.tooltips.get(this.styleBtn)?.update(label);
  }

  private openStylePanel(): void {
    if (!this.styleBtn) return;
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-style-menu",
      minWidth: 140,
      anchor: this.styleBtn,
      place: "right-start",
      role: "menu",
      label: t("sidebar.chartType", "Chart type"),
      onClose: () => {
        if (this.stylePanel === popup) this.stylePanel = null;
      },
    });
    this.stylePanel = popup;
    adoptStyles(popup.el, MENU_ROW_STYLES);
    for (const s of this.chartStyles) {
      const on = s.id === this.chartStyle;
      const label = s.label();
      const row = popupRow(
        "",
        () => {
          this.setChartStyle(s.id);
          this.cbs.onChartType(s.id);
          this.closeStylePanel();
        },
        { role: "menuitemradio", checked: on, label },
      );
      popup.el.appendChild(fillMenuRow(row, { checked: on, icon: s.icon, label }));
    }
    popup.reposition();
  }

  private closeStylePanel(): void {
    this.stylePanel?.close();
    this.stylePanel = null;
  }

  destroy(): void {
    this.closeStylePanel();
    for (const tip of this.tooltips.values()) tip.destroy();
    this.tooltips.clear();
    this.removeKeyboardNavigation();
    this.el.remove();
  }
}
