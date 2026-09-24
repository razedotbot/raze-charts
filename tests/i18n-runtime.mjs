// Translation runtime: inline defaults, packs, locale fallback chain, lazy
// loaders, placeholders, plurals, hooks, isolation and loud misuse.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "raze-i18n-"));
try {
  const result = await build({
    entryPoints: [resolve(root, "src/i18n/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(dir, "i18n.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const i18n = await import(pathToFileURL(file).href);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // Inline defaults and placeholders.
    assert.equal(i18n.t("test.ok", "OK"), "OK", "t() returns the inline default without any pack");
    assert.equal(i18n.t("test.greet", "Hello {name}", { name: "Ada" }), "Hello Ada");
    assert.equal(i18n.formatMessage("{a} {missing}", { a: 1 }), "1 {missing}", "unknown placeholders stay visible");
    assert.equal(i18n.getLocale(), "en");
    assert.equal(i18n.direction(), "ltr");

    // Packs and the fallback chain pt-BR -> pt -> inline default.
    i18n.registerMessages("pt", { "test.ok": "Certo", "test.greet": "Olá {name}" });
    i18n.registerMessages("pt_br", { "test.ok": "Beleza" });
    await i18n.setLocale("PT_br");
    assert.equal(i18n.getLocale(), "pt-BR", "locales are canonicalised");
    assert.equal(i18n.t("test.ok", "OK"), "Beleza");
    assert.equal(i18n.t("test.greet", "Hello {name}", { name: "Ada" }), "Olá Ada", "base-language pack fills gaps");
    assert.equal(i18n.t("test.untranslated", "Fallback"), "Fallback");
    assert.equal(i18n.hasMessage("test.ok"), true);
    assert.equal(i18n.hasMessage("test.untranslated"), false);

    // Lazy loaders run once, before listeners fire; ESM default exports work.
    let loads = 0;
    const seen = [];
    const off = i18n.onLocaleChange((locale) => seen.push([locale, i18n.t("test.ok", "OK")]));
    i18n.registerLocaleLoader("de", async () => {
      loads++;
      return { default: { "test.ok": "Gut", "test.items.one": "{count} Eintrag", "test.items.other": "{count} Einträge" } };
    });
    await Promise.all([i18n.setLocale("de"), i18n.setLocale("de-AT")]);
    assert.equal(i18n.getLocale(), "de-AT", "the most recent of two overlapping calls wins");
    await i18n.setLocale("de");
    assert.equal(loads, 1, "a lazy pack loads once");
    assert.deepEqual(seen, [["de-AT", "Gut"], ["de", "Gut"]], "listeners observe the loaded messages, once per applied locale");
    off();

    // Regression: overlapping calls apply in call order, not in the order
    // their loaders settle. A slow earlier pack must not overwrite a newer
    // choice, and listeners hear only the winning locale.
    {
      const runtime = i18n.createI18n("en");
      const heard = [];
      runtime.onLocaleChange((locale) => heard.push([locale, runtime.t("race.a", "EN")]));
      let releaseDe;
      runtime.registerLocaleLoader("de", () => new Promise((resolveDe) => {
        releaseDe = () => resolveDe({ "race.a": "DE" });
      }));
      runtime.registerLocaleLoader("fr", () => Promise.resolve({ "race.a": "FR" }));
      const slow = runtime.setLocale("de");
      const fast = runtime.setLocale("fr");
      await fast;
      assert.equal(runtime.getLocale(), "fr");
      releaseDe();
      await slow;
      assert.equal(runtime.getLocale(), "fr", "a superseded setLocale() does not win when its pack loads later");
      assert.equal(runtime.t("race.a", "EN"), "FR");
      assert.deepEqual(heard, [["fr", "FR"]], "exactly one listener call, for the winning locale");
      // The superseded pack is still cached for the next switch.
      await runtime.setLocale("de");
      assert.equal(runtime.t("race.a", "EN"), "DE");

      // Switching back to the current locale supersedes a pending switch.
      runtime.registerLocaleLoader("it", () => new Promise((resolveIt) => setTimeout(() => resolveIt({ "race.a": "IT" }), 20)));
      const pending = runtime.setLocale("it");
      await runtime.setLocale("de");
      await pending;
      assert.equal(runtime.getLocale(), "de", "returning to the current locale cancels the pending switch");
      assert.deepEqual(heard.map(([locale]) => locale), ["fr", "de"]);

      // A superseded call whose pack fails still rejects (the failure is real)
      // without disturbing the winning locale.
      runtime.registerLocaleLoader("nl", () => new Promise((_, rejectNl) => setTimeout(() => rejectNl(new Error("nl offline")), 10)));
      const failing = runtime.setLocale("nl");
      await runtime.setLocale("fr");
      await assert.rejects(failing, /nl offline/);
      assert.equal(runtime.getLocale(), "fr");
    }

    // Plurals use CLDR categories with inline fallbacks.
    const forms = { one: "{count} item", other: "{count} items" };
    assert.equal(i18n.plural("test.items", 1, forms), "1 Eintrag");
    assert.equal(i18n.plural("test.items", 3, forms), "3 Einträge");
    await i18n.setLocale("en");
    assert.equal(i18n.plural("test.items", 1, forms), "1 item");
    assert.equal(i18n.plural("test.items", 2, forms), "2 items");

    // RTL detection.
    await i18n.setLocale("ar-EG");
    assert.equal(i18n.direction(), "rtl");
    assert.equal(i18n.isRtlLocale("he"), true);
    assert.equal(i18n.isRtlLocale("en-US"), false);
    assert(warnings.some((warning) => warning.includes('"ar-EG"')), "a locale without messages warns instead of silently staying English");
    const warningCount = warnings.length;
    await i18n.setLocale("ar-EG");
    await i18n.setLocale("en");
    await i18n.setLocale("ar-EG");
    assert.equal(warnings.length, warningCount, "the missing-locale warning is emitted once");

    // Host hook (TradingView custom_translate_function adapters).
    i18n.setTranslateHook((key, fallback) => (key === "test.ok" ? `[${fallback}]` : null));
    assert.equal(i18n.t("test.ok", "OK"), "[OK]");
    assert.equal(i18n.t("test.greet", "Hello {name}", { name: "Ada" }), "Hello Ada", "null falls through");
    i18n.setTranslateHook(() => {
      throw new Error("boom");
    });
    assert.equal(i18n.t("test.ok", "OK"), "OK", "a throwing hook degrades to the default");
    assert(warnings.some((warning) => warning.includes("translate hook threw")));
    i18n.setTranslateHook(null);

    // Isolated runtimes do not share state with the page-wide one.
    const isolated = i18n.createI18n("fr");
    isolated.registerMessages("fr", { "test.ok": "D'accord" });
    assert.equal(isolated.t("test.ok", "OK"), "D'accord");
    assert.equal(i18n.t("test.ok", "OK"), "OK");
    assert.equal(isolated.getLocale(), "fr");

    // Misuse fails loudly.
    assert.throws(() => i18n.registerMessages("de", { "test.bad": 1 }), /must be a string/);
    assert.throws(() => i18n.registerMessages("de", null), /expects a \{ key: message \} object/);
    assert.throws(() => i18n.registerLocaleLoader("de", "not-a-function"), /expects a function/);
    i18n.registerLocaleLoader("xx", async () => {
      throw new Error("network down");
    });
    await assert.rejects(i18n.setLocale("xx"), /network down/, "a failing lazy pack rejects setLocale()");
  } finally {
    console.warn = originalWarn;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("I18N RUNTIME: PASS");
