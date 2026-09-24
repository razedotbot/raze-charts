// Context menu hooks: the items a host adds with widget.onContextMenu().

// ── Context menu ────────────────────────────────────────────────────────────
export interface ContextMenuItem {
  /**
   * Where the item goes relative to the chart's default items: `"top"`
   * (the default) before them, `"bottom"` after them.
   */
  position?: "top" | "bottom";
  /**
   * Item label. TradingView conventions apply: `"-"` renders a separator
   * (skipped by the arrow keys) and `"-Label"` removes the default item named
   * `Label` instead of adding one.
   */
  text: string;
  /**
   * Runs when the item is activated; the menu closes first. Separators and
   * removals need none. A labelled item without one is shown disabled, with a
   * console warning.
   */
  click?: () => void;
}
export type ContextMenuCallback = (unixTime: number, price: number) => ContextMenuItem[] | Promise<ContextMenuItem[]>;
