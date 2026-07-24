const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

const finderStart = source.indexOf("function findCommunicationButtons(root)");
const finderEnd = source.indexOf("function findCommunicationButtonForJob(job)", finderStart);
const finder = source.slice(finderStart, finderEnd);
assert.ok(finderStart >= 0 && finderEnd > finderStart, "communication button finder must exist");
assert.match(finder, /立即沟通\|继续沟通\|继续聊/,
  "both first-contact and existing-conversation buttons must be recognized");
assert.doesNotMatch(finder, /===\s*["']立即沟通["']/,
  "button recognition must not require the exact immediate-contact label");

const contactStart = source.indexOf("async function clickCommunicateForJob(job)");
const contactEnd = source.indexOf("function communicationBlockStatus", contactStart);
const contact = source.slice(contactStart, contactEnd);
assert.ok(contactStart >= 0 && contactEnd > contactStart, "current-page contact function must exist");
assert.match(contact, /await selectJobDetail\(job\)/,
  "the requested job must be selected before clicking");
assert.match(contact, /clickWithoutNavigation\(button\)/,
  "the native BOSS button must be clicked directly");
assert.match(contact, /\^\(继续沟通\|继续聊\)\$/,
  "existing conversations must be accepted as actionable controls");
assert.doesNotMatch(contact, /for\s*\(|while\s*\(|dispatchCommunicationRetryClick|communicateInIsolatedTab/,
  "one job may trigger only one direct communication click");

const clickCalls = contact.match(/clickWithoutNavigation\(button\)/g) || [];
assert.equal(clickCalls.length, 2,
  "the two mutually exclusive label branches should each contain exactly one click");

const lockStart = source.indexOf("async function updateContactSession(contactInFlight, job)");
const lockEnd = source.indexOf("function isQualifiedJob(job)", lockStart);
const lockUpdate = source.slice(lockStart, lockEnd);
assert.doesNotMatch(lockUpdate, /buildAutomationSessionPayload/,
  "clearing the navigation lock must not overwrite the background-restored job progress");
assert.match(lockUpdate, /contactInFlight[\s\S]*currentJobKey[\s\S]*updatedAt/,
  "the contact session update should change only the navigation lock fields");

console.log("Current-page communication button tests passed");
