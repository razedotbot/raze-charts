#!/usr/bin/env node
// Extract the translation catalog from `t("key", "Default")` and
// `plural("key", count, { one: "…", other: "…" })` calls in library source.
//
// Usage:
//   node scripts/extract-messages.mjs                 print the catalog (JSON)
//   node scripts/extract-messages.mjs --out file.json write the catalog
//   node scripts/extract-messages.mjs --check de.json [it.json …] [--strict]
//       report coverage of locale packs: unknown keys and placeholder
//       mismatches fail; missing keys fail only with --strict
//   node scripts/extract-messages.mjs --src dir       scan another directory
//
// Keys and defaults must be string literals so they can be extracted; a key
// used with two different defaults is an error.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maskComments } from "./check-dom-sinks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CALL = /(?<![\w$.])(t|plural)\s*\(/g;

function readString(source, index) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let i = index + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\") {
      const escaped = source[i + 1];
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      i += 2;
      continue;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") return null; // dynamic
    value += source[i];
    i++;
  }
  return i < source.length ? { value, end: i + 1 } : null;
}

function skipSpace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index++;
  return index;
}

/** Skip one argument expression; returns the index of the `,` or `)` ending it. */
function skipExpression(source, index) {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const string = readString(source, i);
      if (!string) {
        // Template literal with substitutions: skip to its closing backtick.
        i = source.indexOf(ch, i + 1) + 1 || source.length;
        continue;
      }
      i = string.end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (ch === "," && depth === 0) return i;
    i++;
  }
  return i;
}

function readForms(source, index) {
  if (source[index] !== "{") return null;
  const forms = {};
  let i = index + 1;
  for (;;) {
    i = skipSpace(source, i);
    if (source[i] === "}") return { forms, end: i + 1 };
    const key = /^(?:"(\w+)"|'(\w+)'|(\w+))\s*:/.exec(source.slice(i, i + 40));
    if (!key) return null;
    i = skipSpace(source, i + key[0].length);
    const value = readString(source, i);
    if (!value) return null;
    forms[key[1] ?? key[2] ?? key[3]] = value.value;
    i = skipSpace(source, value.end);
    if (source[i] === ",") i++;
  }
}

function lineOf(source, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (source[k] === "\n") line++;
  return line;
}

/** Extract messages from one file. */
export function extractFromSource(source, file) {
  const masked = maskComments(source);
  const messages = [];
  const errors = [];
  for (const match of masked.matchAll(CALL)) {
    const kind = match[1];
    const at = `${file}:${lineOf(source, match.index)}`;
    let i = skipSpace(source, match.index + match[0].length);
    const key = readString(source, i);
    if (!key) {
      // Declarations (`function t(key…`, `t(key: string): string;`) are not calls.
      if (/\bfunction\s*$/.test(masked.slice(Math.max(0, match.index - 16), match.index))) continue;
      if (/^[A-Za-z_$][\w$]*\??\s*:/.test(source.slice(i, i + 64))) continue;
      errors.push(`${at}: ${kind}() key must be a string literal so it can be extracted`);
      continue;
    }
    i = skipSpace(source, key.end);
    if (source[i] !== ",") {
      errors.push(`${at}: ${kind}("${key.value}") needs an inline English default`);
      continue;
    }
    i = skipSpace(source, i + 1);
    if (kind === "t") {
      const fallback = readString(source, i);
      if (!fallback) {
        errors.push(`${at}: t("${key.value}", …) default must be a string literal`);
        continue;
      }
      messages.push({ key: key.value, message: fallback.value, at });
    } else {
      i = skipSpace(source, skipExpression(source, i) + 1);
      const forms = readForms(source, i);
      if (!forms || typeof forms.forms.other !== "string") {
        errors.push(`${at}: plural("${key.value}", count, { …, other }) forms must be an object literal of strings with "other"`);
        continue;
      }
      for (const [category, message] of Object.entries(forms.forms)) {
        messages.push({ key: `${key.value}.${category}`, message, at });
      }
    }
  }
  return { messages, errors };
}

function collect(path, files) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (/\.(?:ts|tsx|js|mjs)$/.test(path) && !path.endsWith(".d.ts")) files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    collect(join(path, entry.name), files);
  }
}

/** Build the catalog for a directory. */
export function extractCatalog(directory = resolve(root, "src")) {
  const files = [];
  collect(directory, files);
  files.sort();
  const catalog = {};
  const origin = {};
  const errors = [];
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    const result = extractFromSource(readFileSync(path, "utf8"), file);
    errors.push(...result.errors);
    for (const { key, message, at } of result.messages) {
      if (Object.hasOwn(catalog, key) && catalog[key] !== message) {
        errors.push(`${at}: "${key}" has default ${JSON.stringify(message)} but ${origin[key]} uses ${JSON.stringify(catalog[key])}`);
        continue;
      }
      catalog[key] = message;
      origin[key] ??= at;
    }
  }
  const sorted = Object.fromEntries(Object.keys(catalog).sort().map((key) => [key, catalog[key]]));
  return { catalog: sorted, errors, files: files.length };
}

function placeholders(message) {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
}

/** Compare a locale pack with the catalog. */
export function checkPack(catalog, pack) {
  const missing = Object.keys(catalog).filter((key) => !Object.hasOwn(pack, key));
  const unknown = Object.keys(pack).filter((key) => !Object.hasOwn(catalog, key) && !/\.(?:zero|one|two|few|many|other)$/.test(key));
  const mismatched = Object.keys(pack).filter((key) =>
    Object.hasOwn(catalog, key) && placeholders(catalog[key]) !== placeholders(String(pack[key])));
  return { missing, unknown, mismatched };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const src = valueOf("--src");
  const { catalog, errors, files } = extractCatalog(src ? resolve(src) : undefined);
  if (errors.length) {
    for (const error of errors) console.error(error);
    console.error(`\n[raze-charts] ${errors.length} message extraction error(s).`);
    process.exit(1);
  }
  const out = valueOf("--out");
  const checkIndex = args.indexOf("--check");
  if (checkIndex >= 0) {
    const packs = args.slice(checkIndex + 1).filter((arg) => !arg.startsWith("--"));
    if (!packs.length) {
      console.error("[raze-charts] --check needs at least one locale JSON file.");
      process.exit(1);
    }
    let failed = false;
    for (const packPath of packs) {
      const pack = JSON.parse(readFileSync(resolve(packPath), "utf8"));
      const report = checkPack(catalog, pack);
      const total = Object.keys(catalog).length;
      const covered = total - report.missing.length;
      console.log(`${packPath}: ${covered}/${total} messages translated`);
      for (const key of report.unknown) console.error(`  unknown key: ${key}`);
      for (const key of report.mismatched) console.error(`  placeholder mismatch: ${key} (expected {${placeholders(catalog[key]) || "none"}})`);
      if (args.includes("--strict")) for (const key of report.missing) console.error(`  missing: ${key}`);
      if (report.unknown.length || report.mismatched.length || (args.includes("--strict") && report.missing.length)) failed = true;
    }
    process.exit(failed ? 1 : 0);
  }
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (out) {
    writeFileSync(resolve(out), json);
    console.log(`[raze-charts] wrote ${Object.keys(catalog).length} messages from ${files} files to ${out}`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
