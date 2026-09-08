// Right-click context menu. The app registers items via widget.onContextMenu,
// which receives the unix time (and price) under the cursor and returns a list
// of { position, text, click } entries.

import type { ContextMenuItem } from "../types/charting_library";
import { isCoarsePointer, openPopup, popupRow, type PopupHandle } from "./popup";

let current: PopupHandle | null = null;

export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  fontFamily: string,
): void {
  closeContextMenu();
  if (!items.length) return;

  const popup = openPopup({
    fontFamily,
    className: "raze-chart-context-menu",
    minWidth: 160,
    padding: "4px",
    x,
    y,
    role: "menu",
    label: "Chart context menu",
    onClose: () => {
      if (current === popup) current = null;
    },
  });
  current = popup;

  const top = items.filter((i) => i.position !== "bottom");
  const bottom = items.filter((i) => i.position === "bottom");
  const ordered = [...top, ...bottom];
  for (const [index, item] of ordered.entries()) {
    const row = popupRow(item.text, () => {
      closeContextMenu();
      try {
        item.click();
      } catch {
        /* a handler throwing must not wedge the menu */
      }
    }, { role: "menuitem", label: item.text });
    row.setAttribute("aria-posinset", String(index + 1));
    row.setAttribute("aria-setsize", String(ordered.length));
    if (!isCoarsePointer()) row.style.padding = "6px 10px";
    row.textContent = item.text; // plain text, never HTML
    popup.el.appendChild(row);
  }
  popup.reposition();
}

export function closeContextMenu(): void {
  current?.close();
  current = null;
}
