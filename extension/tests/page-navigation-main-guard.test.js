// 验证 MAIN 世界导航保护的启停、时长和持久保护边界。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../page-navigation-guard.js", `file://${__dirname}/`), "utf8");
const listeners = new Map();
const calls = [];
let now = 1000;
const sandbox = {
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  Date: { now: () => now },
  URL,
  location: { href: "https://www.zhipin.com/web/geek/jobs" },
  document: {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent() {}
  },
  window: {
    open(...args) { calls.push(["window.open", ...args]); },
    navigation: {
      addEventListener(type, listener) { listeners.set(`navigation:${type}`, listener); }
    }
  },
  history: {
    pushState(...args) { calls.push(["pushState", ...args]); },
    replaceState(...args) { calls.push(["replaceState", ...args]); }
  }
};

vm.runInNewContext(source, sandbox);
listeners.get("job-copilot-owner-navigation-guard-start")({ detail: { durationMs: 12000 } });
let navigationPrevented = false;
listeners.get("navigation:navigate")({
  destination: { url: "https://www.zhipin.com/web/geek/chat" },
  navigationType: "push",
  cancelable: true,
  preventDefault() { navigationPrevented = true; }
});
assert.equal(navigationPrevented, true,
  "the guard must cancel a browser-level navigation before the jobs document unloads");
sandbox.history.pushState({}, "", "/web/geek/chat");
sandbox.history.replaceState({}, "", "/job_detail/abc.html");
sandbox.window.open("/job_detail/new-tab.html", "_blank");
sandbox.window.open("/web/geek/chat", "_blank");
sandbox.history.pushState({}, "", "/web/geek/jobs?page=2");

assert.deepEqual(calls, [["pushState", {}, "", "/web/geek/jobs?page=2"]],
  "the temporary main-world guard must block chat/detail routes but preserve normal jobs routing");

listeners.get("job-copilot-owner-navigation-guard-stop")();
sandbox.history.pushState({}, "", "/web/geek/chat");
sandbox.window.open("/job_detail/allowed-after-stop.html", "_blank");
assert.equal(calls.length, 3, "stopping the guard must restore ordinary page and new-window routing");

listeners.get("job-copilot-owner-navigation-guard-start")({
  detail: { durationMs: 12000, persistent: true }
});
now += 60000;
listeners.get("job-copilot-owner-navigation-guard-stop")();
sandbox.history.pushState({}, "", "/web/geek/chat");
sandbox.history.replaceState({}, "", "/job_detail/late-route.html");
sandbox.window.open("/web/geek/chat", "_blank");
sandbox.history.pushState({}, "", "/web/geek/jobs?page=3");
assert.deepEqual(calls.at(-1), ["pushState", {}, "", "/web/geek/jobs?page=3"],
  "a persistent jobs-tab guard must preserve normal jobs routing");
assert.equal(calls.length, 4,
  "late chat/detail routes must remain blocked for the lifetime of a protected jobs page");

console.log("Main-world owner navigation guard tests passed");
