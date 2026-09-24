// W1A-04 follow-up: the DOM-sink lint also catches React's
// dangerouslySetInnerHTML, document.write reached without a direct call, and
// parenthesised innerHTML assignment targets, without new false positives.
// Run: node tests/dom-sinks-evasions.mjs

import assert from "node:assert/strict";
import { scanSource } from "../scripts/check-dom-sinks.mjs";

let passed = 0;
const sinksIn = (source) => scanSource(source, "src/example.tsx").findings.map((finding) => finding.sink);

const caught = {
  "dangerouslySetInnerHTML (JSX)": "const node = <div dangerouslySetInnerHTML={{ __html: name }} />;",
  "dangerouslySetInnerHTML (props object)": "createElement('div', { dangerouslySetInnerHTML: { __html: name } });",
  "document.write alias": "const write = document.write;",
  "document.write bound alias": "const w = document.write.bind(document);",
  "document.writeln alias": "const w = document.writeln;",
  "document.write optional call": "document?.write(name);",
  "document.write bracket": 'document["write"](name);',
  "document.write optional bracket": "document?.['write'](name);",
  "ownerDocument.write": "el.ownerDocument.write(name);",
  "contentDocument.write": "frame.contentDocument?.write(name);",
  "doc handle": "const doc = document; doc.write(name);",
  "destructured write": "const { write } = document;",
  "destructured writeln from window.document": "const { writeln: out } = window.document;",
  "parenthesised innerHTML target": "(el.innerHTML) = name;",
  "doubly parenthesised innerHTML target": "((el).innerHTML) = name;",
  "parenthesised outerHTML append": "(el.outerHTML) += name;",
};
for (const [label, source] of Object.entries(caught)) {
  const sinks = sinksIn(source);
  assert.ok(sinks.length > 0, `${label} is reported: ${source}`);
  passed += 1;
  console.log(`✓ reports ${label}`);
}

const clean = {
  "innerHTML comparison": "if ((el.innerHTML) === name) return;",
  "innerHTML read in a call": "log(el.innerHTML);",
  "writeFile on a handle": "doc.writeFile(path, text);",
  "clipboard write": "navigator.clipboard.write(items);",
  "stream writer": "writer.write(chunk);",
  "document.writeable-like identifiers": "const documentWriter = createWriter(document);",
  "sink names in strings": 'label("dangerouslySetInnerHTML and document.write are forbidden");',
  "sink names in comments": "// const { write } = document; (el.innerHTML) = x\nrun();",
};
for (const [label, source] of Object.entries(clean)) {
  assert.deepEqual(sinksIn(source), [], `${label} is not reported: ${source}`);
  passed += 1;
  console.log(`✓ ignores ${label}`);
}

console.log(`DOM SINK EVASIONS: PASS (${passed} cases)`);
