#!/usr/bin/env node
// Lint: HTML/script injection sinks are forbidden in library source outside
// the sanitizer allow-list. Datafeed, host and user strings must be written as
// text (textContent / setText / h()); library markup goes through
// html`…` / trustedMarkup() and setMarkup() in src/ui/kit/safe.ts, which is
// Trusted Types aware.
//
// Usage: node scripts/check-dom-sinks.mjs [--json] [file-or-directory ...]
// Scans src/ by default. Exits non-zero when a sink is found.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Injection sinks. Patterns run on source with comments blanked out. */
export const SINKS = [
  // el.innerHTML = / += / ??= / ||= / &&= (and outerHTML), including the
  // parenthesised target form (el.innerHTML) = … and ((el).innerHTML) = ….
  { id: "innerHTML", pattern: /\.\s*(?:inner|outer)HTML\s*(?:\)\s*)*(?:\+|\?\?|\|\||&&)?=(?![=>])/g },
  // React's escape hatch, as a JSX attribute or a props object key.
  { id: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/g },
  // The property named as a string: el["innerHTML"] = …, Reflect.set(el, "innerHTML", …),
  // Object.defineProperty(el, "outerHTML", …).
  { id: "innerHTML-string", pattern: /["'`](?:inner|outer)HTML["'`]/g },
  // The property as an object key: Object.assign(el, { innerHTML: … }).
  { id: "innerHTML-key", pattern: /(?<![\w$.])(?:inner|outer)HTML\s*:(?!:)/g },
  { id: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\s*\(/g },
  { id: "setHTMLUnsafe", pattern: /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\s*\(/g },
  // document.write in any form, not only a direct call: a reference taken for
  // later (const w = document.write.bind(document)), optional chaining, the
  // bracket form (document["write"]), other document handles
  // (el.ownerDocument.write, frame.contentDocument.write, doc.write) and
  // destructuring (const { write } = document).
  {
    id: "document.write",
    pattern: /\b(?:document|ownerDocument|contentDocument|doc)\s*(?:\?\.|\.)\s*write(?:ln)?\b(?!\s*:)|\b(?:document|ownerDocument|contentDocument|doc)\s*(?:\?\.)?\s*\[\s*["'`]write(?:ln)?["'`]\s*\]|\{[^{}]*\bwrite(?:ln)?\b[^{}]*\}\s*=\s*(?:[\w$]+\s*(?:\?\.|\.)\s*)*(?:document|ownerDocument|contentDocument)\b/g,
  },
  { id: "createContextualFragment", pattern: /\bcreateContextualFragment\s*\(/g },
  { id: "DOMParser.parseFromString", pattern: /\bparseFromString\s*\(/g },
  { id: "srcdoc", pattern: /\.\s*srcdoc\s*=(?!=)|\bsetAttribute(?:NS)?\s*\([^)]*?["'`]srcdoc["'`]/g },
  // on* attributes: a literal name ("onclick"), or a name built at run time
  // that starts with "on" ("on" + type, `on${type}`), for setAttribute (first
  // argument), setAttributeNS (second) and createAttribute.
  {
    id: "event-handler-attribute",
    pattern: /\bsetAttribute(?:NS)?\s*\([^)]*?["'`]on[a-z]+["'`]|\b(?:setAttribute|createAttribute)\s*\(\s*["'`]on(?:["'`]|\$\{)|\b(?:setAttributeNS|createAttributeNS)\s*\([^,()]*,\s*["'`]on(?:["'`]|\$\{)/gi,
  },
  // Any code reference to the global eval: direct and member calls
  // (globalThis.eval(s)), indirect calls ((0, eval)(s)), aliases
  // (const run = eval) and the bracket form (window["eval"]).
  { id: "eval", pattern: /(?<![\w$])eval(?![\w$])|\[\s*["'`]eval["'`]\s*\]/g },
  // The Function constructor, called with or without new, directly or as a
  // member (window.Function), in bracket form, or reached through a
  // function's constructor ((() => {}).constructor(s)). Library code has no
  // other use for the name: write a signature such as
  // (...args: never[]) => unknown instead of the `Function` type.
  { id: "Function", pattern: /(?<![\w$])Function(?![\w$])|\[\s*["'`]Function["'`]\s*\]|\.\s*constructor\s*\(/g },
  { id: "string-timer", pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g },
  { id: "javascript-url", pattern: /["'`]\s*javascript:/gi },
  // SafeMarkup is only minted by html`…` and trustedMarkup() in safe.ts.
  { id: "SafeMarkup", pattern: /\bnew\s+SafeMarkup\s*\(/g },
  // Renaming trustedMarkup on import would hide it from the argument rule.
  { id: "trustedMarkup-alias", pattern: /\btrustedMarkup\s+as\b/g },
];

/**
 * `trustedMarkup(x)` turns a string into markup that setMarkup() writes
 * through the Trusted Types policy, so its argument must be a library
 * constant: a string literal (templates without `${}`), or an ALL_CAPS
 * constant or member of one (`ICON_CLOSE`, `ICONS.trend`). Any other
 * argument is reported as a `trustedMarkup` finding and needs an allow-list
 * entry explaining where the markup comes from.
 */
export const TRUSTED_ARGUMENT = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`|[A-Z][A-Z0-9_]*(?:\.[A-Za-z_$][\w$]*)*)$/;

/**
 * Allowed sinks. `file` is a path prefix (or RegExp) relative to the repo
 * root; `match` narrows the entry to the exact statement so a new sink in the
 * same file still fails.
 */
export const ALLOW = [
  {
    file: "src/ui/kit/safe.ts",
    sink: "innerHTML",
    match: /^element\.innerHTML = value as string;$/,
    reason: "setMarkup(): the single HTML sink; accepts only SafeMarkup and routes through the Trusted Types policy.",
  },
  {
    file: "src/ui/kit/safe.ts",
    sink: "SafeMarkup",
    match: /^return new SafeMarkup\((?:out|libraryConstant)\);$/,
    reason: "html`…` (escapes every interpolated value) and trustedMarkup() are the only SafeMarkup factories.",
  },
  {
    file: "src/ui/popup.ts",
    sink: "trustedMarkup",
    match: /^if \(options\?\.trustedHtml\) setMarkup\(row, trustedMarkup\(content\)\);$/,
    reason: "popupRow(content, …, { trustedHtml: true }) is the public, documented opt-in for caller-owned markup. Datafeed and user strings take the default text path.",
  },
  {
    file: "src/ui/LeftSidebar.ts",
    sink: "trustedMarkup",
    match: /^if \(typeof icon === "string"\) setMarkup\(b, trustedMarkup\(icon\)\);$/,
    reason: "Built-in icons from the library-owned ICONS table, and SidebarCustomItem.icon strings: host-authored markup (documented). Hosts enforcing Trusted Types can pass an Element instead.",
  },
  {
    file: "src/ui/LeftSidebar.ts",
    sink: "trustedMarkup",
    match: /^setMarkup\((?:this\.styleBtn|icon), trustedMarkup\((?:def|s)\.svg\)\);$/,
    reason: "Chart-type icons from the library-owned ALL_CHART_STYLES table.",
  },
  {
    file: /^src\/chart\/render(?:\.ts$|\/)/,
    sink: "innerHTML",
    match: /\bstage\.innerHTML\s*=\s*markup\b/,
    reason: "Native SVG mount: markup comes from svgFromCompiled(), which escapes every text node and attribute. Scheduled to move to setMarkup()/a retained SVG patcher.",
  },
];

/**
 * Tokenise TypeScript/JavaScript well enough to tell code from comments and
 * string contents (strings, template literals with nested `${}`, regular
 * expression literals). Returns the source with comments blanked (newlines
 * kept, so positions are stable) and a per-character "inside a string" map.
 */
export function tokenize(source) {
  const out = source.split("");
  const inString = new Uint8Array(source.length);
  const templateDepth = [];
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$/;
  const keywordBefore = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;
  const NEWLINE = "\n";
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== NEWLINE && out[k] !== "\r") out[k] = " ";
  };
  const mark = (from, to) => inString.fill(1, from, Math.min(to, source.length));
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf(NEWLINE, i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = ++i;
      while (i < source.length && source[i] !== ch && source[i] !== NEWLINE) i += source[i] === "\\" ? 2 : 1;
      mark(start, i);
      i++;
      continue;
    }
    if (ch === "`" || (ch === "}" && templateDepth.length && templateDepth[templateDepth.length - 1] === 0)) {
      if (ch === "}") templateDepth.pop();
      const start = ++i;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          templateDepth.push(0);
          break;
        }
        i++;
      }
      mark(start, i);
      i += source[i] === "$" ? 2 : 1;
      continue;
    }
    if (ch === "/") {
      const before = source.slice(Math.max(0, i - 12), i).trimEnd();
      if (!before || regexAllowedAfter.test(before) || keywordBefore.test(before)) {
        const start = ++i;
        let inClass = false;
        while (i < source.length && source[i] !== NEWLINE) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          else if (source[i] === "/" && !inClass) break;
          i++;
        }
        mark(start, i);
        i++;
        while (/[a-z]/i.test(source[i] ?? "")) i++;
        continue;
      }
    }
    if (templateDepth.length) {
      if (ch === "{") templateDepth[templateDepth.length - 1]++;
      else if (ch === "}") templateDepth[templateDepth.length - 1]--;
    }
    i++;
  }
  return { masked: out.join(""), inString };
}

/** Source with comments blanked out (see `tokenize`). */
export function maskComments(source) {
  return tokenize(source).masked;
}

function lineAt(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < index; k++) {
    if (text[k] === "\n") {
      line++;
      lineStart = k + 1;
    }
  }
  return { line, column: index - lineStart + 1, lineStart };
}

function allowed(file, sink, lineText) {
  return ALLOW.find((entry) => {
    const fileMatches = typeof entry.file === "string" ? file === entry.file || file.startsWith(`${entry.file}/`) : entry.file.test(file);
    return fileMatches && entry.sink === sink && (!entry.match || entry.match.test(lineText));
  });
}

/**
 * Arguments of the call whose `(` is at `open`, split on top-level commas
 * (string contents and nested brackets are skipped). Comments are already
 * blanked in `masked`.
 */
function callArguments(masked, inString, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open + 1; k < masked.length; k++) {
    if (inString[k]) continue;
    const ch = masked[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push(masked.slice(start, k).trim());
        return args.filter((arg, index) => arg || index < args.length - 1);
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(masked.slice(start, k).trim());
      start = k + 1;
    }
  }
  return args;
}

/** Calls of trustedMarkup() (not its declaration) whose argument is not a library constant. */
function untrustedMarkupCalls(masked, inString) {
  const calls = [];
  for (const match of masked.matchAll(/(?<!function\s+)\btrustedMarkup\s*\(/g)) {
    if (inString[match.index]) continue;
    const args = callArguments(masked, inString, match.index + match[0].length - 1);
    if (args.length === 1 && TRUSTED_ARGUMENT.test(args[0])) continue;
    calls.push(match.index);
  }
  return calls;
}

/** Find sinks in one source text. `file` is repo-relative with `/` separators. */
export function scanSource(source, file) {
  const { masked, inString } = tokenize(source);
  const findings = [];
  const used = [];
  const report = (index, sink) => {
    const position = lineAt(masked, index);
    const lineEnd = source.indexOf("\n", position.lineStart);
    const lineText = source.slice(position.lineStart, lineEnd < 0 ? source.length : lineEnd).trim();
    const entry = allowed(file, sink, lineText);
    if (entry) {
      used.push(entry);
      return;
    }
    findings.push({ file, line: position.line, column: position.column, sink, text: lineText });
  };
  for (const sink of SINKS) {
    sink.pattern.lastIndex = 0;
    for (const match of masked.matchAll(sink.pattern)) {
      // Sinks are code; text that merely mentions one inside a string is not.
      if (inString[match.index]) continue;
      report(match.index, sink.id);
    }
  }
  for (const index of untrustedMarkupCalls(masked, inString)) report(index, "trustedMarkup");
  return { findings, used };
}

function collect(path, files) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (/\.(?:[cm]?[jt]sx?)$/.test(path) && !path.endsWith(".d.ts")) files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    collect(join(path, entry.name), files);
  }
}

/** Scan files/directories (default: src/). */
export function scanPaths(paths = [resolve(root, "src")]) {
  const files = [];
  for (const path of paths) collect(resolve(path), files);
  const findings = [];
  const used = new Set();
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    const result = scanSource(readFileSync(path, "utf8"), file);
    findings.push(...result.findings);
    for (const entry of result.used) used.add(entry);
  }
  return { files: files.length, findings, unusedAllowances: ALLOW.filter((entry) => !used.has(entry)) };
}

function main() {
  const args = process.argv.slice(2);
  const knownFlags = ["--json", "--help"];
  const unknown = args.find((arg) => arg.startsWith("--") && !knownFlags.includes(arg));
  if (unknown) {
    console.error(`[raze-charts] Unknown option "${unknown}". Supported options: ${knownFlags.join(", ")}.`);
    process.exit(2);
  }
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-dom-sinks.mjs [--json] [file-or-directory ...]\n\n" +
      "Fails when src/ uses innerHTML/outerHTML (assigned, named as a string or as an object key),\n" +
      "dangerouslySetInnerHTML, insertAdjacentHTML, setHTMLUnsafe, any reference to document.write,\n" +
      "any reference to eval or the Function\n" +
      "constructor, event-handler attributes (literal or built at run time), string timers,\n" +
      "new SafeMarkup(), or trustedMarkup() with anything but a library constant, outside the\n" +
      "sanitizer allow-list in this script. Forms it cannot see (el[name] = s, setTimeout(variable),\n" +
      "URLs assembled at run time) are listed in docs/ui-kit.md.");
    return;
  }
  const json = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("--"));
  const result = scanPaths(paths.length ? paths : undefined);
  if (json) {
    console.log(JSON.stringify(result, (key, value) => (value instanceof RegExp ? String(value) : value), 2));
  } else {
    for (const finding of result.findings) {
      console.error(`${finding.file}:${finding.line}:${finding.column}  ${finding.sink}  ${finding.text}`);
    }
    // Stale allowances only mean something for a full scan of src/.
    for (const entry of paths.length ? [] : result.unusedAllowances) {
      console.warn(`[raze-charts] note: allow-list entry for ${entry.file} (${entry.sink}) matched nothing; remove it if the sink is gone.`);
    }
  }
  if (result.findings.length) {
    if (!json) {
      console.error(
        `\n[raze-charts] ${result.findings.length} DOM injection sink(s) found. Write untrusted strings as text ` +
        "(textContent, setText, h()); build library markup with html`…` or trustedMarkup(LIBRARY_CONSTANT) and " +
        "write it with setMarkup() from src/ui/kit/safe.ts. Any other trustedMarkup() argument needs an allow-list " +
        "entry in scripts/check-dom-sinks.mjs that explains where the markup comes from.",
      );
    }
    process.exit(1);
  }
  if (!json) console.log(`[raze-charts] DOM sink check passed (${result.files} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
