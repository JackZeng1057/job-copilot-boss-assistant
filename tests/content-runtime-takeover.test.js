// 验证扩展重载后可接管不响应的旧面板。
const test = require("node:test");
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").contentSource();

test("content runtime replaces an unresponsive stale panel after extension reload", () => {
  assert.match(source, /const SHOULD_BOOT_CONTENT_RUNTIME = !hasLiveContentRuntime\(\);/);
  assert.match(source, /document\.dispatchEvent\(new CustomEvent\(RUNTIME_PROBE_EVENT/);
  assert.match(source, /document\.dispatchEvent\(new CustomEvent\(RUNTIME_ACK_EVENT/);
  assert.match(source, /installManualChatTabHandler\(true\)/);

  const initPanelBody = source.match(/function initPanel\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(initPanelBody, /scriptVersion === CONTENT_SCRIPT_VERSION\) return/);
  assert.match(initPanelBody, /existingPanel\?\.remove\(\)/);
});
