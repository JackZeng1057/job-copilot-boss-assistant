const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

assert.match(source, /const nativeAutomationContactKeys = new Set\(\)/,
  "trusted automation clicks need a separate ownership marker from real manual clicks");

const manualStart = source.indexOf("function handleManualJobContactClick(event)");
const manualEnd = source.indexOf("function containTrustedManualContactNavigation", manualStart);
const manualHandler = source.slice(manualStart, manualEnd);
assert.match(manualHandler,
  /nativeAutomationContactKeys\.has\(job\.key\)[\s\S]*trustedManualContactEvents\.add\(event\)[\s\S]*return true/,
  "the trusted automation event must reuse navigation containment without starting a second contact controller");

const ownerStart = source.indexOf("async function communicateOnOwnerPage(job");
const ownerEnd = source.indexOf("async function performIsolatedCommunication", ownerStart);
const ownerContact = source.slice(ownerStart, ownerEnd);
assert.match(ownerContact, /dispatchNativeContactClick\(job, button\)/,
  "owner-page communication must use the browser-native click executor");
assert.doesNotMatch(ownerContact, /node\.click\(\)|button\.click\(\)|clickOnOwnerPage\(button\)/,
  "the new contact path must never fall back to an untrusted DOM click");

const dispatchStart = source.indexOf("async function dispatchNativeContactClick(job, button)");
const dispatchEnd = source.indexOf("async function performIsolatedCommunication", dispatchStart);
const dispatcher = source.slice(dispatchStart, dispatchEnd);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, "the content-side click boundary must exist");
assert.match(dispatcher, /elementFromPoint/,
  "the click point must still be owned by the exact communication control");
assert.match(dispatcher, /type:\s*["']dispatchTrustedContactClick["']/,
  "only validated coordinates may cross into the elevated service worker");
assert.match(dispatcher, /nativeAutomationContactKeys\.add[\s\S]*finally[\s\S]*nativeAutomationContactKeys\.delete/,
  "the automation ownership marker must be cleared on every outcome");

console.log("Content browser-native contact boundary tests passed");
