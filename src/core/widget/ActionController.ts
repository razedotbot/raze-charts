// `executeActionById` / `getCheckableActionState` and the undo/redo keyboard
// shortcuts on the chart canvas.
//
// ACTIONS is the catalogue: every id listed runs real behaviour, and any other
// id throws with the supported list, so a typo or a TradingView action Raze
// Charts does not implement is never a silent no-op.

import type { ChartActionId, CheckableChartActionId, EntityId } from "../../types/charting_library";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    actions: ActionController;
  }
}

const VOLUME_MODES = ["overlay", "pane", "hidden"] as const;

interface ActionDefinition {
  run(controller: ActionController, host: WidgetHost): void;
  /** Present on toggle actions: the current state. */
  checked?(controller: ActionController, host: WidgetHost): boolean;
}

const objectsTree: ActionDefinition = {
  run: (c, { controllers }) => controllers.chrome.objectsTree?.toggle(c.anchor("Objects tree")),
};
const stayInDrawingMode: ActionDefinition = {
  run: (_, { context }) => { context.stayInDrawingMode = !context.stayInDrawingMode; },
  checked: (_, { context }) => context.stayInDrawingMode,
};

const ACTIONS: Readonly<Record<ChartActionId, ActionDefinition>> = {
  undo: { run: (_, { commands }) => { commands.undo(); } },
  redo: { run: (_, { commands }) => { commands.redo(); } },
  chartReset: {
    run: (c, { context }) => {
      c.resetTimeScale();
      context.setScaleMode({ autoScale: true }, "api");
    },
  },
  timeScaleReset: { run: (c) => c.resetTimeScale() },
  insertIndicator: {
    run: (c, { controllers }) => {
      const menu = controllers.chrome.indicatorsMenu;
      menu?.close();
      menu?.open(c.anchor("Indicators"));
    },
  },
  symbolSearch: {
    run: (c, { controllers }) => {
      const input = controllers.chrome.symbolSearch?.el.querySelector("input");
      if (input) input.focus();
      else if (!c.warnedSearch) {
        c.warnedSearch = true;
        console.warn('[raze-charts] executeActionById("symbolSearch") needs the header_widget and header_symbol_search featuresets');
      }
    },
  },
  paneObjectTree: objectsTree,
  objects_tree: objectsTree,
  stayInDrawingModeAction: stayInDrawingMode,
  stay_in_drawing_mode: stayInDrawingMode,
  magnet: {
    run: (_, { context }) => { context.magnet = !context.magnet; },
    checked: (_, { context }) => context.magnet,
  },
  hideAllDrawingTools: {
    run: (c) => c.toggleDrawingsHidden(),
    checked: (c) => !!c.hiddenDrawings,
  },
  paneRemoveAllStudiesDrawingTools: {
    run: (_, { shapes, studies }) => {
      studies.clear();
      shapes.removeAll();
    },
  },
  volume_pane: {
    run: (_, { context }) => {
      context.volumeMode = VOLUME_MODES[(VOLUME_MODES.indexOf(context.volumeMode) + 1) % VOLUME_MODES.length]!;
    },
  },
};

const ids = (filter?: (definition: ActionDefinition) => unknown): string =>
  Object.keys(ACTIONS).filter((id) => !filter || filter(ACTIONS[id as ChartActionId])).join(", ");

export class ActionController implements WidgetController {
  /** Drawings hidden by `hideAllDrawingTools`, shown again when it toggles off. */
  hiddenDrawings: EntityId[] | null = null;
  warnedSearch = false;
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    e.preventDefault();
    const { commands, context } = this.host;
    if (key === "z" && !e.shiftKey) commands.undo();
    else commands.redo();
    context.requestPaint();
  };

  constructor(private readonly host: WidgetHost) {}

  boot(): void {
    this.host.engine.canvas.addEventListener("keydown", this.onKeyDown);
  }

  executeActionById(actionId: ChartActionId): void {
    this.definition(actionId, "executeActionById").run(this, this.host);
    this.host.context.requestPaint();
  }

  getCheckableActionState(actionId: CheckableChartActionId): boolean {
    const { checked } = this.definition(actionId, "getCheckableActionState");
    if (!checked) {
      throw new TypeError(
        `[raze-charts] getCheckableActionState("${actionId}"): not a toggle action; checkable actions: ${ids((definition) => definition.checked)}`,
      );
    }
    return checked(this, this.host);
  }

  /** The sidebar button labelled `label`, or the chart area when the sidebar is hidden. */
  anchor(label: string): HTMLElement {
    const chrome = this.host.controllers.chrome;
    const button = chrome.leftSidebar?.el.querySelector(`[aria-label="${label}"]`);
    return button instanceof HTMLElement ? button : chrome.chartArea;
  }

  /** The default (initial) time-scale view, anchored to the latest bar. */
  resetTimeScale(): void {
    const context = this.host.context;
    const n = context.bars.length;
    const count = Math.min(n, context.defaultVisibleBars());
    if (count > 0) {
      context.setViewport({ from: n - count, to: n - 1 + Math.max(2, Math.floor(count * 0.08)) }, "reset");
    }
  }

  /** Hide every visible drawing, or show the ones this action hid. View state, not undo history. */
  toggleDrawingsHidden(): void {
    const { commands, shapes } = this.host;
    const resume = commands.suspend();
    try {
      const hidden = this.hiddenDrawings;
      this.hiddenDrawings = hidden ? null : shapes.list().filter((shape) => !shape.hidden).map((shape) => shape.id);
      for (const id of hidden ?? this.hiddenDrawings!) shapes.setHidden(id, !hidden);
    } finally {
      resume();
    }
  }

  destroy(): void {
    this.host.engine.canvas.removeEventListener("keydown", this.onKeyDown);
  }

  private definition(actionId: string, method: string): ActionDefinition {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, actionId)) {
      throw new TypeError(`[raze-charts] ${method}("${String(actionId)}"): unsupported action; supported actions: ${ids()}`);
    }
    return ACTIONS[actionId as ChartActionId];
  }
}
