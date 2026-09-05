// 验证本地修复不触发额外模型请求，避免增加等待与 token 消耗。
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const source = require("./helpers/extension-source").backgroundSource();
const start = source.indexOf("function parseJsonWithDiagnostics(text");
const end = source.indexOf("function normalizeAnalysis(data)", start);
assert.ok(start >= 0 && end > start, "JSON repair helpers must exist");

const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.parseJson = (text) => parseJsonWithDiagnostics(text).value;`, sandbox);

const malformed = `分析结果如下：\n\`\`\`json\n{
  score: 72,
  decision: 'recommend',
  excluded: False,
  reasons: ['方向匹配', '简历有证据',],
  risks: ['经验深度待确认',],
}\n\`\`\``;

for (let index = 0; index < 50; index += 1) sandbox.parseJson(malformed);
const iterations = 2000;
const startedAt = performance.now();
for (let index = 0; index < iterations; index += 1) {
  const parsed = sandbox.parseJson(malformed);
  assert.equal(parsed.score, 72);
}
const durationMs = performance.now() - startedAt;
assert.ok(durationMs < iterations,
  `local JSON repair must remain sub-millisecond on average; ${iterations} parses took ${durationMs.toFixed(1)}ms`);

console.log(`AI local JSON repair performance passed: ${iterations} parses in ${durationMs.toFixed(1)}ms`);
