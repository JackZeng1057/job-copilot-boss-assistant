const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");
const start = source.indexOf("function updateJobRow(item, job)");
const end = source.indexOf("function dismissJob(key", start);
assert.ok(start >= 0 && end > start, "job-row renderer must exist");
const renderer = source.slice(start, end);

assert.doesNotMatch(renderer, /jc-token-usage|可见输出|思考.*token|formatTokenUsage/,
  "token usage may remain in diagnostics but must not be rendered in the plugin job list");

console.log("Content token visibility tests passed");
