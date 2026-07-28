const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  new URL("../background.js", `file://${__dirname}/`),
  "utf8"
);
const contentSource = fs.readFileSync(
  new URL("../content.js", `file://${__dirname}/`),
  "utf8"
);

const timeoutConstantSource = backgroundSource.match(/const AI_REQUEST_TIMEOUT_MS = \d+;/);
const timeoutHelperSource = backgroundSource.match(
  /async function fetchAiResponse[\s\S]*?\n\}/
);
assert.ok(timeoutConstantSource && timeoutHelperSource, "AI requests must have a shared timeout helper");

const timeoutSandbox = {
  AbortController,
  clearTimeout,
  setTimeout,
  fetch(_url, options) {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }
};
vm.runInNewContext(
  `${timeoutConstantSource[0]}\n${timeoutHelperSource[0]}\nthis.fetchAiResponse = fetchAiResponse;`,
  timeoutSandbox
);

(async () => {
  await assert.rejects(
    timeoutSandbox.fetchAiResponse("https://api.example.test", {}, 5),
    /AI 请求超时：超过 1 秒未完成/,
    "a stalled AI request must fail with a recoverable timeout"
  );

  for (const event of [
    "ai_analysis_started",
    "ai_analysis_completed",
    "ai_analysis_failed",
    "automation_paused_manual",
    "automation_resumed_manual",
    "batch_wait_started",
    "batch_wait_completed"
  ]) {
    assert.match(
      contentSource,
      new RegExp(`["']${event}["']`),
      `${event} must be written to the automation log`
    );
  }

  assert.match(
    contentSource,
    /AI 分析中（已等待 \$\{elapsedSeconds\} 秒）/,
    "the panel must show how long the current AI request has been waiting"
  );

  const providerCalls = backgroundSource.match(/await fetchAiResponse\(/g) || [];
  assert.equal(providerCalls.length, 4, "all four AI provider protocols must use the timeout helper");

  console.log("AI timeout and observability tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
