const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const contentSource = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");

const start = backgroundSource.indexOf("function emptyTokenUsage");
const end = backgroundSource.indexOf("async function callAi", start);
assert.ok(start >= 0 && end > start, "shared token usage normalizers must exist");

const sandbox = {};
vm.runInNewContext(
  `${backgroundSource.slice(start, end)}\n` +
  `this.aggregateTokenUsage = aggregateTokenUsage;`,
  sandbox
);

const aggregate = sandbox.aggregateTokenUsage([
  {
    inputTokens: 1000,
    outputTokens: 500,
    visibleOutputTokens: 350,
    reasoningTokens: 150,
    cachedInputTokens: 100,
    totalTokens: 1500,
    reported: true
  },
  {
    inputTokens: 200,
    outputTokens: 80,
    visibleOutputTokens: 80,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 280,
    reported: true
  }
]);

assert.deepEqual({ ...aggregate }, {
  inputTokens: 1200,
  outputTokens: 580,
  visibleOutputTokens: 430,
  reasoningTokens: 150,
  cachedInputTokens: 100,
  totalTokens: 1780,
  reported: true
});

assert.match(contentSource,
  /function applyAnalysisPerformance\(analysis, performance[\s\S]*analysis\.tokenUsage\s*=\s*performance\.usage/,
  "each main or parallel job analysis must retain normalized token counters for the current session");
assert.doesNotMatch(contentSource, /jc-token-usage|可见输出.*token|思考.*token/,
  "token counters may remain in diagnostics but must not be rendered in the plugin panel");
assert.doesNotMatch(contentSource, /rawJson|rawResponse|providerResponse/,
  "token observability must not retain raw provider responses in page state");

console.log("AI token usage observability tests passed");
