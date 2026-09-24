// Contract for the flattened TradingView-compatible declaration file.
//
// src/types/charting_library.d.ts re-exports the src/types/tv/ domain modules;
// scripts/compat-types.mjs flattens them into the self-contained
// dist/charting_library.d.ts. This test checks the real sources flatten into a
// standalone, error-free module that declares every module export exactly once,
// and that each flattening rule fails loudly with guidance instead of emitting
// a file whose surface differs from the module tree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bundleCompatibilityTypes } from "../scripts/compat-types.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const test = (name, run) => {
  try {
    run();
    results.push(`✓ ${name}`);
  } catch (error) {
    console.error(results.join("\n"));
    console.error(`✗ ${name}`);
    throw error;
  }
};

const probeFile = resolve(tmpdir(), "raze-compat-types-probe", "charting_library.d.ts");
const probeOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
  strict: true,
  noEmit: true,
  types: [],
};

/** Type-check `text` as one standalone declaration file; return the diagnostics. */
function standaloneDiagnostics(text) {
  const fileName = probeFile;
  const options = probeOptions;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, ...rest) => (resolve(path) === fileName
    ? ts.createSourceFile(path, text, language, true)
    : getSourceFile(path, language, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (path) => resolve(path) === fileName || fileExists(path);
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const source = program.getSourceFile(fileName);
  return { program, source, diagnostics: [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)] };
}

const exportedNames = (text) => [...text.matchAll(/^export (?:declare )?(?:type|interface|class|const|function|enum|namespace) (\w+)/gm)]
  .map((match) => match[1]);

/** The `// ── label ───` divider the flattened file puts above each module. */
const moduleRule = (label) => {
  const head = `// ── ${label} `;
  return head + "─".repeat(79 - head.length);
};

/**
 * What an editor shows when hovering each top-level declaration of `files`
 * (a Map of absolute path to text; sibling imports resolve from disk): the
 * quick-info documentation and JSDoc tags, plus whether a `/** … *\/` comment
 * sits directly above the declaration, the only place documentation belongs.
 */
function hoverDocs(files) {
  const lookup = (path) => files.get(resolve(path));
  const service = ts.createLanguageService({
    getCompilationSettings: () => probeOptions,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (path) => {
      const text = lookup(path) ?? (ts.sys.fileExists(path) ? ts.sys.readFile(path) : undefined);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (path) => lookup(path) !== undefined || ts.sys.fileExists(path),
    readFile: (path) => lookup(path) ?? ts.sys.readFile(path),
  }, ts.createDocumentRegistry());
  const program = service.getProgram();
  const byFile = new Map();
  for (const path of files.keys()) {
    const source = program.getSourceFile(path);
    const text = source.getFullText();
    const declarations = new Map();
    for (const statement of source.statements) {
      const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
      const last = ranges.at(-1);
      const docAbove = Boolean(last)
        && text.startsWith("/**", last.pos)
        && (text.slice(last.end, statement.getStart(source)).match(/\n/g) ?? []).length <= 1;
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => declaration.name)
        : statement.name ? [statement.name] : [];
      for (const name of names) {
        const info = service.getQuickInfoAtPosition(path, name.getStart(source));
        declarations.set(name.text, {
          documentation: ts.displayPartsToString(info?.documentation),
          tags: (info?.tags ?? []).map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text)}`.trim()),
          docAbove,
        });
      }
    }
    byFile.set(path, declarations);
  }
  return byFile;
}

const documented = ({ documentation, tags }) => Boolean(documentation || tags.length);
const shownDocs = (declarations) => Object.fromEntries(
  [...declarations].map(([name, { documentation, tags }]) => [name, { documentation, tags }]),
);

/**
 * Asserts the flattened text shows the same hover documentation as the tv
 * modules under `treeRoot`, and that no declaration in either shows
 * documentation without a `/** … *\/` comment directly above it (for example
 * a module's file header attaching to its first declaration).
 */
function assertHoverDocsPreserved(treeRoot, flattened) {
  const moduleDirectory = resolve(treeRoot, "src/types/tv");
  const modules = readdirSync(moduleDirectory)
    .filter((entry) => entry.endsWith(".d.ts"))
    .map((entry) => resolve(moduleDirectory, entry));
  const docs = hoverDocs(new Map([
    [probeFile, flattened],
    ...modules.map((path) => [path, readFileSync(path, "utf8")]),
  ]));
  for (const [path, declarations] of docs) {
    for (const [name, entry] of declarations) {
      assert.ok(
        !documented(entry) || entry.docAbove,
        `${path === probeFile ? "flattened file" : path}: "${name}" shows documentation that is not directly `
          + `above it: ${JSON.stringify(entry.documentation || entry.tags)}`,
      );
    }
  }
  const moduleDocs = Object.assign({}, ...modules.map((path) => shownDocs(docs.get(path))));
  assert.deepEqual(shownDocs(docs.get(probeFile)), moduleDocs, "hover docs match the declaring tv module");
  return moduleDocs;
}

test("the real barrel flattens into one standalone, error-free module", () => {
  const flattened = bundleCompatibilityTypes(root);
  assert.equal(bundleCompatibilityTypes(root), flattened, "flattening is deterministic");
  assert.doesNotMatch(flattened, /^\s*import\b/m, "sibling imports are removed");
  assert.doesNotMatch(flattened, /^\s*export\s*\*/m, "barrel re-exports are replaced by declarations");
  assert.doesNotMatch(flattened, /\r/, "output uses LF line endings");
  assert.match(flattened, /Generated by build\.mjs/, "the vendored file says where to edit it");
  assert.match(flattened, /^\/\/ Public type surface for @razedotbot\/charts\.\n/, "the public header leads the file");
  assert.doesNotMatch(flattened, /re-exports them|Re-exported by/, "no source-tree wording survives flattening");
  const { diagnostics } = standaloneDiagnostics(flattened);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")),
    [],
    "the flattened file type-checks without the module tree",
  );
});

test("every tv module declaration appears exactly once in the flattened file", () => {
  const flattened = exportedNames(bundleCompatibilityTypes(root));
  const moduleDirectory = resolve(root, "src/types/tv");
  const declared = readdirSync(moduleDirectory)
    .filter((entry) => entry.endsWith(".d.ts"))
    .flatMap((entry) => exportedNames(readFileSync(join(moduleDirectory, entry), "utf8")));
  assert.ok(declared.length > 50, "the tv modules declare the compatibility surface");
  assert.deepEqual([...flattened].sort(), [...declared].sort());
  assert.equal(new Set(flattened).size, flattened.length, "no declaration is duplicated");
});

test("hover docs match the tv modules and no module header documents a declaration", () => {
  // Regression: JSDoc file headers once became the hover docs of each module's
  // first declaration (Bar, IChartWidgetApi, ContextMenuItem, ...) in the
  // flattened file, and of Nominal, ShapePoint and TradingSide in the tree.
  const moduleDocs = assertHoverDocsPreserved(root, bundleCompatibilityTypes(root));
  const entries = Object.entries(moduleDocs);
  assert.ok(entries.length > 50, "every tv declaration is compared");
  assert.ok(entries.some(([, entry]) => documented(entry)), "documented declarations are compared too");
});

test("the barrel owns the seams later packages extend", () => {
  const barrel = readFileSync(resolve(root, "src/types/charting_library.d.ts"), "utf8");
  for (const module of ["common", "datafeed", "shapes", "trading", "chart-api", "layout", "context-menu", "widget", "options", "studies"]) {
    assert.match(barrel, new RegExp(`^export \\* from "\\./tv/${module}";$`, "m"), `re-exports ./tv/${module}`);
  }
});

// ── Rule enforcement on fixture trees ──────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "raze-compat-types-"));
let fixtureCount = 0;
function fixture(files) {
  const fixtureRoot = join(sandbox, `case-${fixtureCount++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    writeFileSync(join(fixtureRoot, path), text);
  }
  return fixtureRoot;
}
const barrelPath = "src/types/charting_library.d.ts";
const flatten = (files) => bundleCompatibilityTypes(fixture(files));
const rejects = (files, pattern) => assert.throws(() => flatten(files), (error) => {
  assert.equal(error.name, "CompatibilityTypesError");
  assert.match(error.message, pattern);
  return true;
});

try {
  test("flattening keeps comments, drops sibling imports and normalises line endings", () => {
    const treeRoot = fixture({
      [barrelPath]: "// Header.\r\n\r\nexport * from \"./tv/a\";\r\n// Section b\r\nexport * from \"./tv/b.js\";\r\n",
      "src/types/tv/a.d.ts": "// Module a.\r\n\r\n/** A docs. */\r\nexport interface A { value: number; }\r\n",
      "src/types/tv/b.d.ts": "// Module b.\r\nimport type { A } from \"./a\";\r\n\r\n\r\n\r\n/** B docs. */\r\nexport type B = A[];   \r\n",
    });
    const output = bundleCompatibilityTypes(treeRoot);
    assert.equal(
      output,
      "// Header.\n\n"
        + "// Generated by build.mjs from src/types/charting_library.d.ts and the\n"
        + "// src/types/tv/*.d.ts modules it re-exports. Edit those sources instead.\n\n"
        + `${moduleRule("src/types/tv/a.d.ts")}\n// Module a.\n\n/** A docs. */\nexport interface A { value: number; }\n\n`
        + `// Section b\n${moduleRule("src/types/tv/b.d.ts")}\n// Module b.\n\n/** B docs. */\nexport type B = A[];\n`,
    );
    assert.deepEqual(standaloneDiagnostics(output).diagnostics, []);
    assert.deepEqual(assertHoverDocsPreserved(treeRoot, output), {
      A: { documentation: "A docs.", tags: [] },
      B: { documentation: "B docs.", tags: [] },
    });
  });

  test("a /** */ comment is only accepted directly above the declaration it documents", () => {
    const barrel = { [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/b\";\n" };
    const b = { "src/types/tv/b.d.ts": "export interface B {}\n" };
    // A JSDoc file header above the imports documents A once flattening drops them.
    rejects(
      { ...barrel, ...b, "src/types/tv/a.d.ts": "/** Module a. */\nimport type { B } from \"./b\";\n\nexport type A = B;\n" },
      /tv\/a\.d\.ts:1: this \/\*\* \*\/ comment would become the hover documentation of the next declaration/,
    );
    // Without imports it documents A even in the module tree: across a blank line or a note.
    rejects(
      { ...barrel, ...b, "src/types/tv/a.d.ts": "/**\n * Module a.\n */\n\nexport type A = 1;\n" },
      /tv\/a\.d\.ts:1: .*hover documentation of "A", although it is not directly above it\. .*as \/\/ comments/,
    );
    rejects(
      { ...barrel, ...b, "src/types/tv/a.d.ts": "// Module a.\n/** A docs. */\n// ── Section ──\nexport type A = 1;\n" },
      /tv\/a\.d\.ts:2: .*"A", although it is not directly above it/,
    );
    rejects(
      { ...barrel, ...b, "src/types/tv/a.d.ts": "/** One. */\n/** Two. */\nexport type A = 1;\n" },
      /tv\/a\.d\.ts:1: .*"A", although/,
    );
    // A trailing JSDoc would document the next module's first declaration.
    rejects(
      { ...barrel, ...b, "src/types/tv/a.d.ts": "export type A = 1;\n\n/** Dangling. */\n" },
      /tv\/a\.d\.ts:3: .*the next declaration in the flattened file/,
    );
    // Barrel comments are copied above the modules' declarations.
    rejects(
      { ...b, "src/types/tv/a.d.ts": "export type A = 1;\n", [barrelPath]: "/** Header. */\n\nexport * from \"./tv/a\";\nexport * from \"./tv/b\";\n" },
      /charting_library\.d\.ts:1: .*the next declaration in the flattened file/,
    );
    // Member docs are not top-level comments and stay untouched.
    const output = flatten({
      ...barrel,
      ...b,
      "src/types/tv/a.d.ts": "// Module a.\n\n// ── Section ──\n/** A docs. */\nexport interface A {\n  /** Value docs. */\n  value: number;\n}\n",
    });
    assert.match(output, /\/\*\* A docs\. \*\/\nexport interface A \{\n {2}\/\*\* Value docs\. \*\/\n/);
  });

  const valid = {
    "src/types/tv/a.d.ts": "export interface A { value: number; }\n",
  };
  test("the barrel only accepts value-carrying export-star re-exports of tv modules", () => {
    rejects({ ...valid, [barrelPath]: "export * from \"./tv/a\";\nexport interface Extra {}\n" }, /may only contain `export \* from/);
    rejects({ ...valid, [barrelPath]: "export type * from \"./tv/a\";\n" }, /may only contain/);
    rejects({ ...valid, [barrelPath]: "export { A } from \"./tv/a\";\n" }, /may only contain/);
    rejects({ ...valid, [barrelPath]: "export * from \"./other/a\";\n" }, /may only contain/);
    rejects({ ...valid, [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/missing\";\n" }, /missing\.d\.ts does not exist/);
    rejects({ ...valid, [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/a.js\";\n" }, /re-exported twice/);
    rejects({ ...valid, [barrelPath]: "// nothing\n" }, /re-exports no src\/types\/tv modules/);
  });

  test("a tv module the barrel forgets is reported instead of silently unpublished", () => {
    rejects({
      ...valid,
      "src/types/tv/forgotten.d.ts": "export type Forgotten = string;\n",
      [barrelPath]: "export * from \"./tv/a\";\n",
    }, /tv\/forgotten\.d\.ts is not re-exported/);
  });

  test("modules must export every declaration and may not re-export", () => {
    const barrel = { [barrelPath]: "export * from \"./tv/a\";\n" };
    rejects({ ...barrel, "src/types/tv/a.d.ts": "interface Hidden {}\nexport type A = Hidden;\n" }, /named `export`/);
    rejects({ ...barrel, "src/types/tv/a.d.ts": "declare global { interface Window { raze: 1 } }\n" }, /named `export`/);
    rejects({ ...barrel, "src/types/tv/a.d.ts": "export default interface A {}\n" }, /named `export`/);
    rejects({
      [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/b\";\n",
      "src/types/tv/a.d.ts": "export * from \"./b\";\n",
      "src/types/tv/b.d.ts": "export type B = 1;\n",
    }, /re-exports belong in the barrel/);
  });

  test("sibling imports must be type-only, unrenamed and published", () => {
    const barrel = { [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/b\";\n" };
    const b = { "src/types/tv/b.d.ts": "export interface B {}\n" };
    rejects({ ...barrel, ...b, "src/types/tv/a.d.ts": "import { B } from \"./b\";\nexport type A = B;\n" }, /import type \{ A, B \}/);
    rejects({ ...barrel, ...b, "src/types/tv/a.d.ts": "import type B from \"./b\";\nexport type A = B;\n" }, /import type \{ A, B \}/);
    rejects({ ...barrel, ...b, "src/types/tv/a.d.ts": "import type * as b from \"./b\";\nexport type A = b.B;\n" }, /import type \{ A, B \}/);
    rejects({ ...barrel, ...b, "src/types/tv/a.d.ts": "import type { X } from \"react\";\nexport type A = X;\n" }, /import type \{ A, B \}/);
    rejects({ ...barrel, ...b, "src/types/tv/a.d.ts": "import type { B as Renamed } from \"./b\";\nexport type A = Renamed;\n" }, /rename "B as Renamed"/);
    rejects({
      [barrelPath]: "export * from \"./tv/a\";\n",
      "src/types/tv/a.d.ts": "import type { B } from \"../b\";\nexport type A = B;\n",
      "src/types/b.d.ts": "export interface B {}\n",
    }, /import type \{ A, B \}/);
  });

  test("two modules declaring one name would merge when flattened, so it is rejected", () => {
    rejects({
      [barrelPath]: "export * from \"./tv/a\";\nexport * from \"./tv/b\";\n",
      "src/types/tv/a.d.ts": "export interface Shared { a: 1 }\n",
      "src/types/tv/b.d.ts": "export interface Shared { b: 2 }\n",
    }, /"Shared" is also declared in src\/types\/tv\/a\.d\.ts/);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log("\nCOMPAT TYPES: PASS");
