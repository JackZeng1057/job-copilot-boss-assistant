const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", `file://${__dirname}/`), "utf8"));

const contactStart = source.indexOf("async function clickCommunicateForJob(job)");
const contactEnd = source.indexOf("async function performIsolatedCommunication", contactStart);
assert.ok(contactStart >= 0 && contactEnd > contactStart, "queue communication coordinator must exist");
const contact = source.slice(contactStart, contactEnd);

assert.match(source, /async function communicateOnOwnerPage\(job/,
  "automatic communication must use the visible owner jobs page");
assert.match(contact, /communicateOnOwnerPage\(job/,
  "automatic queue communication must stay in the owner page");
assert.doesNotMatch(contact, /communicateInIsolatedTab/,
  "automatic queue communication must not create a separate detail tab");
assert.match(source, /function communicateOnOwnerPage[\s\S]*createStayOnCurrentPageWaiter/,
  "owner-page communication must wait for the native BOSS confirmation dialog");
assert.match(source, /function clickOnOwnerPage[\s\S]*setAttribute\(["']target["'],\s*["']_self["']\)/,
  "owner-page communication must contain link targets in the current tab");
assert.match(source, /manual_required/,
  "untrusted extension clicks must fall back to a trusted manual click instead of guessing success");
const mainGuard = manifest.content_scripts.find((entry) =>
  Array.isArray(entry.js) && entry.js.includes("page-navigation-guard.js"));
assert.equal(mainGuard?.all_frames, true,
  "route guard must remain active in every BOSS frame");

console.log("Owner-page communication tests passed");
