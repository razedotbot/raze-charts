// Small DOM helpers for kit components. `h()` renders every string child as
// text and refuses event-handler attributes, so kit code cannot turn a
// datafeed or host string into markup by accident.

import { safeUrl, toText } from "./safe";

let sequence = 0;

/** Document-unique id for ARIA relationships. */
export function uid(prefix: string): string {
  sequence += 1;
  return `raze-${prefix}-${sequence}`;
}

export type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  class?: string;
  /** Attributes; `false`/`null`/`undefined` omit the attribute. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Text content (untrusted-safe). */
  text?: unknown;
}

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster"]);

/** Create an element with text-only children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props?.class) element.className = props.class;
  if (props?.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) {
      if (value === false || value === null || value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || lower === "srcdoc" || lower === "style") {
        throw new TypeError(`[raze-charts] h(): attribute "${name}" is not allowed; use addEventListener or classes.`);
      }
      const text = value === true ? "" : String(value);
      element.setAttribute(name, URL_ATTRIBUTES.has(lower) ? safeUrl(text) : text);
    }
  }
  if (props?.text !== undefined) element.textContent = toText(props.text);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  return element;
}

/** `node.contains()` that crosses shadow-root boundaries. */
export function composedContains(ancestor: Node, node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode ?? (current as ShadowRoot).host ?? null;
  }
  return false;
}

/** The focused element, descending into open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let active: Element | null = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** Focus without scrolling the page. */
export function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  try {
    element?.focus({ preventScroll: true });
  } catch {
    element?.focus();
  }
}
