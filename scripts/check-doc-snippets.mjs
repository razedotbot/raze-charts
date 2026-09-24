#!/usr/bin/env node
// Documentation code-fence harness.
//
// Every ```ts / ```tsx / ```typescript fence in README.md, CONTRIBUTING.md and
// docs/**/*.md is type-checked under strict mode against the BUILT package
// declarations (dist/types), resolved through package.json `exports` exactly
// as a consumer would, once with `moduleResolution: "Bundler"` and once with
// `"NodeNext"`. Snippets import the public specifiers (`@razedotbot/charts`,
// `/chart`, `/react`, `/studies`), never `src/**`.
//
// Directives are HTML comments on the lines directly above a fence (blank
// lines between them are allowed):
//
//   <!-- prelude: financial, trading-host -->
//       Prepend hidden ambient declarations from PRELUDES below, so a snippet
//       can use `financialChart` or `widget` without repeating setup code.
//       A prelude that stands for code an earlier fence shows refers to that
//       fence through PRELUDE_MODULES instead of restating its types.
//   <!-- no-check: reason -->
//       Skip the fence. The reason is mandatory and should say why the code
//       cannot compile standalone (for example, it is pseudo-code).
//
// Each snippet is its own module (an `export {}` is appended), so top-level
// names never collide across fences. Snippets that share a prelude set are
// checked in one program per resolution mode.
//
//   node scripts/check-doc-snippets.mjs             check every fence
//   node scripts/check-doc-snippets.mjs --list      list fences and directives
//   node scripts/check-doc-snippets.mjs README.md   check selected files
//
// `npm run check:docs` runs this harness through scripts/check-docs.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fence languages that are type-checked. */
export const CHECKED_LANGUAGES = Object.freeze(["ts", "tsx", "typescript"]);

/**
 * Hidden preludes: ambient (global-script) declarations prepended to a
 * snippet through `<!-- prelude: name -->`. A prelude stands in for setup the
 * surrounding prose already introduced (a constructed widget, the imports of
 * an earlier fence, sample rows), so a fragment stays short on the page but
 * is still checked against the real public types.
 */
export const PRELUDES = Object.freeze({
  financial: `// The financial quick start: a constructed widget and its imports.
declare const financialChart: import("@razedotbot/charts").IChartingLibraryWidget;
declare const widget: typeof import("@razedotbot/charts").widget;
type ResolutionString = import("@razedotbot/charts").ResolutionString;
/** The options every widget needs (container, symbol, interval, datafeed). */
declare const requiredWidgetOptions: Pick<
  import("@razedotbot/charts").ChartingLibraryWidgetOptions,
  "container" | "symbol" | "interval" | "datafeed"
>;
`,
  "trading-host": `// Host-application broker callbacks referenced by trading examples.
declare function sendOrderAmendment(lineId: string, price: number): void;
declare function updateRiskPreview(riskRewardRatio: number | null | undefined): void;
declare function cancelOrderGroup(groupId: string): void;
declare function cancelOrder(lineId: string): void;
`,
  native: `// Imports of the native grammar (@razedotbot/charts/chart).
declare const defineChart: typeof import("@razedotbot/charts/chart").defineChart;
declare const line: typeof import("@razedotbot/charts/chart").line;
declare const compileChart: typeof import("@razedotbot/charts/chart").compileChart;
declare const mountChart: typeof import("@razedotbot/charts/chart").mountChart;
type ChartDefinition = import("@razedotbot/charts/chart").ChartDefinition;
type CompiledChart = import("@razedotbot/charts/chart").CompiledChart;
type ChartViewport = import("@razedotbot/charts/chart").ChartViewport;
type MountChartOptions = import("@razedotbot/charts/chart").MountChartOptions;
`,
  "native-data": `// Sample rows used by native-grammar examples.
declare const data: { date: string; value: number }[];
declare const points: { time: number; value: number }[];
declare const revenue: { month: string; value: number }[];
declare const returns: { month: string; asset: string; change: number }[];
`,
  indicator: `// The Envelope indicator, typed from the defineIndicator() fence in
// docs/indicators.md itself (PRELUDE_MODULES "indicators-envelope"), and an
// active chart to create it on.
declare const Envelope: typeof import("./doc-module-indicators-envelope.js").Envelope;
declare const chart: import("@razedotbot/charts").IChartWidgetApi;
`,
});

/**
 * Prelude modules: a documentation fence compiled as its own module, so a
 * prelude can refer to what the page really shows (`typeof
 * import("./doc-module-<name>.js").Name`) instead of a hand-written copy that
 * would keep passing after the documented code changed. The module is the
 * first checked fence in `file` that declares `export const <exports>`.
 */
export const PRELUDE_MODULES = Object.freeze({
  "indicators-envelope": Object.freeze({ file: "docs/indicators.md", exports: "Envelope" }),
});

const PRELUDE_MODULE_REFERENCE = /\.\/doc-module-([\w-]+)\.js/g;

/** Names of the prelude modules a prelude's source refers to. */
export function preludeModulesOf(source) {
  return [...source.matchAll(PRELUDE_MODULE_REFERENCE)].map((match) => match[1]);
}

/**
 * The fence a prelude module is compiled from: the first checked fence in
 * `markdown` that declares `export const <exports>`, or null when the page no
 * longer has one.
 */
export function findPreludeModuleFence(markdown, { file, exports }) {
  const declares = new RegExp(`^export\\s+const\\s+${exports}\\b`, "m");
  return extractFences(markdown, file).fences.find((fence) => (
    CHECKED_LANGUAGES.includes(fence.lang) && !fence.directives.noCheck && declares.test(fence.code)
  )) ?? null;
}

/** Read every prelude module's fence from the documentation under `root`. */
export function readPreludeModules(root = repositoryRoot) {
  const modules = {};
  for (const [name, source] of Object.entries(PRELUDE_MODULES)) {
    const path = resolve(root, source.file);
    modules[name] = existsSync(path) ? findPreludeModuleFence(readFileSync(path, "utf8"), source) : null;
  }
  return modules;
}

const RESOLUTION_MODES = Object.freeze([
  { id: "bundler", module: "ESNext", moduleResolution: "Bundler" },
  { id: "nodenext", module: "NodeNext", moduleResolution: "NodeNext" },
]);

const DIRECTIVE = /^\s*<!--\s*(prelude|no-check)\s*(?::\s*([\s\S]*?))?\s*-->\s*$/i;
const FENCE_OPEN = /^( {0,3}|\s*)(`{3,}|~{3,})\s*([\w+-]*)[^\n]*$/;

function displayPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

/** Markdown files covered by the harness: README.md, CONTRIBUTING.md, docs/**. */
export function documentationFiles(root = repositoryRoot) {
  const files = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    if (statSync(path).isFile()) {
      if (extname(path).toLowerCase() === ".md") files.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      walk(join(path, entry.name));
    }
  };
  for (const path of ["README.md", "CONTRIBUTING.md", "docs"]) walk(resolve(root, path));
  return files;
}

/**
 * Extract fenced code blocks with their directives. `line` is the 1-based
 * Markdown line of the first code line. Problems (malformed directives,
 * unknown preludes, unterminated fences) are returned rather than thrown so
 * one report lists them all.
 */
export function extractFences(markdown, file = "<markdown>") {
  const lines = markdown.split(/\r?\n/);
  const fences = [];
  const problems = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index].match(FENCE_OPEN);
    if (!open) continue;
    const indent = open[1].length;
    const marker = open[2];
    const lang = open[3].toLowerCase();
    const close = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    const body = [];
    let end = index + 1;
    while (end < lines.length && !close.test(lines[end])) {
      // Fences nested in list items are indented; strip the fence's indent.
      const raw = lines[end];
      body.push(raw.slice(Math.min(indent, raw.length - raw.trimStart().length)));
      end += 1;
    }
    if (end >= lines.length) {
      problems.push(`${file}:${index + 1}: unterminated ${marker} fence`);
      break;
    }
    const directives = { preludes: [], noCheck: null };
    for (let back = index - 1; back >= 0; back -= 1) {
      const text = lines[back];
      if (!text.trim()) continue;
      const directive = text.match(DIRECTIVE);
      if (!directive) break;
      const kind = directive[1].toLowerCase();
      const value = (directive[2] ?? "").trim();
      if (kind === "no-check") {
        if (!value) {
          problems.push(`${file}:${back + 1}: <!-- no-check --> needs a reason: <!-- no-check: why this fence cannot compile -->`);
        }
        directives.noCheck = value || "(no reason given)";
      } else {
        const names = value.split(",").map((name) => name.trim()).filter(Boolean);
        if (!names.length) problems.push(`${file}:${back + 1}: <!-- prelude: --> names no prelude`);
        for (const name of names) {
          if (!Object.hasOwn(PRELUDES, name)) {
            problems.push(
              `${file}:${back + 1}: unknown prelude "${name}". Known preludes: ${Object.keys(PRELUDES).join(", ")} (scripts/check-doc-snippets.mjs).`,
            );
          } else if (!directives.preludes.includes(name)) {
            directives.preludes.unshift(name);
          }
        }
      }
    }
    fences.push({ file, line: index + 2, lang, code: body.join("\n"), directives });
    index = end;
  }
  return { fences, problems };
}

function loadTypeScript(root) {
  const require = createRequire(pathToFileURL(resolve(root, "package.json")).href);
  return require("typescript");
}

/**
 * Type-check snippets. Each snippet is `{ file, line, lang, code, directives }`
 * (see extractFences). `preludeModules` maps a PRELUDE_MODULES name to the
 * fence it is compiled from (default: read from the documentation under
 * `root`). Returns failures as "file:line:col [mode] TSxxxx message".
 */
export function typecheckSnippets(
  snippets,
  { root = repositoryRoot, ts = loadTypeScript(root), preludeModules = undefined } = {},
) {
  const failures = [];
  const checked = snippets.filter((snippet) => !snippet.directives.noCheck);
  if (!checked.length) return failures;
  // Virtual files live inside the package directory so TypeScript resolves
  // the package's own name through its `exports` (self-reference), exactly
  // like an installed consumer, without writing anything to disk.
  const virtualDir = resolve(root, ".doc-snippets");
  const virtual = new Map();
  const origin = new Map();
  checked.forEach((snippet, index) => {
    const stem = snippet.file.replace(/[^A-Za-z0-9]+/g, "-");
    const path = join(virtualDir, `${stem}-L${snippet.line}-${index}.${snippet.lang === "tsx" ? "tsx" : "ts"}`);
    virtual.set(path, `${snippet.code}\nexport {};\n`);
    origin.set(path, snippet);
  });
  for (const [name, source] of Object.entries(PRELUDES)) {
    virtual.set(join(virtualDir, `prelude-${name}.d.ts`), source);
  }
  // Prelude modules are compiled only for the preludes a checked snippet uses;
  // a prelude whose documented fence disappeared fails instead of passing.
  const used = [...new Set(checked.flatMap((snippet) => snippet.directives.preludes))];
  const needed = new Set(used.flatMap((name) => preludeModulesOf(PRELUDES[name] ?? "")));
  const fences = needed.size ? (preludeModules ?? readPreludeModules(root)) : {};
  const moduleOrigin = new Map();
  for (const name of needed) {
    const source = PRELUDE_MODULES[name];
    const fence = fences[name];
    if (!source) {
      failures.push(`a prelude imports "./doc-module-${name}.js", which is not in PRELUDE_MODULES (scripts/check-doc-snippets.mjs)`);
    } else if (!fence) {
      const users = used.filter((prelude) => preludeModulesOf(PRELUDES[prelude] ?? "").includes(name));
      failures.push(
        `${source.file}: no checked ts fence declares \`export const ${source.exports}\`, but the prelude(s) `
          + `${users.join(", ")} are typed from it. Restore the fence, or point PRELUDE_MODULES["${name}"] at the one that replaced it.`,
      );
    } else {
      const path = join(virtualDir, `doc-module-${name}.${fence.lang === "tsx" ? "tsx" : "ts"}`);
      virtual.set(path, `${fence.code}\n`);
      moduleOrigin.set(path, fence);
    }
  }
  if (failures.length) return failures;

  const groups = new Map();
  for (const [path, snippet] of origin) {
    const key = [...snippet.directives.preludes].sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }

  const libFiles = ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];
  const sourceCache = new Map();
  let oldProgram;
  for (const mode of RESOLUTION_MODES) {
    const options = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      lib: libFiles,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind[mode.module],
      moduleResolution: ts.ModuleResolutionKind[mode.moduleResolution],
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      types: [],
    };
    const host = ts.createCompilerHost(options, true);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    const directoryExists = host.directoryExists?.bind(host);
    host.fileExists = (fileName) => virtual.has(resolve(fileName)) || fileExists(fileName);
    // The virtual directory is not on disk, and module resolution only probes
    // for files (the prelude modules) inside directories that exist.
    host.directoryExists = (name) => resolve(name) === virtualDir || (directoryExists ? directoryExists(name) : true);
    host.readFile = (fileName) => virtual.get(resolve(fileName)) ?? readFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const text = virtual.get(resolve(fileName));
      const format = typeof languageVersion === "object" ? languageVersion.impliedNodeFormat : undefined;
      const key = `${fileName}\0${JSON.stringify(languageVersion)}\0${format}`;
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      if (!sourceCache.has(key)) sourceCache.set(key, getSourceFile(fileName, languageVersion, onError, shouldCreate));
      return sourceCache.get(key);
    };
    for (const [key, paths] of groups) {
      const preludeFiles = key ? key.split(",").map((name) => join(virtualDir, `prelude-${name}.d.ts`)) : [];
      const program = ts.createProgram({ rootNames: [...preludeFiles, ...paths], options, host, oldProgram });
      oldProgram = program;
      for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        const code = `TS${diagnostic.code}`;
        const path = diagnostic.file ? resolve(diagnostic.file.fileName) : undefined;
        const snippet = path ? origin.get(path) ?? moduleOrigin.get(path) : undefined;
        if (snippet && diagnostic.start !== undefined) {
          const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
          const failure = `${snippet.file}:${snippet.line + line}:${character + 1} [${mode.id}] ${code} ${message}`;
          // A prelude module's fence is usually checked as a snippet too: report it once.
          if (!failures.includes(failure)) failures.push(failure);
        } else if (path && path.startsWith(virtualDir)) {
          failures.push(`prelude ${displayPath(virtualDir, path)} [${mode.id}] ${code} ${message}`);
        } else if (!path || !path.includes(`${sep}node_modules${sep}`)) {
          const where = path ? displayPath(root, path) : "global";
          failures.push(`${where} [${mode.id}] ${code} ${message}`);
        }
      }
    }
  }
  return failures;
}

/**
 * Extract and type-check every documentation fence. Returns
 * `{ files, snippets, checked, skipped, failures }`.
 */
export function checkDocSnippets({ root = repositoryRoot, files = documentationFiles(root) } = {}) {
  const failures = [];
  const snippets = [];
  for (const path of files) {
    const file = displayPath(root, path);
    const { fences, problems } = extractFences(readFileSync(path, "utf8"), file);
    failures.push(...problems);
    snippets.push(...fences.filter((fence) => CHECKED_LANGUAGES.includes(fence.lang)));
  }
  const declarations = resolve(root, "dist/types/index.d.ts");
  if (snippets.some((snippet) => !snippet.directives.noCheck) && !existsSync(declarations)) {
    failures.push('dist/types is missing: documentation snippets type-check against the built declarations; run "npm run build" first');
    return { files: files.length, snippets, checked: 0, skipped: 0, failures };
  }
  failures.push(...typecheckSnippets(snippets, { root }));
  const skipped = snippets.filter((snippet) => snippet.directives.noCheck).length;
  return { files: files.length, snippets, checked: snippets.length - skipped, skipped, failures };
}

const usage = `Usage: node scripts/check-doc-snippets.mjs [--list] [file.md ...]

Type-checks every \`\`\`ts / \`\`\`tsx fence in README.md, CONTRIBUTING.md and
docs/**/*.md against the built declarations (run "npm run build" first), with
strict Bundler and NodeNext resolution.

Directives (HTML comments directly above a fence):
  <!-- prelude: ${Object.keys(PRELUDES).join(", ")} -->
  <!-- no-check: reason -->

--list  print each fence with its directives instead of checking
--help  show this message`;

function main(argv) {
  const known = ["--list", "--help"];
  const unknown = argv.filter((argument) => argument.startsWith("--") && !known.includes(argument));
  if (unknown.length) {
    console.error(`[raze-charts] Unknown option "${unknown[0]}". Supported options: ${known.join(", ")}.`);
    return 2;
  }
  if (argv.includes("--help")) {
    console.log(usage);
    return 0;
  }
  const selected = argv.filter((argument) => !argument.startsWith("--")).map((path) => resolve(path));
  for (const path of selected) {
    if (!existsSync(path)) {
      console.error(`[raze-charts] ${path} does not exist`);
      return 2;
    }
  }
  const files = selected.length ? selected : documentationFiles();
  if (argv.includes("--list")) {
    for (const path of files) {
      const file = displayPath(repositoryRoot, path);
      for (const fence of extractFences(readFileSync(path, "utf8"), file).fences) {
        if (!CHECKED_LANGUAGES.includes(fence.lang)) continue;
        const notes = [
          fence.directives.preludes.length ? `prelude: ${fence.directives.preludes.join(", ")}` : "",
          fence.directives.noCheck ? `no-check: ${fence.directives.noCheck}` : "",
        ].filter(Boolean).join("; ");
        console.log(`${fence.file}:${fence.line} ${fence.lang}${notes ? ` (${notes})` : ""}`);
      }
    }
    return 0;
  }
  const result = checkDocSnippets({ files });
  if (result.failures.length) {
    console.error("[raze-charts] documentation snippet checks failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    console.error(
      "Fix the snippet, add a hidden prelude (<!-- prelude: name -->), or opt out with <!-- no-check: reason -->.",
    );
    return 1;
  }
  console.log(
    `[raze-charts] documentation snippets type-check (${result.checked} fences, ${result.skipped} opted out; Bundler + NodeNext)`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
