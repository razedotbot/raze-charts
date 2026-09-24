import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_ENTRIES,
  bundleArtifacts,
  entryArtifacts,
  entrySpecifier,
} from "../scripts/entries.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "raze-package-contract-"));

const npmExecPath = process.env.npm_execpath;
const npmIsJavaScript = npmExecPath?.endsWith(".js");
const npmNeedsCmd = !npmExecPath && process.platform === "win32";
const npmCommand = npmIsJavaScript
  ? process.execPath
  : npmNeedsCmd
    ? (process.env.ComSpec ?? "cmd.exe")
    : (npmExecPath ?? "npm");
const npmPrefix = npmIsJavaScript
  ? [npmExecPath]
  : npmNeedsCmd
    ? ["/d", "/s", "/c", "npm.cmd"]
    : [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`);
  }
  return result.stdout;
}

function copyInstalledPackage(sourceName, targetName, consumerDir) {
  const source = join(root, "node_modules", ...sourceName.split("/"));
  const target = join(consumerDir, "node_modules", ...targetName.split("/"));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function supplyReactTypes(version, consumerDir) {
  const source = version === 17
    ? "react17-types"
    : version === 19
      ? "react19-types"
      : "@types/react";
  copyInstalledPackage(source, "@types/react", consumerDir);
  copyInstalledPackage("@types/prop-types", "@types/prop-types", consumerDir);
  copyInstalledPackage("@types/scheduler", "@types/scheduler", consumerDir);
  copyInstalledPackage("csstype", "csstype", consumerDir);
}

try {
  const prepareProject = join(sandbox, "prepare-project");
  const prepareDist = join(prepareProject, "dist");
  const prepareSentinel = join(prepareProject, "build-ran");
  mkdirSync(join(prepareProject, "scripts"), { recursive: true });
  mkdirSync(join(prepareProject, "src"), { recursive: true });
  mkdirSync(join(prepareDist, "types"), { recursive: true });
  cpSync(join(root, "scripts", "prepare.mjs"), join(prepareProject, "scripts", "prepare.mjs"));
  cpSync(join(root, "scripts", "entries.mjs"), join(prepareProject, "scripts", "entries.mjs"));
  writeFileSync(join(prepareProject, "src", "index.ts"), "export const fixture = true;\n");
  writeFileSync(
    join(prepareProject, "build.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./build-ran", import.meta.url), "yes");\n`,
  );
  const prepareBundles = bundleArtifacts();
  for (const artifact of [
    ...prepareBundles,
    ...prepareBundles.map((entry) => `${entry}.map`),
    "charting_library.d.ts",
    "datafeed-api.d.ts",
    ...PACKAGE_ENTRIES.map((entry) => entryArtifacts(entry).types),
  ]) {
    mkdirSync(dirname(join(prepareDist, artifact)), { recursive: true });
    writeFileSync(join(prepareDist, artifact), "fixture\n");
  }
  run(process.execPath, [join(prepareProject, "scripts", "prepare.mjs")], prepareProject);
  assert.equal(existsSync(prepareSentinel), false, "prepare should skip a complete dist tree");
  // Every entry's declaration is required, not a fixed list of subpaths.
  const newestDeclaration = join(prepareDist, entryArtifacts(PACKAGE_ENTRIES.at(-1)).types);
  rmSync(newestDeclaration);
  run(process.execPath, [join(prepareProject, "scripts", "prepare.mjs")], prepareProject);
  assert.equal(
    existsSync(prepareSentinel),
    true,
    `prepare should rebuild when ${PACKAGE_ENTRIES.at(-1).subpath} declarations are missing`,
  );
  rmSync(prepareSentinel);
  writeFileSync(newestDeclaration, "fixture\n");
  writeFileSync(join(prepareDist, "react.cjs"), "");
  run(process.execPath, [join(prepareProject, "scripts", "prepare.mjs")], prepareProject);
  assert.equal(existsSync(prepareSentinel), true, "prepare should rebuild a partial dist tree");

  const packDir = join(sandbox, "packed");
  const consumerDir = join(sandbox, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumerDir);

  const packOutput = run(
    npmCommand,
    [...npmPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    root,
  );
  const packs = JSON.parse(packOutput);
  assert.equal(packs.length, 1, "npm pack should produce exactly one tarball");
  const tarball = join(packDir, packs[0].filename);
  assert.ok(existsSync(tarball), "npm pack did not create the reported tarball");

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "raze-package-contract", private: true, type: "module" }),
  );
  run(
    npmCommand,
    [
      ...npmPrefix,
      "install",
      "--ignore-scripts",
      "--omit=peer",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    consumerDir,
  );

  // The React adapter has an optional peer. Supply the project's pinned dev
  // copy explicitly while keeping the consumer otherwise isolated from this
  // repository's node_modules, so undeclared runtime dependencies are caught.
  cpSync(
    join(root, "node_modules", "react"),
    join(consumerDir, "node_modules", "react"),
    { recursive: true },
  );
  supplyReactTypes(18, consumerDir);

  const installedDir = join(consumerDir, "node_modules", "@razedotbot", "charts");
  const installedPackage = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"));
  const publishedReactTypes = readFileSync(join(installedDir, "dist", "types", "react", "index.d.ts"), "utf8");
  assert.doesNotMatch(
    publishedReactTypes,
    /(?:React\.)?JSX\.Element/,
    "React declarations must remain compatible with React 17 type namespaces",
  );
  assert.match(publishedReactTypes, /ReactElement/, "React declarations should expose the version-neutral ReactElement type");
  for (const publishedResource of [
    "CONTRIBUTING.md",
    "docs/accessibility.md",
    "docs/architecture.md",
    "docs/capabilities.md",
    "docs/migration.md",
    "docs/performance.md",
    "benchmarks/dashboard-baseline.json",
    ...PACKAGE_ENTRIES.map((entry) => `benchmarks/budgets/${entry.id}.json`),
  ]) {
    assert.ok(
      existsSync(join(installedDir, publishedResource)),
      `published documentation resource is missing: ${publishedResource}`,
    );
  }
  assert.deepEqual(
    Object.keys(installedPackage.exports).filter((key) => key !== "./package.json"),
    PACKAGE_ENTRIES.map((entry) => entry.subpath),
    "packed exports must list exactly the entries in scripts/entries.mjs",
  );
  for (const entry of PACKAGE_ENTRIES.map((candidate) => candidate.subpath)) {
    const conditions = installedPackage.exports[entry];
    for (const condition of ["types", "import", "require", "default"]) {
      assert.ok(conditions[condition], `${entry} is missing its ${condition} condition`);
    }
    assert.equal(conditions.import.browser, conditions.import.default, `${entry} browser import must use its ESM target`);
    assert.equal(conditions.require.browser, conditions.require.default, `${entry} browser require must remain CommonJS-safe`);
    assert.match(conditions.require.default, /\.cjs$/, `${entry} require target must use a .cjs extension`);
    const targets = [
      conditions.types,
      conditions.import.browser,
      conditions.import.default,
      conditions.require.browser,
      conditions.require.default,
      conditions.default,
    ];
    for (const target of targets) {
      assert.ok(
        existsSync(resolve(installedDir, target)),
        `${entry} export target does not exist in the packed package: ${target}`,
      );
    }
  }

  // Module directives must survive packing as the first statement of every
  // installed JavaScript target: "use client" on /react is what lets React
  // Server Component bundlers (the Next.js App Router) see the client boundary.
  assert.equal(
    PACKAGE_ENTRIES.find((entry) => entry.subpath === "./react")?.directive,
    "use client",
    "the React entry must declare the \"use client\" directive",
  );
  for (const entry of PACKAGE_ENTRIES) {
    const conditions = installedPackage.exports[entry.subpath];
    for (const target of new Set([conditions.import.default, conditions.require.default])) {
      const head = readFileSync(resolve(installedDir, target), "utf8").trimStart();
      if (entry.directive) {
        assert.ok(
          head.startsWith(`${JSON.stringify(entry.directive)};`),
          `packed ${target} must start with "${entry.directive}";`,
        );
      } else {
        assert.doesNotMatch(head, /^["']use client["']/, `packed ${target} must stay server-safe (no "use client")`);
      }
    }
  }

  const esmConsumer = join(consumerDir, "consume.mjs");
  writeFileSync(
    esmConsumer,
    `
      import assert from "node:assert/strict";
      import rootDefault, { widget, version } from "@razedotbot/charts";
      import * as chart from "@razedotbot/charts/chart";
      import * as react from "@razedotbot/charts/react";
      import { BUILTIN_STUDIES, StudyRegistry, ema } from "@razedotbot/charts/studies";

      // Every public entry resolves to its own ESM artifact and exports real code.
      const entries = ${JSON.stringify(PACKAGE_ENTRIES.map((entry) => ({
        specifier: entrySpecifier(entry, "@razedotbot/charts"),
        artifact: entryArtifacts(entry).esm,
        smoke: entry.smoke,
      })))};
      for (const entry of entries) {
        const namespace = await import(entry.specifier);
        assert.equal(typeof namespace[entry.smoke], "function", entry.specifier + " must export " + entry.smoke);
        assert.ok(
          import.meta.resolve(entry.specifier).endsWith("/dist/" + entry.artifact),
          entry.specifier + " must resolve to dist/" + entry.artifact,
        );
      }
      assert.deepEqual(ema([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
      assert.equal(new StudyRegistry().resolve("rsi")?.name, "RSI");
      assert.ok(BUILTIN_STUDIES.length > 0);

      assert.equal(typeof widget, "function");
      assert.equal(typeof version, "string");
      assert.equal(rootDefault.widget, widget);
      assert.equal(typeof chart.defineChart, "function");
      assert.equal(typeof chart.mountChart, "function");
      assert.equal(typeof react.Chart, "function");
      assert.equal(typeof react.LineChart, "function");
      assert.equal(react.compileChart, chart.compileChart);
      let compileError;
      try {
        react.compileChart(react.defineChart({ marks: [] }), { width: 0, height: 100 });
      } catch (error) {
        compileError = error;
      }
      assert.ok(compileError instanceof chart.ChartCompileError);
      assert.match(import.meta.resolve("@razedotbot/charts"), /charting_library\\.esm\\.js$/);
      assert.match(import.meta.resolve("@razedotbot/charts/chart"), /chart\\.esm\\.js$/);
      assert.match(import.meta.resolve("@razedotbot/charts/react"), /react\\.esm\\.js$/);
    `,
  );
  run(process.execPath, [esmConsumer], consumerDir);
  run(process.execPath, ["--conditions=browser", esmConsumer], consumerDir);

  const cjsConsumer = join(consumerDir, "consume.cjs");
  writeFileSync(
    cjsConsumer,
    `
      const assert = require("node:assert/strict");
      const root = require("@razedotbot/charts");
      const chart = require("@razedotbot/charts/chart");
      const react = require("@razedotbot/charts/react");
      const metadata = require("@razedotbot/charts/package.json");
      const studies = require("@razedotbot/charts/studies");

      // Every public entry resolves to its own CommonJS artifact and exports real code.
      const entries = ${JSON.stringify(PACKAGE_ENTRIES.map((entry) => ({
        specifier: entrySpecifier(entry, "@razedotbot/charts"),
        artifact: entryArtifacts(entry).cjs,
        smoke: entry.smoke,
      })))};
      for (const entry of entries) {
        assert.equal(typeof require(entry.specifier)[entry.smoke], "function", entry.specifier + " must export " + entry.smoke);
        assert.ok(
          require.resolve(entry.specifier).replaceAll("\\\\", "/").endsWith("/dist/" + entry.artifact),
          entry.specifier + " must resolve to dist/" + entry.artifact,
        );
      }
      assert.deepEqual(studies.sma([2, 4, 6], 2), [null, 3, 5]);

      assert.equal(typeof root.widget, "function");
      assert.equal(typeof root.version, "string");
      assert.equal(metadata.version, root.version);
      assert.equal(typeof chart.defineChart, "function");
      assert.equal(typeof chart.mountChart, "function");
      assert.equal(typeof react.Chart, "function");
      assert.equal(typeof react.LineChart, "function");
      assert.equal(react.compileChart, chart.compileChart);
      let compileError;
      try {
        react.compileChart(react.defineChart({ marks: [] }), { width: 0, height: 100 });
      } catch (error) {
        compileError = error;
      }
      assert.ok(compileError instanceof chart.ChartCompileError);
      assert.match(require.resolve("@razedotbot/charts"), /charting_library\\.cjs$/);
      assert.match(require.resolve("@razedotbot/charts/chart"), /chart\\.cjs$/);
      assert.match(require.resolve("@razedotbot/charts/react"), /react\\.cjs$/);
    `,
  );
  run(process.execPath, [cjsConsumer], consumerDir);

  const browserCjsConsumer = join(consumerDir, "consume-browser-condition.cjs");
  writeFileSync(
    browserCjsConsumer,
    `
      const assert = require("node:assert/strict");
      assert.match(require.resolve("@razedotbot/charts"), /charting_library\\.cjs$/);
      assert.match(require.resolve("@razedotbot/charts/chart"), /chart\\.cjs$/);
      assert.match(require.resolve("@razedotbot/charts/react"), /react\\.cjs$/);
      assert.match(require.resolve("@razedotbot/charts/studies"), /studies\\.cjs$/);
    `,
  );
  run(process.execPath, ["--conditions=browser", browserCjsConsumer], consumerDir);

  // Bundle a real browser consumer from the packed install. The metafile makes
  // export-condition selection observable without executing DOM code in Node.
  const browserEntry = join(consumerDir, "consume-browser.ts");
  const browserBundle = join(consumerDir, "consume-browser.js");
  const browserMetafile = join(consumerDir, "consume-browser-meta.json");
  writeFileSync(
    browserEntry,
    `
      import rootDefault, { version } from "@razedotbot/charts";
      import { defineChart } from "@razedotbot/charts/chart";
      import { Chart } from "@razedotbot/charts/react";
      import { rsi } from "@razedotbot/charts/studies";
      export { rootDefault, version, defineChart, Chart, rsi };
    `,
  );
  const esbuild = join(root, "node_modules", "esbuild", "bin", "esbuild");
  // The installed esbuild entry is a JavaScript launcher on Windows, but a
  // native executable on Unix. Invoke each form with its matching runtime.
  const esbuildCommand = process.platform === "win32" ? process.execPath : esbuild;
  const esbuildArgs = process.platform === "win32" ? [esbuild] : [];
  run(
    esbuildCommand,
    [
      ...esbuildArgs,
      browserEntry,
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--external:react",
      "--external:react/jsx-runtime",
      `--outfile=${browserBundle}`,
      `--metafile=${browserMetafile}`,
    ],
    consumerDir,
  );
  assert.ok(existsSync(browserBundle), "browser consumer bundle was not emitted");
  const browserInputs = Object.keys(JSON.parse(readFileSync(browserMetafile, "utf8")).inputs)
    .map((path) => path.replaceAll("\\", "/"));
  for (const target of PACKAGE_ENTRIES.map((entry) => entryArtifacts(entry).esm)) {
    assert.ok(
      browserInputs.some((path) => path.endsWith(`/dist/${target}`)),
      `browser bundling did not select ${target}`,
    );
  }
  assert.ok(
    browserInputs.every((path) => !path.endsWith(".cjs")),
    "browser bundling must not select a CommonJS package target",
  );

  // `/react` also re-exports the framework-neutral grammar. Importing only
  // that grammar must remain a small, React-free consumer bundle.
  const reactGrammarEntry = join(consumerDir, "consume-react-grammar.ts");
  const reactGrammarBundle = join(consumerDir, "consume-react-grammar.js");
  const reactGrammarMetafile = join(consumerDir, "consume-react-grammar-meta.json");
  writeFileSync(
    reactGrammarEntry,
    `
      import { defineChart } from "@razedotbot/charts/react";
      export const definition = defineChart({ marks: [] });
    `,
  );
  run(
    esbuildCommand,
    [
      ...esbuildArgs,
      reactGrammarEntry,
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--minify",
      "--external:react",
      "--external:react/jsx-runtime",
      `--outfile=${reactGrammarBundle}`,
      `--metafile=${reactGrammarMetafile}`,
    ],
    consumerDir,
  );
  const reactGrammarSource = readFileSync(reactGrammarBundle);
  const reactGrammarGzipBytes = gzipSync(reactGrammarSource).byteLength;
  const reactGrammarMeta = JSON.parse(readFileSync(reactGrammarMetafile, "utf8"));
  const reactGrammarOutput = Object.values(reactGrammarMeta.outputs)
    .find((output) => Object.hasOwn(output, "entryPoint"));
  assert.ok(reactGrammarOutput, "react grammar bundle metadata has no entry output");
  const largestGrammarInputs = Object.entries(reactGrammarOutput.inputs)
    .sort(([, left], [, right]) => right.bytesInOutput - left.bytesInOutput)
    .slice(0, 5)
    .map(([path, detail]) => `${path.replaceAll("\\", "/")}: ${detail.bytesInOutput}`)
    .join(", ");
  assert.ok(
    reactGrammarGzipBytes <= 8 * 1024,
    `defineChart from /react costs ${reactGrammarGzipBytes} gzip bytes (budget: 8192); largest inputs: ${largestGrammarInputs}`,
  );
  const adapterContribution = Object.entries(reactGrammarOutput.inputs)
    .find(([path]) => path.replaceAll("\\", "/").endsWith("/dist/react.esm.js"))?.[1].bytesInOutput;
  assert.ok(adapterContribution != null, "react grammar bundle did not resolve the /react entry");
  assert.ok(
    adapterContribution <= 512,
    `grammar-only import retained ${adapterContribution} bytes of the React adapter (budget: 512)`,
  );

  const nodeNextConsumer = join(consumerDir, "consume-types.mts");
  writeFileSync(
    nodeNextConsumer,
    `
      import rootDefault, {
        createDatafeed,
        widget,
        type Crosshair,
        type PlotScale,
        type RazeDataSource,
        type ResolutionString,
        type SubPaneGeom,
      } from "@razedotbot/charts";
      import {
        defineChart,
        line,
        type ChartDiagnostics,
        type ChartMarkPluginScale,
        type SceneNode,
        type XScaleSpec,
      } from "@razedotbot/charts/chart";
      import {
        StudyRegistry,
        macd,
        type Bar,
        type StudyDefinition,
      } from "@razedotbot/charts/studies";

      const studyBars: Bar[] = [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
      const spread: StudyDefinition = {
        name: "Spread",
        pane: "pane",
        compute: (bars) => bars.map((bar) => bar.high - bar.low),
      };
      const studyRegistry = new StudyRegistry([spread]);
      const macdHistogram: (number | null)[] = macd([1, 2, 3], 12, 26, 9).hist;
      // @ts-expect-error a study definition requires a compute function
      const invalidStudy: StudyDefinition = { name: "Broken", pane: "overlay" };
      void studyBars;
      void studyRegistry;
      void macdHistogram;
      void invalidStudy;

      type Row = { x: number; y: number };
      const rows: Row[] = [{ x: 0, y: 1 }];
      const definition = defineChart({ marks: [line(rows, { x: "x", y: "y" })] });
      const source: RazeDataSource = {
        resolveSymbol: async (symbol) => ({
          name: symbol, session: "24x7", timezone: "Etc/UTC", exchange: "Test", minmov: 1, pricescale: 100,
        }),
        getBars: async () => [],
      };
      const feed = createDatafeed(source, { supportedResolutions: ["1" as ResolutionString] });
      const widgetConstructor: typeof widget = rootDefault.widget;
      const diagnostics: ChartDiagnostics | undefined = undefined;
      const scaleSpec: XScaleSpec = { type: "linear", domain: [0, 10] };
      const sceneNode: SceneNode = { type: "rect", x: 0, y: 0, w: 1, h: 1 };
      const pluginScale: ChartMarkPluginScale | undefined = undefined;
      const crosshair: Crosshair = { x: 0, y: 0, active: false };
      const pane: SubPaneGeom | undefined = undefined;
      const plotScale: PlotScale | undefined = undefined;
      void definition;
      void feed;
      void widgetConstructor;
      void diagnostics;
      void scaleSpec;
      void sceneNode;
      void pluginScale;
      void crosshair;
      void pane;
      void plotScale;
    `,
  );
  const reactTypesConsumer = join(consumerDir, "consume-react-types.tsx");
  writeFileSync(
    reactTypesConsumer,
    `
      import type { ReactElement } from "react";
      import {
        Chart,
        ResponsiveContainer,
        createChartComponents,
        defineChart,
        type ReactChartHandle,
        type ReactChartSnapshot,
      } from "@razedotbot/charts/react";

      type Row = { month: string; revenue: number };
      const rows: readonly Row[] = [{ month: "Jan", revenue: 10 }];
      const Charts = createChartComponents<Row>({ xKey: "month", valueKey: "revenue" });
      const view: ReactElement = (
        <ResponsiveContainer width="100%" height={240}>
          <Charts.LineChart data={rows}>
            <Charts.XAxis dataKey="month" />
            <Charts.Line dataKey="revenue" lastValue />
            <Charts.Tooltip />
          </Charts.LineChart>
        </ResponsiveContainer>
      );
      const directView: ReactElement = <Chart definition={defineChart({ marks: [] })} />;
      declare const handle: ReactChartHandle;
      const snapshot: ReactChartSnapshot | null = handle.getSnapshot();
      const compatibilityAlias: ReactChartSnapshot | null = handle.getScene();
      void view;
      void directView;
      void snapshot;
      void compatibilityAlias;
    `,
  );
  const browserTypesConsumer = join(consumerDir, "consume-browser-types.tsx");
  writeFileSync(
    browserTypesConsumer,
    `
      import rootDefault, { version } from "@razedotbot/charts";
      import { defineChart, mountChart } from "@razedotbot/charts/chart";
      import { Chart } from "@razedotbot/charts/react";

      const definition = defineChart({ marks: [] });
      const host: HTMLElement = document.createElement("div");
      const mounted = mountChart(host, definition, { width: 320, height: 180 });
      const view = <Chart definition={definition} width={320} height={180} />;
      const widgetConstructor = rootDefault.widget;
      window.document.title = version;
      void mounted;
      void view;
      void widgetConstructor;
    `,
  );

  const commonCompilerOptions = {
    target: "ES2020",
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    jsx: "react-jsx",
    lib: ["ES2020", "DOM", "DOM.Iterable"],
  };
  const typeProjects = [
    {
      name: "tsconfig.nodenext.json",
      compilerOptions: {
        ...commonCompilerOptions,
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      files: ["consume-types.mts", "consume-react-types.tsx"],
    },
    {
      name: "tsconfig.bundler.json",
      compilerOptions: {
        ...commonCompilerOptions,
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      files: ["consume-types.mts", "consume-react-types.tsx"],
    },
    {
      name: "tsconfig.browser.json",
      compilerOptions: {
        ...commonCompilerOptions,
        module: "ESNext",
        moduleResolution: "Bundler",
        customConditions: ["browser"],
        types: ["react"],
      },
      files: ["consume-browser-types.tsx"],
    },
  ];
  for (const project of typeProjects) {
    writeFileSync(
      join(consumerDir, project.name),
      JSON.stringify({ compilerOptions: project.compilerOptions, files: project.files }),
    );
  }
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const project of typeProjects) {
    run(process.execPath, [tsc, "--project", project.name, "--pretty", "false"], consumerDir);
  }
  supplyReactTypes(17, consumerDir);
  for (const project of typeProjects) {
    run(process.execPath, [tsc, "--project", project.name, "--pretty", "false"], consumerDir);
  }
  copyInstalledPackage("react19", "react", consumerDir);
  supplyReactTypes(19, consumerDir);
  run(process.execPath, [esmConsumer], consumerDir);
  run(process.execPath, [cjsConsumer], consumerDir);
  for (const project of typeProjects) {
    run(process.execPath, [tsc, "--project", project.name, "--pretty", "false"], consumerDir);
  }

  const standalonePath = join(installedDir, installedPackage.unpkg);
  assert.equal(
    installedPackage.unpkg,
    installedPackage.jsdelivr,
    "unpkg and jsDelivr should serve the same standalone build",
  );
  assert.ok(existsSync(standalonePath), "standalone browser bundle is missing from the tarball");
  const browserContext = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(standalonePath, "utf8"), browserContext, {
    filename: "charting_library.standalone.js",
  });
  assert.equal(typeof browserContext.RazeCharts.widget, "function");
  assert.equal(browserContext.window.TradingView.widget, browserContext.RazeCharts.widget);
  assert.equal(browserContext.window.TradingView.version, browserContext.RazeCharts.version);

  console.log("[raze-charts] packed package contract passed (ESM, CJS, browser bundle/global, NodeNext/Bundler types, React 17/18/19)");
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
