const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
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
  "communicateInIsolatedTab",
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

console.log("Background async message response tests passed");
