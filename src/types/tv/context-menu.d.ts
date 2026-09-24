// Context menu hooks: the items a host adds with widget.onContextMenu().

// ── Context menu ────────────────────────────────────────────────────────────
export interface ContextMenuItem {
  position: "top" | "bottom";
  text: string;
  click: () => void;
}
export type ContextMenuCallback = (unixTime: number, price: number) => ContextMenuItem[] | Promise<ContextMenuItem[]>;
