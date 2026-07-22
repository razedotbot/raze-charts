// Left drawing toolbar — TV chrome parity. Hosts tool picker + Indicators
// trigger. Hidden when `left_toolbar` is in disabled_features (minimal/chrome-less).

import type { ChartContext } from "../core/context";
import type { DrawingTool } from "../core/context";

export const LEFT_SIDEBAR_W = 42;

export interface LeftSidebarCallbacks {
  onTool(tool: DrawingTool): void;
  onIndicatorsClick(anchor: HTMLElement): void;
  onFit(): void;
  onScreenshot(): void;
  onFullscreen(): void;
  onChartType(style: ChartStyleId): void;
}

export type ChartStyleId = "candles" | "line" | "area" | "heikin_ashi";

interface ToolDef {
  id: DrawingTool | "indicators" | "fit" | "screenshot" | "fullscreen";
  title: string;
  svg: string;
  group: "tools" | "studies" | "actions";
}

const ICON = {
  cursor: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 2.5L4 14.5L7.2 11.2L9.1 15.5L11 14.7L9.1 10.4L13.5 10.4L4 2.5Z" fill="currentColor"/></svg>`,
  trend: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14L8 8L11 11L15 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="4" r="1.4" fill="currentColor"/><circle cx="3" cy="14" r="1.4" fill="currentColor"/></svg>`,
  hline: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 9H16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 5V13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.35"/></svg>`,
  fib: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 3.5H15M3 7H15M3 11H15M3 14.5H15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3 3.5V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  rect: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3.5" y="4.5" width="11" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`,
  text: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4.5H14M9 4.5V14.5M6.5 14.5H11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  indicators: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 12.5L6.5 8.5L9.5 11L15 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14.5H15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.4"/></svg>`,
  fit: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 6V3.5H6M12 3.5H15V6M15 12V14.5H12M6 14.5H3V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  camera: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2.5" y="5" width="13" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="9.5" r="2.4" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 5L7.5 3.5H10.5L11.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fullscreen: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 6.5V3.5H6M12 3.5H15V6.5M15 11.5V14.5H12M6 14.5H3V11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  candles: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 3V15M5 6H7V12H3V6H5ZM13 3V15M13 5H15V11H11V5H13Z" fill="currentColor"/></svg>`,
};

const TOOLS: ToolDef[] = [
  { id: "cursor", title: "Cursor / pan", svg: ICON.cursor, group: "tools" },
  { id: "trend_line", title: "Trend line", svg: ICON.trend, group: "tools" },
  { id: "horizontal_line", title: "Horizontal line", svg: ICON.hline, group: "tools" },
  { id: "fib_retracement", title: "Fib retracement", svg: ICON.fib, group: "tools" },
  { id: "rectangle", title: "Rectangle", svg: ICON.rect, group: "tools" },
  { id: "text", title: "Text", svg: ICON.text, group: "tools" },
  { id: "indicators", title: "Indicators", svg: ICON.indicators, group: "studies" },
  { id: "fit", title: "Fit content (F)", svg: ICON.fit, group: "actions" },
  { id: "screenshot", title: "Screenshot", svg: ICON.camera, group: "actions" },
  { id: "fullscreen", title: "Fullscreen", svg: ICON.fullscreen, group: "actions" },
];

const CHART_STYLES: { id: ChartStyleId; title: string; svg: string }[] = [
  { id: "candles", title: "Candles", svg: ICON.candles },
  {
    id: "line",
    title: "Line",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2.5 12.5L6.5 7.5L10 10.5L15.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    id: "area",
    title: "Area",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2.5 13.5L6.5 8L10 11L15.5 4.5V13.5H2.5Z" fill="currentColor" opacity="0.35"/><path d="M2.5 13.5L6.5 8L10 11L15.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    id: "heikin_ashi",
    title: "Heikin Ashi",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="4" y="5" width="4" height="8" rx="0.5" fill="currentColor"/><rect x="10" y="3" width="4" height="10" rx="0.5" fill="currentColor" opacity="0.55"/></svg>`,
  },
];

export class LeftSidebar {
  readonly el: HTMLDivElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private styleBtn: HTMLButtonElement;
  private stylePanel: HTMLDivElement | null = null;
  private activeTool: DrawingTool = "cursor";
  private chartStyle: ChartStyleId = "candles";
  private onDoc: ((e: MouseEvent) => void) | null = null;

  constructor(
    private readonly context: ChartContext,
    private readonly cbs: LeftSidebarCallbacks,
  ) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-left-sidebar";
    this.el.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      `width:${LEFT_SIDEBAR_W}px`,
      "min-width:" + LEFT_SIDEBAR_W + "px",
      "box-sizing:border-box",
      "padding:6px 0",
      "gap:2px",
      "border-right:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-platform-background, #181615)",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      "user-select:none",
      "z-index:2",
      "overflow:visible",
      "position:relative",
    ].join(";");

    const mkBtn = (title: string, svg: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      b.innerHTML = svg;
      b.style.cssText = [
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "width:32px",
        "height:32px",
        "border:0",
        "border-radius:6px",
        "background:transparent",
        "color:inherit",
        "cursor:pointer",
        "padding:0",
        "flex:0 0 auto",
      ].join(";");
      b.addEventListener("mouseenter", () => {
        if (b.dataset.active !== "1") b.style.background = "rgba(255,255,255,0.06)";
      });
      b.addEventListener("mouseleave", () => {
        if (b.dataset.active !== "1") b.style.background = "transparent";
      });
      return b;
    };

    const addSep = (): void => {
      const s = document.createElement("div");
      s.style.cssText = "width:22px;height:1px;background:var(--tv-color-toolbar-divider-background,#363a45);margin:4px 0;";
      this.el.appendChild(s);
    };

    let lastGroup: string | null = null;
    for (const t of TOOLS) {
      if (lastGroup && lastGroup !== t.group) addSep();
      lastGroup = t.group;
      const b = mkBtn(t.title, t.svg);
      this.toolBtns.set(t.id, b);
      if (t.id === "indicators") {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.cbs.onIndicatorsClick(b);
        });
      } else if (t.id === "fit") {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFit(); });
      } else if (t.id === "screenshot") {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onScreenshot(); });
      } else if (t.id === "fullscreen") {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFullscreen(); });
      } else {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setTool(t.id as DrawingTool);
          this.cbs.onTool(t.id as DrawingTool);
        });
      }
      this.el.appendChild(b);
    }

    addSep();
    this.styleBtn = mkBtn("Chart type", ICON.candles);
    this.styleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.stylePanel) this.closeStylePanel();
      else this.openStylePanel();
    });
    this.el.appendChild(this.styleBtn);

    this.setTool("cursor");
    this.setChartStyle("candles");
  }

  setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    for (const [id, b] of this.toolBtns) {
      const isTool = id === "cursor" || id === "trend_line" || id === "horizontal_line"
        || id === "fib_retracement" || id === "rectangle" || id === "text";
      if (!isTool) continue;
      const on = id === tool;
      b.dataset.active = on ? "1" : "0";
      b.style.background = on ? "rgba(102,216,158,0.18)" : "transparent";
      b.style.color = on ? "#66d89e" : "inherit";
    }
  }

  getTool(): DrawingTool {
    return this.activeTool;
  }

  setChartStyle(style: ChartStyleId): void {
    this.chartStyle = style;
    const def = CHART_STYLES.find((s) => s.id === style) ?? CHART_STYLES[0]!;
    this.styleBtn.innerHTML = def.svg;
    this.styleBtn.title = `Chart type: ${def.title}`;
  }

  private openStylePanel(): void {
    const panel = document.createElement("div");
    panel.style.cssText = [
      "position:absolute",
      "left:100%",
      "bottom:8px",
      "margin-left:6px",
      "min-width:140px",
      "padding:6px 0",
      "border-radius:6px",
      "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-pane-background, #181615)",
      "box-shadow:0 8px 24px rgba(0,0,0,0.45)",
      "z-index:30",
      `font-family:${this.context.fontFamily}`,
      "font-size:12px",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
    ].join(";");
    for (const s of CHART_STYLES) {
      const row = document.createElement("button");
      row.type = "button";
      const on = s.id === this.chartStyle;
      row.innerHTML = `<span style="display:inline-flex;width:18px;margin-right:8px;color:${on ? "#66d89e" : "inherit"}">${s.svg}</span>${on ? "✓ " : ""}${s.title}`;
      row.style.cssText = "display:flex;align-items:center;width:100%;border:0;background:transparent;color:inherit;padding:7px 12px;cursor:pointer;text-align:left;";
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.06)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setChartStyle(s.id);
        this.cbs.onChartType(s.id);
        this.closeStylePanel();
      });
      panel.appendChild(row);
    }
    this.el.appendChild(panel);
    this.stylePanel = panel;
    this.onDoc = (ev: MouseEvent) => {
      if (ev.target instanceof Node && (this.el.contains(ev.target))) return;
      this.closeStylePanel();
    };
    setTimeout(() => document.addEventListener("click", this.onDoc!), 0);
  }

  private closeStylePanel(): void {
    this.stylePanel?.remove();
    this.stylePanel = null;
    if (this.onDoc) {
      document.removeEventListener("click", this.onDoc);
      this.onDoc = null;
    }
  }

  destroy(): void {
    this.closeStylePanel();
    this.el.remove();
  }
}
