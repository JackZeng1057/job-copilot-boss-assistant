const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const contentSource = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
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
  "Unexpected end of JSON input",
  "unterminated JSON string"
]) {
  assert.equal(
    classifierSandbox.isTransientAiError(message),
    true,
    `${message} must pause and preserve the current job for retry`
  );
}

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

console.log("AI failure recovery tests passed");
