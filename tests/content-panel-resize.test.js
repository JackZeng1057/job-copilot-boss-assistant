const assert = require("node:assert/strict");
const fs = require("node:fs");

const script = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const styles = fs.readFileSync(new URL("../content.css", `file://${__dirname}/`), "utf8");

for (const direction of ["n", "e", "s", "w", "nw", "ne", "sw", "se"]) {
  assert.match(script, new RegExp(`data-jc-resize=["']${direction}["']`),
    `panel must expose the ${direction} resize handle`);
}

assert.match(script, /handle\.setPointerCapture\?\.\(event\.pointerId\)/,
  "Windows Edge resizing must retain pointer capture after leaving a narrow edge handle");
assert.match(script, /pointercancel["'], finishResize/,
  "cancelled pointer gestures must clean up the resize session");
assert.match(styles, /\.jc-resize-n[\s\S]*cursor:\s*ns-resize/,
  "top and bottom handles must advertise vertical resizing");
assert.match(styles, /\.jc-resize-e[\s\S]*cursor:\s*ew-resize/,
  "left and right handles must advertise horizontal resizing");
assert.doesNotMatch(styles, /\.jc-resize-handle[\s\S]{0,180}(linear-gradient|background-image)/,
  "resize handles must remain visually transparent without diagonal grip lines");

console.log("Eight-direction panel resize regression test passed");
