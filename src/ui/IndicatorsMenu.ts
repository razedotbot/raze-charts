// Toolbar "Indicators" dropdown — add/remove EMA/SMA/RSI without calling
// createStudy from the host app (TV chrome parity).

import type { ChartContext } from "../core/context";
import type { StudyStore, StudyKind } from "../studies/StudyStore";

interface Preset {
  label: string;
  kind: StudyKind;
  length: number;
  color: string;
}

const PRESETS: Preset[] = [
  { label: "EMA 9", kind: "EMA", length: 9, color: "#f5a623" },
  { label: "EMA 21", kind: "EMA", length: 21, color: "#26a69a" },
  { label: "SMA 20", kind: "SMA", length: 20, color: "#2962ff" },
  { label: "SMA 50", kind: "SMA", length: 50, color: "#e040fb" },
  { label: "RSI 14", kind: "RSI", length: 14, color: "#7E57C2" },
];

export class IndicatorsMenu {
  private btn: HTMLElement;
  private panel: HTMLDivElement | null = null;
  private onDoc: ((e: MouseEvent) => void) | null = null;

  constructor(
    private readonly context: ChartContext,
    private readonly studies: StudyStore,
    hostBtn: HTMLElement,
  ) {
    this.btn = hostBtn;
    this.btn.textContent = "Indicators";
    this.btn.title = "Add / remove indicators";
    this.btn.style.cssText += [
      "display:flex",
      "align-items:center",
      "height:26px",
      "padding:0 10px",
      "margin:0 1px",
      "border-radius:4px",
      "cursor:pointer",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      "font-size:12px",
      "letter-spacing:0.02em",
    ].join(";");
    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.panel) this.close();
      else this.open();
    });
  }

  private open(): void {
    const panel = document.createElement("div");
    panel.className = "raze-chart-indicators-menu";
    panel.style.cssText = [
      "position:absolute",
      "top:100%",
      "left:0",
      "margin-top:4px",
      "min-width:160px",
      "padding:6px 0",
      "border-radius:6px",
      "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-pane-background, #181615)",
      "box-shadow:0 8px 24px rgba(0,0,0,0.45)",
      "z-index:20",
      `font-family:${this.context.fontFamily}`,
      "font-size:12px",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
    ].join(";");

    const activeKey = new Set(
      this.studies.list().map((s) => `${s.kind}:${s.length}`),
    );

    for (const p of PRESETS) {
      const row = document.createElement("button");
      row.type = "button";
      const key = `${p.kind}:${p.length}`;
      const on = activeKey.has(key);
      row.textContent = on ? `✓ ${p.label}` : p.label;
      row.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "width:100%",
        "border:0",
        "background:transparent",
        "color:inherit",
        "padding:7px 12px",
        "cursor:pointer",
        "text-align:left",
        on ? "font-weight:600" : "font-weight:400",
      ].join(";");
      const swatch = document.createElement("span");
      swatch.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};`;
      row.prepend(swatch);
      row.addEventListener("mouseenter", () => {
        row.style.background = "rgba(255,255,255,0.06)";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (on) {
          for (const s of this.studies.list()) {
            if (s.kind === p.kind && s.length === p.length) this.studies.remove(s.id);
          }
        } else {
          this.studies.add({ kind: p.kind, length: p.length, color: p.color });
        }
        this.close();
        this.open(); // refresh checkmarks
      });
      panel.appendChild(row);
    }

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear all";
    clear.style.cssText =
      "display:block;width:100%;border:0;border-top:1px solid #363a45;background:transparent;color:#8b887e;padding:8px 12px;cursor:pointer;text-align:left;margin-top:4px;";
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      this.studies.clear();
      this.close();
    });
    panel.appendChild(clear);

    // Position relative to button's offsetParent (toolbar).
    this.btn.style.position = "relative";
    this.btn.appendChild(panel);
    this.panel = panel;

    this.onDoc = (ev: MouseEvent) => {
      if (!this.panel) return;
      if (ev.target instanceof Node && (this.btn.contains(ev.target) || this.panel.contains(ev.target))) {
        return;
      }
      this.close();
    };
    setTimeout(() => document.addEventListener("click", this.onDoc!), 0);
  }

  private close(): void {
    this.panel?.remove();
    this.panel = null;
    if (this.onDoc) {
      document.removeEventListener("click", this.onDoc);
      this.onDoc = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
