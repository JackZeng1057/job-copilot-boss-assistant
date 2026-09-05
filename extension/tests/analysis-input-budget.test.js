// 验证简历与职位描述的输入长度预算。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const start = source.indexOf("function compactAnalysisText");
const end = source.indexOf("function buildAnalysisPrompt", start);
assert.ok(start >= 0 && end > start, "analysis input compactor must exist");

const sandbox = {};
vm.runInNewContext(
  `${source.slice(start, end)}\nthis.compactAnalysisText = compactAnalysisText;`,
  sandbox
);

const short = "正常长度的简历与岗位信息";
assert.equal(sandbox.compactAnalysisText(short, 100), short,
  "normal inputs must remain byte-for-byte unchanged");

const long = `HEAD-${"A".repeat(500)}-${"M".repeat(500)}-${"Z".repeat(500)}-TAIL`;
const compacted = sandbox.compactAnalysisText(long, 500);
assert.ok(compacted.length <= 560, "compacted text must stay close to its character budget");
assert.match(compacted, /^HEAD-/);
assert.match(compacted, /-TAIL$/);
assert.match(compacted, /中间内容已省略/);

assert.match(source, /const MAX_RESUME_INPUT_CHARS = 16000;/);
assert.match(source, /const MAX_JOB_DESCRIPTION_INPUT_CHARS = 7000;/);
assert.match(source, /compactAnalysisText\(resumeText, MAX_RESUME_INPUT_CHARS\)/);
assert.match(source, /compactAnalysisText\(job\.jd, MAX_JOB_DESCRIPTION_INPUT_CHARS\)/);

console.log("Analysis input budget tests passed");
