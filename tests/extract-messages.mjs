// Message extraction: literal t()/plural() calls become a catalog; dynamic
// keys and conflicting defaults fail; locale packs get coverage reports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPack, extractCatalog, extractFromSource } from "../scripts/extract-messages.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = resolve(root, "scripts/extract-messages.mjs");

// The library catalog extracts cleanly and contains the kit strings.
const library = extractCatalog();
assert.deepEqual(library.errors, [], "library source has only literal, consistent messages");
assert.equal(library.catalog["kit.dialog.ok"], "OK");
assert.equal(library.catalog["kit.dialog.reset"], "Reset to defaults");
assert.equal(library.catalog["kit.sheet.close"], "Close");
assert.equal(library.catalog["kit.number.increase"], "Increase {label}");

// Parsing: quotes, escapes, multi-line calls, plurals, comments.
const sample = [
  'const a = t("a.one", "One");',
  "const b = t('a.two', 'It\\'s two');",
  "const c = t(`a.three`, `Three`, { n: 1 });",
  "const d = t(",
  '  "a.multi",',
  '  "Multi line",',
  ");",
  'const e = plural("a.items", list.filter((x) => x).length, { one: "{count} item", other: "{count} items" });',
  '// t("a.commented", "Ignored")',
  'const f = obj.t("not.ours", "Method call");',
  "function t(key: string, fallback: string) { return fallback; }",
].join("\n");
const parsed = extractFromSource(sample, "src/sample.ts");
assert.deepEqual(parsed.errors, []);
assert.deepEqual(
  Object.fromEntries(parsed.messages.map((message) => [message.key, message.message])),
  {
    "a.one": "One",
    "a.two": "It's two",
    "a.three": "Three",
    "a.multi": "Multi line",
    "a.items.one": "{count} item",
    "a.items.other": "{count} items",
  },
);

// Errors: dynamic keys/defaults, missing default, plural without other.
const invalid = extractFromSource([
  "t(key, 'Dynamic key');",
  "t(`a.${kind}`, 'Template key');",
  "t('a.dynamic-default', label);",
  "t('a.no-default');",
  "plural('a.p', n, { one: 'x' });",
].join("\n"), "src/bad.ts");
assert.equal(invalid.errors.length, 5, invalid.errors.join("\n"));
assert.match(invalid.errors[0], /src\/bad\.ts:1: t\(\) key must be a string literal/);
assert.match(invalid.errors[2], /default must be a string literal/);
assert.match(invalid.errors[3], /needs an inline English default/);
assert.match(invalid.errors[4], /"other"/);

// Conflicting defaults across files fail the CLI; packs are checked.
const dir = mkdtempSync(join(tmpdir(), "raze-messages-"));
try {
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "a.ts"), 'export const a = t("x.save", "Save");\nexport const b = t("x.hello", "Hello {name}");\n');
  writeFileSync(join(src, "b.ts"), 'export const c = t("x.save", "Save");\n');
  const out = join(dir, "catalog.json");
  execFileSync(process.execPath, [script, "--src", src, "--out", out], { cwd: root, stdio: "pipe" });
  const printed = JSON.parse(execFileSync(process.execPath, [script, "--src", src], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(printed, { "x.hello": "Hello {name}", "x.save": "Save" });

  const good = join(dir, "de.json");
  writeFileSync(good, JSON.stringify({ "x.save": "Speichern" }));
  const report = execFileSync(process.execPath, [script, "--src", src, "--check", good], { cwd: root, encoding: "utf8" });
  assert.match(report, /1\/2 messages translated/);
  assert.throws(
    () => execFileSync(process.execPath, [script, "--src", src, "--check", good, "--strict"], { cwd: root, stdio: "pipe" }),
    "--strict fails on missing messages",
  );

  const bad = join(dir, "it.json");
  writeFileSync(bad, JSON.stringify({ "x.hello": "Ciao {nome}", "x.gone": "Rimosso" }));
  assert.deepEqual(checkPack(printed, JSON.parse('{"x.hello":"Ciao {nome}","x.gone":"Rimosso"}')), {
    missing: ["x.save"],
    unknown: ["x.gone"],
    mismatched: ["x.hello"],
  });
  let failed = false;
  try {
    execFileSync(process.execPath, [script, "--src", src, "--check", bad], { cwd: root, stdio: "pipe" });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr), /unknown key: x\.gone/);
    assert.match(String(error.stderr), /placeholder mismatch: x\.hello/);
  }
  assert(failed, "unknown keys and placeholder mismatches fail the check");

  writeFileSync(join(src, "c.ts"), 'export const d = t("x.save", "Store");\n');
  failed = false;
  try {
    execFileSync(process.execPath, [script, "--src", src], { cwd: root, stdio: "pipe" });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr), /"x\.save" has default "Store" but .*a\.ts:1 uses "Save"/);
  }
  assert(failed, "one key with two defaults fails extraction");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("EXTRACT MESSAGES: PASS");
