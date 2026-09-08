// Runs on `npm install`. Skip the build when `dist/` is already present
// (registry installs, local rebuilds). Git clones have no dist, so we build.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = resolve(root, "dist", "charting_library.esm.js");
if (existsSync(marker)) process.exit(0);

const result = spawnSync(process.execPath, [resolve(root, "build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
