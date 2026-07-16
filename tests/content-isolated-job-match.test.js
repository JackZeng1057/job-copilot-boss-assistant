const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("function isolatedJobMatchesExpectation(");
const end = source.indexOf("async function selectJobDetail(", start);
assert.ok(start >= 0 && end > start, "isolated job identity helpers must exist");
const comparableStart = source.indexOf("function comparableJobText(");
const comparableEnd = source.indexOf("function isBossChatUrl(", comparableStart);
assert.ok(comparableStart >= 0 && comparableEnd > comparableStart,
  "production title normalization helper must exist");

let detailText = "前端开发工程师（优先全栈） 示例公司 职位描述";
let headingText = "前端开发工程师（优先全栈）";
const detail = {
  get innerText() { return detailText; },
  querySelectorAll() { return [{ innerText: headingText, textContent: headingText }]; }
};
const context = {
  URL,
  location: { href: "https://www.zhipin.com/job_detail/abc123.html" },
  findJobDetailScope() { return detail; },
  isElementVisible() { return true; },
  stripObfuscatedSalary(value) { return String(value || ""); }
};
vm.runInNewContext(`${source.slice(start, end)}\n${source.slice(comparableStart, comparableEnd)}\nthis.matches = isolatedJobMatchesExpectation;`, context);

assert.equal(context.matches({}, {
  key: "job:abc123.html",
  url: "https://www.zhipin.com/job_detail/abc123.html",
  title: "前端开发工程师（优先全栈）-五险一金",
  company: "示例公司"
}), true, "benefit suffix differences must not reject the same job ID and core title");

assert.equal(context.matches({}, {
  key: "job:different.html",
  url: "https://www.zhipin.com/job_detail/different.html",
  title: "前端开发工程师（优先全栈）",
  company: "示例公司"
}), false, "a different job_detail ID must never be contacted even when text matches");

context.location.href = "https://www.zhipin.com/web/geek/jobs";
assert.equal(context.matches({}, {
  title: "前端开发工程师（优先全栈）-五险一金",
  company: "其他公司"
}), false, "list routes must require both the title and company");

const communication = source.slice(
  source.indexOf("async function performIsolatedCommunication(expectedJob)"),
  source.indexOf("function isolatedJobMatchesExpectation(")
);
assert.doesNotMatch(communication, /throw new Error\(["']临时标签岗位详情与目标岗位不一致/,
  "a transient default detail must not fail immediately");
assert.match(communication, /continue;[\s\S]*sawCommunicateButton \? ["']detail_mismatch["'] : ["']no_button["']/,
  "the worker must wait for React to stabilize before returning a safe mismatch result");

console.log("Isolated job identity regression tests passed");
