// "use client" contract for the React entry (W1B-24).
//
// 1. dist/react.esm.js and dist/react.cjs start with the "use client"
//    directive; the framework-neutral /chart runtime does not.
// 2. An esbuild bundle of a Server Component page, resolved with the
//    `react-server` condition (React 19's server build, which has no
//    useState/useEffect/useRef), renders <LineChart> without a user-authored
//    client wrapper. The client-boundary plugin reproduces what an RSC bundler
//    such as the Next.js App Router does with the directive: modules that begin
//    with "use client" become client references instead of server code.
// 3. Control: the same page with the boundary ignored fails on the server,
//    which proves the directive is what makes step 2 work.
//
// Run: node tests/react-server-components.mjs (after a build).

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => resolve(root, "dist", file);
let passed = 0;
const test = async (name, body) => {
  await body();
  passed += 1;
  console.log(`✓ ${name}`);
};

/** The directive prologue of a script: leading string-literal statements. */
function directives(source) {
  const found = [];
  const pattern = /^\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*;?/;
  let rest = source.replace(/^#!.*\n/, "");
  for (;;) {
    rest = rest.replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)/, "");
    const match = rest.match(pattern);
    if (!match) return found;
    found.push(match[1] ?? match[2]);
    rest = rest.slice(match[0].length);
  }
}

await test('dist/react.esm.js starts with the "use client" directive', () => {
  assert.equal(directives(readFileSync(dist("react.esm.js"), "utf8"))[0], "use client");
});
await test('dist/react.cjs starts with the "use client" directive', () => {
  assert.equal(directives(readFileSync(dist("react.cjs"), "utf8"))[0], "use client");
});
await test("the framework-neutral /chart and root bundles stay server-safe (no directive)", () => {
  for (const file of ["chart.esm.js", "chart.cjs", "charting_library.esm.js", "studies.esm.js"]) {
    assert.ok(!directives(readFileSync(dist(file), "utf8")).includes("use client"), file);
  }
});

const clientExports = Object.keys(await import(pathToFileURL(dist("react.esm.js")).href));
const CLIENT_REFERENCE = Symbol.for("react.client.reference");

const serverPage = `
import { LineChart, Line, XAxis, Tooltip } from "@razedotbot/charts/react";

const revenue = [
  { month: "Jan", revenue: 10 },
  { month: "Feb", revenue: 24 },
];

export default function Page() {
  return (
    <main>
      <h1>Revenue</h1>
      <LineChart data={revenue} height={240} ariaLabel="Monthly revenue">
        <XAxis dataKey="month" />
        <Line dataKey="revenue" />
        <Tooltip />
      </LineChart>
    </main>
  );
}
`;

/** Bundle the page as an RSC bundler would: react-server condition, React 19. */
async function bundleServerPage({ honorUseClient }) {
  const result = await build({
    stdin: { contents: serverPage, loader: "tsx", resolveDir: root, sourcefile: "app/page.tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    conditions: ["react-server"],
    logLevel: "silent",
    // The dev dependency "react19" is React 19 under its own name.
    alias: { react: "react19" },
    plugins: [{
      name: "rsc-client-boundary",
      setup(context) {
        context.onResolve({ filter: /^@razedotbot\/charts\/react$/ }, () => ({ path: dist("react.esm.js") }));
        context.onResolve({ filter: /^\.\/chart\.esm\.js$/ }, () => ({ path: dist("chart.esm.js") }));
        context.onLoad({ filter: /\.(?:m?js|cjs)$/ }, (args) => {
          const source = readFileSync(args.path, "utf8");
          if (!honorUseClient || !directives(source).includes("use client")) return undefined;
          // Client reference module: the server only sees opaque references.
          const lines = clientExports.map((name) =>
            `export const ${name} = Object.defineProperties(function () {` +
            ` throw new Error("client reference ${name} was called on the server"); }, {` +
            ` $$typeof: { value: Symbol.for("react.client.reference") },` +
            ` $$id: { value: ${JSON.stringify(`@razedotbot/charts/react#${name}`)} } });`);
          return { contents: lines.join("\n"), loader: "js" };
        });
      },
    }],
  });
  return result.outputFiles[0].text;
}

/**
 * Minimal Server Component renderer: calls server function components and
 * stops at client references, which Flight serializes by id plus props.
 */
function renderServerTree(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(renderServerTree);
  const { type, props } = node;
  if (typeof type === "function") {
    if (type.$$typeof === CLIENT_REFERENCE) {
      return { client: type.$$id, props: { ...props, children: renderServerTree(props.children) } };
    }
    return renderServerTree(type(props));
  }
  return { host: String(type), children: renderServerTree(props?.children) };
}

const sandbox = mkdtempSync(join(tmpdir(), "raze-rsc-"));
try {
  const load = async (name, code) => {
    const file = join(sandbox, `${name}.mjs`);
    writeFileSync(file, code);
    return (await import(pathToFileURL(file).href)).default;
  };

  await test("a Server Component page renders <LineChart> with no user-authored client wrapper", async () => {
    const Page = await load("page", await bundleServerPage({ honorUseClient: true }));
    const tree = renderServerTree(Page({}));
    const chart = tree.children[1];
    assert.equal(tree.host, "main");
    assert.equal(chart.client, "@razedotbot/charts/react#LineChart");
    assert.equal(chart.props.ariaLabel, "Monthly revenue");
    assert.deepEqual(
      chart.props.children.map((child) => child.client),
      [
        "@razedotbot/charts/react#XAxis",
        "@razedotbot/charts/react#Line",
        "@razedotbot/charts/react#Tooltip",
      ],
    );
  });

  await test("control: without the client boundary the same page fails on the server", async () => {
    const Page = await load("page-no-boundary", await bundleServerPage({ honorUseClient: false }));
    const originalError = console.error;
    console.error = () => {}; // React logs "Invalid hook call" before throwing.
    try {
      assert.throws(() => renderServerTree(Page({})), (error) => error instanceof TypeError);
    } finally {
      console.error = originalError;
    }
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`REACT SERVER COMPONENTS: PASS (${passed} checks)`);
