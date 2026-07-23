const assert = require("node:assert/strict");
const fs = require("node:fs");

const popupHtml = fs.readFileSync(new URL("../popup.html", `file://${__dirname}/`), "utf8");
const popupJs = fs.readFileSync(new URL("../popup.js", `file://${__dirname}/`), "utf8");
const background = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const content = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

assert.match(popupHtml, /id="excludedDirections"/);
assert.match(popupHtml, /默认留空，不会把任何人的个人排除项应用给其他用户/);
assert.match(popupJs, /excludedDirections: fields\.excludedDirections\.value\.trim\(\)/);
assert.match(background, /excludedDirections: ""/);
assert.match(background, /【前台求职配置：绝不投递岗位\/职业类型】/);
assert.match(background, /共享一个宽泛词不算命中/);
assert.match(content, /excludedDirections: JC_STATE\.settings\.excludedDirections/);

console.log("excluded directions configuration tests passed");
