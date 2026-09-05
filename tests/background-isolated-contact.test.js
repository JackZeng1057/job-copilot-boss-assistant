// 验证旧版独立详情页沟通入口被拒绝，避免创建额外投递页。
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").backgroundSource();
const listenerStart = source.indexOf("chrome.runtime.onMessage.addListener");
const listenerEnd = source.indexOf("if (chrome.tabs?.onUpdated)", listenerStart);
const listener = source.slice(listenerStart, listenerEnd);
const branchStart = listener.indexOf('message?.type === "communicateInIsolatedTab"');
const branchEnd = listener.indexOf("message?.type ===", branchStart + 20);
const branch = listener.slice(branchStart, branchEnd >= 0 ? branchEnd : listener.length);

assert.ok(branchStart >= 0, "legacy isolated communication branch must remain explicit");
assert.match(branch, /isolated_detail_tabs_disabled/,
  "automatic communication must reject the legacy detail-tab path");
assert.match(branch, /sendResponse\(\{ ok: false/,
  "the rejection must be observable by stale callers");
assert.match(branch, /return false;/,
  "the disabled path must not keep an asynchronous tab operation alive");

console.log("Isolated contact detail-tab suppression tests passed");
