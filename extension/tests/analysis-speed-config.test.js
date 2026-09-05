// 验证分析速度设置在表单、后台和协议请求间保持一致。
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(new URL("../popup.html", `file://${__dirname}/`), "utf8");
const popup = fs.readFileSync(new URL("../popup.js", `file://${__dirname}/`), "utf8");
const background = require("./helpers/extension-source").backgroundSource();

assert.match(html, /id=["']analysisSpeed["'][\s\S]*value=["']fast["'][\s\S]*value=["']balanced["'][\s\S]*value=["']accurate["']/,
  "the popup must expose one provider-neutral analysis speed control");
assert.match(popup, /analysisSpeed:\s*document\.getElementById\(["']analysisSpeed["']\)/);
assert.match(popup, /analysisSpeed:\s*["']fast["']/,
  "existing users must retain the current low-latency behavior");
assert.match(popup, /analysisSpeed:\s*normalizeAnalysisSpeed\(fields\.analysisSpeed\.value\)/);
assert.match(background, /analysisSpeed:\s*["']fast["']/);
assert.match(background, /function normalizeAnalysisSpeed/);
assert.match(background, /openAiCompatibleReasoning/);
assert.match(background, /openAiResponsesReasoning/);
assert.match(background, /anthropicReasoningConfig/);
assert.match(background, /geminiReasoningConfig/);

console.log("Analysis speed configuration tests passed");
