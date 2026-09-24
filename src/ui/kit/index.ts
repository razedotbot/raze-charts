// Raze UI kit: accessible overlay, form-control, portal, focus and
// safe-text primitives shared by every chrome surface. New UI must be built
// from these (see docs/ui-kit.md) instead of ad-hoc DOM, inline markup or
// `title` attributes.

export { checkboxField, colorField, DEFAULT_PALETTE, lineStyleField, lineWidthField, numberField, parseColor, parseNumberInput, selectField, textField, toCssColor } from "./controls";
export type { ColorFieldOptions, ColorValue, Field, LineStyleValue, LineWidthFieldOptions, NumberFieldOptions, SelectFieldOptions, SelectOption, TextFieldOptions } from "./controls";
export { openDialog } from "./Dialog";
export type { DialogCloseReason, DialogHandle, DialogOptions, DialogTab } from "./Dialog";
export { composedContains, deepActiveElement, focusWithoutScroll, h, uid } from "./dom";
export type { Child, ElementProps } from "./dom";
export { lockScroll, tabbables, trapFocus } from "./focus";
export type { FocusTrap } from "./focus";
export { isInLayerAbove, isTopLayer, openLayerCount, pushLayer } from "./layers";
export type { Layer } from "./layers";
export { isCoarsePointer, prefersReducedMotion, prefersSheet, SHEET_BREAKPOINT } from "./media";
export { openPopover, resolvePresentation } from "./Popover";
export type { PopoverCloseReason, PopoverHandle, PopoverOptions, Presentation } from "./Popover";
export { createPortal, mirrorTheme, portalContainerFor } from "./portal";
export type { Portal, PortalOptions } from "./portal";
export { computePosition } from "./position";
export type { Align, Box, Placement, Position, PositionOptions, Side, Size } from "./position";
export { escapeHtml, html, safeUrl, SafeMarkup, setMarkup, setText, setTrustedTypesPolicy, toText, TRUSTED_TYPES_POLICY, trustedMarkup } from "./safe";
export type { TrustedHtmlPolicy } from "./safe";
export { createSheetFrame } from "./Sheet";
export type { SheetDismissReason, SheetFrame, SheetFrameOptions } from "./Sheet";
export { button, icon, iconButton } from "./surface";
export { showToast } from "./Toast";
export type { ToastHandle, ToastKind, ToastOptions } from "./Toast";
export { attachTooltip } from "./Tooltip";
export type { TooltipHandle, TooltipOptions } from "./Tooltip";
