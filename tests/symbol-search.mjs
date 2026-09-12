import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SymbolSearch } from "../dist/charting_library.esm.js";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requests = [];
const picked = [];
const context = {
  fontFamily: "sans-serif",
  symbol: "INIT",
  datafeed: {
    searchSymbols(query, _exchange, _type, callback) {
      requests.push({ query, callback });
    },
  },
};

const search = new SymbolSearch(context, (symbol) => picked.push(symbol));
document.body.appendChild(search.el);
const input = search.el.querySelector("input");
assert(input, "symbol search renders its input");
assert.equal(input.getAttribute("role"), "combobox");
assert.equal(input.getAttribute("aria-autocomplete"), "list");
assert.equal(input.getAttribute("aria-haspopup"), "listbox");
assert.equal(input.getAttribute("aria-expanded"), "false");

const query = async (value) => {
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(140);
  const request = requests.at(-1);
  assert.equal(request?.query, value);
  return request;
};

input.focus();
const unsafeRequest = await query("unsafe");
unsafeRequest.callback([{
  symbol: '<img src=x onerror="globalThis.__razeXss=1">',
  description: "<svg onload=globalThis.__razeXss=2>",
}]);
await wait(5);

let listbox = document.querySelector('[role="listbox"]');
assert(listbox, "results use listbox semantics");
assert.equal(document.activeElement, input, "results do not steal focus from the combobox");
assert.equal(input.getAttribute("aria-expanded"), "true");
assert.equal(input.getAttribute("aria-controls"), listbox.id);
assert.equal(listbox.querySelectorAll('[role="option"]').length, 1);
assert.equal(listbox.querySelector("img, svg, [onerror], [onload]"), null, "feed text cannot create DOM markup");
assert.match(listbox.textContent, /<img src=x onerror=/, "unsafe symbol markup is rendered literally");
assert.match(listbox.textContent, /<svg onload=/, "unsafe description markup is rendered literally");

const firstRace = await query("A");
const latestRace = await query("AB");
latestRace.callback([{ symbol: "AB", description: "Latest" }]);
await wait(5);
firstRace.callback([{ symbol: "A", description: "Stale" }]);
await wait(5);
listbox = document.querySelector('[role="listbox"]');
assert.equal(listbox?.textContent.trim(), "AB  Latest", "a stale response cannot replace newer results");

const keyboardRequest = await query("ET");
keyboardRequest.callback([
  { symbol: "ETC", description: "First" },
  { symbol: "ETH", description: "Second" },
]);
await wait(5);
input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "ArrowDown",
  bubbles: true,
  cancelable: true,
}));
input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "ArrowDown",
  bubbles: true,
  cancelable: true,
}));
const activeId = input.getAttribute("aria-activedescendant");
assert(activeId, "arrow navigation exposes the active option");
assert.equal(document.getElementById(activeId)?.textContent, "ETH  Second");
assert.equal(document.getElementById(activeId)?.getAttribute("aria-selected"), "true");
assert.equal(document.activeElement, input, "arrow navigation keeps DOM focus in the combobox");
input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter",
  bubbles: true,
  cancelable: true,
}));
assert.deepEqual(picked, ["ETH"]);
assert.equal(input.value, "ETH");
assert.equal(document.querySelector('[role="listbox"]'), null);
assert.equal(input.getAttribute("aria-expanded"), "false");

const escapedRequest = await query("ESC");
input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Escape",
  bubbles: true,
  cancelable: true,
}));
escapedRequest.callback([{ symbol: "ESC-LATE", description: "Must stay closed" }]);
await wait(5);
assert.equal(document.querySelector('[role="listbox"]'), null, "Escape invalidates an in-flight request");

const lateRequest = await query("LATE");
search.destroy();
lateRequest.callback([{ symbol: "LATE", description: "After teardown" }]);
await wait(5);
assert.equal(document.querySelector('[role="listbox"]'), null, "a callback after destroy cannot resurrect the popup");
assert.equal(document.querySelector(".raze-chart-symbol-search"), null);

const timerRequestsBefore = requests.length;
const timerSearch = new SymbolSearch(context, () => {});
document.body.appendChild(timerSearch.el);
const timerInput = timerSearch.el.querySelector("input");
timerInput.value = "TIMER";
timerInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
timerSearch.destroy();
await wait(140);
assert.equal(requests.length, timerRequestsBefore, "destroy cancels the debounce timer");

console.log("SYMBOL SEARCH: PASS");
