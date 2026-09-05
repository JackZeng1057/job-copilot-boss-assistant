// 本地 JSON 修复与结果校验；截断响应由分析入口拒绝后才会到达这里。
function parseJsonWithDiagnostics(text, validator = null) {
  const source = String(text || "").trim();
  const withoutFence = source
    .replace(/^\s*```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const candidates = [
    { value: source, strategy: "strict" },
    { value: withoutFence, strategy: "markdown_fence" }
  ];
  const extractedObjects = extractJsonObjectCandidates(withoutFence);
  if (!extractedObjects.length) extractedObjects.push(withoutFence);
  extractedObjects.forEach((extracted, index) => {
    const suffix = index ? `_${index + 1}` : "";
    const escaped = escapeJsonStringControlCharacters(extracted);
    const normalized = normalizeCommonJsonSyntax(escaped);
    const smartQuoteNormalized = normalizeCommonJsonSyntax(
      escapeJsonStringControlCharacters(extracted.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"))
    );
    candidates.push(
      { value: extracted, strategy: `object_extraction${suffix}` },
      { value: escaped, strategy: `control_characters${suffix}` },
      { value: normalized, strategy: `common_syntax${suffix}` },
      { value: closeTruncatedJson(normalized), strategy: `truncated_closure${suffix}` },
      { value: smartQuoteNormalized, strategy: `smart_quotes${suffix}` },
      { value: closeTruncatedJson(smartQuoteNormalized), strategy: `smart_quotes_truncated_closure${suffix}` }
    );
  });
  let lastError = null;
  const seen = new Set();
  for (const candidate of candidates) {
    const value = String(candidate.value || "").trim();
    if (seen.has(value)) continue;
    seen.add(value);
    if (!value) continue;
    try {
      const parsed = JSON.parse(value);
      if (typeof validator === "function") validator(parsed);
      return {
        value: parsed,
        repaired: candidate.strategy !== "strict",
        strategy: candidate.strategy
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new SyntaxError("模型未返回 JSON 对象");
}

function extractJsonObjectCandidates(text) {
  const source = String(text || "");
  const candidates = [];
  const seen = new Set();
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    const candidate = source.slice(start, end >= 0 ? end : source.length)
      .replace(/\s*```\s*$/i, "")
      .trim();
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
    if (candidates.length >= 32) break;
  }
  return candidates;
}

function normalizeCommonJsonSyntax(text) {
  const doubleQuoted = convertSingleQuotedJsonStrings(String(text || ""));
  return transformOutsideJsonStrings(doubleQuoted, (outside) => outside
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n\r]*/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, "$1\"$2\"$3")
    .replace(/:\s*(True|False|None|undefined|NaN)\b/g, (_match, literal) => {
      if (literal === "True") return ": true";
      if (literal === "False") return ": false";
      return ": null";
    })
    .replace(/:\s*((?!(?:true|false|null)\b)[A-Za-z_$][\w$-]*)(\s*[,}\]])/gi, ': "$1"$2')
    .replace(/,\s*([}\]])/g, "$1"));
}

function transformOutsideJsonStrings(text, transform) {
  let output = "";
  let outside = "";
  let insideString = false;
  let escaped = false;
  const flushOutside = () => {
    output += transform(outside);
    outside = "";
  };
  for (const char of String(text || "")) {
    if (!insideString) {
      if (char === "\"") {
        flushOutside();
        output += char;
        insideString = true;
      } else {
        outside += char;
      }
      continue;
    }
    output += char;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      insideString = false;
    }
  }
  flushOutside();
  return output;
}

function convertSingleQuotedJsonStrings(text) {
  let output = "";
  let quote = "";
  let escaped = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!quote) {
      if (char === "\"" || char === "'") {
        quote = char;
        output += "\"";
      } else {
        output += char;
      }
      continue;
    }
    if (quote === "\"") {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quote = "";
      continue;
    }
    if (escaped) {
      if (char === "'") output += "'";
      else if (char === "\"") output += "\\\"";
      else output += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      output += "\"";
      quote = "";
    } else if (char === "\"") {
      output += "\\\"";
    } else {
      output += char;
    }
  }
  if (escaped) output += "\\";
  if (quote === "'") output += "\"";
  return output;
}

function closeTruncatedJson(text) {
  let source = String(text || "").trim();
  if (!source) return source;
  const stack = [];
  let insideString = false;
  let escaped = false;
  for (const char of source) {
    if (insideString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") insideString = false;
      continue;
    }
    if (char === "\"") {
      insideString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" && stack.at(-1) === "{") {
      stack.pop();
    } else if (char === "]" && stack.at(-1) === "[") {
      stack.pop();
    }
  }
  if (insideString) source += escaped ? "\\\"" : "\"";
  source = source.replace(/,\s*$/, "");
  if (/:\s*$/.test(source)) source += " null";
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    source += stack[index] === "{" ? "}" : "]";
  }
  return source;
}

function escapeJsonStringControlCharacters(text) {
  let output = "";
  let insideString = false;
  let escaped = false;
  for (const char of String(text || "")) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (insideString && char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      insideString = !insideString;
      output += char;
      continue;
    }
    if (insideString && char.charCodeAt(0) < 0x20) {
      if (char === "\n") output += "\\n";
      else if (char === "\r") output += "\\r";
      else if (char === "\t") output += "\\t";
      else output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeAnalysis(data) {
  const excluded = data?.excluded === true;
  return {
    score: excluded ? Math.min(19, clampScore(data?.score)) : clampScore(data?.score),
    decision: excluded ? "skip" : String(data?.decision || "manual_review"),
    excluded,
    exclusion_match: String(data?.exclusion_match || ""),
    exclusion_reason: String(data?.exclusion_reason || ""),
    occupation_family: String(data?.occupation_family || ""),
    target_alignment: String(data?.target_alignment || "unclear"),
    reasons: boundedStringList(data?.reasons, MAX_ANALYSIS_REASONS),
    risks: boundedStringList(data?.risks, MAX_ANALYSIS_RISKS),
    location_fit: String(data?.location_fit || "unclear"),
    greeting: String(data?.greeting || "")
  };
}

function boundedStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").slice(0, limit);
}

const ANALYSIS_ENUM_FIELDS = {
  decision: ["recommend", "manual_review", "skip"],
  target_alignment: ["direct", "transferable", "unrelated", "unclear"],
  location_fit: ["good", "acceptable", "unclear", "poor"]
};

// score 和 excluded 用于识别有效分析；其他字段由 normalizeAnalysis 补默认值，避免丢弃可用结果。
function validateAnalysisShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("AI 结构化输出必须是 JSON 对象");
  }
  if (!Number.isFinite(Number(data.score))) throw new TypeError("AI 结构化输出缺少有效 score");
  if (typeof data.excluded !== "boolean") throw new TypeError("AI 结构化输出缺少布尔值 excluded");
  for (const [key, allowed] of Object.entries(ANALYSIS_ENUM_FIELDS)) {
    if (data[key] !== undefined && !allowed.includes(data[key])) {
      throw new TypeError(`AI 结构化输出的 ${key} 无效`);
    }
  }
  for (const key of ["reasons", "risks"]) {
    if (data[key] !== undefined
      && (!Array.isArray(data[key]) || !data[key].every((item) => typeof item === "string"))) {
      throw new TypeError(`AI 结构化输出的 ${key} 必须是字符串数组`);
    }
  }
  return data;
}

function clampScore(score) {
  const value = Number(score || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
