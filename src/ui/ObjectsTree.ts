import type { ChartContext } from "../core/context";
import type { ShapeStore } from "../core/ShapeStore";
import type { StudyStore } from "../studies/StudyStore";
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

  private render(panel: HTMLDivElement): void {
    panel.replaceChildren();
    const magnet = popupRow(this.context.magnet ? "✓ Magnet OHLC" : "Magnet OHLC", () => {
      this.context.magnet = !this.context.magnet;
      this.context.requestPaint();
      this.render(panel);
    }, { role: "menuitemcheckbox", checked: this.context.magnet, label: "Magnet OHLC" });
    const stay = popupRow(
      this.context.stayInDrawingMode ? "✓ Stay in drawing mode" : "Stay in drawing mode",
      () => {
        this.context.stayInDrawingMode = !this.context.stayInDrawingMode;
        this.render(panel);
      },
      { role: "menuitemcheckbox", checked: this.context.stayInDrawingMode, label: "Stay in drawing mode" },
    );
    panel.append(magnet, stay);
    const volumeModes = ["overlay", "pane", "hidden"] as const;
    const volumeLabel = `Volume: ${this.context.volumeMode}`;
    panel.appendChild(popupRow(volumeLabel, () => {
      const i = volumeModes.indexOf(this.context.volumeMode);
      this.context.volumeMode = volumeModes[(i + 1) % volumeModes.length]!;
      this.context.requestPaint();
      this.render(panel);
    }, { role: "menuitem", label: volumeLabel }));

    const shapes = this.shapes.list().filter((s) => s.showInObjectsTree);
    const studies = this.studies.list();
    if (!shapes.length && !studies.length) {
      const empty = popupRow("No objects", () => {}, { role: "menuitem", label: "No objects" });
      empty.style.color = "#8b887e";
      panel.appendChild(empty);
      return;
    }
    for (const shape of shapes) {
      const label = `${shape.hidden ? "Show" : "Hide"} ${shape.shape.replace(/_/g, " ")}`;
      panel.appendChild(popupRow(label, () => {
        this.shapes.setHidden(shape.id, !shape.hidden);
        this.render(panel);
      }, { role: "menuitemcheckbox", checked: !shape.hidden, label }));
      panel.appendChild(popupRow(`Delete ${shape.shape.replace(/_/g, " ")}`, () => {
        this.shapes.remove(shape.id);
        this.render(panel);
      }, { role: "menuitem", label: `Delete ${shape.shape}` }));
    }
    for (const study of studies) {
      panel.appendChild(popupRow(`Remove ${study.name} ${study.length}`, () => {
        this.studies.remove(study.id);
        this.render(panel);
      }, { role: "menuitem", label: `Remove ${study.name}` }));
    }
  }

  close(): void {
    this.popup?.close();
    this.popup = null;
  }

  destroy(): void {
    this.close();
  }
}
