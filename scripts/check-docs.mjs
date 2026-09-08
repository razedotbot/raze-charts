#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const markdownRoots = [resolve(root, "README.md"), resolve(root, "CONTRIBUTING.md"), resolve(root, "docs")];
const markdownFiles = [];
const failures = [];

function walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (extname(path).toLowerCase() === ".md") markdownFiles.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) walk(child);
    else if (entry.isFile() && extname(child).toLowerCase() === ".md") markdownFiles.push(child);
  }
}

for (const path of markdownRoots) walk(path);

function display(path) {
  return relative(root, path).split(sep).join("/");
}

function githubSlug(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const headingCache = new Map();
function headingsFor(path) {
  if (headingCache.has(path)) return headingCache.get(path);
  const headings = new Set();
  const duplicates = new Map();
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = githubSlug(match[1]);
    const count = duplicates.get(base) ?? 0;
    duplicates.set(base, count + 1);
    headings.add(count === 0 ? base : `${base}-${count}`);
  }
  headingCache.set(path, headings);
  return headings;
}

function normalizeLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  // Strip an optional Markdown title: (path "title").
  target = target.replace(/\s+["'].*["']$/, "");
  return target;
}

for (const file of markdownFiles) {
  const text = readFileSync(file, "utf8");
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const raw = normalizeLinkTarget(match[1]);
    if (/^(?:https?:|mailto:|tel:)/i.test(raw)) continue;
    const hashAt = raw.indexOf("#");
    const pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    const anchor = hashAt >= 0 ? decodeURIComponent(raw.slice(hashAt + 1)) : "";
    let targetPath = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      targetPath = resolve(targetPath, "README.md");
    }
    if (!existsSync(targetPath)) {
      failures.push(`${display(file)}: missing local link target "${raw}"`);
      continue;
    }
    if (anchor && extname(targetPath).toLowerCase() === ".md") {
      const normalizedAnchor = githubSlug(anchor);
      if (!headingsFor(targetPath).has(normalizedAnchor)) {
        failures.push(`${display(file)}: missing heading "#${anchor}" in ${display(targetPath)}`);
      }
    }
  }

  for (const match of text.matchAll(/\bfrom\s+["'](@razedotbot\/charts(?:\/[a-z0-9-]+)?)["']/gi)) {
    const specifier = match[1];
    const exportKey = specifier === packageJson.name
      ? "."
      : `.${specifier.slice(packageJson.name.length)}`;
    if (!Object.hasOwn(packageJson.exports, exportKey)) {
      failures.push(`${display(file)}: documented package subpath "${specifier}" is not exported`);
    }
  }

  for (const match of text.matchAll(/\bnpm run ([\w:-]+)/g)) {
    const script = match[1];
    if (!Object.hasOwn(packageJson.scripts, script)) {
      failures.push(`${display(file)}: documented npm script "${script}" does not exist`);
    }
  }

  for (const match of text.matchAll(/\bnode ((?:\.\/)?(?:scripts|tests)\/[\w./-]+\.mjs)\b/g)) {
    const scriptPath = resolve(root, match[1].replace(/^\.\//, ""));
    if (!existsSync(scriptPath)) {
      failures.push(`${display(file)}: documented command target "${match[1]}" does not exist`);
    }
  }
}

if (markdownFiles.length === 0) failures.push("No Markdown documentation files were found.");

if (failures.length) {
  console.error("[raze-charts] documentation checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[raze-charts] documentation checks passed (${markdownFiles.length} files, local links, commands, package subpaths)`,
);
