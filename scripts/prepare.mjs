// Runs on `npm install`. Skip the build only when every artifact emitted by the
// build is present and non-empty. A single marker is not enough: interrupted
// builds can otherwise leave a package whose root import works while a
// subpath, source map, or declaration is missing.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");
const distRoot = resolve(root, "dist");

const generatedBundles = [
  "charting_library.esm.js",
  "charting_library.cjs",
  "charting_library.standalone.js",
  "chart.esm.js",
  "chart.cjs",
  "react.esm.js",
  "react.cjs",
];

const requiredArtifacts = [
  ...generatedBundles,
  ...generatedBundles.map((artifact) => `${artifact}.map`),
  "charting_library.d.ts",
  "datafeed-api.d.ts",
  join("types", "index.d.ts"),
  join("types", "chart", "index.d.ts"),
  join("types", "react", "index.d.ts"),
];

function collectDeclarationArtifacts(directory) {
  const artifacts = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...collectDeclarationArtifacts(path));
    } else if (entry.isFile() && /(?:\.d)?\.tsx?$/.test(entry.name)) {
      const sourceRelative = relative(sourceRoot, path);
      const declarationRelative = sourceRelative.replace(/(?:\.d)?\.tsx?$/, ".d.ts");
      artifacts.push(join("types", declarationRelative));
    }
  }
  return artifacts;
}

// Packed installs intentionally omit src/. Keep the script safe if a package
// manager invokes `prepare` there; local/git installs still verify every
// declaration corresponding to a source module.
if (existsSync(sourceRoot)) {
  requiredArtifacts.push(...collectDeclarationArtifacts(sourceRoot));
}

const distIsComplete = requiredArtifacts.every((artifact) => {
  const path = resolve(distRoot, artifact);
  if (!existsSync(path)) return false;
  const stats = statSync(path);
  return stats.isFile() && stats.size > 0;
});

if (distIsComplete) process.exit(0);

const result = spawnSync(process.execPath, [resolve(root, "build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
