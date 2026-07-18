const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("async function advanceToNextBatch()");
const end = source.indexOf("function prepareCurrentBatch", start);
const block = source.slice(start, end > start ? end : start + 5000);

assert.ok(start >= 0, "batch transition function must exist");
assert.match(
  block,
  /if \(!JC_STATE\.pipeline\.active \|\| JC_STATE\.pipeline\.allPaused\)[\s\S]*setStatus\("连续投递已暂停，批次进度已保留。"\)/,
  "pausing during the batch countdown must settle on a completed pause status"
);

console.log("Batch pause status regression test passed");
