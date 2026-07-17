const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("function clickWithoutNavigation(node)");
const end = source.indexOf("function isElementVisible(node)", start);
assert.ok(start >= 0 && end > start, "navigation-safe click helper must exist");

const helperSource = source.slice(start, end);
const context = {};
vm.runInNewContext(`${helperSource}\nthis.clickWithoutNavigation = clickWithoutNavigation;`, context);

let clickCount = 0;
const anchor = {
  getAttribute(name) { return name === "href" ? "https://www.zhipin.com/web/geek/chat" : null; }
};
const node = {
  closest(selector) { return selector === "a[href]" ? anchor : null; },
  click() {
    clickCount += 1;
    assert.equal(anchor.getAttribute("href"), "https://www.zhipin.com/web/geek/chat",
      "BOSS's native handler must receive the original href");
  }
};

assert.equal(context.clickWithoutNavigation(node), true);
assert.equal(clickCount, 1);
assert.doesNotMatch(helperSource, /removeAttribute\(["']href["']\)/,
  "isolated communication must not strip information used by BOSS's click handler");

let prevented = false;
const javascriptAnchor = {
  getAttribute(name) { return name === "href" ? "javascript:;" : null; },
  addEventListener(type, listener, options) {
    assert.equal(type, "click");
    assert.equal(options.capture, true);
    assert.equal(options.once, true);
    listener({ preventDefault() { prevented = true; } });
  }
};
const javascriptNode = {
  closest() { return javascriptAnchor; },
  click() { clickCount += 1; }
};
assert.equal(context.clickWithoutNavigation(javascriptNode), true);
assert.equal(prevented, true, "javascript: URL execution must still be cancelled");
assert.equal(javascriptAnchor.getAttribute("href"), "javascript:;",
  "the href must remain visible to BOSS while its listener runs");
assert.match(source, /async function performIsolatedCommunication[\s\S]*clickWithoutNavigation\(currentButton\)/);
const originalContact = source.slice(
  source.indexOf("async function clickCommunicateForJob(job)"),
  source.indexOf("async function performIsolatedCommunication", source.indexOf("async function clickCommunicateForJob(job)"))
);
assert.doesNotMatch(originalContact, /\.click\(|clickWithoutNavigation\(/,
  "the dedicated jobs tab must never click BOSS communication controls");
const manualChatHandler = source.slice(
  source.indexOf("function installManualChatTabHandler"),
  source.indexOf("function isTrustedTopNavigationChatClick", source.indexOf("function installManualChatTabHandler"))
);
assert.match(manualChatHandler, /type:\s*["']openManualChatTab["']/,
  "manual chat navigation must be delegated to the background tab API");
assert.doesNotMatch(manualChatHandler, /window\.open/,
  "manual chat must never let the page choose or reuse the jobs browsing context");
assert.match(source, /function hardenManualChatLinks[\s\S]*target\s*=\s*["']_blank["']/,
  "top-level chat links need a new-tab fallback even when click interception is bypassed");
assert.match(source, /function hardenManualChatLinks[\s\S]*noopener noreferrer/,
  "fallback chat tabs must not receive a jobs-page opener");
assert.match(source, /function hardenManualChatLinks[\s\S]*setAttribute\(["']href["'],\s*`\$\{location\.pathname\}\$\{location\.search\}`\)/,
  "the BOSS chat URL must be removed from the jobs page before a click can navigate it");
assert.match(source, /function hardenManualChatLinks[\s\S]*pointerEvents\s*=\s*["']none["']/,
  "the original BOSS chat node must never receive pointer input");
assert.match(source, /function normalizeManualChatLabel[\s\S]*\[0-9０-９\]/,
  "unread counts must not disable top-message interception");
assert.match(source, /document\.documentElement\.appendChild\(overlay\)/,
  "the message overlay must use viewport coordinates outside transformed BOSS containers");
assert.match(source, /function positionManualChatOverlay[\s\S]*createElement\(["']a["']\)[\s\S]*web\/geek\/chat[\s\S]*target\s*=\s*["']_blank["']/,
  "an extension-owned native link must keep clicks outside the BOSS React route handler");
assert.match(source, /job-copilot-message-overlay[\s\S]*stopImmediatePropagation\(\)/,
  "the native overlay must stop BOSS's SPA click handler without preventing its own default action");
assert.match(source, /addEventListener\(["']pointerdown["'],\s*handleManualChatHitboxEvent,\s*true\)/,
  "the message hitbox must intercept pointer input before the BOSS route handler");
assert.doesNotMatch(source, /clickWithoutJavascriptUrl/);
console.log("Isolated content navigation regression test passed");
