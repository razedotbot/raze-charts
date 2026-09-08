import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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
  copyInstalledPackage(version === 17 ? "react17-types" : "@types/react", "@types/react", consumerDir);
  copyInstalledPackage("@types/prop-types", "@types/prop-types", consumerDir);
  copyInstalledPackage("@types/scheduler", "@types/scheduler", consumerDir);
  copyInstalledPackage("csstype", "csstype", consumerDir);
}

try {
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
    "benchmarks/bundle-budgets.json",
    "benchmarks/dashboard-baseline.json",
  ]) {
    assert.ok(
      existsSync(join(installedDir, publishedResource)),
      `published documentation resource is missing: ${publishedResource}`,
    );
  }
  for (const entry of [".", "./chart", "./react"]) {
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

  const esmConsumer = join(consumerDir, "consume.mjs");
  writeFileSync(
    esmConsumer,
    `
      import assert from "node:assert/strict";
      import rootDefault, { widget, version } from "@razedotbot/charts";
      import * as chart from "@razedotbot/charts/chart";
      import * as react from "@razedotbot/charts/react";

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

  const cjsConsumer = join(consumerDir, "consume.cjs");
  writeFileSync(
    cjsConsumer,
    `
      const assert = require("node:assert/strict");
      const root = require("@razedotbot/charts");
      const chart = require("@razedotbot/charts/chart");
      const react = require("@razedotbot/charts/react");

      assert.equal(typeof root.widget, "function");
      assert.equal(typeof root.version, "string");
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
    `,
  );
  run(process.execPath, ["--conditions=browser", browserCjsConsumer], consumerDir);

  const nodeNextConsumer = join(consumerDir, "consume-types.mts");
  writeFileSync(
    nodeNextConsumer,
    `
      import {
        createDatafeed,
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
      const diagnostics: ChartDiagnostics | undefined = undefined;
      const scaleSpec: XScaleSpec = { type: "linear", domain: [0, 10] };
      const sceneNode: SceneNode = { type: "rect", x: 0, y: 0, w: 1, h: 1 };
      const pluginScale: ChartMarkPluginScale | undefined = undefined;
      const crosshair: Crosshair = { x: 0, y: 0, active: false };
      const pane: SubPaneGeom | undefined = undefined;
      const plotScale: PlotScale | undefined = undefined;
      void definition;
      void feed;
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
        ResponsiveContainer,
        createChartComponents,
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
      declare const handle: ReactChartHandle;
      const snapshot: ReactChartSnapshot | null = handle.getSnapshot();
      const compatibilityAlias: ReactChartSnapshot | null = handle.getScene();
      void view;
      void snapshot;
      void compatibilityAlias;
    `,
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        jsx: "react-jsx",
        lib: ["ES2020", "DOM", "DOM.Iterable"],
      },
      files: ["consume-types.mts", "consume-react-types.tsx"],
    }),
  );
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "--project", "tsconfig.json", "--pretty", "false"], consumerDir);
  supplyReactTypes(17, consumerDir);
  run(process.execPath, [tsc, "--project", "tsconfig.json", "--pretty", "false"], consumerDir);

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

  console.log("[raze-charts] packed package contract passed (ESM, CJS, shared chart identity, React 17/18 types, browser global)");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
