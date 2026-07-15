const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(new URL("../popup.html", `file://${__dirname}/`), "utf8");
const script = fs.readFileSync(new URL("../popup.js", `file://${__dirname}/`), "utf8");

for (const protocol of [
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "gemini_generate_content",
  "azure_openai"
]) {
  assert.match(html, new RegExp(`value=["']${protocol}["']`), `${protocol} must be selectable`);
}

for (const provider of [
  "deepseek", "openai", "anthropic", "gemini", "qwen", "moonshot", "zhipu",
  "siliconflow", "openrouter", "groq", "together", "ollama", "azure", "custom"
]) {
  assert.match(script, new RegExp(`\\b${provider}: \\{`), `${provider} preset must exist`);
}

assert.match(script, /chrome\.storage\.local\.get\(\s*null/,
  "settings must read raw storage so legacy custom URLs can be inferred without being overwritten");
assert.match(script, /raw\.aiProvider \|\| inferProvider\(stored\.apiBaseUrl\)/,
  "legacy provider migration must infer the provider from the existing URL");
assert.match(script, /模型列表不写死|model[^\n]*fields\.model/,
  "model IDs must remain user-editable instead of using a fixed allowlist");
assert.match(script, /ensureApiOriginPermission\(apiOrigin\)/,
  "custom provider origins must request host permission before saving");
assert.match(html, /<details class="api-advanced" id="apiAdvanced">[\s\S]*自定义接口（高级）/,
  "protocol, URL, and authentication controls must stay inside a collapsed advanced section");

console.log("Popup provider configuration tests passed");
