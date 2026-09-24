#!/usr/bin/env node
// Documentation gate behind `npm run check:docs` (with
// `check-bundle-size.mjs --check-docs` for the budget table):
//
//   - local links and heading anchors resolve, and point at files the npm
//     package ships (docs are read from the tarball, too);
//   - documented `@razedotbot/charts/*` subpaths are exported, `npm run`
//     scripts exist, and `node scripts|tests/*.mjs` targets exist;
//   - the React prop table in docs/migration.md matches the adapter's runtime
//     SUPPORTED_PROPS and its public prop interfaces (regenerate with --write);
//   - every ts/tsx fence type-checks (scripts/check-doc-snippets.mjs).
//
//   node scripts/check-docs.mjs            check
//   node scripts/check-docs.mjs --write    regenerate generated doc regions
//   node scripts/check-docs.mjs --no-snippets  skip the (build-dependent) fence check

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDocSnippets } from "./check-doc-snippets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REACT_PROPS_START = "<!-- react-props:start -->";
export const REACT_PROPS_END = "<!-- react-props:end -->";
const REACT_PROPS_NOTE =
  "<!-- Generated from src/react/index.tsx (SUPPORTED_PROPS and the public prop interfaces) by `node scripts/check-docs.mjs --write`. Do not edit by hand. -->";
const REACT_SOURCE = "src/react/index.tsx";
const REACT_TABLE_DOC = "docs/migration.md";

function display(path) {
  return relative(root, path).split(sep).join("/");
}

function markdownFilesUnder(paths) {
  const files = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isFile()) {
      if (extname(path).toLowerCase() === ".md") files.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      walk(join(path, entry.name));
    }
  };
  for (const path of paths) walk(path);
  return files;
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

/**
 * True when a repository path is part of the npm tarball: listed under
 * package.json "files", or one of the files npm always includes.
 */
export function isPackaged(path, packageJson, repositoryRoot = root) {
  const target = relative(repositoryRoot, path).split(sep).join("/");
  if (["package.json", "README.md", "LICENSE"].includes(target)) return true;
  return (packageJson.files ?? []).some((entry) => {
    const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
    return target === clean || target.startsWith(`${clean}/`);
  });
}

// ── Link, subpath, script, and command checks ───────────────────────────────

function checkMarkdown(markdownFiles, packageJson, failures) {
  for (const file of markdownFiles) {
    const text = readFileSync(file, "utf8");
    const shipped = isPackaged(file, packageJson);
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
      if (shipped && !isPackaged(targetPath, packageJson)) {
        failures.push(
          `${display(file)}: links to "${raw}", which the npm package does not ship (package.json "files"); ` +
          "link the repository file with an absolute GitHub URL or reword it",
        );
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
}

// ── React prop table ────────────────────────────────────────────────────────

function loadTypeScript() {
  return createRequire(pathToFileURL(resolve(root, "package.json")).href)("typescript");
}

/**
 * Read the React adapter's prop surface from source: SUPPORTED_PROPS (the
 * runtime allow-list descriptors are validated against), COMPONENT_NAMES, the
 * own members of the public prop interfaces, and the containers typed with
 * BoxProps. Throws with guidance when the source no longer has that shape.
 */
export function readReactPropSurface(source, ts = loadTypeScript()) {
  const file = ts.createSourceFile(REACT_SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const objectLiterals = new Map();
  const interfaces = new Map();
  const containers = [];
  const nameOf = (node) => (ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null);
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      interfaces.set(
        statement.name.text,
        statement.members.map((member) => (member.name ? nameOf(member.name) : null)).filter(Boolean),
      );
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression?.(initializer)) initializer = initializer.expression;
      if (ts.isObjectLiteralExpression(initializer)) objectLiterals.set(declaration.name.text, initializer);
      if (exported && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))) {
        const type = initializer.parameters[0]?.type;
        if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "BoxProps") {
          containers.push(declaration.name.text);
        }
      }
    }
  }
  const readRecord = (name, readValue) => {
    const literal = objectLiterals.get(name);
    if (!literal) throw new Error(`${REACT_SOURCE} no longer declares the ${name} object literal`);
    const record = {};
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property) || !nameOf(property.name)) {
        throw new Error(`${REACT_SOURCE}: ${name} must be a plain object literal of named properties`);
      }
      record[nameOf(property.name)] = readValue(property.initializer, name);
    }
    return record;
  };
  const supported = readRecord("SUPPORTED_PROPS", (node, name) => {
    if (!ts.isArrayLiteralExpression(node) || !node.elements.every(ts.isStringLiteral)) {
      throw new Error(`${REACT_SOURCE}: every ${name} value must be an array of string literals`);
    }
    return node.elements.map((element) => element.text);
  });
  const names = readRecord("COMPONENT_NAMES", (node, name) => {
    if (!ts.isStringLiteral(node)) throw new Error(`${REACT_SOURCE}: every ${name} value must be a string literal`);
    return node.text;
  });
  const members = (name) => {
    if (!interfaces.has(name)) throw new Error(`${REACT_SOURCE} no longer declares interface ${name}`);
    return interfaces.get(name);
  };
  if (!containers.length) throw new Error(`${REACT_SOURCE}: no exported chart containers typed with BoxProps were found`);
  return {
    containers,
    containerProps: members("BoxProps"),
    chartProps: members("ChartProps"),
    responsiveProps: members("ResponsiveContainerProps"),
    descriptors: Object.entries(supported).map(([role, props]) => {
      if (!names[role]) throw new Error(`${REACT_SOURCE}: SUPPORTED_PROPS role "${role}" has no COMPONENT_NAMES entry`);
      return { component: names[role], props };
    }),
  };
}

/** Markdown table (with markers) of every React component and its exact props. */
export function renderReactPropTable(surface) {
  const code = (items) => (items.length ? items.map((item) => `\`${item}\``).join(", ") : "No props");
  const rows = [
    "| Component | Accepted props |",
    "| --- | --- |",
    `| ${code(surface.containers)} | ${code(surface.containerProps)} |`,
    `| \`Chart\` | ${code(surface.chartProps)} |`,
    `| \`ResponsiveContainer\` | ${code(surface.responsiveProps)} |`,
    ...surface.descriptors.map(({ component, props }) => `| \`${component}\` | ${code(props)} |`),
  ];
  return [REACT_PROPS_START, REACT_PROPS_NOTE, "", ...rows, "", REACT_PROPS_END].join("\n");
}

function region(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return { from, to: to + end.length };
}

/** Returns a problem string when the documented React table drifts, else null. */
export function reactPropTableDrift(text, surface) {
  const found = region(text, REACT_PROPS_START, REACT_PROPS_END);
  if (!found) {
    return `${REACT_TABLE_DOC} has no generated React prop table; add the ${REACT_PROPS_START} / ${REACT_PROPS_END} markers and run "node scripts/check-docs.mjs --write"`;
  }
  const current = text.slice(found.from, found.to).replace(/\r\n/g, "\n");
  if (current !== renderReactPropTable(surface)) {
    return `${REACT_TABLE_DOC} React prop table disagrees with ${REACT_SOURCE} (SUPPORTED_PROPS / prop interfaces); run "node scripts/check-docs.mjs --write"`;
  }
  return null;
}

function writeReactPropTable(text, surface) {
  const found = region(text, REACT_PROPS_START, REACT_PROPS_END);
  if (!found) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return text.slice(0, found.from) + renderReactPropTable(surface).replace(/\n/g, eol) + text.slice(found.to);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const usage = `Usage: node scripts/check-docs.mjs [--write] [--no-snippets]

Checks README.md, CONTRIBUTING.md and docs/**/*.md: local links and anchors
(and that shipped docs only link shipped files), package subpaths, npm scripts,
command targets, the generated React prop table in ${REACT_TABLE_DOC}, and
every ts/tsx fence (type-checked against dist/types; build first).

--write        regenerate the React prop table, then check
--no-snippets  skip the fence type-check
--help         show this message`;

function main(argv) {
  const known = ["--write", "--no-snippets", "--help"];
  const unknown = argv.find((argument) => !known.includes(argument));
  if (unknown) {
    console.error(`[raze-charts] Unknown option "${unknown}". Supported options: ${known.join(", ")}.`);
    return 2;
  }
  if (argv.includes("--help")) {
    console.log(usage);
    return 0;
  }
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const markdownFiles = markdownFilesUnder([
    resolve(root, "README.md"),
    resolve(root, "CONTRIBUTING.md"),
    resolve(root, "docs"),
  ]);
  const failures = [];
  if (markdownFiles.length === 0) failures.push("No Markdown documentation files were found.");

  let surface;
  try {
    surface = readReactPropSurface(readFileSync(resolve(root, REACT_SOURCE), "utf8"));
  } catch (error) {
    failures.push(error.message);
  }
  const tablePath = resolve(root, REACT_TABLE_DOC);
  if (surface) {
    let text = readFileSync(tablePath, "utf8");
    if (argv.includes("--write")) {
      const next = writeReactPropTable(text, surface);
      if (next == null) {
        failures.push(`${REACT_TABLE_DOC} is missing the ${REACT_PROPS_START} / ${REACT_PROPS_END} markers`);
      } else if (next !== text) {
        writeFileSync(tablePath, next);
        text = next;
        console.log(`[raze-charts] ${REACT_TABLE_DOC} React prop table regenerated`);
      }
    }
    const drift = reactPropTableDrift(text, surface);
    if (drift) failures.push(drift);
  }

  checkMarkdown(markdownFiles, packageJson, failures);

  let snippets = null;
  if (!argv.includes("--no-snippets")) {
    snippets = checkDocSnippets({ root });
    failures.push(...snippets.failures.map((failure) => `snippet ${failure}`));
  }

  if (failures.length) {
    console.error("[raze-charts] documentation checks failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  const snippetSummary = snippets
    ? `, ${snippets.checked} type-checked fences (${snippets.skipped} opted out)`
    : ", fences skipped";
  console.log(
    `[raze-charts] documentation checks passed (${markdownFiles.length} files, local links, commands, package subpaths, React prop table${snippetSummary})`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
