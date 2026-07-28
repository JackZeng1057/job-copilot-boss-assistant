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
const contactEnd = source.indexOf("async function performIsolatedCommunication", contactStart);
const contact = source.slice(contactStart, contactEnd);
assert.ok(contactStart >= 0 && contactEnd > contactStart, "owner-tab contact coordinator must exist");
assert.match(contact, /await selectJobDetail\(job\)/,
  "the requested job must be selected before dispatching background communication");
assert.match(contact, /type:\s*["']communicateInIsolatedTab["']/,
  "new communication must be delegated to an isolated background tab");
assert.match(contact, /\^\(继续沟通\|继续聊\)\$/,
  "existing conversations must be recognized without entering chat");
assert.match(contact, /existing_conversation_skipped[\s\S]*return ["']already_contacted["']/,
  "existing conversations must be recorded without clicking the chat control");
assert.doesNotMatch(contact, /clickWithoutNavigation|\.click\s*\(/,
  "the owner jobs tab must never click a control that can navigate to chat");
assert.doesNotMatch(contact, /updateContactSession/,
  "the owner tab must not be marked as an in-flight navigation target");

const workerStart = source.indexOf("async function performIsolatedCommunication");
const workerEnd = source.indexOf("function communicationBlockStatus", workerStart);
const worker = source.slice(workerStart, workerEnd);
assert.ok(workerStart >= 0 && workerEnd > workerStart, "isolated communication worker must exist");
assert.equal((worker.match(/clickWithinDisposableTab\(button\)/g) || []).length, 1,
  "the disposable tab may click the immediate-contact button exactly once");
assert.doesNotMatch(worker, /dispatchCommunicationRetryClick|clickAttempt/,
  "a timeout must never trigger a second communication click");
assert.match(worker, /\^\(继续沟通\|继续聊\)\$[\s\S]*return ["']already_contacted["']/,
  "a worker that discovers an existing conversation must also avoid clicking");
assert.match(source, /function clickWithinDisposableTab[\s\S]*setAttribute\(["']target["'],\s*["']_self["']\)/,
  "a link-style communication control must be contained in the inactive worker tab");

console.log("Current-page communication button tests passed");
