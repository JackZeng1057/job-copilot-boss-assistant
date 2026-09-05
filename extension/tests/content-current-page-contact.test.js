// 验证达标岗位在所属职位页沟通并保留页面导航边界。
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").contentSource();

const finderStart = source.indexOf("function findCommunicationButtons(root)");
const finderEnd = source.indexOf("function findCommunicationButtonForJob(job)", finderStart);
const finder = source.slice(finderStart, finderEnd);
assert.ok(finderStart >= 0 && finderEnd > finderStart, "communication button finder must exist");
assert.match(finder, /isContactActionLabel/,
  "all communication button variants must use the shared label classifier");
assert.match(source, /function isContactActionLabel\(label\)[\s\S]*?\^\(立即沟通\|沟通\|继续沟通\|继续聊\|再次沟通\)\$/,
  "both the literal 沟通 label and existing-conversation labels must be recognized");
assert.doesNotMatch(finder, /===\s*["']立即沟通["']/,
  "button recognition must not require the exact immediate-contact label");

const contactStart = source.indexOf("async function clickCommunicateForJob(job)");
const contactEnd = source.indexOf("function communicationBlockStatus", contactStart);
const contact = source.slice(contactStart, contactEnd);
assert.ok(contactStart >= 0 && contactEnd > contactStart, "owner-tab contact coordinator must exist");
assert.match(contact, /await selectJobDetail\(job\)/,
  "the requested job must be selected before dispatching background communication");
assert.match(contact, /communicateOnOwnerPage\(job/,
  "new communication must run on the visible owner jobs page");
assert.doesNotMatch(contact, /communicateInIsolatedTab/,
  "automatic communication must not create a separate detail tab");
assert.match(contact, /isContinuationContactLabel\(label\)/,
  "an existing-conversation label must still be detected");
assert.match(contact, /existing_conversation_contacted/,
  "contacting a job that already shows 继续沟通 must be recorded");
assert.doesNotMatch(contact, /return ["']already_contacted["']/,
  "a 继续沟通 label reflects the recruiter account, not this posting, so it must not skip the contact");
assert.match(contact, /createStayOnCurrentPageWaiter/,
  "owner-page communication must wait for the BOSS stay-on-page dialog");
assert.match(contact, /dispatchNativeContactClick\(job, button\)/,
  "owner-page communication must use the browser-native click path");
assert.match(contact, /const ownerJobsUrl = location\.href/,
  "automatic communication must retain the exact owner jobs URL before clicking");
assert.match(contact, /(?:chat_route|isBossChatUrl)[\s\S]*restoreManualOwnerJobsRoute\(ownerJobsUrl\)/,
  "automatic communication must restore a chat/detail escape instead of relying on one background check");
assert.doesNotMatch(contact, /communicateInHiddenFrame|communicateInIsolatedTab/,
  "automatic communication must not use hidden or isolated detail tabs");
assert.doesNotMatch(contact, /updateContactSession/,
  "the owner tab must not be marked as an in-flight navigation target");

// The isolated worker-tab path was retired in 1.0.0 and its implementation is
// gone; the background still rejects stale callers by message type.
assert.doesNotMatch(source, /function performIsolatedCommunication|function clickWithinDisposableTab/,
  "the retired disposable-tab communication path must not come back");
assert.equal((contact.match(/await dispatchNativeContactClick\(/g) || []).length, 1,
  "the contact coordinator may dispatch the communication click exactly once");
assert.doesNotMatch(contact, /dispatchCommunicationRetryClick|clickAttempt/,
  "a timeout must never trigger a second communication click");
assert.match(source, /stayed_confirmed/,
  "a success dialog followed by staying on the jobs page must be a first-class confirmed outcome");

console.log("Current-page communication button tests passed");
