const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

assert.match(source, /function extensionContextAvailable\(\)[\s\S]*chrome\?\.runtime\?\.id/,
  "content script must detect a reloaded or invalid extension context");
assert.match(source, /function schedulePersistAutomationSession\(\)[\s\S]*contextInvalidated[\s\S]*extensionContextAvailable\(\)/,
  "session persistence must stop before touching an invalid runtime");
assert.match(source, /function sendMessage\(message\)[\s\S]*try \{[\s\S]*chrome\.runtime\.sendMessage[\s\S]*catch \(error\)/,
  "runtime messaging must catch synchronous context invalidation");
assert.match(source, /chrome\.runtime\.sendMessage\(message,[\s\S]*try \{[\s\S]*chrome\.runtime\.lastError/,
  "runtime messaging callbacks must catch lastError access after extension reload");
assert.match(source, /function invalidateExtensionContext\(\)[\s\S]*pipeline\.active = false[\s\S]*allPaused = true[\s\S]*analysisRunId \+= 1/,
  "an invalid context must stop both automation and the current analysis run");
assert.match(source, /function setAutomationFlag\(key, value\)[\s\S]*extensionContextAvailable\(\)[\s\S]*chrome\.storage\.local\.set[\s\S]*catch \(runtimeError\)/,
  "stale-page controls must not throw while saving after an extension reload");
assert.match(source, /扩展已重新加载，请刷新当前职位页后继续/,
  "the stale page must show a recoverable status instead of throwing");

console.log("Content context invalidation regression test passed");
