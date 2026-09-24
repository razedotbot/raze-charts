#!/usr/bin/env node
// Normalized report of the published declaration surface.
//
// The package publishes four declaration entry points: the TradingView-shaped
// standalone files (dist/charting_library.d.ts and its dist/datafeed-api.d.ts
// alias), and the generated trees behind the ".", "./chart" and "./react"
// exports. This test loads each of them with the TypeScript compiler, resolves
// every exported name, and prints its kind, type parameters and resolved
// member types into a line-oriented report. Named package declarations that
// the exports reference without exporting (a private base interface, a helper
// type alias) are described too, under a trailing "# referenced, not exported"
// section, because the exports print them by name only. The report is compared
// with the checked-in snapshot under tests/types-api-report/.
//
// The report is intentionally insensitive to where a declaration lives (module
// paths in `import("…")` qualifiers are dropped) and to member declaration
// order, so moving declarations between files is a no-op while any change to a
// name, optionality, modifier, signature or type is reported.
//
//   node tests/types-api-report.mjs            verify (run after `node build.mjs`)
//   node tests/types-api-report.mjs --update   rewrite the snapshots after an
//                                              intentional public type change

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDirectory = resolve(root, "tests/types-api-report");
const update = process.argv.includes("--update");

/**
 * Each report groups declaration files that must expose the same surface. The
 * first file is the canonical one; the others must produce an identical report.
 */
const REPORTS = [
  {
    id: "charting_library",
    files: [
      "dist/charting_library.d.ts",
      "dist/datafeed-api.d.ts",
      "dist/types/types/charting_library.d.ts",
    ],
  },
  { id: "index", files: ["dist/types/index.d.ts"] },
  { id: "chart", files: ["dist/types/chart/index.d.ts"] },
  { id: "react", files: ["dist/types/react/index.d.ts"] },
];

const display = (path) => relative(root, path).split(sep).join("/");

const missing = REPORTS.flatMap((report) => report.files).filter((file) => !existsSync(resolve(root, file)));
if (missing.length) {
  console.error(
    `[raze-charts] types API report: missing ${missing.join(", ")}.\n` +
      "Run `node build.mjs` (or `npm run build`) before this test.",
  );
  process.exit(1);
}

const rootNames = REPORTS.flatMap((report) => report.files.map((file) => resolve(root, file)));
const program = ts.createProgram({
  rootNames,
  options: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    // Published declarations must type-check on their own, so library checking
    // stays on; only diagnostics inside dist/ are reported below.
    skipLibCheck: false,
    types: [],
  },
});
const checker = program.getTypeChecker();

// ── Published declarations must be self-contained and error-free ────────────
const distRoot = resolve(root, "dist") + sep;
const diagnostics = [
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSourceFiles()
    .filter((file) => resolve(file.fileName).startsWith(distRoot))
    .flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
];
if (diagnostics.length) {
  console.error("[raze-charts] types API report: published declarations do not type-check:");
  console.error(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}

// ── Report rendering ────────────────────────────────────────────────────────
const NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation
  | ts.NodeBuilderFlags.IgnoreErrors
  | ts.NodeBuilderFlags.UseSingleQuotesForStringLiteralType;
const ALIAS_FLAGS = NODE_FLAGS | ts.NodeBuilderFlags.InTypeAlias;
const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true });
const printTarget = ts.createSourceFile("api-report.d.ts", "", ts.ScriptTarget.ES2020, false, ts.ScriptKind.TS);
const printNode = (node) => printer.printNode(ts.EmitHint.Unspecified, node, printTarget);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Union and intersection constituents are ordered by the checker's internal
 * type ids, which depend on the order files happen to be checked in. Sort them
 * by their printed text so the report only reflects the declared surface.
 */
function canonicalize(node) {
  const visited = ts.visitEachChild(node, canonicalize, ts.nullTransformationContext);
  if (ts.isUnionTypeNode(visited) || ts.isIntersectionTypeNode(visited)) {
    const types = [...visited.types].sort((a, b) => compareText(printNode(a), printNode(b)));
    return ts.isUnionTypeNode(visited)
      ? ts.factory.updateUnionTypeNode(visited, ts.factory.createNodeArray(types))
      : ts.factory.updateIntersectionTypeNode(visited, ts.factory.createNodeArray(types));
  }
  return visited;
}

/** Drop `import("…").` qualifiers: a declaration's file is not part of its API. */
const normalize = (text) => text
  .replace(/import\((["'])[^"']*\1\)\./g, "")
  .replace(/\s+/g, " ")
  .replace(/;?\s*$/, "")
  .trim();
const nodeText = (node) => (node ? normalize(printNode(canonicalize(node))) : "unknown");
const typeText = (type, flags = NODE_FLAGS) => nodeText(checker.typeToTypeNode(type, undefined, flags));
const signatureText = (signature, kind = ts.SyntaxKind.CallSignature) =>
  nodeText(checker.signatureToSignatureDeclaration(signature, kind, undefined, NODE_FLAGS));

function typeParametersText(symbol) {
  const declaration = symbol.declarations?.find((node) => ts.getEffectiveTypeParameterDeclarations(node).length);
  if (!declaration) return "";
  const parameters = ts.getEffectiveTypeParameterDeclarations(declaration).map((parameter) => {
    let text = parameter.name.text;
    if (parameter.constraint) text += ` extends ${typeText(checker.getTypeFromTypeNode(parameter.constraint))}`;
    if (parameter.default) text += ` = ${typeText(checker.getTypeFromTypeNode(parameter.default))}`;
    return text;
  });
  return `<${parameters.join(", ")}>`;
}

function modifierFlags(symbol) {
  return (symbol.declarations ?? []).reduce(
    (flags, declaration) => flags | ts.getCombinedModifierFlags(declaration),
    ts.ModifierFlags.None,
  );
}

function isHidden(symbol) {
  if (symbol.name.startsWith("#") || symbol.name.startsWith("__#")) return true;
  return (modifierFlags(symbol) & ts.ModifierFlags.Private) !== 0;
}

function memberLines(type, indent, { skip = new Set() } = {}) {
  const lines = [];
  for (const signature of type.getCallSignatures()) lines.push(`${indent}${signatureText(signature)}`);
  for (const signature of type.getConstructSignatures()) {
    lines.push(`${indent}${signatureText(signature, ts.SyntaxKind.ConstructSignature)}`);
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    lines.push(`${indent}${info.isReadonly ? "readonly " : ""}[key: ${typeText(info.keyType)}]: ${typeText(info.type)}`);
  }
  const properties = checker.getPropertiesOfType(type)
    .filter((property) => !skip.has(property.name) && !isHidden(property))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const property of properties) {
    const flags = modifierFlags(property);
    const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
    const accessor = property.flags & ts.SymbolFlags.Accessor;
    const readonly = flags & ts.ModifierFlags.Readonly
      || (accessor && !(property.flags & ts.SymbolFlags.SetAccessor));
    const prefix = [
      flags & ts.ModifierFlags.Protected ? "protected" : "",
      readonly ? "readonly" : "",
    ].filter(Boolean).join(" ");
    const lead = `${indent}${prefix ? `${prefix} ` : ""}${property.name}${optional}`;
    const propertyType = checker.getTypeOfSymbol(property);
    if (property.flags & ts.SymbolFlags.Method) {
      for (const signature of propertyType.getCallSignatures()) lines.push(`${lead}${signatureText(signature)}`);
    } else {
      lines.push(`${lead}: ${typeText(propertyType)}`);
    }
  }
  return lines;
}

function describe(name, symbol, exportedAsTypeOnly, indent = "") {
  const lines = [];
  const flags = symbol.flags;
  const typeOnly = exportedAsTypeOnly ? " (type-only export)" : "";
  const params = typeParametersText(symbol);

  if (flags & ts.SymbolFlags.Class) {
    const instance = checker.getDeclaredTypeOfSymbol(symbol);
    const heritage = [];
    const bases = checker.getBaseTypes(instance);
    if (bases.length) heritage.push(`extends ${bases.map((base) => typeText(base)).join(", ")}`);
    const implemented = (symbol.declarations ?? [])
      .flatMap((declaration) => declaration.heritageClauses ?? [])
      .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
      .flatMap((clause) => clause.types.map((node) => typeText(checker.getTypeAtLocation(node))));
    if (implemented.length) heritage.push(`implements ${implemented.join(", ")}`);
    const abstract = modifierFlags(symbol) & ts.ModifierFlags.Abstract ? "abstract " : "";
    lines.push(`${indent}${abstract}class ${name}${params}${heritage.length ? ` ${heritage.join(" ")}` : ""}${typeOnly}`);
    const staticType = checker.getTypeOfSymbol(symbol);
    for (const line of memberLines(staticType, `${indent}  static `, { skip: new Set(["prototype"]) })) {
      lines.push(line.replace(`${indent}  static new `, `${indent}  new `));
    }
    lines.push(...memberLines(instance, `${indent}  `));
  } else if (flags & ts.SymbolFlags.Interface) {
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const bases = checker.getBaseTypes(declared);
    const heritage = bases.length ? ` extends ${bases.map((base) => typeText(base)).join(", ")}` : "";
    lines.push(`${indent}interface ${name}${params}${heritage}`);
    lines.push(...memberLines(declared, `${indent}  `));
  }

  if (flags & ts.SymbolFlags.TypeAlias) {
    lines.push(`${indent}type ${name}${params} = ${typeText(checker.getDeclaredTypeOfSymbol(symbol), ALIAS_FLAGS)}`);
  }
  if (flags & ts.SymbolFlags.Enum) {
    const constEnum = flags & ts.SymbolFlags.ConstEnum ? "const " : "";
    lines.push(`${indent}${constEnum}enum ${name}${typeOnly}`);
    for (const member of checker.getExportsOfModule(symbol)) {
      const value = member.valueDeclaration && checker.getConstantValue(member.valueDeclaration);
      lines.push(`${indent}  ${member.name} = ${JSON.stringify(value)}`);
    }
  }
  if (flags & ts.SymbolFlags.Function) {
    for (const signature of checker.getTypeOfSymbol(symbol).getCallSignatures()) {
      lines.push(`${indent}function ${name}${signatureText(signature)}${typeOnly}`);
    }
  }
  if (flags & ts.SymbolFlags.Variable) {
    const declaration = symbol.valueDeclaration;
    const kind = declaration && ts.isVariableDeclaration(declaration)
      ? ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const ? "const" : "let"
      : "var";
    lines.push(`${indent}${kind} ${name}: ${typeText(checker.getTypeOfSymbol(symbol))}${typeOnly}`);
  }
  if (flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) {
    lines.push(`${indent}namespace ${name}${typeOnly}`);
    for (const member of sortedExports(symbol)) {
      lines.push(...describe(member.name, resolveAlias(member), false, `${indent}  `));
    }
  }
  if (!lines.length) lines.push(`${indent}unknown ${name} (symbol flags ${flags})`);
  return lines;
}

const resolveAlias = (symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
const sortedExports = (moduleSymbol) => checker.getExportsOfModule(moduleSymbol)
  .slice()
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * Names whose value meaning is not importable because they are re-exported
 * with `export type` (including `export type * from`). The checker exposes no
 * public query for this, so a probe module imports each value export and
 * collects the "exported using 'export type'" diagnostics.
 */
function typeOnlyExports(file, names) {
  if (!names.length) return new Set();
  const probePath = resolve(root, "tests/types-api-report/__value-probe__.ts");
  const specifier = `./${relative(dirname(probePath), resolve(root, file)).split(sep).join("/")}`
    .replace(/^\.\/\.\.\//, "../")
    .replace(/\.d\.ts$/, ".js");
  // Two lines per name: the import, then a value use that fails for type-only exports.
  const probe = names
    .map((name, index) => `import { ${name} as __probe${index} } from ${JSON.stringify(specifier)};\nvoid __probe${index};`)
    .join("\n");
  const host = ts.createCompilerHost(program.getCompilerOptions());
  const isProbe = (path) => resolve(path) === probePath;
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (path, language, ...rest) =>
    isProbe(path) ? ts.createSourceFile(path, probe, language, true) : getSourceFile(path, language, ...rest);
  host.fileExists = (path) => isProbe(path) || fileExists(path);
  host.readFile = (path) => (isProbe(path) ? probe : readFile(path));
  const probeProgram = ts.createProgram({
    rootNames: [...program.getRootFileNames(), probePath],
    options: program.getCompilerOptions(),
    host,
    oldProgram: program,
  });
  const probeFile = probeProgram.getSourceFile(probePath);
  const typeOnly = new Set();
  for (const diagnostic of probeProgram.getSemanticDiagnostics(probeFile)) {
    const line = diagnostic.start === undefined
      ? -1
      : probeFile.getLineAndCharacterOfPosition(diagnostic.start).line;
    const index = line >= 0 && line % 2 === 1 ? (line - 1) / 2 : -1;
    if ((diagnostic.code === 1361 || diagnostic.code === 1362) && names[index] !== undefined) {
      typeOnly.add(names[index]);
      continue;
    }
    throw new Error(
      `value probe for ${file} failed unexpectedly: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
  return typeOnly;
}

// ── Declarations the exports depend on without exporting them ──────────────
const REFERENCED_SECTION = "# referenced, not exported";
const REFERENCED_KINDS = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class
  | ts.SymbolFlags.Enum | ts.SymbolFlags.Function | ts.SymbolFlags.Variable
  | ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule;
const MODULE_KINDS = ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule;

/** A module- or namespace-level declaration: not a parameter, type parameter or member. */
function isTopLevelDeclaration(declaration) {
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent?.parent : declaration;
  const parent = statement?.parent;
  return Boolean(parent) && (ts.isSourceFile(parent) || ts.isModuleBlock(parent));
}

const isPublishedDeclaration = (symbol) => Boolean(symbol.declarations?.length)
  && symbol.declarations.every((declaration) => isTopLevelDeclaration(declaration)
    && resolve(declaration.getSourceFile().fileName).startsWith(distRoot));

/** The exported symbols, including the members of exported namespaces. */
function exportedClosure(symbols) {
  const closure = new Set();
  const add = (symbol) => {
    if (closure.has(symbol)) return;
    closure.add(symbol);
    if (symbol.flags & MODULE_KINDS) for (const member of checker.getExportsOfModule(symbol)) add(resolveAlias(member));
  };
  symbols.forEach(add);
  return closure;
}

/**
 * Named package declarations that the exported declarations reference, directly
 * or through each other, without exporting them. Their names appear in the
 * report, but a change to their structure would not, so they are described too.
 */
function unexportedReferences(exportedSymbols) {
  const exported = exportedClosure(exportedSymbols);
  const found = new Set();
  const queue = [...exported];
  const consider = (target) => {
    const symbol = target && resolveAlias(target);
    if (!symbol || exported.has(symbol) || found.has(symbol)) return;
    if (!(symbol.flags & REFERENCED_KINDS) || !isPublishedDeclaration(symbol)) return;
    found.add(symbol);
    queue.push(symbol);
  };
  const visit = (node) => {
    const name = ts.isTypeReferenceNode(node) ? node.typeName
      : ts.isExpressionWithTypeArguments(node) ? node.expression
      : ts.isTypeQueryNode(node) ? node.exprName
      : ts.isImportTypeNode(node) ? node.qualifier
      : undefined;
    if (name) consider(checker.getSymbolAtLocation(name));
    ts.forEachChild(node, visit);
  };
  while (queue.length) {
    const symbol = queue.shift();
    if (symbol.flags & MODULE_KINDS) {
      for (const member of checker.getExportsOfModule(symbol)) consider(member);
    }
    // A module re-exported as a namespace is declared by its whole source file;
    // its members are visited individually instead.
    for (const declaration of symbol.declarations ?? []) if (!ts.isSourceFile(declaration)) visit(declaration);
  }
  return [...found].sort((a, b) => compareText(a.name, b.name));
}

function reportFor(file) {
  const sourceFile = program.getSourceFile(resolve(root, file));
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`${file} is not a module; the report cannot resolve its exports.`);
  const exports = sortedExports(moduleSymbol).map((exported) => ({ name: exported.name, symbol: resolveAlias(exported) }));
  const typeOnly = typeOnlyExports(
    file,
    exports.filter(({ symbol }) => symbol.flags & ts.SymbolFlags.Value).map(({ name }) => name),
  );
  const lines = [];
  for (const { name, symbol } of exports) lines.push(...describe(name, symbol, typeOnly.has(name)));
  const referenced = unexportedReferences(exports.map(({ symbol }) => symbol));
  if (referenced.length) {
    lines.push(REFERENCED_SECTION);
    for (const symbol of referenced) lines.push(...describe(symbol.name, symbol, false));
  }
  return `${lines.join("\n")}\n`;
}

// ── Compare with the snapshots ──────────────────────────────────────────────
/** Report lines keyed by their owning top-level declaration, so a diff says where a member changed. */
function keyedLines(text) {
  let owner = "";
  let section = "";
  return text.split("\n").flatMap((line) => {
    if (line === REFERENCED_SECTION) section = "    (referenced, not exported)";
    if (!line || line.startsWith("#")) return [];
    if (!line.startsWith(" ")) {
      owner = `${line}${section}`;
      return [owner];
    }
    return [`${line}    ← in ${owner}`];
  });
}

function lineDiff(expected, actual) {
  const expectedLines = keyedLines(expected);
  const actualLines = keyedLines(actual);
  const expectedSet = new Set(expectedLines);
  const actualSet = new Set(actualLines);
  return [
    ...expectedLines.filter((line) => !actualSet.has(line)).map((line) => `- ${line}`),
    ...actualLines.filter((line) => !expectedSet.has(line)).map((line) => `+ ${line}`),
  ];
}

const failures = [];
mkdirSync(snapshotDirectory, { recursive: true });
for (const report of REPORTS) {
  const [canonical, ...aliases] = report.files;
  const text = reportFor(canonical);
  for (const alias of aliases) {
    const aliasText = reportFor(alias);
    if (aliasText !== text) {
      failures.push(
        `${alias} must expose the same surface as ${canonical}:\n${lineDiff(text, aliasText).join("\n")}`,
      );
    }
  }
  const snapshotPath = resolve(snapshotDirectory, `${report.id}.api.txt`);
  const header = `# Normalized API report for ${report.files.join(", ")}.\n`
    + "# Generated by `node tests/types-api-report.mjs --update`; review every change.\n";
  const content = header + text;
  if (update) {
    writeFileSync(snapshotPath, content);
    console.log(`[raze-charts] wrote ${display(snapshotPath)} (${text.split("\n").length - 1} lines)`);
    continue;
  }
  if (!existsSync(snapshotPath)) {
    failures.push(`missing snapshot ${display(snapshotPath)}; run \`node tests/types-api-report.mjs --update\`.`);
    continue;
  }
  const expected = readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n");
  if (expected !== content) {
    const diff = lineDiff(expected, content);
    failures.push(
      `${canonical} no longer matches ${display(snapshotPath)}:\n`
        + `${(diff.length ? diff : ["(member order or header changed)"]).slice(0, 80).join("\n")}`,
    );
  }
}

if (failures.length) {
  console.error("[raze-charts] types API report failed:");
  for (const failure of failures) console.error(`\n${failure}`);
  console.error(
    "\nIf the public type change is intentional, review it and run `node tests/types-api-report.mjs --update`.",
  );
  process.exit(1);
}

if (!update) {
  console.log(`[raze-charts] types API report matches (${REPORTS.map((report) => report.id).join(", ")})`);
}
