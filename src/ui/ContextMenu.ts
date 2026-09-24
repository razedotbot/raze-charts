// Right-click context menu. The app registers items via widget.onContextMenu,
// which receives the unix time (and price) under the cursor and returns a list
// of { position, text, click } entries.
//
// TradingView conventions are honoured: `{ text: "-" }` is a separator (not a
// stop for the arrow keys) and `{ text: "-Label" }` removes the default item
// named "Label". Items are grouped around the default items by `position`
// ("top" before them, "bottom" after), and redundant separators (leading,
// trailing or doubled) are dropped. The menu renders in the chart's portal,
// so it stays visible in element fullscreen and inside shadow roots.

import { t } from "../i18n";
import type { ContextMenuItem } from "../types/charting_library";
import { openPopup, popupRow, popupSeparator, type PopupHandle } from "./popup";

/** One rendered line of a context menu. */
export type ContextMenuEntry =
  | { readonly kind: "item"; readonly item: ContextMenuItem }
  | { readonly kind: "separator" };

let current: PopupHandle | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[raze-charts] onContextMenu: ${message}`);
}

const SEPARATOR = "-";

function isItem(value: unknown): value is ContextMenuItem {
  return !!value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string";
}

/**
 * Resolve host items against the chart's default items with TradingView's
 * semantics: `-` is a separator, `-Label` removes the default item whose text
 * is `Label`, "top" items come before the defaults and "bottom" items after.
 * Entries that are not `{ text: string }` objects are skipped with a warning,
 * as is a removal that names no default item.
 */
export function resolveContextMenuEntries(
  items: readonly unknown[],
  defaults: readonly ContextMenuItem[] = [],
): ContextMenuEntry[] {
  const removed = new Set<string>();
  const top: ContextMenuEntry[] = [];
  const bottom: ContextMenuEntry[] = [];
  for (const [index, value] of items.entries()) {
    if (!isItem(value)) {
      warnOnce("invalid", `item ${index} is not a { text, click } object and was skipped.`);
      continue;
    }
    const text = value.text.trim();
    const group = value.position === "bottom" ? bottom : top;
    if (text === SEPARATOR) {
      group.push({ kind: "separator" });
      continue;
    }
    if (text.startsWith(SEPARATOR)) {
      const label = text.slice(SEPARATOR.length).trim();
      if (!defaults.some((item) => item.text.trim() === label)) {
        const names = defaults.map((item) => `"${item.text}"`).join(", ");
        warnOnce(
          `remove:${label}`,
          `"${value.text}" removes a default item, but the menu has no default item named "${label}" ` +
          `(${names ? `default items: ${names}` : "this menu has no default items"}). ` +
          'Use { text: "-" } for a separator.',
        );
      }
      removed.add(label);
      continue;
    }
    group.push({ kind: "item", item: value });
  }
  const kept: ContextMenuEntry[] = defaults
    .filter((item) => !removed.has(item.text.trim()))
    .map((item) => ({ kind: "item", item }));

  // Separators only ever sit between two items.
  const entries: ContextMenuEntry[] = [];
  for (const entry of [...top, ...kept, ...bottom]) {
    if (entry.kind === "separator" && (!entries.length || entries[entries.length - 1]!.kind === "separator")) continue;
    entries.push(entry);
  }
  while (entries.length && entries[entries.length - 1]!.kind === "separator") entries.pop();
  return entries;
}

export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  fontFamily: string,
  themeRoot?: HTMLElement,
): void {
  closeContextMenu();
  const entries = resolveContextMenuEntries(Array.isArray(items) ? items : []);
  if (!entries.some((entry) => entry.kind === "item")) return;

  const popup = openPopup({
    fontFamily,
    themeRoot,
    className: "raze-chart-context-menu",
    minWidth: 160,
    x,
    y,
    role: "menu",
    label: t("contextMenu.label", "Chart context menu"),
    onClose: () => {
      if (current === popup) current = null;
    },
  });
  current = popup;

  const count = entries.filter((entry) => entry.kind === "item").length;
  let position = 0;
  for (const entry of entries) {
    if (entry.kind === "separator") {
      popup.el.appendChild(popupSeparator());
      continue;
    }
    const { item } = entry;
    const click = typeof item.click === "function" ? item.click : null;
    const row = popupRow(item.text, () => {
      if (!click) return;
      closeContextMenu();
      try {
        click();
      } catch (error) {
        // A throwing handler must not wedge the menu, nor fail silently.
        console.error(`[raze-charts] context menu item "${item.text}" threw.`, error);
      }
    }, { role: "menuitem", label: item.text });
    if (!click) {
      warnOnce(`click:${item.text}`, `item "${item.text}" has no click function; it is shown disabled.`);
      row.setAttribute("aria-disabled", "true");
      row.tabIndex = -1;
    }
    row.setAttribute("aria-posinset", String(++position));
    row.setAttribute("aria-setsize", String(count));
    popup.el.appendChild(row);
  }
  popup.reposition();
}

export function closeContextMenu(): void {
  current?.close();
  current = null;
}
