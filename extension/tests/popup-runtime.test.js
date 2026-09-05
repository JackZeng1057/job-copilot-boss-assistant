// 验证配置保存失败、分数线输入边界和文本简历的按需依赖加载。
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("./helpers/extension-source");

function loadPopup({ storageError = null, score = "60" } = {}) {
  const nodes = new Map();
  const alerts = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, addEventListener(event, listener) { this[event] = listener; } });
    return nodes.get(id);
  };
  let saved;
  let closed = false;
  const runtime = { lastError: null };
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    chrome: { runtime, storage: { local: {
      get() {},
      set(values, callback) { saved = values; runtime.lastError = storageError; callback(); runtime.lastError = null; }
    } } },
    window: { close() { closed = true; } },
    alert: (message) => alerts.push(message), URL
  });
  vm.runInContext(readSource("popup.js").replace(/^import .*;$/m, ""), context);
  node("apiBaseUrl").value = "https://example.test";
  node("model").value = "test-model";
  node("minScore").value = score;
  return { save: () => node("save").click(), alerts, saved: () => saved, closed: () => closed };
}

test("popup reports failed storage writes and stays open", async () => {
  const popup = loadPopup({ storageError: { message: "quota exceeded" } });
  await popup.save();
  assert.equal(popup.closed(), false);
  assert.match(popup.alerts[0], /保存失败：quota exceeded/);
});

test("popup saves valid thresholds including zero and normalizes invalid input", async () => {
  for (const [score, expected] of [["0", 0], ["88.6", 89], ["200", 100], ["invalid", 60], ["", 60]]) {
    const popup = loadPopup({ score });
    await popup.save();
    assert.equal(popup.saved().minScore, expected);
    assert.equal(popup.closed(), true);
    assert.equal(popup.alerts.length, 0);
  }
});

test("resume text import works as an ES module without loading PDF.js", async () => {
  const source = readSource("popup-resume.js");
  // data URL 中相对 PDF import 无法解析；文本导入成功也验证了 PDF 依赖未被提前触发。
  const { readResumeFile } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(await readResumeFile({ name: "resume.md", type: "text/markdown", text: async () => "简历正文" }), "简历正文");
  await assert.rejects(readResumeFile({ name: "resume.zip", type: "application/zip" }), /暂不支持/);
  await assert.rejects(readResumeFile({ name: "resume.txt", type: "text/plain", text: async () => "\0".repeat(100) }), /不是纯文本/);
});
