const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const contentSource = fs
  .readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8")
  .replace(/\r\n/g, "\n");
const classifierSource = contentSource.match(
  /function isTransientAiError\(error\) \{[\s\S]*?\n\}\n\nfunction isExtensionContextError/
);
assert.ok(classifierSource, "retryable AI error classifier must exist");

const classifierSandbox = {};
vm.runInNewContext(
  classifierSource[0].replace(/\n\nfunction isExtensionContextError[\s\S]*$/, "")
    + "\nthis.isTransientAiError = isTransientAiError;",
  classifierSandbox
);

for (const message of [
  "TypeError: Failed to fetch",
  "NetworkError when attempting to fetch resource",
  "net::ERR_INTERNET_DISCONNECTED",
  "AI request failed: status=503",
  "AI 请求超时：超过 90 秒未完成，请稍后重试",
  "Unexpected end of JSON input",
  "unterminated JSON string"
]) {
  assert.equal(
    classifierSandbox.isTransientAiError(message),
    true,
    `${message} must pause and preserve the current job for retry`
  );
}

const diagnosticSource = contentSource.match(
  /function aiErrorDiagnostic\(error\) \{[\s\S]*?\n\}/
);
assert.ok(diagnosticSource, "AI failures must produce a structured local diagnostic");
const diagnosticSandbox = {};
vm.runInNewContext(
  `${diagnosticSource[0]}\nthis.aiErrorDiagnostic = aiErrorDiagnostic;`,
  diagnosticSandbox
);
assert.equal(
  diagnosticSandbox.aiErrorDiagnostic("AI request failed: status=503, body=overloaded").category,
  "upstream_unavailable",
  "provider 503 responses must not be mislabeled as a local proxy failure"
);
assert.equal(
  diagnosticSandbox.aiErrorDiagnostic("Tunnel connection failed: proxy refused").category,
  "proxy",
  "actual proxy tunnel failures must remain distinguishable"
);
assert.equal(
  diagnosticSandbox.aiErrorDiagnostic("Unexpected end of JSON input").category,
  "invalid_response",
  "truncated model output must remain distinguishable from connectivity failures"
);
assert.doesNotMatch(
  diagnosticSandbox.aiErrorDiagnostic("Authorization: Bearer secret-token").message,
  /secret-token/,
  "diagnostic messages must redact credentials before local persistence"
);

for (const message of [
  "AI request failed: status=401",
  "invalid api key",
  "ordinary validation failure"
]) {
  assert.equal(
    classifierSandbox.isTransientAiError(message),
    false,
    `${message} must not be mislabeled as a transient network failure`
  );
}

assert.match(
  contentSource,
  /if \(isTransientAiError\(error\)\)[\s\S]*JC_STATE\.analyses\.delete\(job\.key\)[\s\S]*pipeline\.allPaused = true/,
  "retryable failures must remove the failed analysis, pause, and retain the job"
);
assert.match(
  contentSource,
  /AI 服务返回内容不完整，已暂停并保留当前岗位/,
  "truncated JSON must show a recoverable status"
);
assert.match(
  contentSource,
  /const retryOnlyRun = Boolean\(JC_STATE\.retryJobKey\)[\s\S]*if \(retryOnlyRun\) \{[\s\S]*reason: "retry_completed"[\s\S]*自动投递保持暂停/,
  "retrying one failed job must not silently advance into another batch"
);
assert.match(
  contentSource,
  /ai_analysis_failed[\s\S]*aiErrorDiagnostic\([\s\S]*diagnostic=/,
  "AI failure logs must persist the structured, redacted diagnostic"
);

console.log("AI failure recovery tests passed");
