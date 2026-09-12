// Overlay shown until the first bars resolve. Mirrors TV's loading_screen
// option { backgroundColor, foregroundColor } with a small spinner.

import type { LoadingScreenOptions } from "../types/charting_library";

export class LoadingScreen {
  readonly el: HTMLDivElement;
  private spinner: HTMLDivElement;
  private message: HTMLDivElement;
  private removalTimer = 0;
  private hidden = false;
  private destroyed = false;

  constructor(opts: LoadingScreenOptions | undefined, fallbackBg: string) {
    const bg = opts?.backgroundColor ?? fallbackBg;
    const fg = opts?.foregroundColor ?? "#2962ff";

    this.el = document.createElement("div");
    this.el.className = "raze-chart-loading-screen";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-atomic", "true");
    this.el.setAttribute("aria-busy", "true");
    this.el.setAttribute("aria-label", "Loading chart data");
    this.el.style.cssText = [
      "position:absolute",
      "inset:0",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:12px",
      `background:${bg}`,
      "z-index:5",
      "transition:opacity 160ms ease",
      "opacity:1",
    ].join(";");

    this.spinner = document.createElement("div");
    this.spinner.className = "raze-chart-loading-spinner";
    this.spinner.setAttribute("aria-hidden", "true");
    this.spinner.style.cssText = [
      "width:28px",
      "height:28px",
      "border-radius:50%",
      `border:3px solid ${fg}`,
      "border-top-color:transparent",
      "animation:raze-chart-spin 0.8s linear infinite",
    ].join(";");
    this.el.appendChild(this.spinner);
    this.message = document.createElement("div");
    this.message.className = "raze-chart-loading-message";
    this.message.style.cssText = [
      "display:none",
      "max-width:min(360px,calc(100% - 32px))",
      "text-align:center",
      "font-size:13px",
      "line-height:1.45",
      "color:var(--tv-color-toolbar-button-text, currentColor)",
    ].join(";");
    this.el.appendChild(this.message);

    if (!document.getElementById("raze-chart-spin-kf")) {
      const style = document.createElement("style");
      style.id = "raze-chart-spin-kf";
      style.textContent =
        "@keyframes raze-chart-spin{to{transform:rotate(360deg)}}" +
        "@media (prefers-reduced-motion:reduce){.raze-chart-loading-spinner{animation:none!important}}";
      document.head.appendChild(style);
    }
  }

  hide(): void {
    if (this.destroyed || this.hidden) return;
    this.hidden = true;
    this.el.setAttribute("aria-busy", "false");
    this.el.setAttribute("aria-label", "Chart data loaded");
    this.el.style.opacity = "0";
    // Stop intercepting the chart immediately; the delayed removal exists only
    // to let the opacity transition finish.
    this.el.style.pointerEvents = "none";
    this.removalTimer = window.setTimeout(() => {
      this.removalTimer = 0;
      this.el.remove();
    }, 200);
  }

  showEmpty(): void {
    this.showMessage("No chart data is available for this symbol and interval.", false);
  }

  showError(): void {
    this.showMessage("Chart data could not be loaded. Try again or choose another symbol.", true);
  }

  private showMessage(text: string, error: boolean): void {
    if (this.destroyed) return;
    window.clearTimeout(this.removalTimer);
    this.removalTimer = 0;
    this.hidden = false;
    this.el.style.opacity = "1";
    this.el.style.pointerEvents = "auto";
    this.el.setAttribute("role", error ? "alert" : "status");
    this.el.setAttribute("aria-live", error ? "assertive" : "polite");
    this.el.setAttribute("aria-busy", "false");
    this.el.setAttribute("aria-label", text);
    this.spinner.style.display = "none";
    this.message.style.display = "block";
    this.message.textContent = text;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.removalTimer);
    this.removalTimer = 0;
    this.el.remove();
  }
}
