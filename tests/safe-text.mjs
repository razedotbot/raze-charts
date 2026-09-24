// Untrusted-string safety: text helpers, the escaping html`` template, the
// single setMarkup() sink with Trusted Types, URL filtering and h().
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });

const dir = mkdtempSync(join(tmpdir(), "raze-safe-"));
async function load(entry, name) {
  const result = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(dir, name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
try {
  const safe = await load("src/ui/kit/safe.ts", "safe.mjs");
  const domKit = await load("src/ui/kit/dom.ts", "dom.mjs");
  const unsafe = '<img src=x onerror="globalThis.__xss=1">';

  // Text helpers never interpret markup and never throw on odd values.
  const span = document.createElement("span");
  safe.setText(span, unsafe);
  assert.equal(span.querySelector("img"), null);
  assert.equal(span.textContent, unsafe);
  assert.equal(safe.toText(null), "");
  assert.equal(safe.toText(undefined), "");
  assert.equal(safe.toText(42), "42");
  assert.equal(safe.toText(Object.create(null)), "", "values that cannot be stringified become empty text");
  assert.equal(safe.escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");

  // html`` escapes interpolations (text and attribute context) but keeps
  // nested SafeMarkup and arrays of it.
  const name = '"><script>alert(1)</script>';
  const markup = safe.html`<b title="${name}">${name}</b>${[safe.html`<i>${"a&b"}</i>`, "<u>"]}`;
  assert(markup instanceof safe.SafeMarkup);
  assert.equal(
    markup.value,
    '<b title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</b><i>a&amp;b</i>&lt;u&gt;',
  );
  const host = document.createElement("div");
  safe.setMarkup(host, markup);
  assert.equal(host.querySelector("script"), null);
  assert.equal(host.querySelector("b").getAttribute("title"), name, "attribute values round-trip as text");
  assert.equal(host.querySelector("i").textContent, "a&b");

  // setMarkup() refuses raw strings: the only way in is html``/trustedMarkup().
  assert.throws(() => safe.setMarkup(host, unsafe), /only accepts markup from html/);
  safe.setMarkup(host, safe.trustedMarkup('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'));
  assert(host.querySelector("svg path"), "library constants render as markup");

  // Trusted Types: the policy is created lazily once, named raze-charts, and
  // only converts the markup setMarkup() is writing.
  const created = [];
  let rules = null;
  globalThis.trustedTypes = {
    createPolicy(policyName, policyRules) {
      created.push(policyName);
      rules = policyRules;
      return { createHTML: (input) => policyRules.createHTML(input) };
    },
  };
  const safeTt = await load("src/ui/kit/safe.ts", "safe-tt.mjs");
  const target = document.createElement("div");
  safeTt.setMarkup(target, safeTt.html`<em>${unsafe}</em>`);
  safeTt.setMarkup(target, safeTt.html`<em>${"second"}</em>`);
  assert.deepEqual(created, ["raze-charts"], "one policy, created on first use");
  assert.equal(target.innerHTML, "<em>second</em>");
  assert.throws(() => rules.createHTML("<img src=x onerror=alert(1)>"), /only accepts library-built markup/,
    "the policy cannot be used to launder arbitrary strings");

  // A host policy can replace the built-in one.
  const hostCalls = [];
  safeTt.setTrustedTypesPolicy({ createHTML: (input) => (hostCalls.push(input), input) });
  safeTt.setMarkup(target, safeTt.trustedMarkup("<b>host</b>"));
  assert.deepEqual(hostCalls, ["<b>host</b>"]);
  safeTt.setTrustedTypesPolicy(null);

  // A CSP that forbids the policy name produces actionable guidance.
  globalThis.trustedTypes = {
    createPolicy() {
      throw new TypeError("Policy raze-charts disallowed");
    },
  };
  const safeBlocked = await load("src/ui/kit/safe.ts", "safe-blocked.mjs");
  const blocked = document.createElement("div");
  Object.defineProperty(blocked, "innerHTML", {
    set() {
      throw new TypeError("This document requires 'TrustedHTML' assignment.");
    },
  });
  assert.throws(() => safeBlocked.setMarkup(blocked, safeBlocked.trustedMarkup("<b>x</b>")), /trusted-types raze-charts/);
  delete globalThis.trustedTypes;

  // URLs: http(s)/mailto/tel/relative/raster data images pass; scripts don't.
  for (const ok of ["https://example.com/a?b#c", "http://x", "mailto:a@b.c", "tel:+1", "/path", "rel/path", "#frag", "?q=1", "data:image/png;base64,iVBORw0KGgo="]) {
    assert.equal(safe.safeUrl(ok), ok, ok);
  }
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "vbscript:x", "data:text/html,<script>", "data:image/svg+xml;base64,PHN2Zz4="]) {
    assert.equal(safe.safeUrl(bad), "", bad);
  }
  assert(warnings.some((warning) => warning.includes("blocked an unsafe URL")), "blocked URLs warn");

  // h(): text-only children, filtered URL attributes, no handler attributes.
  const link = domKit.h("a", { class: "x", attrs: { href: "javascript:alert(1)", "aria-label": unsafe, hidden: false } }, unsafe, 3, null);
  assert.equal(link.getAttribute("href"), "");
  assert.equal(link.getAttribute("aria-label"), unsafe);
  assert.equal(link.hasAttribute("hidden"), false);
  assert.equal(link.textContent, `${unsafe}3`);
  assert.equal(link.querySelector("img"), null);
  assert.throws(() => domKit.h("div", { attrs: { onclick: "alert(1)" } }), /not allowed/);
  assert.throws(() => domKit.h("div", { attrs: { OnMouseOver: "alert(1)" } }), /not allowed/);
  assert.throws(() => domKit.h("div", { attrs: { style: "color:red" } }), /not allowed/, "style attributes would break strict CSP");
  const labelled = domKit.h("button", { text: unsafe, attrs: { disabled: true } });
  assert.equal(labelled.textContent, unsafe);
  assert.equal(labelled.getAttribute("disabled"), "");
  assert.notEqual(domKit.uid("x"), domKit.uid("x"), "ids are unique");
} finally {
  console.warn = originalWarn;
  rmSync(dir, { recursive: true, force: true });
}

console.log("SAFE TEXT: PASS");
