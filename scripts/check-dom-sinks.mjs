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
  { id: "innerHTML", pattern: /\.\s*(?:inner|outer)HTML\s*\+?=(?!=)/g },
  { id: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\s*\(/g },
  { id: "document.write", pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/g },
  { id: "createContextualFragment", pattern: /\bcreateContextualFragment\s*\(/g },
  { id: "DOMParser.parseFromString", pattern: /\bparseFromString\s*\(/g },
  { id: "srcdoc", pattern: /\.\s*srcdoc\s*=(?!=)|\bsetAttribute\s*\(\s*["'`]srcdoc["'`]/g },
  { id: "event-handler-attribute", pattern: /\bsetAttribute(?:NS)?\s*\([^)]*?["'`]on[a-z]+["'`]/gi },
  { id: "eval", pattern: /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(/g },
  { id: "string-timer", pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g },
  { id: "javascript-url", pattern: /["'`]\s*javascript:/gi },
];

/**
 * Allowed sinks. `file` is a path prefix (or RegExp) relative to the repo
 * root; `match` narrows the entry to the exact statement so a new sink in the
 * same file still fails.
 */
export const ALLOW = [
  {
    file: "src/ui/kit/safe.ts",
    sink: "innerHTML",
    match: /\(element as \{ innerHTML: unknown \}\)\.innerHTML = value/,
    reason: "setMarkup(): the single HTML sink; accepts only SafeMarkup and routes through the Trusted Types policy.",
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

/** Find sinks in one source text. `file` is repo-relative with `/` separators. */
export function scanSource(source, file) {
  const { masked, inString } = tokenize(source);
  const findings = [];
  const used = [];
  for (const sink of SINKS) {
    sink.pattern.lastIndex = 0;
    for (const match of masked.matchAll(sink.pattern)) {
      // Sinks are code; text that merely mentions one inside a string is not.
      if (inString[match.index]) continue;
      const position = lineAt(masked, match.index);
      const lineEnd = source.indexOf("\n", position.lineStart);
      const lineText = source.slice(position.lineStart, lineEnd < 0 ? source.length : lineEnd).trim();
      const entry = allowed(file, sink.id, lineText);
      if (entry) {
        used.push(entry);
        continue;
      }
      findings.push({ file, line: position.line, column: position.column, sink: sink.id, text: lineText });
    }
  }
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
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-dom-sinks.mjs [--json] [file-or-directory ...]\n\n" +
      "Fails when src/ uses innerHTML, insertAdjacentHTML, document.write, eval-like APIs or\n" +
      "event-handler attributes outside the sanitizer allow-list in this script.");
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
    for (const entry of result.unusedAllowances) {
      console.warn(`[raze-charts] note: allow-list entry for ${entry.file} (${entry.sink}) matched nothing; remove it if the sink is gone.`);
    }
  }
  if (result.findings.length) {
    if (!json) {
      console.error(
        `\n[raze-charts] ${result.findings.length} DOM injection sink(s) found. Write untrusted strings as text ` +
        "(textContent, setText, h()); build library markup with html`…`/trustedMarkup() and write it with " +
        "setMarkup() from src/ui/kit/safe.ts.",
      );
    }
    process.exit(1);
  }
  if (!json) console.log(`[raze-charts] DOM sink check passed (${result.files} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
