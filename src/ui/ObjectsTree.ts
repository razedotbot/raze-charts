import type { ChartContext } from "../core/context";
import type { ShapeStore } from "../core/ShapeStore";
import type { StudyStore } from "../studies/StudyStore";
import { studyInstanceLabel } from "../studies/label";
import { openPopup, popupRow, type PopupHandle } from "./popup";

export class ObjectsTree {
  private popup: PopupHandle | null = null;

  constructor(
    private readonly context: ChartContext,
    private readonly shapes: ShapeStore,
    private readonly studies: StudyStore,
  ) {}

  toggle(anchor: HTMLElement): void {
    if (this.popup) {
      this.close();
      return;
    }
    this.open(anchor);
  }

  open(anchor: HTMLElement): void {
    this.close();
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-objects-tree",
      minWidth: 220,
      padding: "6px 0",
      anchor,
      place: "right-start",
      role: "menu",
      label: "Objects tree",
      onClose: () => {
        if (this.popup === popup) this.popup = null;
      },
    });
    this.popup = popup;
    this.render(popup.el);
    popup.reposition();
  }

  private render(panel: HTMLDivElement, focusIndex?: number): void {
    panel.replaceChildren();
    let rowIndex = 0;
    const nextRowIndex = (): number => rowIndex++;

    const magnetIndex = nextRowIndex();
    const magnet = popupRow(this.context.magnet ? "✓ Magnet OHLC" : "Magnet OHLC", () => {
      this.context.magnet = !this.context.magnet;
      this.context.requestPaint();
      this.render(panel, magnetIndex);
    }, { role: "menuitemcheckbox", checked: this.context.magnet, label: "Magnet OHLC" });
    const stayIndex = nextRowIndex();
    const stay = popupRow(
      this.context.stayInDrawingMode ? "✓ Stay in drawing mode" : "Stay in drawing mode",
      () => {
        this.context.stayInDrawingMode = !this.context.stayInDrawingMode;
        this.render(panel, stayIndex);
      },
      { role: "menuitemcheckbox", checked: this.context.stayInDrawingMode, label: "Stay in drawing mode" },
    );
    panel.append(magnet, stay);
    const volumeModes = ["overlay", "pane", "hidden"] as const;
    const volumeLabel = `Volume: ${this.context.volumeMode}`;
    const volumeIndex = nextRowIndex();
    panel.appendChild(popupRow(volumeLabel, () => {
      const i = volumeModes.indexOf(this.context.volumeMode);
      this.context.volumeMode = volumeModes[(i + 1) % volumeModes.length]!;
      this.context.requestPaint();
      this.render(panel, volumeIndex);
    }, { role: "menuitem", label: volumeLabel }));

    const shapes = this.shapes.list().filter((s) => s.showInObjectsTree);
    const studies = this.studies.list();
    if (!shapes.length && !studies.length) {
      const empty = document.createElement("div");
      empty.className = "raze-chart-objects-tree-empty";
      empty.setAttribute("role", "status");
      empty.setAttribute("aria-live", "polite");
      empty.textContent = "No objects";
      empty.style.cssText = [
        "padding:8px 12px",
        "color:var(--tv-color-toolbar-button-text, #8b887e)",
        "opacity:0.72",
      ].join(";");
      panel.appendChild(empty);
      if (focusIndex !== undefined) this.popup?.focusItem(focusIndex);
      return;
    }
    for (const shape of shapes) {
      const label = `${shape.hidden ? "Show" : "Hide"} ${shape.shape.replace(/_/g, " ")}`;
      const visibilityIndex = nextRowIndex();
      panel.appendChild(popupRow(label, () => {
        this.shapes.setHidden(shape.id, !shape.hidden);
        this.render(panel, visibilityIndex);
      }, { role: "menuitemcheckbox", checked: !shape.hidden, label }));
      const deleteIndex = nextRowIndex();
      panel.appendChild(popupRow(`Delete ${shape.shape.replace(/_/g, " ")}`, () => {
        this.shapes.remove(shape.id);
        this.render(panel, deleteIndex);
      }, { role: "menuitem", label: `Delete ${shape.shape}` }));
    }
    for (const study of studies) {
      const removeIndex = nextRowIndex();
      const label = `Remove ${studyInstanceLabel(study)}`;
      panel.appendChild(popupRow(label, () => {
        this.studies.remove(study.id);
        this.render(panel, removeIndex);
      }, { role: "menuitem", label }));
    }
    if (focusIndex !== undefined) this.popup?.focusItem(focusIndex);
  }

  close(): void {
    this.popup?.close();
    this.popup = null;
  }

  destroy(): void {
    this.close();
  }
}
