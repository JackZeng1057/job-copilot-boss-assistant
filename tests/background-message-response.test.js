// 验证异步消息保持通道并返回错误，防止调用方无限等待。
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").backgroundSource();
const listenerStart = source.indexOf("chrome.runtime.onMessage.addListener");
const listenerEnd = source.indexOf("if (chrome.tabs?.onUpdated)", listenerStart);
const listener = source.slice(listenerStart, listenerEnd);

assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, "background message listener must exist");
for (const type of [
  "registerAutomationSession",
  "updateAutomationSession",
  "getAutomationSession",
  "focusAutomationTab",
  "openManualChatTab",
  "dispatchTrustedContactClick",
  "controlAutomationTab",
  "appendAutomationLog"
]) {
  const branchStart = listener.indexOf(`message?.type === "${type}"`);
  const nextBranch = listener.indexOf("message?.type ===", branchStart + 20);
  const branch = listener.slice(branchStart, nextBranch >= 0 ? nextBranch : listener.length);
  assert.ok(branchStart >= 0, `${type} message branch must exist`);
  assert.match(branch, /\.catch\(\(error\) => sendResponse\(\{ ok: false, error:/,
    `${type} must answer rejected promises instead of closing the async message channel`);
  assert.match(branch, /return true;/, `${type} async branch must keep the message channel open`);
}

const isolatedBranchStart = listener.indexOf('message?.type === "communicateInIsolatedTab"');
assert.ok(isolatedBranchStart >= 0, "legacy isolated communication branch must exist");
const isolatedBranchEnd = listener.indexOf("message?.type ===", isolatedBranchStart + 20);
const isolatedBranch = listener.slice(isolatedBranchStart,
  isolatedBranchEnd >= 0 ? isolatedBranchEnd : listener.length);
assert.match(isolatedBranch, /isolated_detail_tabs_disabled/,
  "legacy isolated communication must be rejected so it cannot create a detail tab");
assert.match(isolatedBranch, /return false;/,
  "disabled isolated communication must not keep an async channel open");

console.log("Background async message response tests passed");
