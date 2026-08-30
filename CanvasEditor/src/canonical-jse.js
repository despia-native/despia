(() => {
  // packages/kernel/dist/jse/values.js
  var NSNull = {
    __nsnull: true,
    toString() {
      return "<null>";
    }
  };
  function isDict(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v) && v !== NSNull && !isLambda(v);
  }
  function isLambda(v) {
    return typeof v === "object" && v !== null && v.__lambda === true;
  }
  function isWhitespaceOnly(c) {
    if (c === "	")
      return true;
    return /^\p{Zs}$/u.test(c);
  }
  function trimWhitespaceOnly(s) {
    let start = 0;
    let end = s.length;
    while (start < end && isWhitespaceOnly(s[start]))
      start += 1;
    while (end > start && isWhitespaceOnly(s[end - 1]))
      end -= 1;
    return s.substring(start, end);
  }
  var segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
  function graphemes(s) {
    if (s.length === 0)
      return [];
    if (segmenter) {
      const out = [];
      for (const seg of segmenter.segment(s))
        out.push(seg.segment);
      return out;
    }
    return Array.from(s);
  }
  function charCount(s) {
    let simple = true;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) >= 768) {
        simple = false;
        break;
      }
    }
    if (simple)
      return s.length;
    return graphemes(s).length;
  }
  function swiftDouble(s) {
    if (s.length === 0)
      return null;
    if (/\s/.test(s[0]) || /\s/.test(s[s.length - 1]))
      return null;
    const neg = s.startsWith("-");
    const body = s.startsWith("+") || neg ? s.substring(1) : s;
    if (body.length === 0)
      return null;
    const lower = body.toLowerCase();
    if (lower === "inf" || lower === "infinity")
      return neg ? -Infinity : Infinity;
    if (lower === "nan")
      return NaN;
    if (lower.startsWith("0x")) {
      if (/^0x[0-9a-f]+$/.test(lower)) {
        const v2 = parseInt(lower, 16);
        return neg ? -v2 : v2;
      }
      if (/^0x[0-9a-f]*(\.[0-9a-f]*)?p[+-]?[0-9]+$/.test(lower)) {
        const m = /^0x([0-9a-f]*)(?:\.([0-9a-f]*))?p([+-]?[0-9]+)$/.exec(lower);
        const intPart = m[1] ?? "";
        const fracPart = m[2] ?? "";
        if (intPart.length === 0 && fracPart.length === 0)
          return null;
        let mant = 0;
        for (const c of intPart)
          mant = mant * 16 + parseInt(c, 16);
        let scale = 1 / 16;
        for (const c of fracPart) {
          mant += parseInt(c, 16) * scale;
          scale /= 16;
        }
        const v2 = mant * Math.pow(2, parseInt(m[3], 10));
        return neg ? -v2 : v2;
      }
      return null;
    }
    const last = body[body.length - 1].toLowerCase();
    if (last === "f" || last === "d")
      return null;
    if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(body))
      return null;
    const v = Number(body);
    if (Number.isNaN(v))
      return null;
    return neg ? -v : v;
  }
  function number(v) {
    if (typeof v === "number")
      return v;
    if (typeof v === "boolean")
      return v ? 1 : 0;
    if (typeof v === "string")
      return swiftDouble(v);
    if (isDict(v)) {
      const d = v["__date"];
      return typeof d === "number" ? d : null;
    }
    return null;
  }
  var stringCoerceHook = null;
  function setStringCoerce(fn) {
    stringCoerceHook = fn;
  }
  function string(v) {
    if (isDict(v) && stringCoerceHook) {
      const c = stringCoerceHook(v);
      if (c !== null)
        return c;
    }
    if (typeof v === "string")
      return v;
    if (typeof v === "boolean")
      return v ? "1" : "0";
    if (typeof v === "number") {
      if (Number.isNaN(v))
        return "nan";
      if (v === Infinity)
        return "inf";
      if (v === -Infinity)
        return "-inf";
      if (Number.isFinite(v) && Math.floor(v) === v) {
        if (Math.abs(v) < 1e21)
          return String(v);
        return String(BigInt(Math.min(Math.max(v, -9e18), 9e18)));
      }
      return String(v);
    }
    if (v === null || v === void 0)
      return "";
    return String(v);
  }
  function truthy(v) {
    if (typeof v === "boolean")
      return v;
    if (typeof v === "string")
      return v.length > 0;
    if (typeof v === "number")
      return v !== 0;
    if (v === null || v === void 0)
      return false;
    return true;
  }
  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }
  function asRows(v) {
    if (!Array.isArray(v))
      return [];
    return v.filter((e) => isDict(e));
  }
  function watchKey(v, seen) {
    if (v === null || v === void 0 || v === NSNull)
      return "\u2205";
    if (typeof v === "string")
      return "s" + v;
    if (typeof v === "boolean")
      return v ? "b1" : "b0";
    if (typeof v === "number")
      return "n" + string(v);
    const nested = Array.isArray(v) || isDict(v);
    if (!nested)
      return "x" + String(v);
    const path = seen ?? /* @__PURE__ */ new Set();
    if (path.has(v))
      return "\u21BA";
    path.add(v);
    try {
      if (Array.isArray(v))
        return "[" + v.map((e) => watchKey(e, path)).join("") + "]";
      const d = v;
      return "{" + Object.keys(d).sort().map((k) => `${k}=` + watchKey(d[k], path)).join("") + "}";
    } finally {
      path.delete(v);
    }
  }
  function jseEquals(a, b) {
    if (a === NSNull || a === void 0)
      a = null;
    if (b === NSNull || b === void 0)
      b = null;
    if (a === null || b === null)
      return a === b;
    const x = number(a);
    const y = number(b);
    if (x !== null && y !== null)
      return x === y;
    const structural = (v) => {
      if (isDict(v))
        return stringCoerceHook === null || stringCoerceHook(v) === null;
      return Array.isArray(v);
    };
    if (structural(a) || structural(b))
      return watchKey(a) === watchKey(b);
    return string(a) === string(b);
  }
  function compare(a, b, o) {
    if (typeof a === "string" && typeof b === "string") {
      switch (o) {
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        default:
          return a >= b;
      }
    }
    const x = number(a) ?? 0;
    const y = number(b) ?? 0;
    switch (o) {
      case "<":
        return x < y;
      case "<=":
        return x <= y;
      case ">":
        return x > y;
      default:
        return x >= y;
    }
  }
  function arith(a, b, o) {
    if (o === "+") {
      const x2 = number(a);
      const y2 = number(b);
      if (x2 !== null && y2 !== null)
        return x2 + y2;
      return string(a) + string(b);
    }
    const x = number(a) ?? 0;
    const y = number(b) ?? 0;
    switch (o) {
      case "-":
        return x - y;
      case "*":
        return x * y;
      case "/":
        return y === 0 ? 0 : x / y;
      // DIVISION BY ZERO YIELDS 0 — the JSE law
      case "%":
        return y === 0 ? 0 : x % y;
      // JS % (sign of dividend); %0 → 0 like /0
      default:
        return 0;
    }
  }
  function isMissing(v) {
    return v === null || v === void 0 || v === NSNull;
  }
  function toInt32(v) {
    let n = number(v) ?? 0;
    if (!Number.isFinite(n))
      return 0;
    n = Math.trunc(n) % 4294967296;
    if (n >= 2147483648)
      n -= 4294967296;
    else if (n < -2147483648)
      n += 4294967296;
    return n;
  }
  function toUint32(v) {
    let n = number(v) ?? 0;
    if (!Number.isFinite(n))
      return 0;
    n = Math.trunc(n) % 4294967296;
    if (n < 0)
      n += 4294967296;
    return n;
  }
  function bitOp(a, b, o) {
    const s = toUint32(b) & 31;
    switch (o) {
      case "&":
        return toInt32(a) & toInt32(b);
      case "|":
        return toInt32(a) | toInt32(b);
      case "^":
        return toInt32(a) ^ toInt32(b);
      case "<<":
        return toInt32(a) << s | 0;
      case ">>":
        return toInt32(a) >> s;
      case ">>>":
        return toUint32(a) >>> s;
      default:
        return 0;
    }
  }
  function bitNot(v) {
    return -toInt32(v) - 1;
  }
  function powOp(a, b) {
    return Math.pow(number(a) ?? 0, number(b) ?? 0);
  }
  function typeofString(v) {
    if (v === null || v === void 0 || v === NSNull)
      return "undefined";
    if (typeof v === "string")
      return "string";
    if (typeof v === "boolean")
      return "boolean";
    if (typeof v === "number")
      return "number";
    if (isLambda(v))
      return "function";
    return "object";
  }
  function safeInt(d) {
    if (Number.isNaN(d))
      return 0;
    return Math.trunc(Math.min(Math.max(d, -9e18), 9e18));
  }
  function roundedAwayFromZero(x) {
    if (Number.isNaN(x) || !Number.isFinite(x))
      return x;
    const a = Math.abs(x);
    const f = Math.floor(a);
    const r = a - f >= 0.5 ? f + 1 : f;
    return x < 0 ? -r : r;
  }
  function swiftMin(a, b) {
    return b < a ? b : a;
  }
  function swiftMax(a, b) {
    return b >= a ? b : a;
  }
  function capitalizedSwift(s) {
    let out = "";
    let prevLetter = false;
    for (const ch of s) {
      const isLetter2 = /\p{L}/u.test(ch);
      out += isLetter2 && !prevLetter ? ch.toUpperCase() : isLetter2 ? ch.toLowerCase() : ch;
      prevLetter = isLetter2;
    }
    return out;
  }
  function index(base, idx) {
    const n = number(idx);
    if (n !== null) {
      const i = safeInt(n);
      const arr = asArray(base);
      return i >= 0 && i < arr.length ? arr[i] : null;
    }
    return isDict(base) ? base[string(idx)] ?? null : null;
  }
  function member(base, m) {
    if (m === "length") {
      if (typeof base === "string")
        return charCount(base);
      if (Array.isArray(base))
        return base.length;
    }
    return isDict(base) ? base[m] ?? null : null;
  }

  // packages/kernel/dist/jse/tokens.js
  var threeCharOps = ["===", "!==", ">>>", "**=", "..."];
  var twoCharOps = [
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "=>",
    "**",
    "??",
    "?.",
    "<<",
    ">>",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%="
  ];
  function isDigit(c) {
    return c >= "0" && c <= "9";
  }
  function isHexDigit(c) {
    return isDigit(c) || c >= "a" && c <= "f" || c >= "A" && c <= "F";
  }
  function isLetter(c) {
    return /\p{L}/u.test(c);
  }
  function isWordChar(c) {
    return isLetter(c) || isDigit(c) || c === "_";
  }
  function charAllowsRegex(prev) {
    if (prev === null)
      return true;
    if (isWordChar(prev))
      return false;
    return prev !== ")" && prev !== "]" && prev !== "'" && prev !== '"' && prev !== "`";
  }
  var regexKeywords = /* @__PURE__ */ new Set(["return", "case", "typeof", "in", "of", "do", "else", "throw"]);
  function regexAfterKeyword(out) {
    let t = out.length - 1;
    while (t >= 0 && /\s/.test(out[t]))
      t -= 1;
    let w = "";
    while (t >= 0 && isWordChar(out[t]) && w.length <= 8) {
      w = out[t] + w;
      t -= 1;
    }
    if (t >= 0 && isWordChar(out[t]))
      return false;
    return regexKeywords.has(w);
  }
  function scanRegexEnd(c, i) {
    let j = i + 1;
    let inClass = false;
    let closed = false;
    while (j < c.length) {
      const rc = c[j];
      if (rc === "\\" && j + 1 < c.length) {
        j += 2;
        continue;
      }
      if (rc === "[")
        inClass = true;
      if (rc === "]")
        inClass = false;
      if (rc === "/" && !inClass) {
        closed = true;
        j += 1;
        break;
      }
      if (rc === "\n")
        break;
      j += 1;
    }
    if (!closed || j === i + 1)
      return -1;
    while (j < c.length && isLetter(c[j]))
      j += 1;
    return j;
  }
  function copyQuoted(c, i, out) {
    const q = c[i];
    out.push(q);
    let j = i + 1;
    while (j < c.length) {
      const ch = c[j];
      if (ch === "\\" && j + 1 < c.length) {
        out.push(ch, c[j + 1]);
        j += 2;
        continue;
      }
      out.push(ch);
      j += 1;
      if (ch === q)
        break;
    }
    return j;
  }
  function copyTemplate(c, i, out, depth = 0) {
    out.push("`");
    let j = i + 1;
    let hole = 0;
    while (j < c.length) {
      const ch = c[j];
      if (ch === "\\" && j + 1 < c.length) {
        out.push(ch, c[j + 1]);
        j += 2;
        continue;
      }
      if (hole === 0 && ch === "`") {
        out.push(ch);
        j += 1;
        break;
      }
      if (hole > 0 && (ch === "'" || ch === '"')) {
        j = copyQuoted(c, j, out);
        continue;
      }
      if (hole > 0 && ch === "`" && depth < 32) {
        j = copyTemplate(c, j, out, depth + 1);
        continue;
      }
      if (ch === "$" && j + 1 < c.length && c[j + 1] === "{") {
        out.push("$", "{");
        hole += 1;
        j += 2;
        continue;
      }
      if (hole > 0 && ch === "{")
        hole += 1;
      if (hole > 0 && ch === "}")
        hole -= 1;
      out.push(ch);
      j += 1;
    }
    return j;
  }
  function stripComments(s) {
    if (!s.includes("//") && !s.includes("/*"))
      return s;
    const c = Array.from(s);
    const out = [];
    let i = 0;
    let prevSig = null;
    while (i < c.length) {
      const ch = c[i];
      if (ch === "'" || ch === '"') {
        i = copyQuoted(c, i, out);
        prevSig = ch;
        continue;
      }
      if (ch === "`") {
        i = copyTemplate(c, i, out);
        prevSig = "`";
        continue;
      }
      if (ch === "/" && i + 1 < c.length && c[i + 1] === "/" && prevSig !== ":") {
        while (i < c.length && c[i] !== "\n")
          i += 1;
        continue;
      }
      if (ch === "/" && i + 1 < c.length && c[i + 1] === "*") {
        i += 2;
        while (i + 1 < c.length && !(c[i] === "*" && c[i + 1] === "/"))
          i += 1;
        i = Math.min(i + 2, c.length);
        out.push(" ");
        continue;
      }
      if (globalThis.__DSX_OPTIONAL_REGEX__ !== false && ch === "/" && (charAllowsRegex(prevSig) || prevSig !== null && isWordChar(prevSig) && regexAfterKeyword(out))) {
        const end = scanRegexEnd(c, i);
        if (end > 0) {
          for (let k = i; k < end; k++)
            out.push(c[k]);
          i = end;
          prevSig = c[end - 1];
          continue;
        }
      }
      out.push(ch);
      if (!/\s/.test(ch))
        prevSig = ch;
      i += 1;
    }
    return out.join("");
  }
  function decodeOperatorEntities(s) {
    if (!s.includes("&amp;") && !s.includes("&lt;") && !s.includes("&gt;"))
      return s;
    const c = Array.from(s);
    const out = [];
    let i = 0;
    let prevSig = null;
    while (i < c.length) {
      const ch = c[i];
      if (ch === "'" || ch === '"') {
        i = copyQuoted(c, i, out);
        prevSig = ch;
        continue;
      }
      if (ch === "`") {
        i = copyTemplate(c, i, out);
        prevSig = "`";
        continue;
      }
      if (globalThis.__DSX_OPTIONAL_REGEX__ !== false && ch === "/" && (charAllowsRegex(prevSig) || prevSig !== null && isWordChar(prevSig) && regexAfterKeyword(out))) {
        const end = scanRegexEnd(c, i);
        if (end > 0) {
          for (let k = i; k < end; k++)
            out.push(c[k]);
          i = end;
          prevSig = c[end - 1];
          continue;
        }
      }
      if (ch === "&") {
        const rest = c.slice(i + 1, i + 5).join("");
        const op = rest.startsWith("amp;") ? "&" : rest.startsWith("lt;") ? "<" : rest.startsWith("gt;") ? ">" : null;
        if (op !== null) {
          out.push(op);
          prevSig = op;
          i += op === "&" ? 5 : 4;
          continue;
        }
      }
      out.push(ch);
      if (!/\s/.test(ch))
        prevSig = ch;
      i += 1;
    }
    return out.join("");
  }
  function lineContinues(out, c, after) {
    let t = out.length - 1;
    while (t >= 0 && (out[t] === " " || out[t] === "	" || out[t] === "\r"))
      t -= 1;
    if (t >= 0) {
      const last = out[t];
      const isIncDec = (last === "+" || last === "-") && t >= 1 && out[t - 1] === last;
      if (!isIncDec && "+-*/%&|<>=!?:,.".includes(last))
        return true;
    }
    let j = after + 1;
    while (j < c.length && /\s/.test(c[j]))
      j += 1;
    if (j >= c.length)
      return false;
    const ch = c[j];
    if (ch === "." || ch === "?" || ch === ":")
      return true;
    if ((ch === "&" || ch === "|") && j + 1 < c.length && c[j + 1] === ch)
      return true;
    return false;
  }
  function nextWord(c, after) {
    let j = after + 1;
    while (j < c.length && /\s/.test(c[j]))
      j += 1;
    let w = "";
    while (j < c.length && isWordChar(c[j]) && w.length <= 8) {
      w += c[j];
      j += 1;
    }
    return w;
  }
  function braceOpensDo(out) {
    let t = out.length - 1;
    while (t >= 0 && /\s/.test(out[t]))
      t -= 1;
    if (t < 1 || out[t] !== "o" || out[t - 1] !== "d")
      return false;
    return t - 2 < 0 || !isWordChar(out[t - 2]);
  }
  function keywordJoinsBlock(c, after, prevSig, closedDo) {
    if (prevSig !== "}")
      return false;
    const w = nextWord(c, after);
    if (w === "else" || w === "catch" || w === "finally")
      return true;
    return w === "while" && closedDo;
  }
  function asiSemicolons(s) {
    if (!s.includes("\n"))
      return s;
    const c = Array.from(s);
    const out = [];
    const stack = [];
    let i = 0;
    let prevSig = null;
    let justClosedDo = false;
    while (i < c.length) {
      const ch = c[i];
      if (ch === "'" || ch === '"') {
        i = copyQuoted(c, i, out);
        prevSig = ch;
        justClosedDo = false;
        continue;
      }
      if (ch === "`") {
        i = copyTemplate(c, i, out);
        prevSig = "`";
        justClosedDo = false;
        continue;
      }
      if (globalThis.__DSX_OPTIONAL_REGEX__ !== false && ch === "/" && (charAllowsRegex(prevSig) || prevSig !== null && isWordChar(prevSig) && regexAfterKeyword(out))) {
        const end = scanRegexEnd(c, i);
        if (end > 0) {
          for (let k = i; k < end; k++)
            out.push(c[k]);
          prevSig = c[end - 1];
          justClosedDo = false;
          i = end;
          continue;
        }
      }
      let closesDo = false;
      if (ch === "(" || ch === "[" || ch === "{")
        stack.push(ch === "{" && braceOpensDo(out) ? "D" : ch);
      else if (ch === ")" || ch === "]" || ch === "}") {
        const p = stack.pop();
        closesDo = ch === "}" && p === "D";
      } else if (ch === "\n") {
        const innermost = stack.length > 0 ? stack[stack.length - 1] : null;
        if ((innermost === null || innermost === "{" || innermost === "D") && !lineContinues(out, c, i) && !keywordJoinsBlock(c, i, prevSig, justClosedDo)) {
          out.push(";");
          i += 1;
          continue;
        }
      }
      out.push(ch);
      if (!/\s/.test(ch)) {
        prevSig = ch;
        justClosedDo = closesDo;
      }
      i += 1;
    }
    return out.join("");
  }
  function preprocessSource(s) {
    const normalized = s.includes("\r") ? s.replace(/\r(?!\n)/g, "\n") : s;
    return asiSemicolons(stripComments(decodeOperatorEntities(normalized)));
  }
  function unescapeInto(str, c, j) {
    const e = c[j];
    switch (e) {
      case "n":
        str.push("\n");
        return j + 1;
      case "t":
        str.push("	");
        return j + 1;
      case "r":
        str.push("\r");
        return j + 1;
      case "b":
        str.push("\b");
        return j + 1;
      case "f":
        str.push("\f");
        return j + 1;
      case "v":
        str.push("\v");
        return j + 1;
      case "0":
        str.push("\0");
        return j + 1;
      case "\n":
        return j + 1;
      // line continuation
      case "x": {
        if (j + 2 < c.length && isHexDigit(c[j + 1]) && isHexDigit(c[j + 2])) {
          str.push(String.fromCharCode(parseInt(c[j + 1] + c[j + 2], 16)));
          return j + 3;
        }
        str.push(e);
        return j + 1;
      }
      case "u": {
        if (j + 1 < c.length && c[j + 1] === "{") {
          let k = j + 2;
          let hex = "";
          while (k < c.length && isHexDigit(c[k])) {
            hex += c[k];
            k += 1;
          }
          if (k < c.length && c[k] === "}" && hex.length >= 1 && hex.length <= 6) {
            const cp = parseInt(hex, 16);
            if (cp <= 1114111) {
              str.push(String.fromCodePoint(cp));
              return k + 1;
            }
          }
          str.push(e);
          return j + 1;
        }
        if (j + 4 < c.length && isHexDigit(c[j + 1]) && isHexDigit(c[j + 2]) && isHexDigit(c[j + 3]) && isHexDigit(c[j + 4])) {
          str.push(String.fromCharCode(parseInt(c.slice(j + 1, j + 5).join(""), 16)));
          return j + 5;
        }
        str.push(e);
        return j + 1;
      }
      default:
        str.push(e);
        return j + 1;
    }
  }
  function scanNumber(c, i) {
    const radix = (pfx, digit, base) => {
      if (!(c[i] === "0" && i + 1 < c.length && (c[i + 1] === pfx || c[i + 1] === pfx.toUpperCase())))
        return null;
      let j2 = i + 2;
      let any = false;
      let v = 0;
      while (j2 < c.length) {
        const ch = c[j2];
        if (digit(ch)) {
          v = v * base + parseInt(ch, base);
          any = true;
          j2 += 1;
          continue;
        }
        if (ch === "_" && any && j2 + 1 < c.length && digit(c[j2 + 1])) {
          j2 += 1;
          continue;
        }
        break;
      }
      if (!any)
        return null;
      return [v, j2];
    };
    const hex = radix("x", isHexDigit, 16);
    if (hex)
      return hex;
    const bin = radix("b", (ch) => ch === "0" || ch === "1", 2);
    if (bin)
      return bin;
    const oct = radix("o", (ch) => ch >= "0" && ch <= "7", 8);
    if (oct)
      return oct;
    let j = i;
    let n = "";
    let seenDot = false;
    while (j < c.length) {
      const ch = c[j];
      if (isDigit(ch)) {
        n += ch;
        j += 1;
        continue;
      }
      if (ch === "." && !seenDot && j + 1 < c.length && isDigit(c[j + 1])) {
        seenDot = true;
        n += ch;
        j += 1;
        continue;
      }
      if (ch === "." && !seenDot && n.length > 0) {
        seenDot = true;
        n += ch;
        j += 1;
        continue;
      }
      if (ch === "_" && n.length > 0 && isDigit(c[j - 1]) && j + 1 < c.length && isDigit(c[j + 1])) {
        j += 1;
        continue;
      }
      break;
    }
    if (j < c.length && (c[j] === "e" || c[j] === "E")) {
      let k = j + 1;
      if (k < c.length && (c[k] === "+" || c[k] === "-"))
        k += 1;
      if (k < c.length && isDigit(c[k])) {
        let exp = c[j];
        let m = j + 1;
        while (m < c.length && (isDigit(c[m]) || (c[m] === "+" || c[m] === "-") && m === j + 1)) {
          exp += c[m];
          m += 1;
        }
        n += exp;
        j = m;
      }
    }
    return [swiftDouble(n) ?? 0, j];
  }
  function tokenize(s) {
    return tokenizeRaw(preprocessSource(s));
  }
  function tokenizeRaw(s, holeDepth = 0) {
    const toks = [];
    const c = Array.from(s);
    let i = 0;
    while (i < c.length) {
      const ch = c[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch;
        i += 1;
        const str = [];
        while (i < c.length && c[i] !== q) {
          if (c[i] === "\\" && i + 1 < c.length) {
            i = unescapeInto(str, c, i + 1);
            continue;
          }
          str.push(c[i]);
          i += 1;
        }
        if (i < c.length)
          i += 1;
        toks.push({ kind: "str", v: str.join("") });
        continue;
      }
      if (ch === "`") {
        i += 1;
        const parts = [];
        let lit = [];
        while (i < c.length && c[i] !== "`") {
          if (c[i] === "\\" && i + 1 < c.length) {
            i = unescapeInto(lit, c, i + 1);
            continue;
          }
          if (c[i] === "$" && i + 1 < c.length && c[i + 1] === "{") {
            if (lit.length > 0) {
              parts.push({ s: lit.join("") });
              lit = [];
            }
            i += 2;
            let depth = 1;
            const src = [];
            while (i < c.length) {
              const hc = c[i];
              if (hc === "'" || hc === '"') {
                i = copyQuoted(c, i, src);
                continue;
              }
              if (hc === "`") {
                i = copyTemplate(c, i, src);
                continue;
              }
              if (hc === "{")
                depth += 1;
              else if (hc === "}") {
                depth -= 1;
                if (depth === 0) {
                  i += 1;
                  break;
                }
              }
              src.push(hc);
              i += 1;
            }
            if (holeDepth < 32)
              parts.push({ toks: tokenizeRaw(src.join(""), holeDepth + 1) });
            else
              parts.push({ s: src.join("") });
            continue;
          }
          lit.push(c[i]);
          i += 1;
        }
        if (i < c.length)
          i += 1;
        if (lit.length > 0)
          parts.push({ s: lit.join("") });
        toks.push({ kind: "template", parts });
        continue;
      }
      if (isDigit(ch) || ch === "." && i + 1 < c.length && isDigit(c[i + 1])) {
        const [v, next] = scanNumber(c, i);
        toks.push({ kind: "num", v });
        i = next;
        continue;
      }
      if (isLetter(ch) || ch === "_") {
        let id = "";
        while (i < c.length && (isLetter(c[i]) || isDigit(c[i]) || c[i] === "_" || c[i] === ".")) {
          id += c[i];
          i += 1;
        }
        toks.push({ kind: "ident", v: id });
        continue;
      }
      if (globalThis.__DSX_OPTIONAL_REGEX__ !== false && ch === "/") {
        const last = toks.length > 0 ? toks[toks.length - 1] : null;
        const prevAllowsRegex = last === null || last.kind === "op" && last.v !== ")" && last.v !== "]" && last.v !== "++" && last.v !== "--" || last.kind === "ident" && regexKeywords.has(last.v);
        if (prevAllowsRegex && i + 1 < c.length && c[i + 1] !== "/" && c[i + 1] !== "*") {
          let j = i + 1;
          let pat = "";
          let inClass = false;
          let closed = false;
          while (j < c.length) {
            const rc = c[j];
            if (rc === "\\" && j + 1 < c.length) {
              pat += rc + c[j + 1];
              j += 2;
              continue;
            }
            if (rc === "[")
              inClass = true;
            if (rc === "]")
              inClass = false;
            if (rc === "/" && !inClass) {
              closed = true;
              j += 1;
              break;
            }
            if (rc === "\n")
              break;
            pat += rc;
            j += 1;
          }
          if (closed && pat.length > 0) {
            let flags = "";
            while (j < c.length && isLetter(c[j])) {
              flags += c[j];
              j += 1;
            }
            toks.push({ kind: "regex", pattern: pat, flags });
            i = j;
            continue;
          }
        }
      }
      const three = c.slice(i, i + 3).join("");
      if (three.length === 3 && threeCharOps.includes(three)) {
        toks.push({ kind: "op", v: three });
        i += 3;
        continue;
      }
      const two = c.slice(i, i + 2).join("");
      if (two.length === 2 && twoCharOps.includes(two)) {
        if (two === "?." && i + 2 < c.length && isDigit(c[i + 2])) {
          toks.push({ kind: "op", v: "?" });
          i += 1;
          continue;
        }
        toks.push({ kind: "op", v: two });
        i += 2;
        continue;
      }
      toks.push({ kind: "op", v: ch });
      i += 1;
    }
    return toks;
  }
  var tokenCache = /* @__PURE__ */ new Map();
  function cachedTokens(s) {
    const hit = tokenCache.get(s);
    if (hit)
      return hit;
    const toks = tokenize(s);
    if (tokenCache.size > 512)
      tokenCache.clear();
    tokenCache.set(s, toks);
    return toks;
  }

  // packages/kernel/dist/jse/highlight.js
  var KEYWORDS = /* @__PURE__ */ new Set([
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "break",
    "continue",
    "switch",
    "case",
    "default",
    "try",
    "catch",
    "finally",
    "throw",
    "new",
    "typeof",
    "instanceof",
    "in",
    "of",
    "delete",
    "void",
    "await",
    "async",
    "yield",
    "this"
  ]);
  var LITERALS = /* @__PURE__ */ new Set(["true", "false", "null", "undefined"]);
  var PUNCT = /* @__PURE__ */ new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);
  var OPERATOR = new Set("+-*/%=<>!&|^~?:.".split(""));
  function isDigit2(c) {
    return c >= "0" && c <= "9";
  }
  function isWordStart(c) {
    return /[\p{L}_$]/u.test(c);
  }
  function isWordChar2(c) {
    return /[\p{L}\p{N}_$]/u.test(c);
  }
  function opensRegex(src, at) {
    let i = at - 1;
    while (i >= 0 && /\s/.test(src[i]))
      i--;
    if (i < 0)
      return true;
    const prev = src[i];
    if (prev === ")" || prev === "]" || prev === "'" || prev === '"' || prev === "`")
      return false;
    if (!isWordChar2(prev))
      return true;
    let j = i;
    while (j >= 0 && isWordChar2(src[j]))
      j--;
    const word = src.slice(j + 1, i + 1);
    return KEYWORDS.has(word) && word !== "this";
  }
  function endOfRegex(src, at) {
    let i = at + 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i = Math.min(i + 2, src.length);
        continue;
      }
      if (c === "\n")
        return i;
      if (c === "[") {
        inClass = true;
        i++;
        continue;
      }
      if (c === "]") {
        inClass = false;
        i++;
        continue;
      }
      if (c === "/" && !inClass) {
        i++;
        break;
      }
      i++;
    }
    while (i < src.length && /[a-z]/.test(src[i]))
      i++;
    return i;
  }
  function endOfNumber(src, at) {
    let i = at;
    if (src[i] === "0" && i + 1 < src.length && /[xXbBoO]/.test(src[i + 1])) {
      i += 2;
      while (i < src.length && /[0-9a-fA-F_]/.test(src[i]))
        i++;
      return i;
    }
    while (i < src.length && (isDigit2(src[i]) || src[i] === "_"))
      i++;
    if (src[i] === "." && isDigit2(src[i + 1] ?? "")) {
      i++;
      while (i < src.length && (isDigit2(src[i]) || src[i] === "_"))
        i++;
    }
    if (i < src.length && (src[i] === "e" || src[i] === "E")) {
      let k = i + 1;
      if (src[k] === "+" || src[k] === "-")
        k++;
      if (isDigit2(src[k] ?? "")) {
        k++;
        while (k < src.length && isDigit2(src[k]))
          k++;
        i = k;
      }
    }
    return i;
  }
  function highlight(source) {
    const out = [];
    const push = (start, end, kind) => {
      if (end <= start)
        return;
      const last = out[out.length - 1];
      if (last !== void 0 && last.kind === kind && last.end === start) {
        last.end = end;
        return;
      }
      out.push({ start, end, kind });
    };
    const holes = [];
    let depth = 0;
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) {
        const s = i;
        while (i < source.length && /\s/.test(source[i]))
          i++;
        push(s, i, "plain");
        continue;
      }
      if (c === "/" && source[i + 1] === "/") {
        const s = i;
        while (i < source.length && source[i] !== "\n")
          i++;
        push(s, i, "comment");
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const s = i;
        const close = source.indexOf("*/", i + 2);
        i = close < 0 ? source.length : close + 2;
        push(s, i, "comment");
        continue;
      }
      if (c === "/" && opensRegex(source, i)) {
        const s = i;
        i = endOfRegex(source, i);
        push(s, i, "regex");
        continue;
      }
      if (c === "'" || c === '"') {
        const s = i;
        const quote = c;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i = Math.min(i + 2, source.length);
            continue;
          }
          if (source[i] === quote) {
            i++;
            break;
          }
          if (source[i] === "\n")
            break;
          i++;
        }
        push(s, i, "string");
        continue;
      }
      if (c === "`") {
        const s = i;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i = Math.min(i + 2, source.length);
            continue;
          }
          if (source[i] === "`") {
            i++;
            break;
          }
          if (source[i] === "$" && source[i + 1] === "{")
            break;
          i++;
        }
        push(s, i, "string");
        if (source[i] === "$" && source[i + 1] === "{") {
          push(i, i + 2, "operator");
          i += 2;
          holes.push(depth);
          depth = 0;
        }
        continue;
      }
      if (isDigit2(c) || c === "." && isDigit2(source[i + 1] ?? "")) {
        const s = i;
        i = endOfNumber(source, i);
        push(s, i, "number");
        continue;
      }
      if (isWordStart(c)) {
        const s = i;
        while (i < source.length && isWordChar2(source[i]))
          i++;
        const word = source.slice(s, i);
        let j = i;
        while (j < source.length && /[ \t]/.test(source[j]))
          j++;
        let k = s - 1;
        while (k >= 0 && /[ \t]/.test(source[k]))
          k--;
        const kind = KEYWORDS.has(word) ? "keyword" : LITERALS.has(word) ? "literal" : source[j] === "(" ? "call" : k >= 0 && source[k] === "." && source[k - 1] !== "." ? "property" : "ident";
        push(s, i, kind);
        continue;
      }
      if (c === "}" && holes.length > 0 && depth === 0) {
        push(i, i + 1, "operator");
        i++;
        depth = holes.pop();
        const s = i;
        while (i < source.length) {
          if (source[i] === "\\") {
            i = Math.min(i + 2, source.length);
            continue;
          }
          if (source[i] === "`") {
            i++;
            break;
          }
          if (source[i] === "$" && source[i + 1] === "{")
            break;
          i++;
        }
        push(s, i, "string");
        if (source[i] === "$" && source[i + 1] === "{") {
          push(i, i + 2, "operator");
          i += 2;
          holes.push(depth);
          depth = 0;
        }
        continue;
      }
      if (PUNCT.has(c)) {
        if (c === "{" || c === "[" || c === "(")
          depth++;
        else if (c === "}" || c === "]" || c === ")")
          depth = Math.max(0, depth - 1);
        push(i, i + 1, "punct");
        i++;
        continue;
      }
      if (OPERATOR.has(c)) {
        const s = i;
        while (i < source.length && OPERATOR.has(source[i]))
          i++;
        push(s, i, "operator");
        continue;
      }
      push(i, i + 1, "plain");
      i++;
    }
    return out;
  }
  function highlightLines(source) {
    const out = [{ line: 1, spans: [] }];
    for (const tok of highlight(source)) {
      const parts = source.slice(tok.start, tok.end).split("\n");
      for (const [i, part] of parts.entries()) {
        if (i > 0)
          out.push({ line: out.length + 1, spans: [] });
        if (part === "")
          continue;
        const row = out[out.length - 1];
        const last = row.spans[row.spans.length - 1];
        if (last !== void 0 && last.kind === tok.kind) {
          last.text += part;
          continue;
        }
        row.spans.push({ text: part, kind: tok.kind });
      }
    }
    return out;
  }

  // packages/kernel/dist/jse/regex.js
  var cache = /* @__PURE__ */ new Map();
  function unboundedQuantAt(source, i) {
    const ch = source[i];
    if (ch === "*" || ch === "+")
      return source[i + 1] === "?" ? i + 2 : i + 1;
    if (ch === "{") {
      const close = source.indexOf("}", i);
      if (close < 0)
        return -1;
      if (/^\d+,$/.test(source.substring(i + 1, close)))
        return source[close + 1] === "?" ? close + 2 : close + 1;
    }
    return -1;
  }
  function reDoSProne(source) {
    const bodyUnbounded = [];
    let inClass = false;
    let i = 0;
    const n = source.length;
    while (i < n) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (inClass) {
        if (ch === "]")
          inClass = false;
        i += 1;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        i += 1;
        continue;
      }
      if (ch === "(") {
        bodyUnbounded.push(false);
        i += 1;
        continue;
      }
      if (ch === ")") {
        const inner = bodyUnbounded.pop() ?? false;
        const q2 = unboundedQuantAt(source, i + 1);
        if (q2 >= 0) {
          if (inner)
            return true;
          if (bodyUnbounded.length > 0)
            bodyUnbounded[bodyUnbounded.length - 1] = true;
          i = q2;
          continue;
        }
        i += 1;
        continue;
      }
      const q = unboundedQuantAt(source, i);
      if (q >= 0) {
        if (bodyUnbounded.length > 0)
          bodyUnbounded[bodyUnbounded.length - 1] = true;
        i = q;
        continue;
      }
      i += 1;
    }
    return false;
  }
  function compiled(v) {
    if (!isDict(v))
      return null;
    const d = v;
    if (!d["__regex"])
      return null;
    const pattern = string(d["source"]);
    const flags = string(d["flags"]);
    const key = flags + "" + pattern;
    const hit = cache.get(key);
    if (hit)
      return hit;
    if (reDoSProne(pattern)) {
      console.warn(`[JSE regex] rejected a potentially-catastrophic pattern (nested unbounded quantifier): /${pattern}/${flags}`);
      return null;
    }
    let opts = "";
    if (flags.includes("i"))
      opts += "i";
    if (flags.includes("m"))
      opts += "m";
    if (flags.includes("s"))
      opts += "s";
    if (flags.includes("u"))
      opts += "u";
    let re;
    try {
      re = new RegExp(pattern, opts + "g");
    } catch {
      console.warn(`[JSE regex] invalid pattern: /${pattern}/${flags}`);
      return null;
    }
    const c = { re, global: flags.includes("g") };
    if (cache.size > 128)
      cache.clear();
    cache.set(key, c);
    return c;
  }
  function findAll(re, s) {
    re.lastIndex = 0;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      out.push(m);
      if (m[0].length === 0)
        re.lastIndex += 1;
    }
    return out;
  }
  var JSE_REGEX_FULL = {
    test(s, regex) {
      const c = compiled(regex);
      if (!c)
        return false;
      c.re.lastIndex = 0;
      return c.re.test(s);
    },
    match(s, regex) {
      const c = compiled(regex);
      if (!c)
        return null;
      const all = findAll(c.re, s);
      if (c.global) {
        if (all.length === 0)
          return null;
        return all.map((m2) => m2[0]);
      }
      const m = all[0];
      if (!m)
        return null;
      const out = [];
      for (let i = 0; i < m.length; i++)
        out.push(m[i] ?? NSNull);
      return out;
    },
    /** Every match as a match ARRAY ([full, g1, …] — unmatched group → NSNull), always
     *  global semantics (the JS matchAll contract; the `g` flag is implied). */
    matchAll(s, regex) {
      const c = compiled(regex);
      if (!c)
        return [];
      return findAll(c.re, s).map((m) => {
        const out = [];
        for (let i = 0; i < m.length; i++)
          out.push(m[i] ?? NSNull);
        return out;
      });
    },
    search(s, regex) {
      const c = compiled(regex);
      if (!c)
        return -1;
      c.re.lastIndex = 0;
      const m = c.re.exec(s);
      return m ? m.index : -1;
    },
    replace(s, pattern, template, all) {
      const c = compiled(pattern);
      if (c) {
        let out = "";
        let last = 0;
        for (const m of findAll(c.re, s)) {
          out += s.substring(last, m.index) + expand(template, m);
          last = m.index + m[0].length;
          if (!(all || c.global))
            break;
        }
        out += s.substring(last);
        return out;
      }
      const find = string(pattern);
      if (find.length === 0)
        return s;
      if (all)
        return s.split(find).join(template);
      const r = s.indexOf(find);
      if (r < 0)
        return s;
      return s.substring(0, r) + template + s.substring(r + find.length);
    },
    split(s, pattern, limit) {
      let parts;
      const c = compiled(pattern);
      if (c) {
        const out = [];
        let start = 0;
        for (const m of findAll(c.re, s)) {
          out.push(s.substring(start, m.index));
          start = m.index + m[0].length;
        }
        out.push(s.substring(start));
        parts = out;
      } else {
        const sep = string(pattern);
        parts = sep.length === 0 ? graphemes(s) : s.split(sep);
      }
      if (limit > 0 && parts.length > limit)
        parts = parts.slice(0, limit);
      return parts;
    }
  };
  var JSE_REGEX_ABSENT = {
    test: () => false,
    match: () => null,
    matchAll: () => [],
    search: () => -1,
    replace(s, pattern, template, all) {
      const find = string(pattern);
      if (find.length === 0)
        return s;
      if (all)
        return s.split(find).join(template);
      const r = s.indexOf(find);
      if (r < 0)
        return s;
      return s.substring(0, r) + template + s.substring(r + find.length);
    },
    split(s, pattern, limit) {
      const sep = string(pattern);
      let parts = sep.length === 0 ? graphemes(s) : s.split(sep);
      if (limit > 0 && parts.length > limit)
        parts = parts.slice(0, limit);
      return parts;
    }
  };
  var JSERegex = globalThis.__DSX_OPTIONAL_REGEX__ !== false ? JSE_REGEX_FULL : JSE_REGEX_ABSENT;
  function expand(template, m) {
    const groupCount = m.length - 1;
    let out = "";
    let i = 0;
    while (i < template.length) {
      const ch = template[i];
      if (ch === "\\" && i + 1 < template.length) {
        out += template[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && i + 1 < template.length && template[i + 1] >= "0" && template[i + 1] <= "9") {
        let j = i + 1;
        let g = template.charCodeAt(j) - 48;
        j += 1;
        while (j < template.length && template[j] >= "0" && template[j] <= "9") {
          const cand = g * 10 + (template.charCodeAt(j) - 48);
          if (cand > groupCount)
            break;
          g = cand;
          j += 1;
        }
        if (g <= groupCount)
          out += m[g] ?? "";
        i = j;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  // packages/kernel/dist/jse/pathmatch.js
  function normalize(s) {
    const q = s.indexOf("?");
    const h = s.indexOf("#");
    const cut = q >= 0 && h >= 0 ? Math.min(q, h) : q >= 0 ? q : h;
    return cut >= 0 ? s.substring(0, cut) : s;
  }
  function segments(s) {
    return s.split("/").filter((x) => x.length > 0);
  }
  var DSXPathMatch = {
    /** Match a concrete path against a route pattern. Returns the extracted params
     *  (empty object when there are none) on a match, or `null` on no match. */
    match(path, pattern) {
      const p = normalize(path);
      const pat = normalize(pattern);
      if (pat === "*" || pat === "/*" || pat.length === 0)
        return {};
      const ps = segments(p);
      const pats = segments(pat);
      const params = {};
      let i = 0;
      while (i < pats.length) {
        const seg = pats[i];
        if (seg === "*") {
          if (i === pats.length - 1)
            return params;
          if (i >= ps.length)
            return null;
          i += 1;
          continue;
        }
        if (i >= ps.length)
          return null;
        if (seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}")) {
          params[seg.substring(1, seg.length - 1)] = ps[i];
        } else if (seg.startsWith(":")) {
          params[seg.substring(1)] = ps[i];
        } else if (seg !== ps[i]) {
          return null;
        }
        i += 1;
      }
      return ps.length === pats.length ? params : null;
    },
    /** Boolean convenience — backs the `matches(path, pattern)` expression helper. */
    matches(path, pattern) {
      return DSXPathMatch.match(path, pattern) !== null;
    }
  };

  // packages/kernel/dist/logs.js
  var DSXLogBufferImpl = class _DSXLogBufferImpl {
    static cap = 500;
    entries = [];
    total = 0;
    append(e) {
      this.entries.push(e);
      this.total += 1;
      if (this.entries.length > _DSXLogBufferImpl.cap) {
        this.entries.splice(0, this.entries.length - _DSXLogBufferImpl.cap);
      }
    }
    /** the retained tail, oldest → newest (snapshot) */
    recent() {
      return [...this.entries];
    }
    /** monotonic count of every line ever recorded (survives ring eviction) */
    count() {
      return this.total;
    }
    /** dev tooling only — drops the retained tail (the monotonic count stays) */
    clear() {
      this.entries = [];
    }
  };
  var DSXLogs = new DSXLogBufferImpl();
  var JSERedact = {
    sensitive: [
      "token",
      "secret",
      "password",
      "passwd",
      "authorization",
      "cookie",
      "apikey",
      "api_key",
      "api-key",
      "bearer",
      "credential",
      "session_id",
      "sessionid",
      "private_key",
      "privatekey"
    ],
    isSensitive(key) {
      const k = key.toLowerCase();
      return this.sensitive.some((s) => k === s || k.endsWith("_" + s) || k.endsWith(s) && s.length > 5);
    },
    mask(v) {
      if (Array.isArray(v))
        return v.map((e) => this.mask(e));
      if (isDict(v)) {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          out[k] = this.isSensitive(k) ? "\u2022\u2022\u2022" : this.mask(val);
        }
        return out;
      }
      return v;
    }
  };

  // packages/kernel/dist/jse/core.js
  function formatLogValue(x) {
    if (isDict(x) || Array.isArray(x)) {
      return jsonStringify(JSERedact.mask(x), null) ?? string(x);
    }
    return string(x);
  }
  function formatLogArgs(a) {
    return a.map((x) => formatLogValue(x)).join(" ");
  }
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function pad3(n) {
    return String(n).padStart(3, "0");
  }
  function dateShape(ms) {
    return { __date: ms };
  }
  function isDateShape(d) {
    return typeof d["__date"] === "number";
  }
  function dateOf(d) {
    const ms = d["__date"];
    return new Date(Number.isNaN(ms) ? 0 : ms);
  }
  function dateSet(ms, m, a) {
    const nn = (i) => i < a.length ? number(a[i]) : null;
    if (m === "setTime")
      return nn(0) ?? 0;
    const dt = new Date(ms);
    switch (m) {
      case "setFullYear":
        dt.setFullYear(nn(0) ?? dt.getFullYear(), nn(1) ?? dt.getMonth(), nn(2) ?? dt.getDate());
        break;
      case "setMonth":
        dt.setMonth(nn(0) ?? dt.getMonth(), nn(1) ?? dt.getDate());
        break;
      case "setDate":
        dt.setDate(nn(0) ?? dt.getDate());
        break;
      case "setHours":
        dt.setHours(nn(0) ?? dt.getHours(), nn(1) ?? dt.getMinutes(), nn(2) ?? dt.getSeconds(), nn(3) ?? dt.getMilliseconds());
        break;
      case "setMinutes":
        dt.setMinutes(nn(0) ?? dt.getMinutes(), nn(1) ?? dt.getSeconds(), nn(2) ?? dt.getMilliseconds());
        break;
      case "setSeconds":
        dt.setSeconds(nn(0) ?? dt.getSeconds(), nn(1) ?? dt.getMilliseconds());
        break;
      case "setMilliseconds":
        dt.setMilliseconds(nn(0) ?? dt.getMilliseconds());
        break;
    }
    return dt.getTime();
  }
  function toISO(ms) {
    if (Number.isNaN(ms))
      return "";
    const d = new Date(ms);
    return d.getUTCFullYear().toString().padStart(4, "0") + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + "." + pad3(d.getUTCMilliseconds()) + "Z";
  }
  function formEncode(s) {
    return encodeURIComponent(s).replace(/%20/g, "+");
  }
  function paramsToString(pairs) {
    return pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
  }
  function parseQuery(q) {
    const out = [];
    for (const part of q.replace(/^\?/, "").split("&")) {
      if (part.length === 0)
        continue;
      const eq = part.indexOf("=");
      const k = eq >= 0 ? part.substring(0, eq) : part;
      const v = eq >= 0 ? part.substring(eq + 1) : "";
      const dec = (x) => {
        try {
          return decodeURIComponent(x.replace(/\+/g, " "));
        } catch {
          return x;
        }
      };
      out.push([dec(k), dec(v)]);
    }
    return out;
  }
  function paramsShape(pairs) {
    return { __params: pairs.map(([k, v]) => [k, v]) };
  }
  function paramsPairs(d) {
    const raw = d["__params"];
    if (!Array.isArray(raw))
      return [];
    return raw.map((p) => [string(p[0]), string(p[1])]);
  }
  function makeURL(href, base) {
    if (/[\s\x00-\x1f]/.test(href))
      return null;
    let u;
    try {
      u = base !== void 0 ? new URL(href, base) : new URL(href);
    } catch {
      return null;
    }
    return {
      __url: true,
      href: u.href,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      host: u.host,
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      searchParams: paramsShape(parseQuery(u.search))
    };
  }
  var MAX_JSE_JSON_BYTES = 4 * 1024 * 1024;
  var MAX_JSE_JSON_NODES = 25e4;
  var MAX_JSE_JSON_DEPTH = 128;
  function boundedUtf8Bytes(value, limit) {
    let bytes = 0;
    for (let index2 = 0; index2 < value.length; index2 += 1) {
      const code = value.charCodeAt(index2);
      if (code <= 127)
        bytes += 1;
      else if (code <= 2047)
        bytes += 2;
      else if (code >= 55296 && code <= 56319) {
        const low = value.charCodeAt(index2 + 1);
        if (low >= 56320 && low <= 57343) {
          bytes += 4;
          index2 += 1;
        } else
          bytes += 3;
      } else
        bytes += 3;
      if (bytes > limit)
        return bytes;
    }
    return bytes;
  }
  function escapedJsonBytes(value, limit) {
    let bytes = 2;
    for (let index2 = 0; index2 < value.length; index2 += 1) {
      const code = value.charCodeAt(index2);
      if (code === 34 || code === 92 || code === 47)
        bytes += 2;
      else if (code <= 31)
        bytes += 6;
      else if (code <= 127)
        bytes += 1;
      else if (code <= 2047)
        bytes += 2;
      else if (code >= 55296 && code <= 56319) {
        const low = value.charCodeAt(index2 + 1);
        if (low >= 56320 && low <= 57343) {
          bytes += 4;
          index2 += 1;
        } else
          bytes += 6;
      } else if (code >= 56320 && code <= 57343)
        bytes += 6;
      else
        bytes += 3;
      if (bytes > limit)
        return bytes;
    }
    return bytes;
  }
  function jsonStringifyAllowed(value, indent) {
    const stack = [{ value, depth: 0 }];
    const ancestors = /* @__PURE__ */ new Set();
    let nodes = 0;
    let bytes = 0;
    const add = (count) => {
      bytes += count;
      return bytes <= MAX_JSE_JSON_BYTES;
    };
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.exit !== void 0) {
        ancestors.delete(frame.exit);
        continue;
      }
      nodes += 1;
      if (nodes > MAX_JSE_JSON_NODES || frame.depth > MAX_JSE_JSON_DEPTH)
        return false;
      const next = frame.value;
      if (next === null || next === void 0 || next === NSNull || isLambda(next)) {
        if (!add(4))
          return false;
      } else if (typeof next === "boolean") {
        if (!add(next ? 4 : 5))
          return false;
      } else if (typeof next === "number") {
        if (!add(Number.isFinite(next) ? String(next).length : 4))
          return false;
      } else if (typeof next === "string") {
        const cost = escapedJsonBytes(next, MAX_JSE_JSON_BYTES - bytes);
        if (!add(cost))
          return false;
      } else if (Array.isArray(next)) {
        if (ancestors.has(next))
          return false;
        ancestors.add(next);
        const count = next.length;
        if (indent === 0) {
          if (!add(2 + Math.max(0, count - 1)))
            return false;
        } else if (!add(count === 0 ? 2 : 4 + count * indent * (frame.depth + 1) + (count - 1) * 2 + indent * frame.depth))
          return false;
        stack.push({ depth: frame.depth, exit: next });
        for (let index2 = count - 1; index2 >= 0; index2 -= 1) {
          stack.push({ value: next[index2], depth: frame.depth + 1 });
        }
      } else if (isDict(next)) {
        if (ancestors.has(next))
          return false;
        ancestors.add(next);
        const entries = Object.entries(next);
        const count = entries.length;
        if (indent === 0) {
          if (!add(2 + Math.max(0, count - 1)))
            return false;
        } else if (!add(count === 0 ? 2 : 4 + count * indent * (frame.depth + 1) + (count - 1) * 2 + indent * frame.depth))
          return false;
        stack.push({ depth: frame.depth, exit: next });
        for (let index2 = count - 1; index2 >= 0; index2 -= 1) {
          const [key, entryValue] = entries[index2];
          const keyCost = escapedJsonBytes(key, MAX_JSE_JSON_BYTES - bytes);
          if (!add(keyCost + (indent > 0 ? 2 : 1)))
            return false;
          stack.push({ value: entryValue, depth: frame.depth + 1 });
        }
      } else {
        const cost = escapedJsonBytes(String(next), MAX_JSE_JSON_BYTES - bytes);
        if (!add(cost))
          return false;
      }
    }
    return true;
  }
  function jsonStringify(v, space) {
    const indent = typeof space === "number" ? Math.max(0, Math.min(10, Math.trunc(space))) : 0;
    if (!jsonStringifyAllowed(v, indent))
      return null;
    const enc = (x, depth) => {
      if (x === null || x === void 0 || x === NSNull)
        return "null";
      if (typeof x === "boolean")
        return x ? "true" : "false";
      if (typeof x === "number") {
        if (!Number.isFinite(x))
          return "null";
        if (Math.floor(x) === x && Math.abs(x) < 1e15)
          return String(x);
        return String(x);
      }
      if (typeof x === "string") {
        return JSON.stringify(x).replace(/\//g, "\\/");
      }
      if (Array.isArray(x)) {
        const parts = x.map((e) => enc(e, depth + 1) ?? "null");
        if (indent === 0)
          return "[" + parts.join(",") + "]";
        const pad = " ".repeat(indent * (depth + 1));
        const end = " ".repeat(indent * depth);
        return parts.length === 0 ? "[]" : "[\n" + parts.map((p) => pad + p).join(",\n") + "\n" + end + "]";
      }
      if (isDict(x)) {
        const d = x;
        const keys = Object.keys(d);
        const parts = keys.map((k) => {
          const kk = JSON.stringify(k).replace(/\//g, "\\/");
          return `${kk}:${indent > 0 ? " " : ""}${enc(d[k], depth + 1) ?? "null"}`;
        });
        if (indent === 0)
          return "{" + parts.join(",") + "}";
        const pad = " ".repeat(indent * (depth + 1));
        const end = " ".repeat(indent * depth);
        return parts.length === 0 ? "{}" : "{\n" + parts.map((p) => pad + p).join(",\n") + "\n" + end + "}";
      }
      if (isLambda(x))
        return null;
      return JSON.stringify(String(x));
    };
    return enc(v, 0);
  }
  function jsonParse(s) {
    if (s.length > MAX_JSE_JSON_BYTES || boundedUtf8Bytes(s, MAX_JSE_JSON_BYTES) > MAX_JSE_JSON_BYTES)
      return null;
    try {
      const raw = JSON.parse(s);
      let nodes = 0;
      const map = (x, depth) => {
        nodes += 1;
        if (nodes > MAX_JSE_JSON_NODES || depth > MAX_JSE_JSON_DEPTH)
          throw new Error("json_too_complex");
        if (x === null)
          return NSNull;
        if (Array.isArray(x))
          return x.map((entry) => map(entry, depth + 1));
        if (typeof x === "object") {
          const out = {};
          for (const [k, v] of Object.entries(x)) {
            Object.defineProperty(out, k, {
              value: map(v, depth + 1),
              enumerable: true,
              configurable: true,
              writable: true
            });
          }
          return out;
        }
        return x;
      };
      return map(raw, 0);
    } catch {
      return null;
    }
  }
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function base64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64[b0 >> 2] + B64[(b0 & 3) << 4 | b1 >> 4];
      out += i + 1 < bytes.length ? B64[(b1 & 15) << 2 | b2 >> 6] : "=";
      out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
    }
    return out;
  }
  function base64Decode(s) {
    const clean = s.replace(/[\r\n\s]/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1)
      return null;
    const body = clean.replace(/=+$/, "");
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (const c of body) {
      buffer = buffer << 6 | B64.indexOf(c);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push(buffer >> bits & 255);
      }
    }
    return new Uint8Array(out);
  }
  var JSE_CRYPTO_FULL = {
    /** BufferSource coercion: a JSE number array (bytes), a String (UTF-8). */
    data(v) {
      if (Array.isArray(v)) {
        const d = new Uint8Array(v.length);
        for (let i = 0; i < v.length; i++) {
          const n = number(v[i]);
          if (n === null)
            return null;
          d[i] = safeInt(n) & 255;
        }
        return d;
      }
      if (typeof v === "string")
        return new TextEncoder().encode(v);
      return null;
    },
    /** Uint8Array → the JSE byte array ([number] 0–255) every result travels as. */
    bytes(d) {
      return Array.from(d, (b) => b);
    },
    base64(d) {
      return base64Encode(d);
    },
    call(name, a) {
      switch (name) {
        case "Uint8Array": {
          const arg = a[0];
          const n = number(arg);
          if (n !== null && !Array.isArray(arg))
            return new Array(Math.max(0, Math.min(safeInt(n), 1e7))).fill(0);
          const d = JSECrypto.data(arg);
          return d ? JSECrypto.bytes(d) : [];
        }
        case "TextEncoder":
          return { __textEncoder: true };
        case "TextDecoder":
          return { __textDecoder: true };
        case "Array.from": {
          const d = JSECrypto.data(a[0]);
          return d ? JSECrypto.bytes(d) : [];
        }
        case "btoa": {
          const s = string(a[0]);
          const bytes = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++)
            bytes[i] = s.charCodeAt(i) & 255;
          return base64Encode(bytes);
        }
        case "atob": {
          const d = base64Decode(string(a[0]));
          if (!d)
            return null;
          let out = "";
          for (const b of d)
            out += String.fromCharCode(b);
          return out;
        }
        case "crypto.randomUUID":
          return globalThis.crypto?.randomUUID?.() ?? null;
        case "crypto.getRandomValues": {
          const len = Array.isArray(a[0]) ? a[0].length : safeInt(number(a[0]) ?? 0);
          const buf = new Uint8Array(Math.max(0, Math.min(len, 65536)));
          globalThis.crypto?.getRandomValues?.(buf);
          return JSECrypto.bytes(buf);
        }
        default:
          if (name.startsWith("crypto.subtle.")) {
            return subtleCall(name.substring("crypto.subtle.".length), a);
          }
          console.warn(`[JSE crypto] unsupported: ${name}`);
          return null;
      }
    }
  };
  var JSE_CRYPTO_ABSENT = {
    data: () => null,
    bytes: () => [],
    base64: () => "",
    call: () => null
  };
  var JSECrypto = globalThis.__DSX_OPTIONAL_JS_GLOBALS__ !== false ? JSE_CRYPTO_FULL : JSE_CRYPTO_ABSENT;
  function subtleCall(method, a) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
      return null;
    if (method === "digest") {
      const alg = string(a[0]);
      const d = JSECrypto.data(a[1]);
      if (!d)
        return null;
      return subtle.digest(alg, d).then((buf) => JSECrypto.bytes(new Uint8Array(buf)));
    }
    console.warn(`[JSE crypto] subtle.${method} pending on this runtime`);
    return null;
  }
  var JSE_CORE_FULL = {
    handles(name) {
      if (name.startsWith("Math.") || name.startsWith("Intl.") || name.startsWith("JSON.") || name.startsWith("Date.") || name.startsWith("Promise.") || name.startsWith("Object.") || name.startsWith("console.") || name.startsWith("performance."))
        return true;
      switch (name) {
        case "URL":
        case "URLSearchParams":
        case "Headers":
        case "Request":
        case "Blob":
        case "File":
        case "FormData":
        case "Date":
        case "AbortController":
        case "structuredClone":
        case "encodeURIComponent":
        case "decodeURIComponent":
        case "encodeURI":
        case "decodeURI":
        case "parseInt":
        case "parseFloat":
        case "isNaN":
        case "isFinite":
        case "Number":
        case "String":
        case "Boolean":
        case "Map":
        case "Set":
        case "Error":
        case "RegExp":
        case "WebSocket":
          return true;
        default:
          return false;
      }
    },
    call(name, a) {
      if (name.startsWith("Math."))
        return coreMath(name.substring(5), a);
      if (name.startsWith("JSON.")) {
        if (name === "JSON.stringify")
          return jsonStringify(a[0], number(a[2]) ?? (typeof a[1] === "number" ? a[1] : null));
        if (name === "JSON.parse")
          return jsonParse(string(a[0]));
        return null;
      }
      if (name.startsWith("Object.")) {
        const fn = name.substring(7);
        const d = isDict(a[0]) ? a[0] : null;
        switch (fn) {
          case "keys":
            return d ? Object.keys(d) : [];
          case "values":
            return d ? Object.values(d) : [];
          case "entries":
            return d ? Object.entries(d).map(([k, v]) => [k, v]) : [];
          case "assign": {
            const out = {};
            for (const arg of a)
              if (isDict(arg))
                Object.assign(out, arg);
            return out;
          }
          case "hasOwn": {
            const o = a[0];
            return isDict(o) ? Object.prototype.hasOwnProperty.call(o, string(a[1])) : false;
          }
          case "fromEntries": {
            const out = {};
            for (const e of a[0] && Array.isArray(a[0]) ? a[0] : []) {
              if (Array.isArray(e) && e.length >= 1)
                out[string(e[0])] = e.length > 1 ? e[1] : NSNull;
            }
            return out;
          }
          default:
            return null;
        }
      }
      if (name.startsWith("console.")) {
        const level = name.substring(8);
        const msg = formatLogArgs(a);
        DSXLogs.append({ scheme: "console", level, message: msg, at: Date.now() });
        if (level === "error")
          console.error("[dsx]", msg);
        else if (level === "warn")
          console.warn("[dsx]", msg);
        else
          console.log("[dsx]", msg);
        return null;
      }
      if (name.startsWith("performance.")) {
        if (name === "performance.now")
          return globalThis.performance?.now?.() ?? Date.now();
        return null;
      }
      if (name.startsWith("Date.")) {
        if (name === "Date.now")
          return Date.now();
        if (name === "Date.UTC") {
          const nn = (i) => i < a.length ? number(a[i]) ?? 0 : 0;
          const ms = Date.UTC(nn(0), a.length > 1 ? nn(1) : 0, a.length > 2 ? nn(2) : 1, nn(3), nn(4), nn(5), nn(6));
          return Number.isNaN(ms) ? null : ms;
        }
        if (name === "Date.parse") {
          const t = Date.parse(string(a[0]));
          return t;
        }
        return null;
      }
      if (name.startsWith("Intl."))
        return intlCall(name.substring(5), a);
      if (name.startsWith("Promise."))
        return promiseCall(name.substring(8), a);
      switch (name) {
        case "URL": {
          const base = a.length > 1 ? string(a[1]) : void 0;
          return makeURL(string(a[0]), base);
        }
        case "URLSearchParams": {
          const init = a[0];
          if (typeof init === "string")
            return paramsShape(parseQuery(init));
          if (isDict(init)) {
            if (isDict(init["__params"]) || Array.isArray(init["__params"])) {
              return paramsShape(paramsPairs(init));
            }
            return paramsShape(Object.entries(init).map(([k, v]) => [k, string(v)]));
          }
          if (Array.isArray(init)) {
            return paramsShape(init.map((e) => [string(e[0]), string(e[1])]));
          }
          return paramsShape([]);
        }
        case "Headers": {
          const init = isDict(a[0]) ? a[0] : {};
          const entries = {};
          for (const [k, v] of Object.entries(init))
            entries[k.toLowerCase()] = string(v);
          return { __headers: true, ...entries };
        }
        case "Request":
          return { __request: true, url: string(a[0]), ...isDict(a[1]) ? a[1] : {} };
        case "Blob":
        case "File": {
          const parts = Array.isArray(a[0]) ? a[0] : [];
          let bytes = new Uint8Array(0);
          for (const p of parts) {
            const d = JSECrypto.data(p) ?? (typeof p === "string" ? new TextEncoder().encode(p) : null);
            if (d) {
              const merged = new Uint8Array(bytes.length + d.length);
              merged.set(bytes);
              merged.set(d, bytes.length);
              bytes = merged;
            }
          }
          const opts = isDict(name === "File" ? a[2] : a[1]) ? name === "File" ? a[2] : a[1] : {};
          const shape = { __blob: base64Encode(bytes), type: string(opts["type"] ?? ""), size: bytes.length };
          if (name === "File") {
            shape["name"] = string(a[1]);
            shape["lastModified"] = Date.now();
          }
          return shape;
        }
        case "FormData":
          return { __formData: true, entries: [] };
        case "Date": {
          if (a.length === 0)
            return dateShape(Date.now());
          if (a.length >= 2) {
            const nn = (i, def) => i < a.length ? number(a[i]) ?? NaN : def;
            const y = nn(0, 1970);
            const parts = [y, nn(1, 0), nn(2, 1), nn(3, 0), nn(4, 0), nn(5, 0), nn(6, 0)];
            if (parts.some((p) => !Number.isFinite(p)))
              return dateShape(NaN);
            const dt = new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]);
            if (y >= 0 && y <= 99)
              dt.setFullYear(y);
            return dateShape(dt.getTime());
          }
          const v = a[0];
          if (isDict(v) && isDateShape(v))
            return dateShape(v["__date"]);
          const n = typeof v === "number" ? v : null;
          if (n !== null)
            return dateShape(n);
          const parsed = Date.parse(string(v));
          return dateShape(parsed);
        }
        case "AbortController":
          return { __abortController: true, signal: { __abortSignal: true, aborted: false } };
        case "structuredClone":
          return structuredCloneValue(a[0]);
        case "encodeURIComponent":
          return encodeURIComponent(string(a[0]));
        case "decodeURIComponent": {
          try {
            return decodeURIComponent(string(a[0]));
          } catch {
            return null;
          }
        }
        case "encodeURI":
          return encodeURI(string(a[0]));
        case "decodeURI": {
          try {
            return decodeURI(string(a[0]));
          } catch {
            return null;
          }
        }
        case "parseInt": {
          const s = string(a[0]).trim();
          let radix = safeInt(number(a[1]) ?? 0);
          let body = s;
          let sign = 1;
          if (body.startsWith("-")) {
            sign = -1;
            body = body.substring(1);
          } else if (body.startsWith("+"))
            body = body.substring(1);
          if ((radix === 0 || radix === 16) && /^0x/i.test(body)) {
            radix = 16;
            body = body.substring(2);
          }
          if (radix === 0)
            radix = 10;
          if (radix < 2 || radix > 36)
            return NaN;
          let out = 0;
          let any = false;
          for (const c of body) {
            const d = parseInt(c, 36);
            if (Number.isNaN(d) || d >= radix)
              break;
            out = out * radix + d;
            any = true;
          }
          return any ? sign * out : NaN;
        }
        case "parseFloat": {
          const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(string(a[0]).trim());
          return m ? Number(m[0]) : NaN;
        }
        case "isNaN": {
          const n = number(a[0]);
          return n === null || Number.isNaN(n);
        }
        // The twin of isNaN, which shipped without it: an author reaching for one reaches for
        // the other, and a missing global reads as `null` — silently falsy — not as an error.
        case "isFinite": {
          const n = number(a[0]);
          return n !== null && Number.isFinite(n);
        }
        case "Number":
          return number(a[0]) ?? NaN;
        case "String":
          return string(a[0]);
        case "Boolean":
          return truthy(a[0]);
        case "Map": {
          const entries = [];
          if (Array.isArray(a[0])) {
            for (const e of a[0])
              if (Array.isArray(e))
                entries.push([e[0], e.length > 1 ? e[1] : NSNull]);
          }
          return { __map: entries, size: entries.length };
        }
        case "Set": {
          const values = [];
          if (Array.isArray(a[0])) {
            for (const v of a[0])
              if (!values.some((x) => jseEquals(x, v)))
                values.push(v);
          }
          return { __set: values, size: values.length };
        }
        case "Error":
          return { __error: true, name: "Error", message: string(a[0]) };
        // native twins carry the marker (Globals.kt / Stack.swift)
        case "RegExp":
          return { __regex: true, source: string(a[0]), flags: string(a[1]) };
        case "WebSocket":
          return null;
        // statement-only (the action runner owns sockets)
        default:
          return null;
      }
    },
    /** Constants the evaluator can't reach as calls (bare member reads on a namespace). */
    constant(id) {
      switch (id) {
        case "Math.PI":
          return Math.PI;
        case "Math.E":
          return Math.E;
        case "Number.MAX_SAFE_INTEGER":
          return 9007199254740991;
        case "Number.MIN_SAFE_INTEGER":
          return -9007199254740991;
        case "Number.EPSILON":
          return Number.EPSILON;
        case "Infinity":
          return Infinity;
        case "NaN":
          return NaN;
        default:
          return null;
      }
    },
    /** applyMethod's first stop — claims the call only for ITS dict shapes.
     *  Returns null = "not mine"; { value } = handled (value may be null). */
    method(m, base, a) {
      if (!isDict(base))
        return null;
      const d = base;
      if (d["__regex"] !== void 0 && d["__regex"] !== null && m === "test") {
        return { value: regexTest(string(a[0]), d) };
      }
      if (isDateShape(d)) {
        const ms = d["__date"];
        const dt = dateOf(d);
        switch (m) {
          case "getTime":
          case "valueOf":
            return { value: ms };
          case "toISOString":
          case "toJSON":
            return { value: toISO(ms) };
          case "getFullYear":
            return { value: dt.getFullYear() };
          case "getMonth":
            return { value: dt.getMonth() };
          // 0-based
          case "getDate":
            return { value: dt.getDate() };
          case "getDay":
            return { value: dt.getDay() };
          // 0 = Sunday
          case "getHours":
            return { value: dt.getHours() };
          case "getMinutes":
            return { value: dt.getMinutes() };
          case "getSeconds":
            return { value: dt.getSeconds() };
          case "getMilliseconds":
            return { value: dt.getMilliseconds() };
          case "getUTCFullYear":
            return { value: dt.getUTCFullYear() };
          case "getUTCMonth":
            return { value: dt.getUTCMonth() };
          case "getUTCDate":
            return { value: dt.getUTCDate() };
          case "getUTCDay":
            return { value: dt.getUTCDay() };
          case "getUTCHours":
            return { value: dt.getUTCHours() };
          case "getUTCMinutes":
            return { value: dt.getUTCMinutes() };
          case "getUTCSeconds":
            return { value: dt.getUTCSeconds() };
          case "getUTCMilliseconds":
            return { value: dt.getUTCMilliseconds() };
          case "getTimezoneOffset":
            return { value: dt.getTimezoneOffset() };
          case "setTime":
          case "setFullYear":
          case "setMonth":
          case "setDate":
          case "setHours":
          case "setMinutes":
          case "setSeconds":
          case "setMilliseconds": {
            const next = dateSet(ms, m, a);
            d["__date"] = next;
            return { value: next };
          }
          case "toLocaleDateString":
            return { value: dt.toLocaleDateString(localeArg(a[0]), intlOpts(a[1])) };
          case "toLocaleTimeString":
            return { value: dt.toLocaleTimeString(localeArg(a[0]), intlOpts(a[1])) };
          case "toLocaleString":
            return { value: dt.toLocaleString(localeArg(a[0]), intlOpts(a[1])) };
          case "toString":
            return { value: dt.toString() };
          default:
            return null;
        }
      }
      if (d["__params"] !== void 0) {
        const pairs = paramsPairs(d);
        switch (m) {
          case "get": {
            const k = string(a[0]);
            const hit = pairs.find((p) => p[0] === k);
            return { value: hit ? hit[1] : null };
          }
          case "getAll": {
            const k = string(a[0]);
            return { value: pairs.filter((p) => p[0] === k).map((p) => p[1]) };
          }
          case "has": {
            const k = string(a[0]);
            return { value: pairs.some((p) => p[0] === k) };
          }
          case "set": {
            const k = string(a[0]);
            const v = string(a[1]);
            const rest = pairs.filter((p) => p[0] !== k);
            d["__params"] = [...rest, [k, v]];
            return { value: null };
          }
          case "append": {
            d["__params"] = [...pairs, [string(a[0]), string(a[1])]];
            return { value: null };
          }
          case "delete": {
            const k = string(a[0]);
            d["__params"] = pairs.filter((p) => p[0] !== k);
            return { value: null };
          }
          case "toString":
            return { value: paramsToString(pairs) };
          default:
            return null;
        }
      }
      if (d["__map"] !== void 0) {
        const entries = Array.isArray(d["__map"]) ? d["__map"] : [];
        switch (m) {
          case "get": {
            const hit = entries.find((e) => jseEquals(e[0], a[0]));
            return { value: hit ? hit[1] : null };
          }
          case "has":
            return { value: entries.some((e) => jseEquals(e[0], a[0])) };
          case "set": {
            const rest = entries.filter((e) => !jseEquals(e[0], a[0]));
            d["__map"] = [...rest, [a[0], a[1]]];
            d["size"] = d["__map"].length;
            return { value: d };
          }
          case "delete": {
            const rest = entries.filter((e) => !jseEquals(e[0], a[0]));
            const removed = rest.length !== entries.length;
            d["__map"] = rest;
            d["size"] = rest.length;
            return { value: removed };
          }
          default:
            return null;
        }
      }
      if (d["__set"] !== void 0) {
        const values = Array.isArray(d["__set"]) ? d["__set"] : [];
        switch (m) {
          case "has":
            return { value: values.some((x) => jseEquals(x, a[0])) };
          case "add": {
            if (!values.some((x) => jseEquals(x, a[0]))) {
              d["__set"] = [...values, a[0]];
              d["size"] = d["__set"].length;
            }
            return { value: d };
          }
          case "delete": {
            const rest = values.filter((x) => !jseEquals(x, a[0]));
            const removed = rest.length !== values.length;
            d["__set"] = rest;
            d["size"] = rest.length;
            return { value: removed };
          }
          default:
            return null;
        }
      }
      if (d["__headers"] !== void 0) {
        switch (m) {
          case "get":
            return { value: d[string(a[0]).toLowerCase()] ?? null };
          case "has":
            return { value: d[string(a[0]).toLowerCase()] !== void 0 };
          case "set": {
            d[string(a[0]).toLowerCase()] = string(a[1]);
            return { value: null };
          }
          case "append": {
            d[string(a[0]).toLowerCase()] = string(a[1]);
            return { value: null };
          }
          case "delete": {
            delete d[string(a[0]).toLowerCase()];
            return { value: null };
          }
          default:
            return null;
        }
      }
      if (d["__formData"] !== void 0) {
        const entries = Array.isArray(d["entries"]) ? d["entries"] : [];
        switch (m) {
          case "append":
          case "set": {
            const k = string(a[0]);
            const rest = m === "set" ? entries.filter((e) => string(e[0]) !== k) : entries;
            d["entries"] = [...rest, [k, a[1]]];
            return { value: null };
          }
          case "get": {
            const hit = entries.find((e) => string(e[0]) === string(a[0]));
            return { value: hit ? hit[1] : null };
          }
          case "has":
            return { value: entries.some((e) => string(e[0]) === string(a[0])) };
          case "delete": {
            d["entries"] = entries.filter((e) => string(e[0]) !== string(a[0]));
            return { value: null };
          }
          default:
            return null;
        }
      }
      if (d["__abortController"] !== void 0 && m === "abort") {
        const sig = d["signal"];
        if (isDict(sig))
          sig["aborted"] = true;
        return { value: null };
      }
      if (d["__intlNumber"] !== void 0 && m === "format") {
        const opts = d["__intlNumber"];
        try {
          return { value: new Intl.NumberFormat(string(d["locale"]) || void 0, opts).format(number(a[0]) ?? 0) };
        } catch {
          return { value: string(a[0]) };
        }
      }
      if (d["__intlDate"] !== void 0 && m === "format") {
        const opts = d["__intlDate"];
        const arg = a[0];
        const ms = isDict(arg) && isDateShape(arg) ? arg["__date"] : number(arg) ?? Date.now();
        try {
          return { value: new Intl.DateTimeFormat(string(d["locale"]) || void 0, opts).format(new Date(ms)) };
        } catch {
          return { value: toISO(ms) };
        }
      }
      if (d["__intlRelative"] !== void 0 && m === "format") {
        const opts = d["__intlRelative"];
        try {
          return { value: new Intl.RelativeTimeFormat(string(d["locale"]) || void 0, opts).format(number(a[0]) ?? 0, string(a[1])) };
        } catch {
          return { value: string(a[0]) + " " + string(a[1]) };
        }
      }
      return null;
    },
    /** `'' + date` / `{{ url }}` string coercion for the core shapes. null = no coercion. */
    stringCoerce(d) {
      if (isDateShape(d))
        return toISO(d["__date"]);
      if (d["__url"] !== void 0)
        return string(d["href"]);
      if (d["__params"] !== void 0)
        return paramsToString(paramsPairs(d));
      if (d["__error"] !== void 0)
        return string(d["name"] ?? "Error") + ": " + string(d["message"]);
      return null;
    }
  };
  var JSE_CORE_ABSENT = {
    handles: () => false,
    call: () => null,
    constant: () => null,
    method(m, base, a) {
      if (!isDict(base))
        return null;
      const d = base;
      if (d["__regex"] !== void 0 && d["__regex"] !== null && m === "test") {
        return { value: regexTest(string(a[0]), d) };
      }
      return null;
    },
    stringCoerce(d) {
      if (d["__error"] !== void 0)
        return string(d["name"] ?? "Error") + ": " + string(d["message"]);
      return null;
    }
  };
  var JSECore = globalThis.__DSX_OPTIONAL_JS_GLOBALS__ !== false ? JSE_CORE_FULL : JSE_CORE_ABSENT;
  function regexTest(s, d) {
    try {
      let flags = "";
      const f = string(d["flags"]);
      if (f.includes("i"))
        flags += "i";
      if (f.includes("m"))
        flags += "m";
      if (f.includes("s"))
        flags += "s";
      return new RegExp(string(d["source"]), flags).test(s);
    } catch {
      return false;
    }
  }
  function coreMath(fn, a) {
    const nums = a.map((x) => number(x) ?? NaN);
    const n = (i) => i < nums.length ? nums[i] : NaN;
    switch (fn) {
      case "floor":
        return Math.floor(n(0));
      case "ceil":
        return Math.ceil(n(0));
      case "round":
        return Math.floor(n(0) + 0.5);
      // JS half-up (incl. negatives)
      case "trunc": {
        const x = n(0);
        return Number.isNaN(x) ? x : Math.trunc(x);
      }
      case "abs":
        return Math.abs(n(0));
      case "sign": {
        const x = n(0);
        return x === 0 ? 0 : x > 0 ? 1 : -1;
      }
      case "min":
        return nums.length === 0 ? Infinity : nums.reduce((m, x) => x < m ? x : m);
      case "max":
        return nums.length === 0 ? -Infinity : nums.reduce((m, x) => m < x ? x : m);
      case "pow":
        return Math.pow(n(0), n(1));
      case "sqrt":
        return n(0) < 0 ? NaN : Math.sqrt(n(0));
      case "cbrt":
        return Math.cbrt(n(0));
      case "hypot":
        return Math.hypot(n(0), n(1));
      case "random":
        return Math.random();
      case "log":
        return Math.log(n(0));
      case "log2":
        return Math.log2(n(0));
      case "log10":
        return Math.log10(n(0));
      case "exp":
        return Math.exp(n(0));
      case "sin":
        return Math.sin(n(0));
      case "cos":
        return Math.cos(n(0));
      case "tan":
        return Math.tan(n(0));
      case "atan2":
        return Math.atan2(n(0), n(1));
      case "atan":
        return Math.atan(n(0));
      case "asin":
        return Math.asin(n(0));
      case "acos":
        return Math.acos(n(0));
      case "sinh":
        return Math.sinh(n(0));
      case "cosh":
        return Math.cosh(n(0));
      case "tanh":
        return Math.tanh(n(0));
      case "asinh":
        return Math.asinh(n(0));
      case "acosh":
        return Math.acosh(n(0));
      case "atanh":
        return Math.atanh(n(0));
      case "log1p":
        return Math.log1p(n(0));
      case "expm1":
        return Math.expm1(n(0));
      case "fround":
        return Math.fround(n(0));
      case "clz32":
        return Math.clz32(n(0));
      case "imul":
        return Math.imul(n(0), n(1));
      default:
        return null;
    }
  }
  function localeArg(v) {
    const s = string(v);
    return s.length > 0 ? s : void 0;
  }
  function intlOpts(v) {
    return isDict(v) ? v : void 0;
  }
  function intlCall(name, a) {
    const locale = string(a[0]);
    const opts = isDict(a[1]) ? a[1] : {};
    switch (name) {
      case "NumberFormat":
        return { __intlNumber: opts, locale };
      case "DateTimeFormat":
        return { __intlDate: opts, locale };
      case "RelativeTimeFormat":
        return { __intlRelative: opts, locale };
      default:
        return null;
    }
  }
  function promiseCall(name, a) {
    const items = Array.isArray(a[0]) ? a[0] : [];
    const asPromise = (v) => v instanceof Promise ? v : Promise.resolve(v);
    switch (name) {
      case "all":
        return Promise.all(items.map(asPromise));
      case "allSettled":
        return Promise.allSettled(items.map(asPromise)).then((rs) => rs.map((r) => r.status === "fulfilled" ? { status: "fulfilled", value: r.value } : { status: "rejected", reason: string(r.reason) }));
      case "race":
        return Promise.race(items.map(asPromise));
      case "any":
        return Promise.any(items.map(asPromise)).catch(() => null);
      case "resolve":
        return Promise.resolve(a[0]);
      default:
        return null;
    }
  }
  function structuredCloneValue(v) {
    if (Array.isArray(v))
      return v.map(structuredCloneValue);
    if (isDict(v)) {
      const out = {};
      for (const [k, val] of Object.entries(v))
        out[k] = structuredCloneValue(val);
      return out;
    }
    return v;
  }
  setStringCoerce((d) => JSECore.stringCoerce(d));

  // packages/kernel/dist/jse/dispatch.js
  var higherOrderFns = /* @__PURE__ */ new Set([
    "filter",
    "reject",
    "map",
    "find",
    "some",
    "every",
    "sortBy",
    "sumBy",
    "reduce",
    "forEach",
    "sort",
    "flatMap",
    "findIndex",
    "groupBy",
    "keyBy",
    "findLast",
    "findLastIndex",
    "reduceRight",
    "toSorted"
  ]);
  var methodFns = /* @__PURE__ */ new Set([
    "includes",
    "indexOf",
    "join",
    "reverse",
    "slice",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "startsWith",
    "endsWith",
    "localeCompare",
    "toString",
    "padStart",
    "padEnd",
    "toHex",
    "toBase64",
    "encode",
    "decode",
    "get",
    "getAll",
    "has",
    "set",
    "append",
    "delete",
    "format",
    "json",
    "text",
    "abort",
    "getTime",
    "toISOString",
    "toJSON",
    "getFullYear",
    "getMonth",
    "getDate",
    "getDay",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "getUTCFullYear",
    "getUTCMonth",
    "getUTCDate",
    "getUTCDay",
    "getUTCHours",
    "getUTCMinutes",
    "getUTCSeconds",
    "getUTCMilliseconds",
    "getTimezoneOffset",
    "setTime",
    "setFullYear",
    "setMonth",
    "setDate",
    "setHours",
    "setMinutes",
    "setSeconds",
    "setMilliseconds",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "flat",
    "concat",
    "at",
    "add",
    "test",
    "match",
    "replace",
    "replaceAll",
    "split",
    "search",
    "repeat",
    "substring",
    "lastIndexOf",
    "trimStart",
    "trimEnd",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "normalize",
    "matchAll",
    "fill",
    "toReversed",
    "with",
    "toSpliced",
    "pop",
    "shift",
    "entries",
    "keys",
    "values",
    "toFixed"
  ]);

  // packages/kernel/dist/style-overrides.js
  var NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  var HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
  var FUNCTIONAL_COLOR = /^(rgb|rgba|hsl|hsla)\(/;
  var COLOR_TOKEN = /^[A-Za-z]+$/;
  function strictNumber(value) {
    if (typeof value === "number")
      return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && NUMERIC.test(value))
      return parseFloat(value);
    return null;
  }
  function clamp(value, decl) {
    const min = strictNumber(decl.min ?? null);
    const max = strictNumber(decl.max ?? null);
    let out = value;
    if (min !== null && out < min)
      out = min;
    if (max !== null && out > max)
      out = max;
    return out;
  }
  function scalarText(raw) {
    if (typeof raw === "string")
      return raw.trim();
    if (typeof raw === "number")
      return Number.isFinite(raw) ? String(raw) : null;
    if (typeof raw === "boolean")
      return raw ? "true" : "false";
    return null;
  }
  function balancedFunctional(value) {
    if (!value.endsWith(")"))
      return false;
    let depth = 0;
    for (const ch of value) {
      if (ch === "(")
        depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth < 0)
          return false;
      }
    }
    return depth === 0;
  }
  function coerce(decl, raw) {
    if (raw === null || raw === void 0)
      return null;
    switch (decl.type ?? "text") {
      case "number": {
        if (typeof raw === "boolean")
          return null;
        const n = strictNumber(typeof raw === "string" ? raw.trim() : raw);
        return n === null ? null : clamp(n, decl);
      }
      case "length": {
        if (typeof raw === "boolean")
          return null;
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        const n = strictNumber(text);
        if (n !== null)
          return clamp(n, decl);
        if (text.includes(";") || text.includes("{") || text.includes("}"))
          return null;
        return text;
      }
      case "boolean": {
        if (typeof raw === "boolean")
          return raw;
        if (raw === "true")
          return true;
        if (raw === "false")
          return false;
        return null;
      }
      case "enum": {
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        const options = (decl.options ?? "").split(/\s+/).filter((o) => o.length > 0);
        return options.includes(text) ? text : null;
      }
      case "multiEnum": {
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        const options = (decl.options ?? "").split(/\s+/).filter((o) => o.length > 0);
        const tokens = text.split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length === 0)
          return null;
        for (const token of tokens)
          if (!options.includes(token))
            return null;
        return tokens.join(" ");
      }
      case "color": {
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        if (text.startsWith("#"))
          return HEX_COLOR.test(text) ? text : null;
        if (FUNCTIONAL_COLOR.test(text))
          return balancedFunctional(text) ? text : null;
        return COLOR_TOKEN.test(text) ? text : null;
      }
      case "gradient":
      case "ratio": {
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        if (text.includes(";") || text.includes("{") || text.includes("}"))
          return null;
        return text;
      }
      case "css": {
        const text = scalarText(raw);
        if (text === null || text.length === 0)
          return null;
        if (text.includes("{") || text.includes("}"))
          return null;
        return text;
      }
      default: {
        const text = scalarText(raw);
        return text === null || text.length === 0 ? null : text;
      }
    }
  }
  function resolveOverride(decl, raw) {
    const value = coerce(decl, raw);
    if (value !== null)
      return value;
    if (decl.default !== void 0)
      return coerce(decl, decl.default);
    return null;
  }
  function resolveOverridePlane(decls, itemOverrides, storeOverrides) {
    const out = {};
    for (const decl of decls) {
      const fromItem = itemOverrides?.[decl.as];
      const raw = fromItem !== void 0 && fromItem !== null ? fromItem : storeOverrides?.[decl.as];
      out[decl.as] = resolveOverride(decl, raw);
    }
    return out;
  }

  // packages/kernel/dist/jse/jse.js
  var StackStore = class {
    vars = /* @__PURE__ */ new Map();
    // live surface state (NSNull marks present-null)
    computed = /* @__PURE__ */ new Map();
    // reactive formulas: <variable computed="true">
    computedDepth = 0;
    // guards self-referential computed values
    initials = /* @__PURE__ */ new Map();
    // declared defaults: <variable as="x">expr</variable>
    formulas = /* @__PURE__ */ new Map();
    // parameterized reactive formulas: <formula>
    functions = /* @__PURE__ */ new Map();
    // user functions: function name(args){…}
    fnDepth = 0;
    // guards user-function recursion (capped at 32)
    evalDepth = 0;
    // guards expression-evaluator recursion (capped at 64)
    attrDefaults = /* @__PURE__ */ new Map();
    // declared prop defaults: <attribute as="x" default="…"/>
    overrideDecls = /* @__PURE__ */ new Map();
    // declared style knobs: <override as="x" type="…" default="…"/>
    /** signal read hook — store.ts wires this so `lookup` reads track dependencies. */
    onVarRead = null;
  };
  var JSESeams = {
    /** DSX.state.vars — the app-wide reactive store (`global.*` / `route.*` / `env`). */
    stateVars: () => ({}),
    /** the live cookie jar (`cookie.*`). */
    cookieJar: () => ({}),
    /** environment channel — detection fails CLOSED to "appstore". */
    appEnvironment: () => "appstore",
    /** ModuleRegistry availability — the `has(scheme)` capability check. */
    moduleAvailable: (_scheme) => false,
    /** next-tick hop for reactive author logic (the render-safe invariant). */
    afterRenderDispatch: (work) => {
      queueMicrotask(work);
    },
    /** `os` / `platform` resolve to "web" on this renderer BY DESIGN — the same markup
     *  reads "ios" / "android" / "macos" / "windows" / "linux" on the native kernels
     *  (/web/14; desktop-platforms.md). */
    platformOS: "web",
    /** third-party web-component embed vs in-app surface (/web/14). */
    platformEmbed: false,
    /** dependency tracking for `global.*` / `route.*` / `env` reads (store.ts wires it). */
    onGlobalRead: null
  };
  var DESKTOP_OSES = ["macos", "windows", "linux"];
  function isDesktopOS(os) {
    return DESKTOP_OSES.includes(os);
  }
  function makeLambda(params, body, block, captured) {
    return { __lambda: true, params, body, block, captured };
  }
  var globalFunctions = /* @__PURE__ */ new Map();
  function scanFunctions(body, register) {
    if (!body.includes("function"))
      return;
    const s = Array.from(body);
    let i = 0;
    const kw = "function";
    const isWord = (c) => /[\p{L}\p{Nd}_]/u.test(c);
    while (i < s.length) {
      const slice = s.slice(i, i + kw.length).join("");
      const isKw = slice === kw && (i === 0 || !isWord(s[i - 1])) && (i + kw.length >= s.length || !isWord(s[i + kw.length]));
      if (!isKw) {
        i += 1;
        continue;
      }
      let j = i + kw.length;
      while (j < s.length && /\s/.test(s[j]))
        j += 1;
      let name = "";
      while (j < s.length && isWord(s[j])) {
        name += s[j];
        j += 1;
      }
      while (j < s.length && /\s/.test(s[j]))
        j += 1;
      if (j >= s.length || s[j] !== "(") {
        i += 1;
        continue;
      }
      let depth = 0;
      let paramStr = "";
      while (j < s.length) {
        const ch = s[j];
        if (ch === "(") {
          depth += 1;
          if (depth === 1) {
            j += 1;
            continue;
          }
        }
        if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
        paramStr += ch;
        j += 1;
      }
      while (j < s.length && /\s/.test(s[j]))
        j += 1;
      if (j >= s.length || s[j] !== "{") {
        i = j;
        continue;
      }
      let bdepth = 0;
      let bodyStr = "";
      while (j < s.length) {
        const ch = s[j];
        if (ch === "{") {
          bdepth += 1;
          if (bdepth === 1) {
            j += 1;
            continue;
          }
        }
        if (ch === "}") {
          bdepth -= 1;
          if (bdepth === 0) {
            j += 1;
            break;
          }
        }
        bodyStr += ch;
        j += 1;
      }
      const params = paramStr.split(",").map((p) => ({ name: trimWhitespaceOnly(p), keys: [] })).filter((p) => (p.name ?? "").length > 0);
      if (name.length > 0)
        register(name, makeLambda(params, tokenize(bodyStr), true, {}));
      i = j;
    }
  }
  function spreadValues(v) {
    if (Array.isArray(v))
      return v;
    if (typeof v === "string")
      return graphemes(v);
    if (isDict(v)) {
      const d = v;
      if (Array.isArray(d["__set"]))
        return d["__set"];
      if (Array.isArray(d["__map"]))
        return d["__map"];
    }
    return [];
  }
  function forInKeys(v) {
    if (Array.isArray(v))
      return v.map((_, i) => i);
    if (isDict(v))
      return Object.keys(v).filter((k) => !k.startsWith("__"));
    return [];
  }
  function inOp(l, r) {
    if (Array.isArray(r)) {
      const n = number(l);
      if (n === null)
        return false;
      const i = safeInt(n);
      return i >= 0 && i < r.length;
    }
    if (isDict(r))
      return Object.prototype.hasOwnProperty.call(r, string(l));
    return false;
  }
  function parseDeclarators(toks) {
    const out = [];
    let i = 0;
    const cur = () => i < toks.length ? toks[i] : null;
    const isOp = (v) => {
      const t = cur();
      return t !== null && t.kind === "op" && t.v === v;
    };
    const captureUntil = (stops) => {
      const acc = [];
      let d = 0;
      while (i < toks.length) {
        const tk = toks[i];
        if (tk.kind === "op") {
          if (tk.v === "(" || tk.v === "[" || tk.v === "{")
            d += 1;
          else if (tk.v === ")" || tk.v === "]" || tk.v === "}") {
            if (d === 0 && stops.includes(tk.v))
              break;
            d -= 1;
          } else if (d === 0 && stops.includes(tk.v))
            break;
        }
        acc.push(tk);
        i += 1;
      }
      return acc;
    };
    const parsePattern = () => {
      const t = cur();
      if (t !== null && t.kind === "ident") {
        i += 1;
        return { kind: "ident", name: t.v };
      }
      if (isOp("{")) {
        i += 1;
        const entries = [];
        let rest;
        while (cur() !== null && !isOp("}")) {
          if (isOp("...")) {
            i += 1;
            const rt = cur();
            if (rt !== null && rt.kind === "ident") {
              rest = rt.v;
              i += 1;
            }
            if (isOp(","))
              i += 1;
            continue;
          }
          const kt = cur();
          if (kt === null || kt.kind !== "ident" && kt.kind !== "str") {
            i += 1;
            continue;
          }
          const key = kt.v;
          i += 1;
          let value = { kind: "ident", name: key };
          if (isOp(":")) {
            i += 1;
            value = parsePattern() ?? { kind: "ident", name: key };
          }
          let def;
          if (isOp("=")) {
            i += 1;
            const d = captureUntil([",", "}"]);
            if (d.length > 0)
              def = d;
          }
          entries.push(def === void 0 ? { key, value } : { key, value, def });
          if (isOp(","))
            i += 1;
        }
        if (isOp("}"))
          i += 1;
        return rest === void 0 ? { kind: "object", entries } : { kind: "object", entries, rest };
      }
      if (isOp("[")) {
        i += 1;
        const items = [];
        let rest;
        let expectItem = true;
        while (cur() !== null && !isOp("]")) {
          if (isOp(",")) {
            if (expectItem)
              items.push(null);
            expectItem = true;
            i += 1;
            continue;
          }
          if (isOp("...")) {
            i += 1;
            const rt = cur();
            if (rt !== null && rt.kind === "ident") {
              rest = rt.v;
              i += 1;
            }
            expectItem = false;
            continue;
          }
          const value = parsePattern();
          if (value === null) {
            i += 1;
            continue;
          }
          let def;
          if (isOp("=")) {
            i += 1;
            const d = captureUntil([",", "]"]);
            if (d.length > 0)
              def = d;
          }
          items.push(def === void 0 ? { value } : { value, def });
          expectItem = false;
        }
        if (isOp("]"))
          i += 1;
        return rest === void 0 ? { kind: "array", items } : { kind: "array", items, rest };
      }
      return null;
    };
    while (i < toks.length) {
      const pattern = parsePattern();
      if (pattern === null) {
        i += 1;
        continue;
      }
      let expr = [];
      if (isOp("=")) {
        i += 1;
        expr = captureUntil([","]);
      }
      out.push({ pattern, expr });
      if (isOp(","))
        i += 1;
    }
    return out;
  }
  function parseArrowParams(toks, start) {
    const params = [];
    const defaults = [];
    let i = start;
    const cur = () => i < toks.length ? toks[i] : null;
    const isOp = (v) => {
      const t = cur();
      return t !== null && t.kind === "op" && t.v === v;
    };
    const balanced = () => {
      const out = [];
      let d = 0;
      for (; ; ) {
        const tk = cur();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          if (tk.v === "{" || tk.v === "[" || tk.v === "(")
            d += 1;
          else if (tk.v === "}" || tk.v === "]" || tk.v === ")")
            d -= 1;
        }
        out.push(tk);
        i += 1;
        if (d === 0)
          break;
      }
      return out;
    };
    const defaultTokens = () => {
      const out = [];
      let d = 0;
      for (; ; ) {
        const tk = cur();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          if (tk.v === "(" || tk.v === "[" || tk.v === "{")
            d += 1;
          else if (tk.v === ")" || tk.v === "]" || tk.v === "}") {
            if (d === 0)
              break;
            d -= 1;
          } else if (tk.v === "," && d === 0)
            break;
        }
        out.push(tk);
        i += 1;
      }
      return out;
    };
    while (!isOp(")") && cur() !== null) {
      if (isOp("{") || isOp("[")) {
        const decls = parseDeclarators(balanced());
        const pattern = decls.length > 0 ? decls[0].pattern : null;
        params.push(pattern === null ? { name: null, keys: [] } : { name: null, keys: [], pattern });
        defaults.push(null);
      } else if (isOp("...")) {
        i += 1;
        const nt = cur();
        if (nt !== null && nt.kind === "ident") {
          i += 1;
          params.push({ name: nt.v, keys: [], rest: true });
          defaults.push(null);
        } else
          i += 1;
      } else {
        const nt = cur();
        if (nt !== null && nt.kind === "ident") {
          i += 1;
          const param = { name: nt.v, keys: [] };
          if (isOp("=")) {
            i += 1;
            defaults.push(defaultTokens());
          } else
            defaults.push(null);
          params.push(param);
        } else
          i += 1;
      }
      if (isOp(","))
        i += 1;
    }
    if (isOp(")"))
      i += 1;
    return { params, defaults, next: i };
  }
  function bindPattern(p, value, bind, evalDefault) {
    const withDefault = (v, def) => {
      if (def === void 0 || evalDefault === void 0)
        return v;
      return v === null || v === void 0 || v === NSNull ? evalDefault(def) : v;
    };
    if (p.kind === "ident") {
      bind(p.name, value);
      return;
    }
    if (p.kind === "object") {
      const taken = /* @__PURE__ */ new Set();
      for (const e of p.entries) {
        taken.add(e.key);
        bindPattern(e.value, withDefault(member(value, e.key), e.def), bind, evalDefault);
      }
      if (p.rest !== void 0) {
        const out = {};
        if (isDict(value)) {
          for (const [k, v] of Object.entries(value))
            if (!taken.has(k))
              out[k] = v;
        }
        bind(p.rest, out);
      }
      return;
    }
    p.items.forEach((item, index2) => {
      if (item === null)
        return;
      bindPattern(item.value, withDefault(index(value, index2), item.def), bind, evalDefault);
    });
    if (p.rest !== void 0) {
      const src = Array.isArray(value) ? value : [];
      bind(p.rest, src.slice(p.items.length));
    }
  }
  function attributeBinding(template) {
    if (!template.includes("{{"))
      return { kind: "static" };
    const t = template.trim();
    if (!t.startsWith("{{"))
      return { kind: "text" };
    const close = t.indexOf("}}", 2);
    if (close < 0 || close !== t.length - 2)
      return { kind: "text" };
    return { kind: "value", expr: t.substring(2, close) };
  }
  var JSE = {
    attributeBinding,
    /** Resolve one consumer attribute to the value it should carry: typed when the template
     *  is a sole hole, its own text when it has none, the interpolated sentence otherwise. */
    bindAttribute(template, store, item) {
      const b = attributeBinding(template);
      if (b.kind === "static")
        return template;
      if (b.kind === "value")
        return JSE.eval(b.expr, store, item);
      return JSE.interpolate(template, store, item);
    },
    interpolate(s, store, item) {
      if (!s.includes("{{"))
        return s;
      let out = "";
      let idx = 0;
      for (; ; ) {
        const open = s.indexOf("{{", idx);
        if (open < 0)
          break;
        out += s.substring(idx, open);
        const close = s.indexOf("}}", open + 2);
        if (close < 0) {
          out += s.substring(open);
          return out;
        }
        const expr = s.substring(open + 2, close);
        out += string(JSE.eval(expr, store, item));
        idx = close + 2;
      }
      out += s.substring(idx);
      return out;
    },
    eval(raw, store, item) {
      const e = trimWhitespaceOnly(raw);
      if (e.length === 0)
        return null;
      if (store.evalDepth >= 64) {
        console.warn(`[JSE] eval recursion budget (64) exceeded \u2014 expression cycle; returning nil: ${e.slice(0, 80)}`);
        return null;
      }
      store.evalDepth += 1;
      try {
        const p = new Parser(cachedTokens(e), store, item);
        return p.expression();
      } catch (err) {
        console.warn(`[JSE] eval failed \u2014 returning nil: ${String(err)} in ${e.slice(0, 80)}`);
        return null;
      } finally {
        store.evalDepth -= 1;
      }
    },
    /** Evaluate a `<variable>`/function body as a VALUE — a **bounded-JS** block.
     *  PURE: `const`/`let`/`x = e` write a throwaway local scope, never the store.
     *  The full statement grammar incl. BUDGETED loops (10000 iterations per evaluation,
     *  corpus core-004) — so it always terminates. */
    evalBlock(body, store, item) {
      const trimmed = body.trim();
      if (trimmed.length === 0)
        return null;
      if (!trimmed.includes(";") && !trimmed.includes("\n") && !trimmed.includes("{") && !trimmed.startsWith("return") && !trimmed.startsWith("const ") && !trimmed.startsWith("let ") && !trimmed.startsWith("if ") && !trimmed.startsWith("if(") && !trimmed.startsWith("function")) {
        return JSE.eval(trimmed, store, item);
      }
      const e = new JSEval(cachedTokens(body), store, item ?? {});
      e.runBlock();
      return e.result;
    },
    /** Register every top-level `function name(params) { … }` in `body` as a callable
     *  user function — positional args, depth-capped at 32. String-scanned. */
    registerFunctions(body, store) {
      scanFunctions(body, (name, fn) => store.functions.set(name, fn));
    },
    /** Register `body`'s top-level functions into the APP-WIDE table — the global function
     *  library (js-core.md "Shared logic"): validation/pricing/formatting written ONCE,
     *  callable from every surface. Same scanner, same shapes as registerFunctions; global
     *  registration does NOT capture scope (free names resolve against the CALLING
     *  surface's live store, exactly like top-level surface functions). Lookup order at a
     *  named call: scope lambda → the surface's `store.functions` (a local name SHADOWS
     *  the global) → this table → builtins; same fnDepth 32 guard. Boot/modules call this
     *  once at startup; re-registration replaces (last write wins). */
    registerGlobalFunctions(body) {
      scanFunctions(body, (name, fn) => globalFunctions.set(name, fn));
    },
    /** Drop every globally registered function (tests; a full app reload). */
    clearGlobalFunctions() {
      globalFunctions.clear();
    },
    /** The app-wide table's read side — the executors' shared lookup seam (Parser +
     *  compiled `$.call` resolve through this after the surface table misses). */
    globalFunction(name) {
      return globalFunctions.get(name);
    },
    /** Invoke a lambda / user function: bind args to params (destructuring `{a,b}`,
     *  call-time defaults, a trailing rest array), then evaluate the body.
     *  Scope = caller `base` ⊕ captured creation scope ⊕ params — base fills UNDER the
     *  captured snapshot (capture semantics hold), which is what lets a stored lambda call
     *  ITSELF (`const f = n => … f(n - 1)`: f is not in its own creation snapshot, so the
     *  caller's live scope supplies it). */
    callLambda(f, args, store, base = null) {
      if (f.native)
        return f.native(args, base);
      const scope = base ? { ...base } : {};
      Object.assign(scope, f.captured);
      f.params.forEach((p2, k) => {
        if (p2.rest === true && p2.name !== null) {
          scope[p2.name] = k < args.length ? args.slice(k).map((x) => x ?? NSNull) : [];
          return;
        }
        const a = k < args.length ? args[k] : null;
        if (p2.name !== null) {
          if (isMissing(a) && p2.def !== void 0 && p2.def.length > 0) {
            scope[p2.name] = new Parser(p2.def, store, scope).expression() ?? NSNull;
          } else {
            scope[p2.name] = a ?? NSNull;
          }
        } else if (p2.pattern !== void 0) {
          bindPattern(p2.pattern, a, (n, v) => {
            scope[n] = v ?? NSNull;
          }, (toks) => new Parser(toks, store, scope).expression());
        } else {
          const d = isDict(a) ? a : {};
          for (const key of p2.keys)
            scope[key] = d[key] ?? NSNull;
        }
      });
      if (f.block) {
        const e = new JSEval(f.body, store, scope);
        e.runBlock();
        return e.result;
      }
      const p = new Parser(f.body, store, scope);
      return p.expression();
    },
    /** Pure built-in functions for `{{ … }}` — no side effects, no I/O. */
    apply(name, a, store) {
      const s = (i) => i < a.length ? string(a[i]) : "";
      const n = (i) => i < a.length ? number(a[i]) ?? 0 : 0;
      if (name.startsWith("crypto.") || name === "Uint8Array" || name.startsWith("Uint8Array.") || name === "TextEncoder" || name === "TextDecoder" || name === "Array.from" || name === "btoa" || name === "atob") {
        if (name === "Array.from")
          return arrayFrom(a, store);
        return JSECrypto.call(name, a);
      }
      if (JSECore.handles(name))
        return JSECore.call(name, a);
      switch (name) {
        // SOURCE, DRAWN. The `<code>` surface needs token spans in markup, and a page cannot
        // reach the scanner any other way - so the kernel exposes it instead of every caller
        // shipping a fourth tokenizer. Pure: text in, rows of {text, kind} out.
        //
        // An OPTIONAL PLANE, like the regex engine beside it: almost no document draws source,
        // and a self-contained embed has a byte budget that a scanner nobody called would eat.
        // The define folds the branch, and the import goes with it.
        case "highlight":
          return globalThis.__DSX_OPTIONAL_HIGHLIGHT__ !== false ? highlightLines(s(0)) : [];
        case "upper":
          return s(0).toUpperCase();
        case "lower":
          return s(0).toLowerCase();
        case "cap":
        case "capitalize":
          return capitalizedSwift(s(0));
        case "trim":
          return trimWhitespaceOnly(s(0));
        case "len":
        case "count": {
          const f = a[0];
          if (Array.isArray(f))
            return f.length;
          return charCount(s(0));
        }
        case "abs":
          return Math.abs(n(0));
        case "round":
          return roundedAwayFromZero(n(0));
        // Swift .rounded() — half away from zero
        case "floor":
          return Math.floor(n(0));
        case "ceil":
          return Math.ceil(n(0));
        case "min":
          return swiftMin(n(0), n(1));
        case "max":
          return swiftMax(n(0), n(1));
        case "int":
          return safeInt(n(0));
        case "pad": {
          const width = Math.min(Math.max(safeInt(n(1)), 0), 64);
          const value = safeInt(n(0));
          if (width === 0)
            return String(value);
          const neg = value < 0;
          const digits = String(Math.abs(value));
          const padded = digits.padStart(neg ? width - 1 : width, "0");
          return neg ? "-" + padded : padded;
        }
        case "mmss":
        case "clock": {
          const total = safeInt(n(0));
          const neg = total < 0;
          const t = Math.abs(total);
          const two = (x) => String(x).padStart(2, "0");
          const body = t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t % 3600 / 60))}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`;
          return neg ? `-${body}` : body;
        }
        case "if":
          return truthy(a[0]) ? a.length > 1 ? a[1] : null : a.length > 2 ? a[2] : null;
        case "typeof":
          return typeofString(a[0]);
        case "Array.isArray":
          return Array.isArray(a[0]);
        case "range": {
          let lo = 0, hi = n(0), step = 1;
          if (a.length >= 2) {
            lo = n(0);
            hi = n(1);
          }
          if (a.length >= 3)
            step = n(2);
          if (step === 0 || !Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step))
            return [];
          const ladder = [];
          let v = lo;
          while ((step > 0 ? v < hi : v > hi) && ladder.length < 1e4) {
            ladder.push(v);
            v += step;
          }
          return ladder;
        }
        case "String.fromCharCode": {
          let out = "";
          for (const c of a) {
            const code = safeInt(number(c) ?? 0);
            if (code >= 0 && code <= 1114111)
              out += String.fromCharCode(code);
          }
          return out;
        }
        case "Array.of":
          return a.map((x) => x ?? NSNull);
        case "Number.isInteger":
          return typeof a[0] === "number" && Number.isFinite(a[0]) && Math.trunc(a[0]) === a[0];
        case "Number.isFinite":
          return typeof a[0] === "number" && Number.isFinite(a[0]);
        case "Number.isSafeInteger":
          return typeof a[0] === "number" && Number.isSafeInteger(a[0]);
        case "Number.isNaN":
          return typeof a[0] === "number" && Number.isNaN(a[0]);
        case "Number.parseInt":
          return JSECore.call("parseInt", a);
        case "Number.parseFloat":
          return JSECore.call("parseFloat", a);
        case "matches":
          return DSXPathMatch.matches(s(0), s(1));
        case "has":
          return JSESeams.moduleAvailable(s(0));
        // ── collection utilities (bounded, total) ──
        case "first":
          return asArray(a[0])[0] ?? null;
        case "last": {
          const arr = asArray(a[0]);
          return arr.length > 0 ? arr[arr.length - 1] : null;
        }
        case "reverse":
          return [...asArray(a[0])].reverse();
        case "sum":
          return asArray(a[0]).reduce((acc, e) => acc + (number(e) ?? 0), 0);
        case "join":
          return asArray(a[0]).map((x) => string(x)).join(a.length > 1 ? s(1) : ", ");
        case "contains":
          return asArray(a[0]).some((x) => string(x) === s(1));
        case "keys":
          return isDict(a[0]) ? Object.keys(a[0]) : null;
        case "values":
          return isDict(a[0]) ? Object.values(a[0]) : null;
        // ── form validators (pure predicates) ──
        case "required": {
          const v = a[0];
          if (Array.isArray(v))
            return v.length > 0;
          if (typeof v === "string")
            return trimWhitespaceOnly(v).length > 0;
          return truthy(v);
        }
        case "minLength":
          return (Array.isArray(a[0]) ? a[0].length : charCount(s(0))) >= safeInt(n(1));
        case "maxLength":
          return (Array.isArray(a[0]) ? a[0].length : charCount(s(0))) <= safeInt(n(1));
        case "regex": {
          if (globalThis.__DSX_OPTIONAL_REGEX__ === false)
            return false;
          const pat = s(1);
          if (reDoSProne(pat)) {
            console.warn(`[JSE] regex() rejected a potentially-catastrophic pattern: /${pat}/`);
            return false;
          }
          try {
            return new RegExp(pat).test(s(0));
          } catch {
            return false;
          }
        }
        case "email":
          return /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i.test(s(0));
        case "phone":
          return /^[+]?[0-9 ()\-]{7,}$/.test(s(0));
        case "url": {
          try {
            const u = new URL(s(0));
            return u.protocol.length > 0 && u.hostname.length > 0;
          } catch {
            return false;
          }
        }
        default:
          return null;
      }
    },
    /** JS array/string methods called method-style. */
    applyMethod(m, base, a) {
      const handled = JSECore.method(m, base, a);
      if (handled !== null)
        return handled.value;
      switch (m) {
        case "includes": {
          if (asArray(base).some((x) => jseEquals(x, a[0])))
            return true;
          const needle = string(a[0]);
          return needle.length > 0 && string(base).includes(needle);
        }
        case "indexOf": {
          if (typeof base === "string") {
            const needle = string(a[0]);
            if (needle.length === 0)
              return 0;
            const h = graphemes(base);
            const nd = graphemes(needle);
            for (let i2 = 0; i2 <= h.length - nd.length; i2++) {
              let ok = true;
              for (let j = 0; j < nd.length; j++)
                if (h[i2 + j] !== nd[j]) {
                  ok = false;
                  break;
                }
              if (ok)
                return i2;
            }
            return -1;
          }
          const i = asArray(base).findIndex((x) => jseEquals(x, a[0]));
          return i < 0 ? -1 : i;
        }
        case "localeCompare": {
          const l = string(base);
          const r = string(a[0]);
          return l === r ? 0 : l.localeCompare(r) < 0 ? -1 : 1;
        }
        case "startsWith":
          return string(base).startsWith(string(a[0]));
        case "endsWith":
          return string(base).endsWith(string(a[0]));
        case "join": {
          const sep = a.length > 0 && a[0] !== null && a[0] !== void 0 ? string(a[0]) : ",";
          return asArray(base).map((x) => string(x)).join(sep);
        }
        case "reverse":
          return [...asArray(base)].reverse();
        case "slice": {
          const bound = (v, len, def) => {
            if (v === null || !Number.isFinite(v))
              return def;
            const i = Math.trunc(Math.min(Math.max(v, -9e15), 9e15));
            return i < 0 ? Math.max(len + i, 0) : Math.min(i, len);
          };
          if (typeof base === "string") {
            const chars = graphemes(base);
            const lo2 = bound(number(a[0]), chars.length, 0);
            const hi2 = bound(a.length > 1 ? number(a[1]) : null, chars.length, chars.length);
            return lo2 < hi2 ? chars.slice(lo2, hi2).join("") : "";
          }
          const arr = asArray(base);
          const lo = bound(number(a[0]), arr.length, 0);
          const hi = bound(a.length > 1 ? number(a[1]) : null, arr.length, arr.length);
          return lo < hi ? arr.slice(lo, hi) : [];
        }
        case "toUpperCase":
          return string(base).toUpperCase();
        case "toLowerCase":
          return string(base).toLowerCase();
        case "trim":
          return trimWhitespaceOnly(string(base));
        case "flat": {
          const raw = number(a[0]) ?? 1;
          const depth = Number.isFinite(raw) ? safeInt(raw) : 512;
          const flatten = (v, d) => v.flatMap((e) => Array.isArray(e) && d > 0 ? flatten(e, d - 1) : [e]);
          return flatten(asArray(base), depth);
        }
        case "concat": {
          const out = [...asArray(base)];
          for (const v of a) {
            if (Array.isArray(v))
              out.push(...v);
            else if (v !== null && v !== void 0)
              out.push(v);
          }
          return out;
        }
        case "at": {
          const i = safeInt(number(a[0]) ?? 0);
          if (typeof base === "string") {
            const chars = graphemes(base);
            const idx2 = i < 0 ? chars.length + i : i;
            return idx2 >= 0 && idx2 < chars.length ? chars[idx2] : null;
          }
          const arr = asArray(base);
          const idx = i < 0 ? arr.length + i : i;
          return idx >= 0 && idx < arr.length ? arr[idx] : null;
        }
        case "match":
          return JSERegex.match(string(base), a[0]);
        case "search":
          return JSERegex.search(string(base), a[0]);
        case "replace":
          return JSERegex.replace(string(base), a[0], string(a[1]), false);
        case "replaceAll":
          return JSERegex.replace(string(base), a[0], string(a[1]), true);
        case "split": {
          const limit = a.length > 1 ? safeInt(number(a[1]) ?? 0) : 0;
          return JSERegex.split(string(base), a[0], limit);
        }
        case "toString": {
          const radix = number(a[0]);
          if (radix !== null) {
            const r = Math.trunc(radix);
            if (r >= 2 && r <= 36 && r !== 10) {
              const v = number(base);
              if (v !== null)
                return safeInt(v).toString(r);
            }
          }
          return string(base);
        }
        case "padStart":
        case "padEnd": {
          const len = Math.min(safeInt(number(a[0]) ?? 0), 1e4);
          const pad = a.length > 1 ? string(a[1]) : " ";
          const str = string(base);
          const strG = graphemes(str);
          if (pad.length === 0 || strG.length >= len)
            return str;
          const fill = [];
          while (fill.length + strG.length < len)
            fill.push(...graphemes(pad));
          const f = fill.slice(0, len - strG.length).join("");
          return m === "padStart" ? f + str : str + f;
        }
        case "toHex": {
          const d = JSECrypto.data(base);
          return d ? Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("") : null;
        }
        case "toBase64": {
          const d = JSECrypto.data(base);
          return d ? JSECrypto.base64(d) : null;
        }
        case "encode": {
          if (isDict(base) && base["__textEncoder"] !== void 0 && base["__textEncoder"] !== null) {
            return JSECrypto.bytes(new TextEncoder().encode(string(a[0])));
          }
          return null;
        }
        case "decode": {
          if (isDict(base) && base["__textDecoder"] !== void 0 && base["__textDecoder"] !== null) {
            const d = JSECrypto.data(a[0]);
            return d ? new TextDecoder().decode(d) : null;
          }
          return null;
        }
        case "repeat": {
          const n = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), 1e4);
          let out = "";
          const s = string(base);
          for (let i = 0; i < n; i++)
            out += s;
          return out;
        }
        case "substring": {
          const chars = graphemes(string(base));
          const clamp2 = (v) => {
            if (v === null || Number.isNaN(v))
              return 0;
            return Math.min(Math.max(safeInt(v), 0), chars.length);
          };
          let lo = clamp2(number(a[0]));
          let hi = a.length > 1 ? clamp2(number(a[1])) : chars.length;
          if (lo > hi) {
            const tmp = lo;
            lo = hi;
            hi = tmp;
          }
          return chars.slice(lo, hi).join("");
        }
        case "lastIndexOf": {
          if (typeof base === "string") {
            const h = graphemes(base);
            const nd = graphemes(string(a[0]));
            if (nd.length === 0)
              return h.length;
            for (let i = h.length - nd.length; i >= 0; i--) {
              let ok = true;
              for (let j = 0; j < nd.length; j++)
                if (h[i + j] !== nd[j]) {
                  ok = false;
                  break;
                }
              if (ok)
                return i;
            }
            return -1;
          }
          const arr = asArray(base);
          for (let i = arr.length - 1; i >= 0; i--)
            if (jseEquals(arr[i], a[0]))
              return i;
          return -1;
        }
        case "trimStart": {
          const s = string(base);
          let start = 0;
          while (start < s.length && isWhitespaceOnly(s[start]))
            start += 1;
          return s.substring(start);
        }
        case "trimEnd": {
          const s = string(base);
          let end = s.length;
          while (end > 0 && isWhitespaceOnly(s[end - 1]))
            end -= 1;
          return s.substring(0, end);
        }
        case "charAt": {
          const chars = graphemes(string(base));
          const i = safeInt(number(a[0]) ?? 0);
          return i >= 0 && i < chars.length ? chars[i] : "";
        }
        case "charCodeAt":
        case "codePointAt": {
          const chars = graphemes(string(base));
          const i = safeInt(number(a[0]) ?? 0);
          if (i < 0 || i >= chars.length)
            return null;
          return chars[i].codePointAt(0) ?? null;
        }
        case "normalize": {
          const form = a.length > 0 ? string(a[0]) : "NFC";
          if (form !== "NFC" && form !== "NFD" && form !== "NFKC" && form !== "NFKD")
            return string(base);
          return string(base).normalize(form);
        }
        case "matchAll":
          return JSERegex.matchAll(string(base), a[0]);
        case "fill": {
          const arr = [...asArray(base)];
          const bound = (v2, def) => {
            if (v2 === null || !Number.isFinite(v2))
              return def;
            const i = safeInt(v2);
            return i < 0 ? Math.max(arr.length + i, 0) : Math.min(i, arr.length);
          };
          const v = a.length > 0 ? a[0] ?? NSNull : NSNull;
          const lo = bound(a.length > 1 ? number(a[1]) : null, 0);
          const hi = bound(a.length > 2 ? number(a[2]) : null, arr.length);
          for (let i = lo; i < hi; i++)
            arr[i] = v;
          return arr;
        }
        case "toReversed":
          return [...asArray(base)].reverse();
        // JS pop()/shift() mutate; JSE values are value-typed on the native runtimes, so
        // the JSE spelling is the PURE read (the toReversed/toSpliced family's law): last/
        // first element out, receiver untouched. Corpus: stdlib-002.
        case "pop":
          return asArray(base).at(-1) ?? null;
        case "shift":
          return asArray(base).at(0) ?? null;
        case "with": {
          const arr = [...asArray(base)];
          let i = safeInt(number(a[0]) ?? 0);
          if (i < 0)
            i += arr.length;
          if (i >= 0 && i < arr.length)
            arr[i] = a[1] ?? NSNull;
          return arr;
        }
        case "toSpliced": {
          const arr = [...asArray(base)];
          const start = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), arr.length);
          const del = a.length > 1 ? Math.max(safeInt(number(a[1]) ?? 0), 0) : arr.length - start;
          arr.splice(start, del, ...a.slice(2).map((x) => x ?? NSNull));
          return arr;
        }
        case "entries":
          return asArray(base).map((e, i) => [i, e ?? NSNull]);
        case "keys":
          return asArray(base).map((_, i) => i);
        case "values":
          return [...asArray(base)];
        case "toLocaleString": {
          const v = number(base);
          if (v === null || isDict(base))
            break;
          const txt = string(v);
          const dot = txt.indexOf(".");
          const whole = dot < 0 ? txt : txt.substring(0, dot);
          return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dot < 0 ? "" : txt.substring(dot));
        }
        case "toFixed": {
          const v = number(base);
          if (v === null || !Number.isFinite(v))
            return string(base);
          if (Math.abs(v) >= 9007199254740992)
            return string(v);
          const d = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), 100);
          const shift = Math.pow(10, d);
          const r = roundedAwayFromZero(Math.abs(v) * shift);
          const whole = Math.floor(r / shift);
          let out = String(whole);
          if (d > 0) {
            const frac = String(r - whole * shift).padStart(d, "0");
            out += "." + frac;
          }
          return (v < 0 && r > 0 ? "-" : "") + out;
        }
        default:
          return null;
      }
    },
    /** Bounded higher-order collection functions — total, one pass, arrow-fn callbacks. */
    higherOrder(id, coll, fn, store, initial = null, hasInitial = false) {
      const arr = asArray(coll);
      const call = (args) => fn ? JSE.callLambda(fn, args, store) : null;
      switch (id) {
        case "map":
          return arr.map((e, i) => call([e, i]) ?? NSNull);
        case "filter":
          return arr.filter((e, i) => truthy(call([e, i])));
        case "reject":
          return arr.filter((e, i) => !truthy(call([e, i])));
        case "find":
          return arr.find((e, i) => truthy(call([e, i]))) ?? null;
        case "some":
          return arr.some((e, i) => truthy(call([e, i])));
        case "every":
          return arr.every((e, i) => truthy(call([e, i])));
        case "forEach": {
          arr.forEach((e, i) => call([e, i]));
          return null;
        }
        case "sumBy":
          return arr.reduce((acc, e, i) => acc + (number(call([e, i])) ?? 0), 0);
        case "sortBy": {
          const desc = hasInitial && string(initial) === "desc";
          return arr.map((e, i) => ({ e, i })).sort((l, r) => {
            const x = call([l.e, l.i]);
            const y = call([r.e, r.i]);
            const nx = number(x);
            const ny = number(y);
            let cmp;
            if (nx !== null && ny !== null)
              cmp = nx < ny ? -1 : ny < nx ? 1 : 0;
            else {
              const sx = string(x);
              const sy = string(y);
              cmp = sx < sy ? -1 : sy < sx ? 1 : 0;
            }
            return desc ? -cmp : cmp;
          }).map((p) => p.e);
        }
        case "groupBy": {
          const groups = {};
          arr.forEach((e, i) => {
            const k = string(call([e, i]));
            const bucket = groups[k] ?? (groups[k] = []);
            bucket.push(e);
          });
          return groups;
        }
        case "keyBy": {
          const keyed = {};
          arr.forEach((e, i) => {
            keyed[string(call([e, i]))] = e;
          });
          return keyed;
        }
        case "reduce": {
          let acc = hasInitial ? initial : arr[0] ?? null;
          let k = hasInitial ? 0 : 1;
          while (k < arr.length) {
            acc = call([acc, arr[k], k]);
            k += 1;
          }
          return acc;
        }
        case "sort":
          return JSE.sortedArray(arr, fn, store);
        case "flatMap":
          return arr.flatMap((e, i) => {
            const v = call([e, i]) ?? NSNull;
            return Array.isArray(v) ? v : [v];
          });
        case "findIndex": {
          const i = arr.findIndex((e, o) => truthy(call([e, o])));
          return i < 0 ? -1 : i;
        }
        case "findLast": {
          for (let i = arr.length - 1; i >= 0; i--)
            if (truthy(call([arr[i], i])))
              return arr[i] ?? null;
          return null;
        }
        case "findLastIndex": {
          for (let i = arr.length - 1; i >= 0; i--)
            if (truthy(call([arr[i], i])))
              return i;
          return -1;
        }
        case "reduceRight": {
          let acc = hasInitial ? initial : arr.length > 0 ? arr[arr.length - 1] ?? null : null;
          let k = hasInitial ? arr.length - 1 : arr.length - 2;
          while (k >= 0) {
            acc = call([acc, arr[k], k]);
            k -= 1;
          }
          return acc;
        }
        case "toSorted":
          return JSE.sortedArray(arr, fn, store);
        // JS ES2023 — sort was already a copy here
        default:
          return null;
      }
    },
    /** JS Array.prototype.sort semantics — returns a sorted COPY (value semantics). */
    sortedArray(arr, comparator, store) {
      if (isLambda(comparator)) {
        return [...arr].sort((a, b) => {
          const v = number(JSE.callLambda(comparator, [a, b], store)) ?? 0;
          return v < 0 ? -1 : v > 0 ? 1 : 0;
        });
      }
      return [...arr].sort((a, b) => {
        const sa = string(a);
        const sb = string(b);
        return sa < sb ? -1 : sb < sa ? 1 : 0;
      });
    },
    /** Normalize an explicit `dsx.`-namespace prefix to its canonical scope path. */
    normalizeScope(path) {
      if (!path.startsWith("dsx."))
        return path;
      const body = path.substring(4);
      const dot = body.indexOf(".");
      const head = dot >= 0 ? body.substring(0, dot) : body;
      const rest = dot >= 0 ? body.substring(dot + 1) : "";
      const join = (base) => rest.length === 0 ? base : `${base}.${rest}`;
      if (globalThis.__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false && head === "override")
        return join("override");
      switch (head) {
        case "variable":
        case "formula":
          return rest.length === 0 ? body : rest;
        case "global":
          return join("global");
        // app-wide constants (App.json `consts`; networking.md N0) live on the app store
        // under `const` — `dsx.const.api_url` folds to `global.const.api_url`, so the reserved
        // `global` branch below serves it (tracked read + reactive) with no extra dispatch.
        case "const":
          return join("global.const");
        case "screen":
          return join("global.screen");
        // G4 unified input (dsx-game.md §2): `dsx.input.jump` / `dsx.input.move.x` is an
        // ordinary tracked read of the app store — the input runtime publishes each declared
        // binding under `global.input.<name>`, so a markup read is reactive for free and no
        // new dispatch path exists. (`<input>` in the BODY is still the form element.)
        case "input":
          return join("global.input");
        case "source":
          return join("global.source");
        case "app":
          return join("global.app");
        case "route":
          return join("route");
        case "cookie":
          return join("cookie");
        case "attribute":
          return join("attribute");
        case "item":
        case "this":
          return join("item");
        case "element":
          return join("item.__element");
        case "params":
          return join("route.params");
        case "query":
          return join("route.query");
        case "path":
          return "route.path";
        default:
          return body;
      }
    },
    lookup(rawPath, store, item) {
      const explicitStore = rawPath.startsWith("dsx.variable.") || rawPath.startsWith("dsx.formula.");
      const path = JSE.normalizeScope(rawPath);
      const parts = path.split(".").filter((p) => p.length > 0);
      const first = parts[0];
      if (first === void 0)
        return null;
      if (parts.length === 1 && (first === "os" || first === "platform"))
        return JSESeams.platformOS;
      if (first === "platform" && parts.length === 2) {
        if (parts[1] === "os")
          return JSESeams.platformOS;
        if (parts[1] === "native")
          return JSESeams.platformOS !== "web";
        if (parts[1] === "desktop")
          return isDesktopOS(JSESeams.platformOS);
        if (parts[1] === "embed")
          return JSESeams.platformEmbed;
      }
      if (parts.length === 1 && !explicitStore && first === "env") {
        JSESeams.onGlobalRead?.("app");
        return walk(["app", "env"], JSESeams.stateVars()) ?? JSESeams.appEnvironment();
      }
      if (first === "global") {
        JSESeams.onGlobalRead?.(parts[1] ?? "");
        return walk(parts.slice(1), JSESeams.stateVars());
      }
      if (first === "route") {
        JSESeams.onGlobalRead?.("route");
        return walk(parts, JSESeams.stateVars());
      }
      if (first === "nav") {
        JSESeams.onGlobalRead?.("nav");
        return walk(parts, JSESeams.stateVars());
      }
      if (first === "cookie") {
        JSESeams.onGlobalRead?.("cookie");
        const jar = JSESeams.cookieJar();
        return parts.length === 1 ? jar : walk(parts.slice(1), jar);
      }
      if (globalThis.__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false && first === "override") {
        store.onVarRead?.("dsx.override");
        const itemRaw = item ? item["__overrides"] : void 0;
        const itemOv = isDict(itemRaw) ? itemRaw : null;
        const storeRaw = store.vars.get("dsx.override");
        const storeOv = isDict(storeRaw) ? storeRaw : null;
        if (parts.length === 1)
          return resolveOverridePlane(store.overrideDecls.values(), itemOv, storeOv);
        const name = parts[1];
        const decl = store.overrideDecls.get(name);
        if (decl === void 0)
          return null;
        const fromItem = itemOv?.[name];
        const raw = fromItem !== void 0 && fromItem !== null ? fromItem : storeOv?.[name];
        const v = resolveOverride(decl, raw);
        return parts.length === 2 ? v : walk(parts.slice(2), v);
      }
      if (first === "item" || first === "attribute") {
        store.onVarRead?.("dsx.attribute");
        const v = walk(parts.slice(1), item);
        if (v === null && first === "attribute" && parts.length >= 2) {
          const av = store.vars.get("dsx.attribute");
          if (isDict(av)) {
            const runtime = walk(parts.slice(1), av);
            if (runtime !== null)
              return runtime;
          }
        }
        if (v === null && first === "attribute" && parts.length === 2) {
          const def = store.attrDefaults.get(parts[1]);
          if (def !== void 0)
            return def.trim() === "" ? "" : JSE.eval(def, store, item);
        }
        return v;
      }
      if (!explicitStore) {
        const local = item ? item[first] : void 0;
        if (local !== void 0 && local !== null) {
          store.onVarRead?.("dsx.attribute");
          return walk(parts.slice(1), local);
        }
      }
      store.onVarRead?.(first);
      if (store.vars.get(first) === void 0 || store.vars.get(first) === null) {
        const formula = store.computed.get(first);
        if (formula !== void 0 && store.computedDepth < 32) {
          store.computedDepth += 1;
          const v = JSE.evalBlock(formula, store, item);
          store.computedDepth -= 1;
          return parts.length === 1 ? v : walk(parts.slice(1), v);
        }
      }
      if (store.vars.get(first) === void 0 || store.vars.get(first) === null) {
        const f = store.formulas.get(first);
        if (f !== void 0 && store.computedDepth < 32) {
          store.computedDepth += 1;
          const scope = {};
          for (const [k, e] of Object.entries(f.inputs))
            scope[k] = JSE.evalBlock(e, store, item) ?? NSNull;
          const v = JSE.evalBlock(f.body, store, scope);
          store.computedDepth -= 1;
          return parts.length === 1 ? v : walk(parts.slice(1), v);
        }
      }
      if (store.vars.get(first) === void 0 || store.vars.get(first) === null) {
        const initial = store.initials.get(first);
        if (initial !== void 0 && initial !== null) {
          return parts.length === 1 ? initial : walk(parts.slice(1), initial);
        }
      }
      return walk(parts.slice(1), store.vars.get(first) ?? null);
    },
    // re-exported value ops (ONE table — the compiled helpers import these too)
    number,
    string,
    truthy,
    equals: jseEquals,
    compare,
    arith,
    typeofString,
    watchKey,
    asArray,
    asRows,
    index,
    member,
    higherOrderFns,
    methodFns,
    afterRender(work) {
      JSESeams.afterRenderDispatch(work);
    }
  };
  function walk(parts, value) {
    let cur = value;
    for (const p of parts) {
      if (p === "length" && !isDict(cur)) {
        if (typeof cur === "string") {
          cur = charCount(cur);
          continue;
        }
        if (Array.isArray(cur)) {
          cur = cur.length;
          continue;
        }
      }
      if (p === "__proto__" || p === "constructor" || p === "prototype") {
        cur = null;
        continue;
      }
      const i = /^\d+$/.test(p) ? parseInt(p, 10) : null;
      if (i !== null && Array.isArray(cur)) {
        cur = i >= 0 && i < cur.length ? cur[i] : null;
      } else {
        cur = isDict(cur) ? cur[p] ?? null : null;
      }
    }
    return cur === void 0 ? null : cur;
  }
  function arrayFrom(a, store) {
    const src = a[0];
    let items;
    if (Array.isArray(src))
      items = src;
    else if (isDict(src) && Object.keys(src).length === 1) {
      const len = number(src["length"]);
      if (len === null || !Number.isFinite(len))
        return JSECrypto.call("Array.from", a);
      const nn = Math.max(0, Math.min(Math.trunc(len), 1e4));
      items = new Array(nn).fill(NSNull);
    } else
      return JSECrypto.call("Array.from", a);
    const fn = a[1];
    if (!isLambda(fn))
      return items;
    return items.map((e, i) => JSE.callLambda(fn, [e, i], store) ?? NSNull);
  }
  var Parser = class _Parser {
    pos = 0;
    depth = 0;
    // expression-nesting budget — see expression()
    tokens;
    store;
    item;
    constructor(tokens, store, item) {
      this.tokens = tokens;
      this.store = store;
      this.item = item;
    }
    peek() {
      return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
    }
    advance() {
      this.pos += 1;
    }
    op(s) {
      const t = this.peek();
      return t !== null && t.kind === "op" && t.v === s;
    }
    anyOp(list) {
      const t = this.peek();
      return t !== null && t.kind === "op" && list.includes(t.v) ? t.v : null;
    }
    expression() {
      while (this.op(";"))
        this.advance();
      if (this.depth >= 200)
        return null;
      this.depth += 1;
      const v = this.ternary();
      this.depth -= 1;
      return v;
    }
    ternary() {
      const cond = this.nullish();
      if (!this.op("?"))
        return cond;
      this.advance();
      const a = this.expression();
      if (this.op(":"))
        this.advance();
      const b = this.expression();
      return truthy(cond) ? a : b;
    }
    nullish() {
      let l = this.logicalOr();
      while (this.op("??")) {
        this.advance();
        const r = this.logicalOr();
        l = isMissing(l) ? r : l;
      }
      return l;
    }
    logicalOr() {
      let l = this.logicalAnd();
      while (this.op("||")) {
        this.advance();
        const r = this.logicalAnd();
        l = truthy(l) ? l : r;
      }
      return l;
    }
    logicalAnd() {
      let l = this.bitOr();
      while (this.op("&&")) {
        this.advance();
        const r = this.bitOr();
        l = truthy(l) ? r : l;
      }
      return l;
    }
    bitOr() {
      let l = this.bitXor();
      while (this.op("|")) {
        this.advance();
        l = bitOp(l, this.bitXor(), "|");
      }
      return l;
    }
    bitXor() {
      let l = this.bitAnd();
      while (this.op("^")) {
        this.advance();
        l = bitOp(l, this.bitAnd(), "^");
      }
      return l;
    }
    bitAnd() {
      let l = this.equality();
      while (this.op("&")) {
        this.advance();
        l = bitOp(l, this.equality(), "&");
      }
      return l;
    }
    equality() {
      let l = this.comparison();
      for (; ; ) {
        const o = this.anyOp(["===", "!==", "==", "!="]);
        if (o === null)
          break;
        this.advance();
        const r = this.comparison();
        const eq = jseEquals(l, r);
        l = o.startsWith("!") ? !eq : eq;
      }
      return l;
    }
    comparison() {
      let l = this.shift();
      for (; ; ) {
        const o = this.anyOp(["<", "<=", ">", ">="]);
        if (o !== null) {
          this.advance();
          l = compare(l, this.shift(), o);
          continue;
        }
        const t = this.peek();
        if (t !== null && t.kind === "ident" && t.v === "in") {
          this.advance();
          l = inOp(l, this.shift());
          continue;
        }
        break;
      }
      return l;
    }
    shift() {
      let l = this.additive();
      for (; ; ) {
        const o = this.anyOp(["<<", ">>", ">>>"]);
        if (o === null)
          break;
        this.advance();
        l = bitOp(l, this.additive(), o);
      }
      return l;
    }
    additive() {
      let l = this.multiplicative();
      for (; ; ) {
        const o = this.anyOp(["+", "-"]);
        if (o === null)
          break;
        this.advance();
        l = arith(l, this.multiplicative(), o);
      }
      return l;
    }
    multiplicative() {
      let l = this.power();
      for (; ; ) {
        const o = this.anyOp(["*", "/", "%"]);
        if (o === null)
          break;
        this.advance();
        l = arith(l, this.power(), o);
      }
      return l;
    }
    power() {
      const l = this.unary();
      if (!this.op("**"))
        return l;
      this.advance();
      return powOp(l, this.power());
    }
    unary() {
      if (this.op("!")) {
        this.advance();
        return !truthy(this.unary());
      }
      if (this.op("-")) {
        this.advance();
        return -(number(this.unary()) ?? 0);
      }
      if (this.op("+")) {
        this.advance();
        return number(this.unary()) ?? 0;
      }
      if (this.op("~")) {
        this.advance();
        return bitNot(this.unary());
      }
      const t = this.peek();
      if (t !== null && t.kind === "ident" && t.v === "typeof") {
        this.advance();
        return typeofString(this.unary());
      }
      return this.primary();
    }
    primary() {
      let base = this.primaryBase();
      for (; ; ) {
        if (this.op("[")) {
          this.advance();
          const idx = this.expression();
          if (this.op("]"))
            this.advance();
          base = index(base, idx);
        } else if (this.op(".") || this.op("?.")) {
          const optional = this.op("?.");
          this.advance();
          if (optional && this.op("(")) {
            if (isLambda(base))
              continue;
            this.skipBalanced("(", ")");
            base = null;
            continue;
          }
          if (optional && this.op("[")) {
            this.advance();
            const idx = this.expression();
            if (this.op("]"))
              this.advance();
            base = index(base, idx);
            continue;
          }
          const mt = this.peek();
          if (mt === null || mt.kind !== "ident")
            break;
          let m = mt.v;
          this.advance();
          if (this.op("(")) {
            if (m.includes(".")) {
              const dot = m.lastIndexOf(".");
              for (const seg of m.substring(0, dot).split("."))
                base = member(base, seg);
              m = m.substring(dot + 1);
            }
            this.advance();
            if (higherOrderFns.has(m)) {
              let fn = null, initVal = null, hasInit = false;
              if (!this.op(")")) {
                fn = this.expression();
                if (this.op(",")) {
                  this.advance();
                  initVal = this.expression();
                  hasInit = true;
                }
              }
              if (this.op(")"))
                this.advance();
              base = JSE.higherOrder(m, base, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
            } else {
              const args = [];
              if (!this.op(")")) {
                this.pushArg(args);
                while (this.op(",")) {
                  this.advance();
                  this.pushArg(args);
                }
              }
              if (this.op(")"))
                this.advance();
              base = JSE.applyMethod(m, base, args);
            }
          } else if (m.includes(".")) {
            for (const seg of m.split("."))
              base = member(base, seg);
          } else {
            base = member(base, m);
          }
        } else if (this.op("(") && isLambda(base)) {
          this.advance();
          const args = [];
          if (!this.op(")")) {
            this.pushArg(args);
            while (this.op(",")) {
              this.advance();
              this.pushArg(args);
            }
          }
          if (this.op(")"))
            this.advance();
          if (this.store.fnDepth >= 32) {
            base = null;
            continue;
          }
          this.store.fnDepth += 1;
          base = JSE.callLambda(base, args, this.store);
          this.store.fnDepth -= 1;
        } else
          break;
      }
      return base;
    }
    /** One call argument — `...expr` splices the coerced iterable (call-position spread,
     *  wave 3); shared by every arg-collection loop below. */
    pushArg(args) {
      if (this.op("...")) {
        this.advance();
        args.push(...spreadValues(this.expression()));
      } else {
        args.push(this.expression());
      }
    }
    primaryBase() {
      const t = this.peek();
      if (t === null)
        return null;
      if (t.kind === "num") {
        this.advance();
        return t.v;
      }
      if (t.kind === "str") {
        this.advance();
        return t.v;
      }
      if (t.kind === "regex") {
        this.advance();
        return globalThis.__DSX_OPTIONAL_REGEX__ !== false ? { __regex: true, source: t.pattern, flags: t.flags } : null;
      }
      if (t.kind === "template") {
        this.advance();
        let out = "";
        for (const part of t.parts) {
          if ("s" in part)
            out += part.s;
          else
            out += string(new _Parser(part.toks, this.store, this.item).expression());
        }
        return out;
      }
      if (t.kind === "ident") {
        const id = t.v;
        this.advance();
        if (id === "new")
          return this.primaryBase();
        if (id === "await") {
          const v = this.primaryBase();
          return v instanceof Promise ? null : v;
        }
        if (this.op("=>")) {
          this.advance();
          return this.arrowBody([{ name: id, keys: [] }]);
        }
        if (this.op("(")) {
          if (id === "Object.groupBy" || id === "Array.from") {
            this.advance();
            const args2 = [];
            if (!this.op(")")) {
              this.pushArg(args2);
              while (this.op(",")) {
                this.advance();
                this.pushArg(args2);
              }
            }
            if (this.op(")"))
              this.advance();
            if (id === "Object.groupBy") {
              const fn = args2[1];
              return JSE.higherOrder("groupBy", args2[0] ?? null, isLambda(fn) ? fn : null, this.store);
            }
            return arrayFrom(args2, this.store);
          }
          const dot = id.lastIndexOf(".");
          if (dot >= 0 && !JSECore.handles(id)) {
            const method = id.substring(dot + 1);
            if (higherOrderFns.has(method) || methodFns.has(method)) {
              const baseVal = JSE.lookup(id.substring(0, dot), this.store, this.item);
              this.advance();
              if (higherOrderFns.has(method)) {
                let fn = null, initVal = null, hasInit = false;
                if (!this.op(")")) {
                  fn = this.expression();
                  if (this.op(",")) {
                    this.advance();
                    initVal = this.expression();
                    hasInit = true;
                  }
                }
                if (this.op(")"))
                  this.advance();
                return JSE.higherOrder(method, baseVal, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
              }
              const args2 = [];
              if (!this.op(")")) {
                this.pushArg(args2);
                while (this.op(",")) {
                  this.advance();
                  this.pushArg(args2);
                }
              }
              if (this.op(")"))
                this.advance();
              return JSE.applyMethod(method, baseVal, args2);
            }
          }
          if (higherOrderFns.has(id)) {
            this.advance();
            const coll = this.expression();
            let fn = null, initVal = null, hasInit = false;
            if (this.op(",")) {
              this.advance();
              fn = this.expression();
            }
            if (this.op(",")) {
              this.advance();
              initVal = this.expression();
              hasInit = true;
            }
            if (this.op(")"))
              this.advance();
            return JSE.higherOrder(id, coll, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
          }
          const scopeFn = JSE.lookup(id, this.store, this.item);
          const fromScope = isLambda(scopeFn);
          const any = fromScope ? scopeFn : this.store.functions.get(id) ?? globalFunctions.get(id);
          if (isLambda(any)) {
            this.advance();
            const args2 = [];
            if (!this.op(")")) {
              this.pushArg(args2);
              while (this.op(",")) {
                this.advance();
                this.pushArg(args2);
              }
            }
            if (this.op(")"))
              this.advance();
            if (this.store.fnDepth >= 32)
              return null;
            this.store.fnDepth += 1;
            const v = JSE.callLambda(any, args2, this.store, fromScope ? this.item : null);
            this.store.fnDepth -= 1;
            return v;
          }
          this.advance();
          const args = [];
          if (!this.op(")")) {
            this.pushArg(args);
            while (this.op(",")) {
              this.advance();
              this.pushArg(args);
            }
          }
          if (this.op(")"))
            this.advance();
          return JSE.apply(id, args, this.store);
        }
        switch (id) {
          case "true":
            return true;
          case "false":
            return false;
          case "null":
          case "nil":
          case "undefined":
            return null;
          default:
            return JSE.lookup(id, this.store, this.item) ?? JSECore.constant(id);
        }
      }
      if (t.v === "[") {
        this.advance();
        const arr = [];
        while (this.peek() !== null && !this.op("]")) {
          if (this.op("...")) {
            this.advance();
            arr.push(...spreadValues(this.expression()));
          } else {
            arr.push(this.expression() ?? NSNull);
          }
          if (this.op(","))
            this.advance();
        }
        if (this.op("]"))
          this.advance();
        return arr;
      }
      if (t.v === "{") {
        this.advance();
        const obj = {};
        while (this.peek() !== null && !this.op("}")) {
          if (this.op("...")) {
            this.advance();
            const src = this.expression();
            if (isDict(src))
              Object.assign(obj, src);
            if (this.op(","))
              this.advance();
            continue;
          }
          const kt = this.peek();
          let key;
          let computed = false;
          if (this.op("[")) {
            this.advance();
            key = string(this.expression());
            if (this.op("]"))
              this.advance();
            computed = true;
          } else if (kt !== null && kt.kind === "ident") {
            key = kt.v;
            this.advance();
          } else if (kt !== null && kt.kind === "str") {
            key = kt.v;
            this.advance();
          } else if (kt !== null && kt.kind === "num") {
            key = string(kt.v);
            this.advance();
          } else {
            this.advance();
            continue;
          }
          if (this.op(":")) {
            this.advance();
            obj[key] = this.expression() ?? NSNull;
          } else if (computed)
            obj[key] = NSNull;
          else
            obj[key] = JSE.lookup(key, this.store, this.item) ?? NSNull;
          if (this.op(","))
            this.advance();
        }
        if (this.op("}"))
          this.advance();
        return obj;
      }
      if (t.v === "(") {
        const lam = this.tryArrow();
        if (lam !== null)
          return lam;
        this.advance();
        const v = this.expression();
        if (this.op(")"))
          this.advance();
        return v;
      }
      this.advance();
      return null;
    }
    /** `(params) => body` — detected by an `=>` after the matching `)`. Named params take
     *  an optional `= default` (call-time, callee scope) and a `...rest` binds the
     *  remaining args as an array; destructured `{a,b}` params take neither (wave 3). */
    tryArrow() {
      let d = 0;
      let j = this.pos;
      while (j < this.tokens.length) {
        const tk = this.tokens[j];
        if (tk.kind === "op" && tk.v === "(")
          d += 1;
        else if (tk.kind === "op" && tk.v === ")") {
          d -= 1;
          if (d === 0)
            break;
        }
        j += 1;
      }
      const after = j + 1 < this.tokens.length ? this.tokens[j + 1] : null;
      if (!(after !== null && after.kind === "op" && after.v === "=>"))
        return null;
      this.advance();
      const scan = parseArrowParams(this.tokens, this.pos);
      this.pos = scan.next;
      const params = scan.params;
      scan.defaults.forEach((def, k) => {
        if (def !== null && params[k] !== void 0)
          params[k].def = def;
      });
      if (this.op("=>"))
        this.advance();
      return this.arrowBody(params);
    }
    /** Skip past one balanced group WITHOUT evaluating anything inside — the optional-call
     *  short-circuit, where JS specifies the arguments are never evaluated. */
    skipBalanced(open, close) {
      if (!this.op(open))
        return;
      let d = 0;
      for (; ; ) {
        const tk = this.peek();
        if (tk === null)
          return;
        if (tk.kind === "op") {
          if (tk.v === open)
            d += 1;
          else if (tk.v === close) {
            d -= 1;
            if (d === 0) {
              this.advance();
              return;
            }
          }
        }
        this.advance();
      }
    }
    /** Capture a balanced `{…}` / `[…]` group INCLUDING its brackets, advancing past it.
     *  Used for destructured arrow params so they read through the one pattern parser. */
    balancedGroup() {
      const out = [];
      let d = 0;
      for (; ; ) {
        const tk = this.peek();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          if (tk.v === "{" || tk.v === "[" || tk.v === "(")
            d += 1;
          else if (tk.v === "}" || tk.v === "]" || tk.v === ")")
            d -= 1;
        }
        out.push(tk);
        this.advance();
        if (d === 0)
          break;
      }
      return out;
    }
    /** Capture one arrow-param default's tokens — to the next top-level `,` or the
     *  params' closing `)` (nested brackets stay whole). */
    defaultTokens() {
      const body = [];
      let d = 0;
      for (; ; ) {
        const tk = this.peek();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          const o = tk.v;
          if (o === "(" || o === "[" || o === "{")
            d += 1;
          else if (o === ")" || o === "]" || o === "}") {
            if (d === 0)
              break;
            d -= 1;
          } else if (d === 0 && o === ",")
            break;
        }
        body.push(tk);
        this.advance();
      }
      return body;
    }
    /** After `=>`: capture the body — a `{ }` block or one expression — as a lambda value. */
    arrowBody(params) {
      if (this.op("{")) {
        this.advance();
        const body2 = [];
        let d2 = 1;
        for (; ; ) {
          const tk = this.peek();
          if (tk === null)
            break;
          if (tk.kind === "op" && tk.v === "{")
            d2 += 1;
          else if (tk.kind === "op" && tk.v === "}") {
            d2 -= 1;
            if (d2 === 0) {
              this.advance();
              break;
            }
          }
          body2.push(tk);
          this.advance();
        }
        return makeLambda(params, body2, true, { ...this.item ?? {} });
      }
      const body = [];
      let d = 0;
      for (; ; ) {
        const tk = this.peek();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          const o = tk.v;
          if (o === "(" || o === "[" || o === "{")
            d += 1;
          else if (o === ")" || o === "]" || o === "}") {
            if (d === 0)
              break;
            d -= 1;
          } else if (d === 0 && o === ",")
            break;
        }
        body.push(tk);
        this.advance();
      }
      return makeLambda(params, body, false, { ...this.item ?? {} });
    }
  };
  function splitTopLevel(toks) {
    const out = [];
    let cur = [];
    let d = 0;
    for (const tk of toks) {
      if (tk.kind === "op") {
        if (tk.v === "(" || tk.v === "[" || tk.v === "{")
          d += 1;
        else if (tk.v === ")" || tk.v === "]" || tk.v === "}")
          d -= 1;
        else if (d === 0 && tk.v === ",") {
          out.push(cur);
          cur = [];
          continue;
        }
      }
      cur.push(tk);
    }
    out.push(cur);
    return out;
  }
  function setInLocal(container, parts, value) {
    if (parts.length === 0)
      return value;
    const head = parts[0];
    const rest = parts.slice(1);
    if (Array.isArray(container)) {
      const idx = number(head);
      if (idx !== null) {
        const i = Math.trunc(idx);
        const copy = [...container];
        if (i >= 0 && i < copy.length)
          copy[i] = setInLocal(copy[i], rest, value);
        else if (i === copy.length)
          copy.push(setInLocal(null, rest, value));
        return copy;
      }
    }
    const d = isDict(container) ? { ...container } : {};
    const key = string(head);
    d[key] = setInLocal(d[key] ?? null, rest, value);
    return d;
  }
  function getInLocal(container, parts) {
    let cur = container;
    for (const p of parts) {
      if (Array.isArray(cur)) {
        const idx = number(p);
        cur = idx !== null && idx >= 0 && idx < cur.length ? cur[Math.trunc(idx)] : null;
      } else if (isDict(cur)) {
        cur = cur[string(p)] ?? null;
      } else {
        return null;
      }
    }
    return cur ?? null;
  }
  function loopStep(e) {
    const b = e.budget ??= { used: 0 };
    b.used += 1;
    return b.used <= 1e4;
  }
  function runCaptured(e, body) {
    const sub = new JSEval(body, e.store, e.scope, true);
    sub.budget = e.budget ??= { used: 0 };
    sub.runBlock();
    if (sub.done) {
      e.result = sub.result;
      e.done = true;
    }
    e.flow = sub.flow;
  }
  function captureBranchTokens(e) {
    if (e.isOp("{")) {
      e.i += 1;
      const out2 = [];
      let d = 1;
      for (; ; ) {
        const tk = e.cur();
        if (tk === null)
          break;
        if (tk.kind === "op" && tk.v === "{")
          d += 1;
        else if (tk.kind === "op" && tk.v === "}") {
          d -= 1;
          if (d === 0) {
            e.i += 1;
            break;
          }
        }
        out2.push(tk);
        e.i += 1;
      }
      return out2;
    }
    const out = e.capture(/* @__PURE__ */ new Set([";"]));
    if (e.isOp(";"))
      e.i += 1;
    return out;
  }
  function splitOnSemis(toks) {
    const out = [];
    let cur = [];
    let d = 0;
    for (const tk of toks) {
      if (tk.kind === "op") {
        if (tk.v === "(" || tk.v === "[" || tk.v === "{")
          d += 1;
        else if (tk.v === ")" || tk.v === "]" || tk.v === "}")
          d -= 1;
        else if (d === 0 && tk.v === ";") {
          out.push(cur);
          cur = [];
          continue;
        }
      }
      cur.push(tk);
    }
    out.push(cur);
    return out;
  }
  function baseFor(e, name) {
    return Object.prototype.hasOwnProperty.call(e.scope, name) ? e.scope[name] : e.evalExpr([{ kind: "ident", v: name }]);
  }
  function evalSegs(e, segs) {
    return segs.map((s) => typeof s === "string" ? s : e.evalExpr(s));
  }
  function readAt(e, name, parts) {
    return getInLocal(baseFor(e, name), parts);
  }
  function mutation(e, toks) {
    const t0 = toks[0];
    if (toks.length < 2 || t0 === void 0 || t0.kind !== "ident")
      return false;
    const head = t0.v.split(".");
    const name = head[0];
    if (name.length === 0 || name === "dsx" || name === "global" || name === "route" || name === "cookie")
      return false;
    const segs = head.slice(1);
    let j = 1;
    for (; ; ) {
      const a = toks[j];
      const b = toks[j + 1];
      if (a !== void 0 && a.kind === "op" && a.v === "." && b !== void 0 && b.kind === "ident") {
        for (const part of b.v.split("."))
          segs.push(part);
        j += 2;
        continue;
      }
      if (a !== void 0 && a.kind === "op" && a.v === "[") {
        const inner = [];
        let d = 1;
        let k = j + 1;
        while (k < toks.length) {
          const tk = toks[k];
          if (tk.kind === "op" && (tk.v === "[" || tk.v === "(" || tk.v === "{"))
            d += 1;
          if (tk.kind === "op" && (tk.v === "]" || tk.v === ")" || tk.v === "}")) {
            d -= 1;
            if (d === 0)
              break;
          }
          inner.push(tk);
          k += 1;
        }
        if (k >= toks.length)
          return false;
        segs.push(inner);
        j = k + 1;
        continue;
      }
      break;
    }
    const bump = toks[j];
    if (bump !== void 0 && bump.kind === "op" && (bump.v === "++" || bump.v === "--") && j === toks.length - 1) {
      const parts2 = evalSegs(e, segs);
      const value2 = arith(readAt(e, name, parts2), 1, bump.v === "++" ? "+" : "-");
      if (parts2.length === 0)
        e.scope[name] = value2 ?? NSNull;
      else
        e.scope[name] = setInLocal(baseFor(e, name), parts2, value2 ?? NSNull);
      return true;
    }
    const last = segs.length > 0 ? segs[segs.length - 1] : void 0;
    const after = toks[j];
    if (last === "push" && after !== void 0 && after.kind === "op" && after.v === "(") {
      let d = 1;
      let k = j + 1;
      const inner = [];
      while (k < toks.length) {
        const tk = toks[k];
        if (tk.kind === "op" && (tk.v === "(" || tk.v === "[" || tk.v === "{"))
          d += 1;
        if (tk.kind === "op" && (tk.v === ")" || tk.v === "]" || tk.v === "}")) {
          d -= 1;
          if (d === 0)
            break;
        }
        inner.push(tk);
        k += 1;
      }
      if (d !== 0 || k !== toks.length - 1)
        return false;
      segs.pop();
      const parts2 = evalSegs(e, segs);
      const arr = [...asArray(readAt(e, name, parts2))];
      for (const argToks of splitTopLevel(inner))
        if (argToks.length > 0)
          arr.push(e.evalExpr(argToks) ?? NSNull);
      e.scope[name] = setInLocal(baseFor(e, name), parts2, arr);
      return true;
    }
    const op = toks[j];
    if (op === void 0 || op.kind !== "op")
      return false;
    if (op.v !== "=" && op.v !== "+=" && op.v !== "-=" && op.v !== "*=" && op.v !== "/=" && op.v !== "%=")
      return false;
    const rhsToks = toks.slice(j + 1);
    if (rhsToks.length === 0)
      return false;
    const rhs = e.evalExpr(rhsToks);
    const parts = evalSegs(e, segs);
    const value = op.v === "=" ? rhs : arith(readAt(e, name, parts), rhs, op.v.substring(0, 1));
    if (parts.length === 0) {
      e.scope[name] = value ?? NSNull;
      return true;
    }
    e.scope[name] = setInLocal(baseFor(e, name), parts, value ?? NSNull);
    return true;
  }
  function forStmt(e, execute) {
    e.i += 1;
    const head = e.captureParen();
    const body = captureBranchTokens(e);
    if (!execute)
      return;
    const parts = splitOnSemis(head);
    if (parts.length === 3) {
      runCaptured(e, parts[0]);
      if (e.done)
        return;
      e.flow = void 0;
      for (; ; ) {
        if (parts[1].length > 0 && !truthy(e.evalExpr(parts[1])))
          break;
        if (!loopStep(e))
          break;
        runCaptured(e, body);
        if (e.done)
          return;
        if (e.flow === "break") {
          e.flow = void 0;
          break;
        }
        e.flow = void 0;
        runCaptured(e, parts[2]);
        if (e.done)
          return;
        e.flow = void 0;
      }
      return;
    }
    let p = 0;
    const first = head[p];
    if (first !== void 0 && first.kind === "ident" && (first.v === "const" || first.v === "let" || first.v === "var"))
      p += 1;
    let kwAt = -1;
    let kind = null;
    let d = 0;
    for (let k = p; k < head.length; k += 1) {
      const tk = head[k];
      if (tk.kind === "op") {
        if (tk.v === "(" || tk.v === "[" || tk.v === "{")
          d += 1;
        else if (tk.v === ")" || tk.v === "]" || tk.v === "}")
          d -= 1;
      }
      if (d === 0 && tk.kind === "ident" && (tk.v === "of" || tk.v === "in")) {
        kwAt = k;
        kind = tk.v;
        break;
      }
    }
    if (kwAt < 0 || kind === null)
      return;
    const patToks = head.slice(p, kwAt);
    const exprToks = head.slice(kwAt + 1);
    const decls = parseDeclarators([...patToks, { kind: "op", v: "=" }, { kind: "num", v: 0 }]);
    if (decls.length !== 1)
      return;
    const pattern = decls[0].pattern;
    const seq = kind === "of" ? spreadValues(e.evalExpr(exprToks)) : forInKeys(e.evalExpr(exprToks));
    for (const el of seq) {
      if (!loopStep(e))
        break;
      bindPattern(pattern, el, (n, v) => {
        e.scope[n] = v ?? NSNull;
      }, (dts) => e.evalExpr(dts));
      runCaptured(e, body);
      if (e.done)
        return;
      if (e.flow === "break") {
        e.flow = void 0;
        break;
      }
      e.flow = void 0;
    }
  }
  function whileStmt(e, execute) {
    e.i += 1;
    const cond = e.captureParen();
    const body = captureBranchTokens(e);
    if (!execute)
      return;
    while (truthy(e.evalExpr(cond))) {
      if (!loopStep(e))
        break;
      runCaptured(e, body);
      if (e.done)
        return;
      if (e.flow === "break") {
        e.flow = void 0;
        break;
      }
      e.flow = void 0;
    }
  }
  function doStmt(e, execute) {
    e.i += 1;
    const body = captureBranchTokens(e);
    let cond = [];
    if (e.isKw("while")) {
      e.i += 1;
      cond = e.captureParen();
      if (e.isOp(";"))
        e.i += 1;
    }
    if (!execute)
      return;
    do {
      if (!loopStep(e))
        break;
      runCaptured(e, body);
      if (e.done)
        return;
      if (e.flow === "break") {
        e.flow = void 0;
        break;
      }
      e.flow = void 0;
    } while (truthy(e.evalExpr(cond)));
  }
  var BLOCK_ITERATION_IMPL = {
    loop(e, kind, execute) {
      if (kind === "for")
        forStmt(e, execute);
      else if (kind === "while")
        whileStmt(e, execute);
      else
        doStmt(e, execute);
    },
    mutation
  };
  var JSEval = class {
    i = 0;
    scope;
    result = null;
    done = false;
    flow;
    // loop control in flight (consumed by its loop; absent = none)
    budget;
    // iteration ledger, created lazily by the impl (10k, the runner's law)
    t;
    store;
    constructor(t, store, scope, share = false) {
      this.t = t;
      this.store = store;
      this.scope = share ? scope : { ...scope };
    }
    cur() {
      return this.i < this.t.length ? this.t[this.i] : null;
    }
    isOp(s) {
      const tk = this.cur();
      return tk !== null && tk.kind === "op" && tk.v === s;
    }
    isKw(s) {
      const tk = this.cur();
      return tk !== null && tk.kind === "ident" && tk.v === s;
    }
    runBlock() {
      while (!this.done && (!(globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) || this.flow === void 0)) {
        const tk = this.cur();
        if (tk === null)
          return;
        if (tk.kind === "op" && tk.v === "}")
          return;
        if (tk.kind === "op" && tk.v === ";") {
          this.i += 1;
          continue;
        }
        const before = this.i;
        this.statement(true);
        if (this.i === before)
          this.i += 1;
      }
    }
    skipBranch() {
      if (this.isOp("{")) {
        let d = 0;
        for (; ; ) {
          const tk = this.cur();
          if (tk === null)
            return;
          if (tk.kind === "op" && tk.v === "{")
            d += 1;
          else if (tk.kind === "op" && tk.v === "}") {
            d -= 1;
            this.i += 1;
            if (d === 0)
              return;
            continue;
          }
          this.i += 1;
        }
      } else {
        for (; ; ) {
          const tk = this.cur();
          if (tk === null)
            return;
          if (tk.kind === "op" && tk.v === ";") {
            this.i += 1;
            return;
          }
          if (tk.kind === "op" && tk.v === "}")
            return;
          this.i += 1;
        }
      }
    }
    branch(execute) {
      if (!execute) {
        this.skipBranch();
        return;
      }
      if (this.isOp("{")) {
        this.i += 1;
        this.runBlock();
        if (this.isOp("}"))
          this.i += 1;
      } else
        this.statement(true);
    }
    statement(execute) {
      if (this.isKw("function")) {
        this.skipFunction();
        return;
      }
      if (this.isKw("if")) {
        this.ifStmt(execute);
        return;
      }
      if (globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__ !== false && (this.isKw("for") || this.isKw("while") || this.isKw("do"))) {
        const kind = this.isKw("for") ? "for" : this.isKw("while") ? "while" : "do";
        BLOCK_ITERATION_IMPL.loop(this, kind, execute);
        return;
      }
      if (globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__ !== false && (this.isKw("break") || this.isKw("continue"))) {
        const f = this.isKw("break") ? "break" : "continue";
        this.i += 1;
        if (this.isOp(";"))
          this.i += 1;
        if (execute)
          this.flow = f;
        return;
      }
      if (this.isKw("const") || this.isKw("let") || this.isKw("var")) {
        this.declStmt(execute);
        return;
      }
      if (this.isKw("return")) {
        this.returnStmt(execute);
        return;
      }
      const toks = this.capture(/* @__PURE__ */ new Set([";"]));
      if (this.isOp(";"))
        this.i += 1;
      if (execute && !this.done)
        this.exprStatement(toks);
    }
    ifStmt(execute) {
      this.i += 1;
      let cond = false;
      const c = this.captureParen();
      if (execute)
        cond = truthy(this.evalExpr(c));
      this.branch(execute && cond);
      if (this.isKw("else")) {
        this.i += 1;
        if (this.isKw("if"))
          this.ifStmt(execute && !cond);
        else
          this.branch(execute && !cond);
      }
    }
    declStmt(execute) {
      this.i += 1;
      const toks = this.capture(/* @__PURE__ */ new Set([";"]));
      if (this.isOp(";"))
        this.i += 1;
      if (!execute)
        return;
      for (const d of parseDeclarators(toks)) {
        const v = d.expr.length === 0 ? null : this.evalExpr(d.expr);
        bindPattern(d.pattern, v, (n, val) => {
          this.scope[n] = val ?? NSNull;
        }, (toks2) => this.evalExpr(toks2));
      }
    }
    returnStmt(execute) {
      this.i += 1;
      const toks = this.capture(/* @__PURE__ */ new Set([";"]));
      if (this.isOp(";"))
        this.i += 1;
      if (execute) {
        this.result = toks.length === 0 ? null : this.evalExpr(toks);
        this.done = true;
      }
    }
    skipFunction() {
      for (; ; ) {
        const tk = this.cur();
        if (tk === null)
          break;
        if (tk.kind === "op" && tk.v === "{")
          break;
        this.i += 1;
      }
      this.skipBranch();
    }
    exprStatement(toks) {
      if (toks.length >= 4 && toks[0].kind === "op" && toks[0].v === "[") {
        const decls = parseDeclarators(toks);
        const d0 = decls.length === 1 ? decls[0] : null;
        if (d0 !== null && d0.pattern.kind === "array" && d0.expr.length > 0 && (d0.pattern.items.some((it) => it !== null) || d0.pattern.rest !== void 0)) {
          const v = this.evalExpr(d0.expr);
          bindPattern(d0.pattern, v, (n, val) => {
            this.scope[n] = val ?? NSNull;
          }, (dts) => this.evalExpr(dts));
          return;
        }
      }
      if (toks.length >= 2) {
        const t0 = toks[0];
        const t1 = toks[1];
        if (t0.kind === "ident" && (!(globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) || !t0.v.includes(".")) && t1.kind === "op" && t1.v === "=") {
          this.scope[t0.v] = this.evalExpr(toks.slice(2)) ?? NSNull;
          return;
        }
      }
      if (globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) {
        const lead = toks[0];
        if (lead !== void 0 && lead.kind === "op" && (lead.v === "++" || lead.v === "--")) {
          if (BLOCK_ITERATION_IMPL.mutation(this, [...toks.slice(1), lead]))
            return;
        }
        if (BLOCK_ITERATION_IMPL.mutation(this, toks))
          return;
      }
      this.result = this.evalExpr(toks);
    }
    capture(stops) {
      const out = [];
      let d = 0;
      for (; ; ) {
        const tk = this.cur();
        if (tk === null)
          break;
        if (tk.kind === "op") {
          const o = tk.v;
          if (o === "(" || o === "[" || o === "{") {
            d += 1;
            out.push(tk);
            this.i += 1;
            continue;
          }
          if (o === ")" || o === "]" || o === "}") {
            if (d === 0)
              break;
            d -= 1;
            out.push(tk);
            this.i += 1;
            continue;
          }
          if (d === 0 && stops.has(o))
            break;
        }
        out.push(tk);
        this.i += 1;
      }
      return out;
    }
    captureParen() {
      const out = [];
      if (!this.isOp("("))
        return out;
      this.i += 1;
      let d = 1;
      for (; ; ) {
        const tk = this.cur();
        if (tk === null)
          break;
        if (tk.kind === "op" && tk.v === "(")
          d += 1;
        else if (tk.kind === "op" && tk.v === ")") {
          d -= 1;
          if (d === 0) {
            this.i += 1;
            break;
          }
        }
        out.push(tk);
        this.i += 1;
      }
      return out;
    }
    evalExpr(toks) {
      const p = new Parser(toks, this.store, this.scope);
      return p.expression();
    }
  };

  // ../CanvasEditor/src/canonical-jse.ts
  function toJseValue(value) {
    if (value === null) return NSNull;
    if (Array.isArray(value)) return value.map(toJseValue);
    if (value !== null && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = toJseValue(child);
      return out;
    }
    return value;
  }
  function evaluate(source, input = {}) {
    const spec = "vars" in input || "item" in input || "attrs" in input ? input : { vars: input };
    const vars = toJseValue(spec.vars ?? {});
    const store = new StackStore();
    for (const [key, value] of Object.entries(vars)) store.vars.set(key, value);
    const priorState = JSESeams.stateVars;
    const priorCookie = JSESeams.cookieJar;
    const priorPlatform = JSESeams.platformOS;
    JSESeams.stateVars = () => vars;
    JSESeams.cookieJar = () => vars.cookie && typeof vars.cookie === "object" ? vars.cookie : {};
    JSESeams.platformOS = spec.platform ?? "ios";
    try {
      const item = {
        ...spec.item && typeof spec.item === "object" ? toJseValue(spec.item) : {},
        ...spec.attrs && typeof spec.attrs === "object" ? toJseValue(spec.attrs) : {},
        item: toJseValue(spec.item ?? null),
        attribute: toJseValue(spec.attrs ?? {})
      };
      return JSE.eval(String(source), store, item);
    } finally {
      JSESeams.stateVars = priorState;
      JSESeams.cookieJar = priorCookie;
      JSESeams.platformOS = priorPlatform;
    }
  }
  var api = { evaluate };
  globalThis.DSXCanvasJSE = api;
})();
