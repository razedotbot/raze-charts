// Inline on-canvas text editor for text drawings and labels. It replaces
// window.prompt, which is unstyled, untranslatable, blocks the main thread
// and is silently ignored in iframes sandboxed without `allow-modals`.
//
// A plain-text <textarea> is positioned over the chart at the label anchor
// inside the chart's overlay host: Enter commits, Shift+Enter adds a line,
// Escape cancels and moving focus away (clicking elsewhere, Tab) commits.
// Keys never leak to chart shortcuts, IME composition is respected, and focus
// returns to the chart canvas afterwards.

import { focusWithoutScroll } from "./kit/dom";
import { adoptStyles, defineStyles, type StyleChunk } from "./styles";

const CLASS = "raze-chart-inline-editor";

export const INLINE_EDITOR_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "inline-text-editor",
  `.${CLASS}{position:absolute;z-index:4;margin:0;padding:2px 5px;max-width:calc(100% - 24px);border:1px solid var(--raze-focus,#2962ff);` +
  "border-radius:var(--raze-radius-sm,4px);outline:none;background:var(--raze-surface,#1e222d);color:var(--raze-text,#d1d4dc);" +
  "font-family:inherit;line-height:1.3;white-space:pre;overflow:hidden;resize:none;pointer-events:auto}",
);

export interface InlineTextEditorOptions {
  /** Positioned layer to render into (the chart overlay host). */
  parent: HTMLElement;
  /** Left edge of the text in `parent` CSS pixels. */
  x: number;
  /** Text baseline in `parent` CSS pixels (the anchor text drawings paint at). */
  y: number;
  /** Initial text (re-editing an existing label). */
  value?: string;
  /** Accessible name of the field. */
  label: string;
  placeholder?: string;
  fontFamily?: string;
  /** CSS pixels; defaults to 12. */
  fontSize?: number;
  /** Receives the edited text (unchanged whitespace) on Enter or focus loss. */
  onCommit(text: string): void;
  /** Escape: the edit is discarded. */
  onCancel(): void;
  /** Focus target after the editor closes, if focus was still inside it. */
  returnFocus?: HTMLElement | null;
}

export interface InlineTextEditorHandle {
  readonly el: HTMLTextAreaElement;
  readonly open: boolean;
  commit(): void;
  cancel(): void;
}

const openEditors = new WeakMap<HTMLElement, InlineTextEditorHandle>();

/** The editor currently open in `parent`, if any. */
export function activeInlineTextEditor(parent: HTMLElement | null | undefined): InlineTextEditorHandle | null {
  const editor = parent && openEditors.get(parent);
  return editor && editor.open ? editor : null;
}

/** Open a focused editor at the anchor. An editor already open in `parent` commits first. */
export function openInlineTextEditor(options: InlineTextEditorOptions): InlineTextEditorHandle {
  const { parent, x, y } = options;
  const size = options.fontSize ?? 12;
  activeInlineTextEditor(parent)?.commit();
  adoptStyles(parent, INLINE_EDITOR_STYLES);
  const el = parent.ownerDocument.createElement("textarea");
  el.className = CLASS;
  el.value = options.value ?? "";
  el.placeholder = options.placeholder ?? "";
  el.spellcheck = false;
  el.setAttribute("aria-label", options.label);
  el.setAttribute("enterkeyhint", "done");
  el.style.fontSize = `${size}px`;
  if (options.fontFamily) el.style.fontFamily = options.fontFamily;

  let open = true;
  // Grow with the text. The first line's box sits above the baseline, like the painted label.
  const place = (): void => {
    const lines = el.value.split("\n");
    el.rows = lines.length;
    el.style.width = `${Math.max(el.placeholder.length, ...lines.map((line) => line.length)) + 1}ch`;
    el.style.left = `${Math.max(4, Math.min(x - 6, (parent.clientWidth || Infinity) - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, y - size * 1.3 - 4)}px`;
  };
  const close = (commit: boolean): void => {
    if (!open) return;
    open = false;
    const focused = el.ownerDocument.activeElement === el;
    el.remove();
    if (focused) focusWithoutScroll(options.returnFocus);
    if (commit) options.onCommit(el.value);
    else options.onCancel();
  };
  const handle: InlineTextEditorHandle = {
    el,
    get open() {
      return open;
    },
    commit: () => close(true),
    cancel: () => close(false),
  };

  el.addEventListener("keydown", (event) => {
    // Chart, page and popup shortcuts must not see keys typed into the label.
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      close(event.key === "Enter");
    }
  });
  el.addEventListener("input", place);
  el.addEventListener("pointerdown", (event) => event.stopPropagation());
  el.addEventListener("blur", handle.commit);

  parent.appendChild(el);
  openEditors.set(parent, handle);
  place();
  focusWithoutScroll(el);
  el.select();
  return handle;
}
