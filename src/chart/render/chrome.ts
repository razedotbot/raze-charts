// Range chrome for Cartesian mounts: the preset button group and the
// navigator strip with its sparkline.

import { asNumber } from "../compile/shared";
import type { CompiledChart } from "../compile/types";
import { RANGE_PRESETS, presetZoomsIn, viewportFromPreset, type RangePreset } from "../viewport";
import type { MountRuntime } from "./types";

export interface RangeChrome {
  /** Show or hide the preset bar and navigator for the scene family. */
  prepare(polar: boolean, heatmap: boolean): void;
  /** Reflect the live viewport in preset visibility and pressed state. */
  syncPresets(): void;
  /** Redraw the navigator sparkline from the full-data scene. */
  paintNavigator(compiled: CompiledChart, fullScene: CompiledChart | null): void;
  /** Wire preset/navigator pointer handling; returns the detach function. */
  attach(): () => void;
}

/** Current X domain of a linear scene. */
export function linearExtent(scene: CompiledChart | null): [number, number] | null {
  if (scene?.xScale.kind !== "linear") return null;
  return [asNumber(scene.xScale.domain[0]), asNumber(scene.xScale.domain[1])];
}

export function createRangeChrome(rt: MountRuntime): RangeChrome {
  const { state } = rt;
  const { presetsBar, nav } = rt.dom;

  /** Full-data X extent, falling back to the current linear scene. */
  const resolvedExtent = (): [number, number] | null => (
    state.fullXExtent ?? linearExtent(state.scene)
  );

  const syncPresets = (): void => {
    const extent = resolvedExtent();
    const vp = state.viewport?.x;
    for (const btn of presetsBar.querySelectorAll("button")) {
      const preset = btn.textContent as RangePreset;
      if (!RANGE_PRESETS.includes(preset)) continue;
      btn.hidden = extent != null && preset !== "ALL" && !presetZoomsIn(preset, extent);
      let on = preset === "ALL" && !vp;
      if (vp && vp.length === 2 && extent && Number.isFinite(asNumber(vp[0]))) {
        const want = viewportFromPreset(preset, extent);
        if (want.x && want.x.length === 2) {
          const span = Math.max(Math.abs(extent[1] - extent[0]), 1);
          on = Math.abs(asNumber(vp[0]) - asNumber(want.x[0])) / span < 0.02
            && Math.abs(asNumber(vp[1]) - asNumber(want.x[1])) / span < 0.02;
        }
      }
      btn.setAttribute("aria-pressed", String(on));
      btn.style.fontWeight = on ? "600" : "400";
      btn.style.background = on
        ? "var(--tv-color-toolbar-button-background-active, rgba(255,255,255,0.1))"
        : "transparent";
    }
  };

  const ensurePresetButtons = (): void => {
    if (presetsBar.childElementCount) return;
    presetsBar.setAttribute("role", "group");
    presetsBar.setAttribute("aria-label", "Visible time range");
    for (const preset of RANGE_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = preset;
      btn.setAttribute("aria-label", `Range ${preset}`);
      btn.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;font-size:11px;padding:2px 6px;border-radius:3px;cursor:pointer;touch-action:manipulation;";
      btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      btn.addEventListener("pointerup", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const extent = resolvedExtent();
        if (!extent) return;
        rt.emitViewport(viewportFromPreset(preset, extent));
      });
      presetsBar.appendChild(btn);
    }
  };

  const prepare = (polar: boolean, heatmap: boolean): void => {
    const interact = rt.flags();
    const cartesian = !polar && !heatmap;
    if (interact.rangePresets && cartesian) ensurePresetButtons();
    presetsBar.style.display = interact.rangePresets && cartesian ? "flex" : "none";
    nav.style.display = interact.navigator && cartesian ? "block" : "none";
  };

  const onNavPointerDown = (ev: PointerEvent): void => {
    ev.stopPropagation();
    const extent = resolvedExtent();
    if (!extent) return;
    const box = nav.getBoundingClientRect();
    const t = (ev.clientX - box.left) / Math.max(1, box.width);
    const mid = extent[0] + t * (extent[1] - extent[0]);
    const viewport = state.viewport;
    const span = (viewport?.x && viewport.x.length === 2)
      ? Math.abs(asNumber(viewport.x[1]) - asNumber(viewport.x[0]))
      : (extent[1] - extent[0]) * 0.25;
    rt.emitViewport({ x: [mid - span / 2, mid + span / 2] });
  };

  const paintNavigator = (compiled: CompiledChart, fullScene: CompiledChart | null): void => {
    let spark = nav.querySelector("canvas");
    if (!spark) {
      spark = document.createElement("canvas");
      spark.style.cssText = "width:100%;height:100%;display:block;";
      spark.setAttribute("aria-hidden", "true");
      nav.appendChild(spark);
    }
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const nw = Math.max(1, nav.clientWidth);
    const nh = Math.max(1, nav.clientHeight);
    const sparkW = Math.floor(nw * dpr);
    const sparkH = Math.floor(nh * dpr);
    if (spark.width !== sparkW || spark.height !== sparkH) {
      spark.width = sparkW;
      spark.height = sparkH;
    }
    const sctx = spark.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, nw, nh);
    const sparkSource = fullScene ?? compiled;
    const line = sparkSource.nodes.find((n) =>
      (n.type === "line" || n.type === "area") && n.points && n.points.length > 1,
    );
    if (line?.points) {
      sctx.beginPath();
      line.points.forEach((p, i) => {
        const x = ((p.x - sparkSource.plot.x) / Math.max(1, sparkSource.plot.w)) * nw;
        const y = 4 + ((p.y - sparkSource.plot.y) / Math.max(1, sparkSource.plot.h)) * (nh - 8);
        if (i === 0) sctx.moveTo(x, y);
        else sctx.lineTo(x, y);
      });
      sctx.strokeStyle = compiled.theme.accent;
      sctx.lineWidth = 1;
      sctx.stroke();
    }
  };

  const stopChromePointer = (ev: Event): void => {
    ev.stopPropagation();
  };

  const attach = (): (() => void) => {
    presetsBar.addEventListener("pointerdown", stopChromePointer);
    presetsBar.addEventListener("pointerup", stopChromePointer);
    presetsBar.addEventListener("wheel", stopChromePointer);
    nav.addEventListener("pointerdown", onNavPointerDown);
    nav.addEventListener("pointerup", stopChromePointer);
    nav.addEventListener("wheel", stopChromePointer);
    return () => {
      presetsBar.removeEventListener("pointerdown", stopChromePointer);
      presetsBar.removeEventListener("pointerup", stopChromePointer);
      presetsBar.removeEventListener("wheel", stopChromePointer);
      nav.removeEventListener("pointerdown", onNavPointerDown);
      nav.removeEventListener("pointerup", stopChromePointer);
      nav.removeEventListener("wheel", stopChromePointer);
    };
  };

  return { prepare, syncPresets, paintNavigator, attach };
}
