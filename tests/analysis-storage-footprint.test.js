// 验证持久化分析只保留必要字段，并限制历史记录数量。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const start = source.indexOf("function sanitizeStoredAnalyses");
const end = source.indexOf("async function appendAutomationLog", start);
assert.ok(start >= 0 && end > start, "stored analysis compactor must exist");
const limit = source.match(/const MAX_STORED_ANALYSES = \d+;/)?.[0];
const clamp = source.match(/function clampScore\(score\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(limit && clamp, "storage compactor dependencies must exist");

const sandbox = {};
vm.runInNewContext(
  `${limit}\n${clamp}\n${source.slice(start, end)}\nthis.sanitizeStoredAnalyses = sanitizeStoredAnalyses;`,
  sandbox
);

const analyses = {};
for (let index = 0; index < 75; index += 1) {
  analyses[`job:${index}`] = {
    score: 60 + (index % 20),
    decision: "recommend",
    excluded: false,
    exclusion_match: "",
    occupation_family: "前端开发",
    target_alignment: "direct",
    location_fit: "acceptable",
    reasons: ["很长的匹配理由".repeat(100)],
    risks: ["很长的风险说明".repeat(100)],
    greeting: "很长的话术".repeat(100),
    raw: "provider raw JSON must never be stored"
  };
}

const stored = sandbox.sanitizeStoredAnalyses(analyses);
assert.equal(Object.keys(stored).length, 50,
  "session recovery must keep a bounded number of analyses");
const one = stored[Object.keys(stored)[0]];
assert.deepEqual(Object.keys(one).sort(), [
  "decision", "excluded", "exclusion_match", "occupation_family", "score"
]);
assert.equal(JSON.stringify(stored).includes("provider raw JSON"), false);
assert.equal(JSON.stringify(stored).includes("很长的匹配理由"), false);

console.log("Analysis session storage footprint tests passed");
