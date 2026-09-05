// 模拟响应头已返回但正文卡住，验证超时覆盖下载并清理计时器。
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("./helpers/extension-source");

function requestWith(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout });
  vm.runInContext(readSource("background-ai-chat.js"), context);
  return (timeoutMs) => context.fetchAiResponse("https://example.test", {}, timeoutMs);
}

test("AI timeout covers a stalled response body after headers arrive", async () => {
  const request = requestWith(async (_url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })
  }));
  await assert.rejects(request(10), /AI 请求超时/);
});

test("AI response is read once and clears the timer on success", async () => {
  let reads = 0;
  let signal;
  const request = requestWith(async (_url, options) => {
    signal = options.signal;
    return { ok: false, status: 429, text: async () => { reads += 1; return "rate limited"; } };
  });
  const result = await request(10);
  assert.equal(result.status, 429);
  assert.equal(result.ok, false);
  assert.equal(result.text, "rate limited");
  assert.equal(reads, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(signal.aborted, false);
});
