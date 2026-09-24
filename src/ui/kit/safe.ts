// Untrusted-string safety for library UI.
//
// Policy (enforced by scripts/check-dom-sinks.mjs):
// - Datafeed, host and user strings (symbols, descriptions, study names, mark
//   text, tooltip content) are only ever written as TEXT: `textContent`,
//   `createTextNode`, `setText()` or `h()` children.
// - Markup is built exclusively with the `html` tagged template (which escapes
//   every interpolated value) or `trustedMarkup()` for library-owned constants
//   such as icon SVG, and is written with `setMarkup()`.
// - `setMarkup()` is the single HTML sink. Under a Trusted Types CSP it goes
//   through the `raze-charts` policy, which only accepts markup produced by
//   this module; allow it with `trusted-types raze-charts` (add
//   `'allow-duplicates'` when two copies of the library share a page).

/** Name of the Trusted Types policy created on first markup write. */
export const TRUSTED_TYPES_POLICY = "raze-charts";

/** Markup produced by `html` / `trustedMarkup`; the only input `setMarkup` accepts. */
export class SafeMarkup {
  /** @internal */
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Minimal structural type of a Trusted Types policy. */
export interface TrustedHtmlPolicy {
  createHTML(input: string): unknown;
}

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createHTML(input: string): string }): TrustedHtmlPolicy;
}

/** Coerce any feed/host value to display text without throwing. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** Write untrusted content as text. */
export function setText(node: Node, value: unknown): void {
  node.textContent = toText(value);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for inclusion in HTML/SVG text or quoted attribute context. */
export function escapeHtml(value: unknown): string {
  return toText(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

function interpolate(value: unknown): string {
  if (value instanceof SafeMarkup) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHtml(value);
}

/**
 * Tagged template for library markup. Static template text is trusted (it is
 * authored in library source); every interpolated value is escaped unless it
 * is itself `SafeMarkup`. URLs must additionally pass through `safeUrl()`.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeMarkup {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index++) {
    out += interpolate(values[index]) + (strings[index + 1] ?? "");
  }
  return new SafeMarkup(out);
}

/**
 * Mark a library-owned constant (icon SVG, static templates) as markup.
 * Never pass datafeed, host or user strings: use `html` or text APIs instead.
 */
export function trustedMarkup(libraryConstant: string): SafeMarkup {
  return new SafeMarkup(libraryConstant);
}

let hostPolicy: TrustedHtmlPolicy | null = null;
let ownPolicy: TrustedHtmlPolicy | null | undefined;
let policyError: unknown = null;
let pending: string | null = null;

/**
 * Supply a host-owned Trusted Types policy instead of the built-in
 * `raze-charts` one (for example when the CSP allows a single app policy).
 * Pass `null` to return to the built-in policy.
 */
export function setTrustedTypesPolicy(policy: TrustedHtmlPolicy | null): void {
  hostPolicy = policy;
}

function trustedTypesFactory(): TrustedTypesFactory | null {
  const scope = globalThis as { trustedTypes?: TrustedTypesFactory };
  return scope.trustedTypes && typeof scope.trustedTypes.createPolicy === "function" ? scope.trustedTypes : null;
}

function policy(): TrustedHtmlPolicy | null {
  if (hostPolicy) return hostPolicy;
  if (ownPolicy !== undefined) return ownPolicy;
  const factory = trustedTypesFactory();
  if (!factory) return (ownPolicy = null);
  try {
    ownPolicy = factory.createPolicy(TRUSTED_TYPES_POLICY, {
      createHTML(input: string): string {
        // The policy object never leaves this module, and it only converts
        // the exact string setMarkup() is currently writing.
        if (input !== pending) {
          throw new TypeError(`[raze-charts] the "${TRUSTED_TYPES_POLICY}" policy only accepts library-built markup.`);
        }
        return input;
      },
    });
  } catch (error) {
    policyError = error;
    ownPolicy = null;
  }
  return ownPolicy;
}

/** Replace `element`'s children with library markup. The only HTML sink. */
export function setMarkup(element: Element, markup: SafeMarkup): void {
  if (!(markup instanceof SafeMarkup)) {
    throw new TypeError(
      "[raze-charts] setMarkup() only accepts markup from html`…` or trustedMarkup(); write untrusted strings with setText().",
    );
  }
  const active = policy();
  let value: unknown = markup.value;
  if (active) {
    pending = markup.value;
    try {
      value = active.createHTML(markup.value);
    } finally {
      pending = null;
    }
  }
  try {
    // `value` is a TrustedHTML object under Trusted Types, a string otherwise.
    element.innerHTML = value as string;
  } catch (error) {
    if (policyError || (!active && trustedTypesFactory())) {
      throw Object.assign(new Error(
        `[raze-charts] Trusted Types blocked library markup. Allow the "${TRUSTED_TYPES_POLICY}" policy ` +
        `(CSP: trusted-types ${TRUSTED_TYPES_POLICY} 'allow-duplicates') or call setTrustedTypesPolicy() with an app policy.`,
      ), { cause: policyError ?? error });
    }
    throw error;
  }
}

const SAFE_URL = /^(?:(?:https?|mailto|tel):|[^:/?#]*(?:[/?#]|$))/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/]+=*$/i;

/**
 * Return `url` when it is http(s), mailto, tel, relative, or a base64 raster
 * image; otherwise warn and return `""` (blocks `javascript:` and friends).
 */
export function safeUrl(url: unknown): string {
  const text = toText(url).trim();
  if (!text) return "";
  // Strip characters browsers ignore inside schemes ("java\tscript:").
  const normalized = text.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (SAFE_URL.test(normalized) || SAFE_DATA_IMAGE.test(normalized)) return text;
  console.warn(`[raze-charts] blocked an unsafe URL (${normalized.slice(0, 32)}…); only http(s), mailto, tel, relative and data:image URLs are allowed.`);
  return "";
}
