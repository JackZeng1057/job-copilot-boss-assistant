const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("function parseJson(text)");
const end = source.indexOf("function normalizeAnalysis(data)", start);
assert.ok(start >= 0 && end > start, "JSON parser helpers must exist");

const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.parseJson = parseJson;`, sandbox);

const repaired = sandbox.parseJson(`{
  "score": 73,
  "greeting": "第一行
第二行\t继续",
  "reasons": ["匹配"]
}`);
assert.equal(repaired.score, 73);
assert.equal(repaired.greeting, "第一行\n第二行\t继续");

assert.match(source, /catch \(firstError\)[\s\S]*buildJsonRepairPrompt\(raw, firstError\)[\s\S]*parseJson\(repairedRaw\)/,
  "an unrecoverable model response must receive one JSON-only repair request");

console.log("AI JSON repair tests passed");
