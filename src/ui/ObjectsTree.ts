import type { ChartContext } from "../core/context";
import type { ShapeStore } from "../core/ShapeStore";
import type { StudyStore } from "../studies/StudyStore";
import { studyInstanceLabel } from "../studies/label";
import { t } from "../i18n";
import {
  fillMenuRow,
  ICON_COLUMNS,
  ICON_EYE,
  ICON_EYE_OFF,
  ICON_MAGNET,
  ICON_PENCIL,
  ICON_TRASH,
  MENU_ROW_STYLES,
} from "./icons";
import { openPopup, popupRow, type PopupHandle } from "./popup";
import { adoptStyles } from "./styles";

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
      anchor,
      place: "right-start",
      role: "menu",
      label: t("sidebar.objectsTree", "Objects tree"),
      onClose: () => {
        if (this.popup === popup) this.popup = null;
      },
    });
    this.popup = popup;
    adoptStyles(popup.el, MENU_ROW_STYLES);
    this.render(popup.el);
    popup.reposition();
  }

  private render(panel: HTMLDivElement, focusIndex?: number): void {
    panel.replaceChildren();
    let rowIndex = 0;
    const nextRowIndex = (): number => rowIndex++;

    const magnetIndex = nextRowIndex();
    const magnetLabel = t("objectsTree.magnet", "Magnet OHLC");
    const magnet = popupRow("", () => {
      this.context.magnet = !this.context.magnet;
      this.context.requestPaint();
      this.render(panel, magnetIndex);
    }, { role: "menuitemcheckbox", checked: this.context.magnet, label: magnetLabel });
    fillMenuRow(magnet, { checked: this.context.magnet, icon: ICON_MAGNET, label: magnetLabel });
    const stayIndex = nextRowIndex();
    const stayLabel = t("objectsTree.stayInDrawingMode", "Stay in drawing mode");
    const stay = popupRow("", () => {
      this.context.stayInDrawingMode = !this.context.stayInDrawingMode;
      this.render(panel, stayIndex);
    }, { role: "menuitemcheckbox", checked: this.context.stayInDrawingMode, label: stayLabel });
    fillMenuRow(stay, { checked: this.context.stayInDrawingMode, icon: ICON_PENCIL, label: stayLabel });
    panel.append(magnet, stay);
    const volumeModes = ["overlay", "pane", "hidden"] as const;
    const volumeLabel = this.context.volumeMode === "pane"
      ? t("objectsTree.volumePane", "Volume: pane")
      : this.context.volumeMode === "hidden"
        ? t("objectsTree.volumeHidden", "Volume: hidden")
        : t("objectsTree.volumeOverlay", "Volume: overlay");
    const volumeIndex = nextRowIndex();
    const volume = popupRow("", () => {
      const i = volumeModes.indexOf(this.context.volumeMode);
      this.context.volumeMode = volumeModes[(i + 1) % volumeModes.length]!;
      this.context.requestPaint();
      this.render(panel, volumeIndex);
    }, { role: "menuitem", label: volumeLabel });
    panel.appendChild(fillMenuRow(volume, { icon: ICON_COLUMNS, label: volumeLabel }));

    const shapes = this.shapes.list().filter((s) => s.showInObjectsTree);
    const studies = this.studies.list();
    if (!shapes.length && !studies.length) {
      const empty = document.createElement("div");
      empty.className = "raze-chart-objects-tree-empty raze-menu-empty raze-menu-muted";
      empty.setAttribute("role", "status");
      empty.setAttribute("aria-live", "polite");
      empty.textContent = t("objectsTree.empty", "No objects");
      panel.appendChild(empty);
      if (focusIndex !== undefined) this.popup?.focusItem(focusIndex);
      return;
    }
    for (const shape of shapes) {
      const name = shape.shape.replace(/_/g, " ");
      // A checkbox with a stable name: checked while the drawing is visible.
      const showLabel = t("objectsTree.show", "Show {name}", { name });
      const visibilityIndex = nextRowIndex();
      const visibility = popupRow("", () => {
        this.shapes.setHidden(shape.id, !shape.hidden);
        this.render(panel, visibilityIndex);
      }, { role: "menuitemcheckbox", checked: !shape.hidden, label: showLabel });
      panel.appendChild(fillMenuRow(visibility, {
        checked: !shape.hidden,
        icon: shape.hidden ? ICON_EYE_OFF : ICON_EYE,
        label: showLabel,
      }));
      const deleteLabel = t("objectsTree.delete", "Delete {name}", { name });
      const deleteIndex = nextRowIndex();
      const remove = popupRow("", () => {
        this.shapes.remove(shape.id);
        this.render(panel, deleteIndex);
      }, { role: "menuitem", label: deleteLabel });
      panel.appendChild(fillMenuRow(remove, { icon: ICON_TRASH, label: deleteLabel }));
    }
    for (const study of studies) {
      // The same definition-built label as the legend row ("EMA 9", "VWAP", "MACD 12 26 9").
      const removeLabel = t("objectsTree.removeStudy", "Remove {name}", { name: studyInstanceLabel(study) });
      const removeIndex = nextRowIndex();
      const remove = popupRow("", () => {
        this.studies.remove(study.id);
        this.render(panel, removeIndex);
      }, { role: "menuitem", label: removeLabel });
      panel.appendChild(fillMenuRow(remove, { icon: ICON_TRASH, label: removeLabel }));
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
