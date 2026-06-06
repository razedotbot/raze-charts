// Overlay shown until the first bars resolve. Mirrors TV's loading_screen
// option { backgroundColor, foregroundColor } with a small spinner.

import type { LoadingScreenOptions } from "../types/charting_library";

export class LoadingScreen {
  readonly el: HTMLDivElement;
  private spinner: HTMLDivElement;

  constructor(opts: LoadingScreenOptions | undefined, fallbackBg: string) {
    const bg = opts?.backgroundColor ?? fallbackBg;
    const fg = opts?.foregroundColor ?? "#2962ff";

    this.el = document.createElement("div");
    this.el.style.cssText = [
      "position:absolute",
      "inset:0",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      `background:${bg}`,
      "z-index:5",
      "transition:opacity 160ms ease",
      "opacity:1",
    ].join(";");

    this.spinner = document.createElement("div");
    this.spinner.style.cssText = [
      "width:28px",
      "height:28px",
      "border-radius:50%",
      `border:3px solid ${fg}`,
      "border-top-color:transparent",
      "animation:raze-chart-spin 0.8s linear infinite",
    ].join(";");
    this.el.appendChild(this.spinner);

    if (!document.getElementById("raze-chart-spin-kf")) {
      const style = document.createElement("style");
      style.id = "raze-chart-spin-kf";
      style.textContent = "@keyframes raze-chart-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }
  }

  hide(): void {
    this.el.style.opacity = "0";
    window.setTimeout(() => this.el.remove(), 200);
  }

  destroy(): void {
    this.el.remove();
  }
}
