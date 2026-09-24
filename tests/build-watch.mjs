import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleArtifacts } from "../scripts/entries.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceProbe = resolve(root, "src/types/WatchContractProbe.ts");
const emittedProbe = resolve(root, "dist/types/types/WatchContractProbe.d.ts");
const compatibilitySource = resolve(root, "src/types/charting_library.d.ts");
const compatibilityOutput = resolve(root, "dist/charting_library.d.ts");
const publicReactTypes = resolve(root, "dist/types/react/index.d.ts");
const compatibilityOriginal = readFileSync(compatibilitySource, "utf8");
let output = "";
const child = spawn(process.execPath, ["build.mjs", "--watch"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

const waitFor = async (predicate, label, timeout = 30_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (child.exitCode != null) throw new Error(`watch process exited while waiting for ${label}\n${output}`);
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}\n${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
};

try {
  rmSync(sourceProbe, { force: true });
  await waitFor(() => output.includes("[raze-charts] watching"), "watch startup");
  // Watch mode builds every public entry from scripts/entries.mjs up front.
  for (const artifact of bundleArtifacts()) {
    assert.ok(existsSync(resolve(root, "dist", artifact)), `watch startup did not emit dist/${artifact}`);
  }
  // Corrupt only generated output, then use the temporary type-only source as
  // the watch trigger. Tests must never rewrite tracked source files: doing so
  // is both unsafe on interruption and flaky on Windows where editors/indexers
  // can briefly hold a source handle open.
  const declarationToken = "raze-watch-declaration-probe";
  writeFileSync(compatibilityOutput, `${compatibilityOriginal}\n// ${declarationToken}\n`);
  writeFileSync(sourceProbe, "export interface WatchContractProbe { readonly synchronized: true; }\n");
  await waitFor(
    () => existsSync(emittedProbe) && readFileSync(emittedProbe, "utf8").includes("synchronized"),
    "type-only declaration emission",
  );
  await waitFor(
    () => !readFileSync(compatibilityOutput, "utf8").includes(declarationToken),
    "hand-authored declaration refresh",
  );
  assert.equal(
    readFileSync(compatibilityOutput, "utf8"),
    compatibilityOriginal,
    "watch restores the compatibility declaration from its tracked source",
  );

  rmSync(sourceProbe, { force: true });
  await waitFor(() => !existsSync(emittedProbe), "removed declaration cleanup");
  console.log("[raze-charts] build watch synchronizes type-only sources");
} finally {
  rmSync(sourceProbe, { force: true });
  if (child.exitCode == null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill();
    await exited;
  }
  assert.ok(
    existsSync(publicReactTypes),
    "interrupting a watch rebuild preserves the last complete public declaration tree",
  );
}
