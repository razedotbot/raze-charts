// Right-click context menu. The app registers items via widget.onContextMenu,
// which receives the unix time (and price) under the cursor and returns a list
// of { position, text, click } entries.

import type { ContextMenuItem } from "../types/charting_library";

export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  fontFamily: string,
): void {
  closeContextMenu();
  if (!items.length) return;

  const menu = document.createElement("div");
  menu.id = "raze-chart-context-menu";
  menu.style.cssText = [
    "position:fixed",
    `top:${y}px`,
    `left:${x}px`,
    "min-width:160px",
    "background:var(--tv-color-popup-background, #1e222d)",
    "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
    "border-radius:4px",
    "box-shadow:0 12px 24px -10px rgba(0,0,0,0.6)",
    "padding:4px",
    "z-index:2147483640",
    `font-family:${fontFamily}`,
    "font-size:12px",
    "color:var(--tv-color-popup-element-text, #d1d4dc)",
  ].join(";");

  const top = items.filter((i) => i.position !== "bottom");
  const bottom = items.filter((i) => i.position === "bottom");
  for (const item of [...top, ...bottom]) {
    const row = document.createElement("div");
    row.textContent = item.text;
    row.style.cssText = "padding:6px 10px;cursor:pointer;border-radius:3px;white-space:nowrap;";
    row.addEventListener("mouseenter", () => {
      row.style.background = "var(--tv-color-popup-element-background-hover, rgba(255,255,255,0.08))";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    row.addEventListener("click", () => {
      closeContextMenu();
      try {
        item.click();
      } catch {
        /* ignore */
      }
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // Reposition if it overflows the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;

  const onAway = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  // Defer so the opening click doesn't immediately close it.
  window.setTimeout(() => document.addEventListener("mousedown", onAway, { once: true }), 0);
}

export function closeContextMenu(): void {
  document.getElementById("raze-chart-context-menu")?.remove();
}
