// 验证结构校验拒绝无关对象，同时容忍可安全补默认值的缺失字段。
const assert = require("node:assert/strict");
const vm = require("node:vm");

// Behavioural test: load background.js into a sandbox with a stubbed chrome
// namespace and call the real functions, instead of regex-matching source text.
const source = require("./helpers/extension-source").backgroundSource();
const sandbox = {
  chrome: {
    runtime: { onMessage: { addListener() {} }, lastError: null },
    storage: { local: {}, session: {} }
  },
  console
};
vm.runInNewContext(
  `${source}\nthis.__api = { validateAnalysisShape, normalizeAnalysis, parseJsonWithDiagnostics, ANALYSIS_JSON_SCHEMA };`,
  sandbox
);
const { validateAnalysisShape, normalizeAnalysis, parseJsonWithDiagnostics, ANALYSIS_JSON_SCHEMA } = sandbox.__api;

// A job that hits no exclusion rule: the model has no reason to emit
// exclusion_match/exclusion_reason, and normalizeAnalysis defaults both.
// Rejecting this reply used to fail the whole job with "不是合法 JSON".
const noExclusionReply = {
  score: 68,
  decision: "recommend",
  excluded: false,
  occupation_family: "AI应用开发",
  target_alignment: "transferable",
  reasons: ["有 Agent 相关项目经验", "岗位要求与简历技能重叠"],
  risks: [],
  location_fit: "good",
  greeting: "您好，我做过智能体搭建相关项目，想了解这个岗位。"
};
assert.doesNotThrow(() => validateAnalysisShape(noExclusionReply),
  "a reply that omits exclusion_match/exclusion_reason must still be accepted");

const normalized = normalizeAnalysis(noExclusionReply);
assert.equal(normalized.score, 68);
assert.equal(normalized.exclusion_match, "", "missing exclusion_match must default to an empty string");
assert.equal(normalized.exclusion_reason, "");

// The same tolerance must hold end-to-end through the repair pipeline, since
// the validator runs against every candidate object pulled out of the reply.
const throughParser = parseJsonWithDiagnostics(
  `分析结果：\n\`\`\`json\n${JSON.stringify(noExclusionReply)}\n\`\`\``,
  validateAnalysisShape
);
assert.equal(throughParser.value.score, 68);
assert.ok(throughParser.repaired, "a fenced reply is a repaired parse, not a strict one");

// Only score+excluded are load-bearing, and they still have to discriminate a
// real analysis from an object scraped out of the model's prose.
assert.throws(() => validateAnalysisShape({ note: "先分析一下这个岗位" }),
  /缺少有效 score/, "a prose fragment must not pass as an analysis");
assert.throws(() => validateAnalysisShape({ score: 70 }),
  /缺少布尔值 excluded/, "excluded stays required — it gates a user-configured hard filter");

// Present-but-wrong enum values are still a real defect and must be rejected.
assert.throws(() => validateAnalysisShape({ score: 70, excluded: false, decision: "apply" }),
  /decision 无效/);
assert.throws(() => validateAnalysisShape({ score: 70, excluded: false, location_fit: "great" }),
  /location_fit 无效/);
assert.throws(() => validateAnalysisShape({ score: 70, excluded: false, reasons: [1, 2] }),
  /reasons 必须是字符串数组/);

// Array bounds moved out of the schema (structured outputs reject maxItems),
// so normalizeAnalysis is now the only thing enforcing them.
const overlong = normalizeAnalysis({
  score: 55,
  excluded: false,
  reasons: ["a", "b", "c", "d", "e"],
  risks: ["x", "y", "z"]
});
assert.equal(overlong.reasons.length, 3, "reasons must be capped locally");
assert.equal(overlong.risks.length, 2, "risks must be capped locally");

// An excluded job is forced into the skip band regardless of what the model said.
const excluded = normalizeAnalysis({ score: 88, excluded: true, decision: "recommend" });
assert.equal(excluded.decision, "skip");
assert.ok(excluded.score <= 19, "an excluded job must be pushed below the pass band");

// The schema itself must stay free of keywords structured outputs reject.
const schemaText = JSON.stringify(ANALYSIS_JSON_SCHEMA);
for (const keyword of ["minimum", "maximum", "maxItems", "minItems", "multipleOf", "minLength", "maxLength"]) {
  assert.ok(!schemaText.includes(`"${keyword}"`),
    `${keyword} is not supported by Anthropic/OpenAI structured outputs and 400s under strict mode`);
}

console.log("Analysis shape tolerance tests passed");
