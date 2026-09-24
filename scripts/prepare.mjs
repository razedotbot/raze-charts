// Runs on `npm install`. Skip the build only when every artifact emitted by the
// build is present and non-empty. A single marker is not enough: interrupted
// builds can otherwise leave a package whose root import works while a
// subpath, source map, or declaration is missing.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGE_ENTRIES, bundleArtifacts, entryArtifacts } from "./entries.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");
const distRoot = resolve(root, "dist");

// Every bundle and entry declaration comes from the public entry table, so a
// new subpath is covered here without editing this script.
const generatedBundles = bundleArtifacts();

const requiredArtifacts = [
  ...generatedBundles,
  ...generatedBundles.map((artifact) => `${artifact}.map`),
  "charting_library.d.ts",
  "datafeed-api.d.ts",
  ...PACKAGE_ENTRIES.map((entry) => join(...entryArtifacts(entry).types.split("/"))),
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
