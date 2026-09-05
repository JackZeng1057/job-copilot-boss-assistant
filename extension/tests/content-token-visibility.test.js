// 验证 token 信息仅在有对应统计数据时展示。
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").contentSource();
const start = source.indexOf("function updateJobRow(item, job)");
const end = source.indexOf("function dismissJob(key", start);
assert.ok(start >= 0 && end > start, "job-row renderer must exist");
const renderer = source.slice(start, end);

assert.doesNotMatch(renderer, /jc-token-usage|可见输出|思考.*token|formatTokenUsage/,
  "token usage may remain in diagnostics but must not be rendered in the plugin job list");

console.log("Content token visibility tests passed");
