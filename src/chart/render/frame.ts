// Stage frame: where a painted scene sits on screen. The scene is compiled at
// the stage size (the wrap minus the preset bar and navigator) and both
// renderers letterbox it uniformly into the stage, so pointer mapping and
// overlay placement must come from the stage box, never from the wrap.

import type { CompiledChart } from "../compile/types";

export interface StageFrame {
  /** Client-space position of scene (0, 0). */
  readonly clientLeft: number;
  readonly clientTop: number;
  /** Wrap-relative CSS position of scene (0, 0); overlay elements live in the wrap. */
  readonly left: number;
  readonly top: number;
  /** CSS pixels per scene unit (uniform on both axes). */
  readonly scale: number;
  /** Wrap-relative CSS box of the stage, for clamping overlays such as the tooltip. */
  readonly bounds: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

function sized(box: Box): boolean {
  return box.width > 0 && box.height > 0;
}

/**
 * Frame of `scene` inside `stage`. Environments without layout (jsdom, a
 * detached host) report an empty stage; the wrap box is used then, and an
 * empty wrap maps one CSS pixel to one scene unit.
 */
export function stageFrame(wrap: HTMLElement, stage: HTMLElement, scene: CompiledChart): StageFrame {
  const wrapBox = wrap.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  const box: Box = sized(stageBox) ? stageBox : wrapBox;
  const width = Math.max(1, scene.width);
  const height = Math.max(1, scene.height);
  const scale = sized(box) ? Math.min(box.width / width, box.height / height) : 1;
  const padX = sized(box) ? (box.width - width * scale) / 2 : 0;
  const padY = sized(box) ? (box.height - height * scale) / 2 : 0;
  const clientLeft = box.left + padX;
  const clientTop = box.top + padY;
  return {
    clientLeft,
    clientTop,
    left: clientLeft - wrapBox.left,
    top: clientTop - wrapBox.top,
    scale,
    bounds: {
      left: box.left - wrapBox.left,
      top: box.top - wrapBox.top,
      width: sized(box) ? box.width : width,
      height: sized(box) ? box.height : height,
    },
  };
}

/** Scene coordinates of a client-space point. */
export function clientToScene(frame: StageFrame, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: (clientX - frame.clientLeft) / frame.scale,
    y: (clientY - frame.clientTop) / frame.scale,
  };
}

/** Wrap-relative CSS x of a scene x. */
export function cssX(frame: StageFrame, x: number): number {
  return frame.left + x * frame.scale;
}

/** Wrap-relative CSS y of a scene y. */
export function cssY(frame: StageFrame, y: number): number {
  return frame.top + y * frame.scale;
}
