#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "benchmarks/bundle-budgets.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const json = process.argv.includes("--json");

if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/check-bundle-size.mjs [--json]

Build the package first. Measures the public ESM artifacts with gzip level 9
and exits non-zero when an entry exceeds benchmarks/bundle-budgets.json.`);
  process.exit(0);
}

const failures = [];
const results = [];

for (const entry of config.entries) {
  const artifact = resolve(root, entry.path);
  if (!existsSync(artifact)) {
    failures.push(`${entry.path} is missing; run "npm run build" first`);
    continue;
  }
  const source = readFileSync(artifact);
  const gzipBytes = gzipSync(source, { level: 9 }).byteLength;
  const result = {
    name: entry.name,
    path: entry.path,
    rawBytes: source.byteLength,
    gzipBytes,
    budgetGzipBytes: entry.budgetGzipBytes,
    remainingBytes: entry.budgetGzipBytes - gzipBytes,
  };
  results.push(result);
  if (gzipBytes > entry.budgetGzipBytes) {
    failures.push(
      `${entry.name} is ${gzipBytes} gzip bytes, above its ${entry.budgetGzipBytes}-byte budget`,
    );
  }
  if (entry.requiresExternal) {
    const text = source.toString("utf8");
    const escaped = entry.requiresExternal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const externalImport = new RegExp(`from\\s*["']${escaped}(?:\\/[^"']*)?["']`).test(text);
    if (!externalImport) {
      failures.push(`${entry.name} no longer imports external peer "${entry.requiresExternal}"`);
    }
  }
}

if (json) {
  console.log(JSON.stringify({ compression: config.compression, results, failures }, null, 2));
} else {
  console.log(`[raze-charts] public ESM bundle sizes (${config.compression})`);
  console.log("entry                     raw        gzip       budget     remaining");
  for (const result of results) {
    const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
    console.log(
      `${result.name.padEnd(26)}` +
      `${kib(result.rawBytes).padStart(10)}  ` +
      `${kib(result.gzipBytes).padStart(10)}  ` +
      `${kib(result.budgetGzipBytes).padStart(10)}  ` +
      `${kib(result.remainingBytes).padStart(10)}`,
    );
  }
}

if (failures.length) {
  if (!json) {
    for (const failure of failures) console.error(`[raze-charts] ${failure}`);
  }
  process.exit(1);
}

if (!json) console.log("\n[raze-charts] bundle budgets passed");
