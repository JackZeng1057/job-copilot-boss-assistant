// 验证模型输出的常见 JSON 格式错误可被本地修复。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const start = source.indexOf("function parseJsonWithDiagnostics(text");
const end = source.indexOf("function normalizeAnalysis(data)", start);
assert.ok(start >= 0 && end > start, "JSON parser helpers must exist");

const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.parseJson = (text) => parseJsonWithDiagnostics(text).value;`, sandbox);

const repaired = sandbox.parseJson(`{
  "score": 73,
  "greeting": "第一行
第二行\t继续",
  "reasons": ["匹配"]
}`);
assert.equal(repaired.score, 73);
assert.equal(repaired.greeting, "第一行\n第二行\t继续");

const commonMalformedCases = [
  `分析结果如下：\n\`\`\`json\n{
    "score": 71,
    "decision": "recommend",
    "reasons": ["匹配",],
  }\n\`\`\``,
  `{score: 68, decision: 'manual_review', excluded: False,
    reasons: ['方向匹配', '经验待确认']}`,
  `{"score": 66, "decision": "manual_review", "reasons": ["包含 } 符号", "第二条"]} 后续解释`,
  `{"score": 64, "decision": "manual_review", "reasons": ["输出在这里被截断`
];

for (const malformed of commonMalformedCases) {
  const value = sandbox.parseJson(malformed);
  assert.ok(Number.isFinite(Number(value.score)), `score must survive local repair: ${malformed}`);
  assert.ok(["recommend", "manual_review", "skip"].includes(value.decision));
  assert.ok(Array.isArray(value.reasons));
}

const booleanRepair = sandbox.parseJson(`{score: 62, decision: 'manual_review', excluded: false,
  reasons: [], risks: []}`);
assert.equal(booleanRepair.excluded, false,
  "local syntax repair must preserve JSON booleans instead of converting them to strings");

const reasoningPrefixed = sandbox.parseJson(`推理过程：先按 {JSON} 模板整理，最终结果如下：
{
  "score": 79,
  "decision": "recommend",
  "excluded": false,
  "reasons": ["方向匹配"],
  "risks": []
}`);
assert.equal(reasoningPrefixed.score, 79,
  "the parser must skip brace-shaped reasoning noise before the actual JSON object");

const unmatchedBracePrefixed = sandbox.parseJson(`思考中 {这里的模板没有闭合
{
  "score": 76,
  "decision": "recommend",
  "excluded": false,
  "reasons": ["经验匹配"],
  "risks": []
}`);
assert.equal(unmatchedBracePrefixed.score, 76,
  "an unmatched brace in reasoning text must not swallow a later valid JSON object");

assert.match(source, /catch \(firstError\)[\s\S]*不会发起二次修复请求/,
  "an unrecoverable structured response must fail without another model request");

console.log("AI JSON repair tests passed");
