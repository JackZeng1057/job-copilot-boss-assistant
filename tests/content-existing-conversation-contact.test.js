// 验证已有 HR 会话不能被误当作当前岗位已投递。
const assert = require("node:assert/strict");

const source = require("./helpers/extension-source").contentSource();

// A "继续沟通" label describes the recruiter account, not this posting: the same
// HR's other jobs carry it too. Neither path may treat it as "already applied".
const autoStart = source.indexOf("async function clickCommunicateForJob(job)");
const autoEnd = source.indexOf("async function communicateOnOwnerPage(", autoStart);
const autoBlock = source.slice(autoStart, autoEnd);
assert.ok(autoStart >= 0 && autoEnd > autoStart, "the auto contact coordinator must exist");
assert.doesNotMatch(autoBlock, /return ["']already_contacted["']/,
  "the auto queue must contact a 继续沟通 job instead of skipping it");
assert.doesNotMatch(source, /already_contacted/,
  "the skipped-contact result must be gone from every branch, not just its producer");
assert.match(autoBlock, /communicateOnOwnerPage\(job/,
  "every qualified job must reach the real owner-page contact flow");

const handlerStart = source.indexOf("function handleManualJobContactClick(event)");
const handlerEnd = source.indexOf("function containTrustedManualContactNavigation", handlerStart);
const handlerBlock = source.slice(handlerStart, handlerEnd);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "the manual click handler must exist");
assert.doesNotMatch(handlerBlock, /openExistingConversationInCompanion\(job\)/,
  "a mapped 继续沟通 job must not be swapped for a chat tab and dropped from the queue");
assert.match(handlerBlock, /contactManuallyWithoutOwnerNavigation\(job, \{[\s\S]*allowButtonLabel: !isContinuationContactLabel\(label\)/,
  "the manual path must pass the pre-click label down as the evidence rule");

// The pre-click label is the whole point: a button that already read 继续沟通
// cannot prove that this attempt sent anything.
const ownerStart = source.indexOf("async function communicateOnOwnerPage(");
const ownerEnd = source.indexOf("async function dispatchNativeContactClick", ownerStart);
const ownerBlock = source.slice(ownerStart, ownerEnd);
assert.match(ownerBlock, /const startedFromExistingConversation = isContinuationContactLabel\(/,
  "the label must be captured before the click, not read back afterwards");
assert.match(ownerBlock, /allowButtonLabel: !startedFromExistingConversation/,
  "a continuation click must not accept the unchanged button label as success");
assert.match(ownerBlock, /createStayOnCurrentPageWaiter\(CONTACT_CONFIRMATION_TIMEOUT_MS, job, evidenceOptions\)/,
  "the confirmation waiter must use the same evidence rule");

assert.match(source, /function hasSuccessfulContactEvidence\(expectedJob = null, evidenceOptions = \{\}\)[\s\S]*evidenceOptions\.allowButtonLabel === false\s*\?\s*\[\]/,
  "button-label evidence must be suppressible for continuation clicks");
assert.match(source, /function manualCommunicationConfirmed\(job, evidenceOptions = \{\}\)[\s\S]*evidenceOptions\.allowButtonLabel !== false/,
  "the manual confirmation check must honour the same rule");

console.log("Existing-conversation contact regression tests passed");
