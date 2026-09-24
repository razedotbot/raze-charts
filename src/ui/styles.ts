// Scoped stylesheet runtime for library chrome.
//
// Each UI module declares its rules as a named chunk with `defineStyles()`.
// `adoptStyles(node, chunks)` installs the chunks into the root that will
// render the node: the owning Document, or the ShadowRoot when the chart is
// mounted inside a web component. Every root receives exactly ONE stylesheet
// that grows as new chunks are adopted, so the cascade order is stable and a
// host can inspect or override library chrome in one place.
//
// CSP: constructable stylesheets (`adoptedStyleSheets`) are used where the
// browser supports them because they are not inline `<style>` elements and do
// not need `'unsafe-inline'`. Elsewhere a `<style>` element is created with
// the nonce passed to this call, the configured nonce
// (`configureStyles({ nonce })`), a nonce passed earlier for the same
// document, or the conventional `<meta property="csp-nonce" nonce="…">` tag.
//
// Every selector is scoped to `.raze-chart-root` or `.raze-kit-*` classes;
// the library never styles host elements.

/** A named block of CSS that can be adopted into any number of roots. */
export interface StyleChunk {
  readonly id: string;
  readonly css: string;
}

export interface StyleOptions {
  /** CSP nonce for the `<style>` fallback. */
  nonce?: string;
}

export interface StyleConfig extends StyleOptions {
  /**
   * `auto` (default) prefers constructable stylesheets and falls back to a
   * `<style>` element; `style-element` always uses the element (useful when a
   * host inspects or moves styles itself).
   */
  strategy?: "auto" | "style-element";
}

type StyleRoot = Document | ShadowRoot;

interface RootSheet {
  readonly ids: Set<string>;
  readonly css: string[];
  sheet: CSSStyleSheet | null;
  element: HTMLStyleElement | null;
}

/** Id of the `<style>` element used for a Document root (kept for compatibility). */
export const STYLE_ELEMENT_ID = "raze-chart-base-css";

const config: StyleConfig = { strategy: "auto" };
const installed = new WeakMap<StyleRoot, RootSheet>();
/**
 * Last explicit nonce passed to `adoptStyles`/`ensureBaseStyles` per Document.
 * A page has one CSP nonce, so overlays that later adopt styles into another
 * root of the same document (a shadow root, a fullscreen element) reuse it.
 */
const documentNonces = new WeakMap<Document, string>();

/** Declare a style chunk. Pure: nothing is inserted until it is adopted. */
export function defineStyles(id: string, css: string): StyleChunk {
  return { id, css };
}

const shared: StyleChunk[] = [];

/**
 * Mark a chunk as shared: kit portals adopt every shared chunk into the root
 * they render in, so content styled by a module that is not the overlay
 * itself (form controls inside a dialog) works in shadow roots too.
 */
export function shareStyles(chunk: StyleChunk): void {
  if (!shared.includes(chunk)) shared.push(chunk);
}

/** Chunks registered with `shareStyles()`. */
export function sharedStyles(): readonly StyleChunk[] {
  return shared;
}

/** Set page-wide defaults (CSP nonce, insertion strategy). */
export function configureStyles(next: StyleConfig): void {
  if (next.nonce !== undefined) config.nonce = next.nonce;
  if (next.strategy !== undefined) config.strategy = next.strategy;
}

function isStyleRoot(node: Node): node is StyleRoot {
  return node.nodeType === 9 /* DOCUMENT_NODE */ ||
    (node.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && "host" in node);
}

/** The Document or ShadowRoot that renders `node` (its owner document when detached). */
export function styleRootOf(node: Node): StyleRoot {
  if (isStyleRoot(node)) return node;
  const root = node.getRootNode?.();
  if (root && isStyleRoot(root)) return root;
  return node.ownerDocument ?? document;
}

function ownerDocumentOf(root: StyleRoot): Document {
  return root.nodeType === 9 ? root as Document : (root as ShadowRoot).ownerDocument;
}

/**
 * Nonce from explicit options, configuration, a nonce previously passed for
 * this document, or a `csp-nonce` meta tag.
 */
export function resolveStyleNonce(doc: Document, options?: StyleOptions): string | undefined {
  const explicit = options?.nonce || config.nonce || documentNonces.get(doc);
  if (explicit) return explicit;
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"],meta[name="csp-nonce"]');
  const value = meta?.nonce || meta?.getAttribute("nonce") || meta?.content;
  return value || undefined;
}

function supportsConstructable(root: StyleRoot): boolean {
  if (config.strategy === "style-element") return false;
  const view = ownerDocumentOf(root).defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null;
  const Sheet = view?.CSSStyleSheet;
  return !!Sheet && "replaceSync" in Sheet.prototype && "adoptedStyleSheets" in root;
}

function write(root: StyleRoot, entry: RootSheet, options?: StyleOptions): void {
  const text = entry.css.join("\n");
  if (!entry.sheet && !entry.element && supportsConstructable(root)) {
    try {
      const view = ownerDocumentOf(root).defaultView as Window & { CSSStyleSheet: typeof CSSStyleSheet };
      entry.sheet = new view.CSSStyleSheet();
    } catch {
      entry.sheet = null;
    }
    if (entry.sheet) root.adoptedStyleSheets = [...root.adoptedStyleSheets, entry.sheet];
  }
  if (entry.sheet) {
    entry.sheet.replaceSync(text);
    return;
  }
  if (!entry.element || !entry.element.isConnected) {
    const doc = ownerDocumentOf(root);
    const element = doc.createElement("style");
    if (root.nodeType === 9) element.id = STYLE_ELEMENT_ID;
    element.setAttribute("data-raze-styles", "");
    const nonce = resolveStyleNonce(doc, options);
    if (nonce) element.nonce = nonce;
    if (root.nodeType === 9) (doc.head ?? doc.documentElement).appendChild(element);
    // Prepend inside shadow roots so component styles can override chrome.
    else root.insertBefore(element, root.firstChild);
    entry.element = element;
  }
  entry.element.textContent = text;
}

/**
 * Install style chunks into the root that renders `node`. Idempotent per root
 * and chunk id; safe to call on every mount.
 */
export function adoptStyles(
  node: Node,
  chunks: StyleChunk | readonly StyleChunk[],
  options?: StyleOptions,
): void {
  if (typeof document === "undefined") return;
  const root = styleRootOf(node);
  if (options?.nonce) documentNonces.set(ownerDocumentOf(root), options.nonce);
  let entry = installed.get(root);
  if (!entry) {
    entry = { ids: new Set(), css: [], sheet: null, element: null };
    installed.set(root, entry);
  }
  let changed = false;
  for (const chunk of Array.isArray(chunks) ? chunks : [chunks as StyleChunk]) {
    if (entry.ids.has(chunk.id)) continue;
    entry.ids.add(chunk.id);
    entry.css.push(chunk.css);
    changed = true;
  }
  const detached = !entry.sheet && !!entry.element && !entry.element.isConnected;
  if (changed || detached) write(root, entry, options);
}

/**
 * Design tokens. `--raze-*` names are the stable styling contract for new
 * chrome; they default to the TradingView-compatible `--tv-color-*`
 * variables the widget already sets, so existing theme overrides keep
 * working. Defined on widget roots and on kit portals so body-portalled
 * overlays resolve the same values.
 */
export const TOKEN_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "tokens",
  ":where(.raze-chart-root,.raze-kit-portal){" +
  "--raze-font:inherit;" +
  "--raze-font-size:12px;" +
  "--raze-font-size-lg:14px;" +
  "--raze-surface:var(--tv-color-popup-background,var(--tv-color-pane-background,#1e222d));" +
  "--raze-text:var(--tv-color-popup-element-text,#d1d4dc);" +
  "--raze-border:var(--tv-color-toolbar-divider-background,#363a45);" +
  "--raze-hover:var(--tv-color-popup-element-background-hover,rgba(255,255,255,.08));" +
  "--raze-active:var(--tv-color-toolbar-button-background-active,rgba(41,98,255,.18));" +
  "--raze-accent:var(--tv-color-toolbar-button-text-hover,#2962ff);" +
  "--raze-accent-contrast:#fff;" +
  "--raze-focus:var(--tv-color-toolbar-button-text-hover,#2962ff);" +
  "--raze-danger:#f23645;" +
  "--raze-success:#089981;" +
  "--raze-warning:#f7a600;" +
  "--raze-shadow:var(--tv-color-popup-shadow,0 12px 24px -10px rgba(0,0,0,.6));" +
  "--raze-backdrop:rgba(0,0,0,.5);" +
  "--raze-radius:6px;" +
  "--raze-radius-sm:4px;" +
  "--raze-radius-lg:12px;" +
  "--raze-row-height:32px;" +
  "--raze-touch-row-height:48px;" +
  "--raze-duration:160ms;" +
  "--raze-z:2147483640}",
);

/** Behaviour-level rules for the built-in financial chrome. */
export const BASE_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "base",
  ".raze-chart-left-sidebar{scrollbar-width:none}" +
  ".raze-chart-left-sidebar::-webkit-scrollbar{display:none}" +
  ".raze-chart-toolbar-scroll{scrollbar-width:none}" +
  ".raze-chart-toolbar-scroll::-webkit-scrollbar{display:none}" +
  ".raze-chart-toolbar{scrollbar-width:none}" +
  ".raze-chart-toolbar::-webkit-scrollbar{display:none}" +
  ".raze-chart-toolbar[data-scroll-left=\"true\"]::before,.raze-chart-toolbar[data-scroll-right=\"true\"]::after{position:absolute;top:0;bottom:1px;width:24px;display:flex;align-items:center;z-index:1;pointer-events:none;font-size:18px;font-weight:400;color:var(--tv-color-toolbar-button-text,#d1d4dc)}" +
  ".raze-chart-toolbar[data-scroll-left=\"true\"]::before{content:\"‹\";left:0;padding-left:4px;background:linear-gradient(90deg,var(--tv-color-pane-background,#131722) 55%,transparent)}" +
  ".raze-chart-toolbar[data-scroll-right=\"true\"]::after{content:\"›\";right:0;justify-content:flex-end;padding-right:4px;background:linear-gradient(90deg,transparent,var(--tv-color-pane-background,#131722) 45%)}" +
  ".raze-chart-root,.raze-chart-canvas{user-select:none;-webkit-user-select:none}" +
  ".raze-chart-root input,.raze-chart-root textarea{user-select:text;-webkit-user-select:text}" +
  ".raze-chart-canvas:focus,.raze-chart-canvas:focus-visible{outline:none}" +
  ".raze-chart-focusable:focus{outline:none}" +
  ".raze-chart-focusable:focus-visible{outline:2px solid var(--tv-color-toolbar-button-text-hover,#2962ff);outline-offset:1px}" +
  "@media (forced-colors:active){.raze-chart-focusable:focus-visible{outline-color:Highlight}}" +
  "@keyframes raze-chart-spin{to{transform:rotate(360deg)}}" +
  "@media (prefers-reduced-motion:reduce){.raze-chart-loading-screen{transition:none!important}.raze-chart-loading-spinner{animation:none!important}.raze-chart-toolbar{scroll-behavior:auto!important}}",
);
