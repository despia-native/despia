//
//  prose.ts — the PROSE PLANE: the default skin for rendered markdown (`.dsx-markdown`,
//  the `<markdown>` block element + the inline `<text markdown>` vocabulary inside it).
//  Before this sheet existed the block tree rendered as bare UA HTML — the one surface
//  a documentation site is mostly made of. The plane sets TYPE + RHYTHM + SURFACES
//  (headings, paragraph flow, band-header card tables, elevated code, chips, quotes,
//  rules, images, lists); the measured COLUMN stays the consumer's job.
//
//  Byte law (/web/13): this module rides the `__DSX_OPTIONAL_MARKDOWN__` fold. The
//  sheet reaches full apps through boot.ts (gated exactly like the element factory)
//  and SSR documents through @despia-native/server page assembly; the tokenizer below is
//  imported ONLY by markdown-blocks.ts, so a slice that authors no markdown
//  tree-shakes this whole file — an unrelated embed stays byte-identical.
//
//  The syntax TINT is render-time presentation, not grammar: the neutral block tree
//  and the markdown corpus are untouched (Kotlin/Swift render code their own way).
//  One tokenizer drives BOTH web consumers (DOM fragment + SSR string), so first
//  paint and hydration stay identical by construction. Scanning is single-pass and
//  regex-free — every branch advances the cursor, so hostile input degrades to plain
//  tokens instead of pathological time.
//

/** Tint ceiling — the block model already caps a document at 65,536 characters
 *  (MARKDOWN_BLOCK_LIMITS, not imported to keep this module leaf-shaped); past it the
 *  remainder is one plain token. */
export const CODE_TINT_LIMITS = { characters: 65_536 } as const;

export type CodeTokenKind =
  | "kw" | "str" | "com" | "num" | "typ" | "pun"
  | "fn" | "att" | "tag" | "cst" | "op";
export type CodeToken = { kind: CodeTokenKind | "plain"; text: string };

type Lexicon = {
  keywords: ReadonlySet<string>;
  /** capitalized identifiers read as types (SCREAMING_CASE reads as a constant) */
  capitalTypes: boolean;
  lineComments: readonly string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  /** `$name` / `${…}` / `@name` variables (bash, ruby ivars) */
  sigils?: readonly string[];
  /** literal value words — `true` / `nil` / `None` */
  constants?: ReadonlySet<string>;
  /** lowercase builtin type words — `string`, `int`, `void` */
  builtinTypes?: ReadonlySet<string>;
  /** `name(` reads as a call */
  callable?: boolean;
  /** the word after these keywords is a declaration name (`function` / `def` / `func` / `fun`) */
  functionKeywords?: ReadonlySet<string>;
  /** `@name` decorators/annotations */
  decorators?: boolean;
  /** backtick template strings with `${…}` interpolation */
  templates?: boolean;
  /** `"key":` object keys (json) */
  keyStrings?: boolean;
  /** line-leading `key:` mapping keys (yaml) */
  lineKeys?: boolean;
  /** `:name` symbols (ruby) */
  symbols?: boolean;
  /** shell semantics: line-leading command position, `-flags` */
  commandLine?: boolean;
};

const TS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new",
  "of", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "super", "switch", "this", "throw", "try", "type",
  "typeof", "var", "while", "yield",
]);
const TS_CONSTANTS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const TS_TYPES = new Set([
  "any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "unknown", "void",
]);
const SWIFT_KEYWORDS = new Set([
  "actor", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
  "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
  "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "init",
  "inout", "internal", "is", "lazy", "let", "mutating", "open", "operator", "override",
  "private", "protocol", "public", "repeat", "required", "rethrows", "return", "self", "some",
  "static", "struct", "subscript", "super", "switch", "throw", "throws", "try",
  "typealias", "var", "weak", "where", "while",
]);
const KOTLIN_KEYWORDS = new Set([
  "abstract", "as", "break", "by", "catch", "class", "companion", "const", "continue",
  "data", "do", "else", "enum", "final", "finally", "for", "fun", "if", "import",
  "in", "init", "inline", "interface", "internal", "is", "lateinit", "object",
  "open", "operator", "out", "override", "package", "private", "protected", "public",
  "return", "sealed", "super", "suspend", "this", "throw", "try", "typealias",
  "val", "var", "when", "while",
]);
const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "break", "case", "catch", "class",
  "const", "continue", "default", "do", "else", "enum", "extends",
  "final", "finally", "for", "if", "implements", "import", "instanceof",
  "interface", "native", "new", "package", "private", "protected",
  "public", "record", "return", "static", "super", "switch", "synchronized",
  "this", "throw", "throws", "transient", "try", "var", "volatile", "while",
]);
const JAVA_TYPES = new Set(["boolean", "byte", "char", "double", "float", "int", "long", "short", "void"]);
const RUBY_KEYWORDS = new Set([
  "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else",
  "elsif", "end", "ensure", "for", "if", "in", "module", "next", "not",
  "or", "raise", "redo", "require", "require_relative", "rescue", "retry", "return",
  "self", "super", "then", "undef", "unless", "until", "when", "while", "yield",
]);
const BASH_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "exit", "export", "fi", "for", "function",
  "if", "in", "local", "return", "select", "set", "shift", "then", "until", "while",
]);
/** shell prefixes whose FOLLOWING word is still the command */
const BASH_CHAINERS = new Set(["sudo", "env", "time", "xargs", "nohup", "exec"]);
const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
  "with", "yield",
]);
const BOOL_NULL = new Set(["true", "false", "null"]);
const YAML_CONSTANTS = new Set([
  "true", "false", "null", "yes", "no", "on", "off",
  "True", "False", "Null", "Yes", "No", "On", "Off",
]);

const LEXICONS: { [language: string]: Lexicon } = (() => {
  const table: { [language: string]: Lexicon } = {};
  const add = (names: string[], lexicon: Lexicon): void => {
    for (const name of names) table[name] = lexicon;
  };
  add(["ts", "tsx", "typescript", "js", "jsx", "javascript"], {
    keywords: TS_KEYWORDS, capitalTypes: true, lineComments: ["//"],
    blockComment: ["/*", "*/"], quotes: ['"', "'", "`"],
    constants: TS_CONSTANTS, builtinTypes: TS_TYPES, callable: true,
    functionKeywords: new Set(["function"]), decorators: true, templates: true,
  });
  add(["swift"], {
    keywords: SWIFT_KEYWORDS, capitalTypes: true, lineComments: ["//"],
    blockComment: ["/*", "*/"], quotes: ['"'],
    constants: new Set(["true", "false", "nil"]), callable: true,
    functionKeywords: new Set(["func"]), decorators: true,
  });
  add(["kotlin", "kt", "kts"], {
    keywords: KOTLIN_KEYWORDS, capitalTypes: true, lineComments: ["//"],
    blockComment: ["/*", "*/"], quotes: ['"'],
    constants: BOOL_NULL, callable: true,
    functionKeywords: new Set(["fun"]), decorators: true,
  });
  add(["java"], {
    keywords: JAVA_KEYWORDS, capitalTypes: true, lineComments: ["//"],
    blockComment: ["/*", "*/"], quotes: ['"'],
    constants: BOOL_NULL, builtinTypes: JAVA_TYPES, callable: true, decorators: true,
  });
  add(["json", "jsonc"], {
    keywords: new Set<string>(), capitalTypes: false, lineComments: ["//"], quotes: ['"'],
    constants: BOOL_NULL, keyStrings: true,
  });
  add(["bash", "sh", "shell", "zsh", "console"], {
    keywords: BASH_KEYWORDS, capitalTypes: false, lineComments: ["#"],
    quotes: ['"', "'"], sigils: ["$"], commandLine: true,
  });
  add(["ruby", "rb"], {
    keywords: RUBY_KEYWORDS, capitalTypes: true, lineComments: ["#"],
    quotes: ['"', "'"], sigils: ["@", "$"],
    constants: new Set(["true", "false", "nil"]), callable: true,
    functionKeywords: new Set(["def"]), symbols: true,
  });
  add(["yaml", "yml"], {
    keywords: new Set<string>(), capitalTypes: false,
    lineComments: ["#"], quotes: ['"', "'"],
    constants: YAML_CONSTANTS, lineKeys: true,
  });
  add(["python", "py"], {
    keywords: PYTHON_KEYWORDS, capitalTypes: true, lineComments: ["#"], quotes: ['"', "'"],
    constants: new Set(["True", "False", "None"]), callable: true,
    functionKeywords: new Set(["def"]), decorators: true,
  });
  return table;
})();

const MARKUP_LANGUAGES = new Set(["dsx", "xml", "html", "svg"]);

const isIdentStart = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
const isIdentPart = (ch: string): boolean =>
  isIdentStart(ch) || (ch >= "0" && ch <= "9") || ch === "-" || ch === "?";
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isHexDigit = (ch: string): boolean =>
  isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
/** operators stay visible; structural punctuation dims */
const isOperator = (ch: string): boolean => "=+-*/%<>!&|?~^".includes(ch);
const isPunct = (ch: string): boolean => "()[]{},;:.#@\\".includes(ch);
const isSpace = (ch: string): boolean => ch === " " || ch === "\t";
/** SCREAMING_CASE identifiers read as constants */
const isConstCase = (word: string): boolean => {
  if (word.length < 2 || word[0]! < "A" || word[0]! > "Z") return false;
  for (const ch of word) {
    if (!((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_")) return false;
  }
  return true;
};
/** the next code character on the line (spaces/tabs skipped; gaps are disjoint, so
 *  every peek is amortized single-pass) */
const peekCode = (text: string, from: number): string => {
  let k = from;
  while (k < text.length && isSpace(text[k]!)) k += 1;
  return text[k] ?? "";
};

/** Token sink with same-kind coalescing, so adjacent runs become ONE node in both
 *  consumers (adjacent DOM text nodes would serialize like SSR output but compare
 *  differently node-for-node — merged, the two trees are congruent). */
class Tokens {
  readonly out: CodeToken[] = [];
  push(kind: CodeToken["kind"], text: string): void {
    if (text.length === 0) return;
    const last = this.out[this.out.length - 1];
    if (last !== undefined && last.kind === kind) last.text += text;
    else this.out.push({ kind, text });
  }
}

function tokenizeMarkup(text: string): CodeToken[] {
  const tokens = new Tokens();
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? text.length : end + 3;
      tokens.push("com", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (text[i] === "<") {
      // the tag trichromacy: "<" or "</" dimmed, the NAME on the tag plane, then the
      // attribute run (names on the attribute plane, "=" dimmed, values as strings)
      let j = i + 1;
      if (text[j] === "/" || text[j] === "!" || text[j] === "?") j += 1;
      tokens.push("pun", text.slice(i, j));
      i = j;
      while (i < text.length && isIdentPart(text[i]!)) i += 1;
      tokens.push("tag", text.slice(j, i));
      // inside the tag until ">": attr names, "=", quoted values
      while (i < text.length && text[i] !== ">") {
        const ch = text[i]!;
        if (ch === '"' || ch === "'") {
          let k = i + 1;
          while (k < text.length && text[k] !== ch) k += 1;
          if (k < text.length) k += 1;
          tokens.push("str", text.slice(i, k));
          i = k;
        } else if (isIdentStart(ch)) {
          let k = i + 1;
          while (k < text.length && (isIdentPart(text[k]!) || text[k] === ":" || text[k] === ".")) k += 1;
          tokens.push("att", text.slice(i, k));
          i = k;
        } else if (ch === "=" || ch === "/") {
          tokens.push("pun", ch);
          i += 1;
        } else {
          tokens.push("plain", ch);
          i += 1;
        }
      }
      if (i < text.length) { tokens.push("pun", ">"); i += 1; }
      continue;
    }
    const next = text.indexOf("<", i);
    const stop = next === -1 ? text.length : next;
    tokens.push("plain", text.slice(i, stop));
    i = stop;
  }
  return tokens.out;
}

function tokenizeWithLexicon(text: string, lexicon: Lexicon, depth = 0): CodeToken[] {
  const tokens = new Tokens();
  let i = 0;
  // contextual slots — one-token lookbehind state, so scanning stays single-pass
  let pendingFn = false;    // the word after `function` / `def` / `func` / `fun`
  let boundary = true;      // at line start or after whitespace (shell flags)
  let keySlot = true;       // yaml: no mapping key emitted on this line yet
  let commandSlot = true;   // shell: the next bare word is the command
  outer: while (i < text.length) {
    const ch = text[i]!;
    const pending: boolean = pendingFn;
    const atBoundary: boolean = boundary;
    pendingFn = false;
    boundary = false;
    for (const opener of lexicon.lineComments) {
      if (text.startsWith(opener, i)) {
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? text.length : end;
        tokens.push("com", text.slice(i, stop));
        i = stop;
        continue outer;
      }
    }
    if (lexicon.blockComment !== undefined && text.startsWith(lexicon.blockComment[0], i)) {
      const end = text.indexOf(lexicon.blockComment[1], i + lexicon.blockComment[0].length);
      const stop = end === -1 ? text.length : end + lexicon.blockComment[1].length;
      tokens.push("com", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (lexicon.templates === true && ch === "`" && depth < 4) {
      i = scanTemplate(text, i, tokens, lexicon, depth);
      continue;
    }
    if (lexicon.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        // a backslash escape keeps an embedded quote inside the string run
        j += text[j] === "\\" && j + 1 < text.length ? 2 : 1;
        // plain quotes never span lines; template literals do
        if (ch !== "`" && text[j - 1] === "\n") { j -= 1; break; }
      }
      if (j < text.length && text[j] === ch) j += 1;
      // an object key reads as a property: `"name":` (json), line-leading (yaml)
      const key = (lexicon.keyStrings === true || (lexicon.lineKeys === true && keySlot))
        && peekCode(text, j) === ":";
      tokens.push(key ? "att" : "str", text.slice(i, j));
      keySlot = false;
      i = j;
      continue;
    }
    if (lexicon.sigils !== undefined && lexicon.sigils.includes(ch) && i + 1 < text.length
      && (isIdentStart(text[i + 1]!) || text[i + 1] === "{")) {
      let j = i + 1;
      if (text[j] === "{") {
        const end = text.indexOf("}", j);
        j = end === -1 ? text.length : end + 1;
      } else {
        while (j < text.length && isIdentPart(text[j]!)) j += 1;
      }
      tokens.push("cst", text.slice(i, j));
      keySlot = false;
      i = j;
      continue;
    }
    if (lexicon.symbols === true && ch === ":" && i + 1 < text.length && isIdentStart(text[i + 1]!)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      tokens.push("cst", text.slice(i, j));
      i = j;
      continue;
    }
    if (lexicon.decorators === true && ch === "@" && i + 1 < text.length && isIdentStart(text[i + 1]!)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      tokens.push("att", text.slice(i, j));
      i = j;
      continue;
    }
    if (lexicon.commandLine === true && ch === "-" && atBoundary && i + 1 < text.length
      && (text[i + 1] === "-" || isIdentStart(text[i + 1]!))) {
      let j = i + 1;
      while (j < text.length && (text[j] === "-" || isIdentPart(text[j]!))) j += 1;
      tokens.push("att", text.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(ch)) {
      let j = i;
      while (j < text.length && (isHexDigit(text[j]!) || text[j] === "." || text[j] === "_"
        || text[j] === "x" || text[j] === "X")) j += 1;
      tokens.push("num", text.slice(i, j));
      keySlot = false;
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      const word = text.slice(i, j);
      i = j;
      if (lexicon.keywords.has(word)) {
        tokens.push("kw", word);
        if (lexicon.functionKeywords?.has(word) === true) pendingFn = true;
        continue;
      }
      const wasKey = keySlot;
      keySlot = false;
      // a yaml mapping key: `key:` followed by a break or a space (never `https://`)
      if (lexicon.lineKeys === true && wasKey && text[j] === ":"
        && (j + 1 >= text.length || text[j + 1] === " " || text[j + 1] === "\t" || text[j + 1] === "\n")) {
        tokens.push("att", word);
        continue;
      }
      if (lexicon.constants?.has(word) === true) { tokens.push("cst", word); continue; }
      if (lexicon.builtinTypes?.has(word) === true) { tokens.push("typ", word); continue; }
      if (lexicon.commandLine === true) {
        if (commandSlot && word !== "$") {
          if (text[j] === "=") { tokens.push("cst", word); continue; }  // VAR=… assignment
          tokens.push("fn", word);
          commandSlot = BASH_CHAINERS.has(word);
          continue;
        }
        tokens.push("plain", word);
        continue;
      }
      if (lexicon.capitalTypes && isConstCase(word)) { tokens.push("cst", word); continue; }
      if (lexicon.capitalTypes && word[0]! >= "A" && word[0]! <= "Z") { tokens.push("typ", word); continue; }
      if (pending) { tokens.push("fn", word); continue; }
      if (lexicon.callable === true && text[j] === "(") { tokens.push("fn", word); continue; }
      tokens.push("plain", word);
      continue;
    }
    if (isOperator(ch) || isPunct(ch)) {
      if (lexicon.commandLine === true && (ch === ";" || ch === "|" || ch === "&" || ch === "(")) {
        commandSlot = true;
      }
      tokens.push(isOperator(ch) ? "op" : "pun", ch);
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pendingFn = pending;   // whitespace keeps the declaration-name slot open
      boundary = true;
      if (ch === "\n") { keySlot = true; commandSlot = true; }
      tokens.push("plain", ch);
      i += 1;
      continue;
    }
    tokens.push("plain", ch);
    i += 1;
  }
  return tokens.out;
}

/** A template literal: string segments, with each `${…}` interpolation re-entering the
 *  lexicon scan (its span is consumed exactly once more, and re-entry is depth-capped,
 *  so hostile nesting stays linear). Returns the index after the literal. */
function scanTemplate(text: string, start: number, tokens: Tokens, lexicon: Lexicon, depth: number): number {
  let j = start + 1;
  let segment = start;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "\\") { j += 2; continue; }
    if (ch === "`") {
      j += 1;
      tokens.push("str", text.slice(segment, j));
      return j;
    }
    if (ch === "$" && text[j + 1] === "{") {
      tokens.push("str", text.slice(segment, j));
      tokens.push("op", "${");
      let k = j + 2;
      let braces = 1;
      while (k < text.length) {
        const inner = text[k]!;
        if (inner === "{") braces += 1;
        else if (inner === "}") {
          braces -= 1;
          if (braces === 0) break;
        }
        k += 1;
      }
      for (const token of tokenizeWithLexicon(text.slice(j + 2, k), lexicon, depth + 1)) {
        tokens.push(token.kind, token.text);
      }
      if (k < text.length) { tokens.push("op", "}"); k += 1; }
      j = k;
      segment = j;
      continue;
    }
    j += 1;
  }
  tokens.push("str", text.slice(segment, j));
  return j;
}

/** CSS rides its own three-plane scan: selectors, properties, values. */
function tokenizeCss(text: string): CodeToken[] {
  const tokens = new Tokens();
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let inValue = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      tokens.push("com", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== "\n") {
        j += text[j] === "\\" && j + 1 < text.length ? 2 : 1;
      }
      if (j < text.length && text[j] === ch) j += 1;
      tokens.push("str", text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "@" && i + 1 < text.length && isIdentStart(text[i + 1]!)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      tokens.push("kw", text.slice(i, j));
      i = j;
      continue;
    }
    // custom properties ride the property plane on both sides of the declaration
    if (ch === "-" && text[i + 1] === "-" && i + 2 < text.length && isIdentStart(text[i + 2]!)) {
      let j = i + 2;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      tokens.push("att", text.slice(i, j));
      i = j;
      continue;
    }
    const hexColor = ch === "#" && (inValue || parenDepth > 0) && i + 1 < text.length
      && isHexDigit(text[i + 1]!);
    if (isDigit(ch) || hexColor) {
      let j = i + (hexColor ? 1 : 0);
      while (j < text.length && (isHexDigit(text[j]!) || text[j] === "." || text[j] === "_"
        || text[j] === "x" || text[j] === "X")) j += 1;
      while (j < text.length && (isIdentStart(text[j]!) || text[j] === "%")) j += 1;
      tokens.push("num", text.slice(i, j));
      i = j;
      continue;
    }
    // a compound selector run: `.card`, `#app`, `:hover`, `li::marker`, `a:focus`
    const selectorLead = !inValue && parenDepth === 0
      && (ch === "." || ch === "&" || ch === "*"
        || (ch === "#" && i + 1 < text.length && isIdentStart(text[i + 1]!))
        || (braceDepth === 0 && ch === ":" && i + 1 < text.length
          && (text[i + 1] === ":" || isIdentStart(text[i + 1]!)))
        || (braceDepth === 0 && isIdentStart(ch)));
    if (selectorLead) {
      let j = i + 1;
      while (j < text.length && (isIdentPart(text[j]!) || text[j] === "." || text[j] === "#"
        || text[j] === "&" || text[j] === "*" || text[j] === ":")) j += 1;
      tokens.push("tag", text.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j += 1;
      const word = text.slice(i, j);
      i = j;
      if (word === "important") { tokens.push("kw", word); continue; }
      if (!inValue) {
        // the property side of a declaration (or a media-query feature)
        tokens.push(peekCode(text, j) === ":" ? "att" : parenDepth > 0 ? "cst" : "tag", word);
        continue;
      }
      tokens.push(text[j] === "(" ? "fn" : "cst", word);
      continue;
    }
    if (isOperator(ch) || isPunct(ch)) {
      if (ch === "{") { braceDepth += 1; inValue = false; }
      else if (ch === "}") { braceDepth = Math.max(0, braceDepth - 1); inValue = false; }
      else if (ch === ";") inValue = false;
      else if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === ":" && braceDepth > 0 && parenDepth === 0) inValue = true;
      tokens.push(isOperator(ch) ? "op" : "pun", ch);
      i += 1;
      continue;
    }
    tokens.push("plain", ch);
    i += 1;
  }
  return tokens.out;
}

/** Tint `text` for `language`. Unknown languages (and anything past the ceiling)
 *  come back as plain tokens, so the consumer's fallback is the exact pre-tint
 *  output. The concatenated token text is ALWAYS the input — tint never rewrites,
 *  drops or reorders a byte. */
export function tokenizeCode(language: string, text: string): CodeToken[] {
  const id = language.trim().toLowerCase();
  const capped = text.length > CODE_TINT_LIMITS.characters
    ? text.slice(0, CODE_TINT_LIMITS.characters) : text;
  const rest = text.slice(capped.length);
  let out: CodeToken[];
  if (MARKUP_LANGUAGES.has(id)) out = tokenizeMarkup(capped);
  else if (id === "css") out = tokenizeCss(capped);
  else {
    const lexicon = LEXICONS[id];
    out = lexicon === undefined
      ? (capped.length > 0 ? [{ kind: "plain", text: capped }] : [])
      : tokenizeWithLexicon(capped, lexicon);
  }
  if (rest.length > 0) {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "plain") last.text += rest;
    else out.push({ kind: "plain", text: rest });
  }
  return out;
}

// ── the sheet ───────────────────────────────────────────────────────────────────────
//
//  Weak layer (dsx-elements), tokens only for color. The tint palette ships as its own
//  scheme tables in the RATIFIED four-table shape (base :root/:host light → the OS-dark
//  media twin → dark pin → light pin, /web/17) INSIDE this sheet, so the palette slices
//  with the plane instead of growing the shared token sheet every embed pays for.
//  Values clear WCAG AA (4.5:1) against both the code surface and the page background
//  in their scheme.
//

const PROSE_LIGHT_PALETTE = `    --dsx-code-keyword: #6d3fd4;
    --dsx-code-string: #177541;
    --dsx-code-comment: #69707d;
    --dsx-code-number: #a94b0a;
    --dsx-code-type: #0b6f7e;
    --dsx-code-punct: #5f6068;
    --dsx-code-function: #0f5cc4;
    --dsx-code-attribute: #8a5a06;
    --dsx-code-tag: #b93348;
    --dsx-code-constant: #a11f80;
    --dsx-code-operator: #45464f;`;

const PROSE_DARK_PALETTE = `    --dsx-code-keyword: #b7a5fb;
    --dsx-code-string: #7fd79f;
    --dsx-code-comment: #9094a0;
    --dsx-code-number: #eda15f;
    --dsx-code-type: #5fd0e0;
    --dsx-code-punct: #a8a8b0;
    --dsx-code-function: #82b5ff;
    --dsx-code-attribute: #e3bb6e;
    --dsx-code-tag: #f5808c;
    --dsx-code-constant: #f095dc;
    --dsx-code-operator: #d4d4dd;`;

export const PROSE_CSS = `@layer dsx-elements {
  :root, :host {
${PROSE_LIGHT_PALETTE}
  }
  @media (prefers-color-scheme: dark) {
    :root, :host {
${PROSE_DARK_PALETTE}
    }
  }
  [data-dsx-theme="dark"], :host([data-dsx-theme="dark"]) {
${PROSE_DARK_PALETTE}
  }
  [data-dsx-theme="light"], :host([data-dsx-theme="light"]) {
${PROSE_LIGHT_PALETTE}
  }

  .dsx-markdown {
    color: var(--dsx-label);
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-reading-size);
    line-height: var(--dsx-type-reading-leading);
    letter-spacing: var(--dsx-type-reading-tracking);
    overflow-wrap: break-word;
    min-width: 0;
  }
  .dsx-markdown > :first-child { margin-block-start: 0; }
  .dsx-markdown > :last-child { margin-block-end: 0; }

  /* type scale: fluid clamps, tracking tightening upward, balanced heads */
  .dsx-markdown h1, .dsx-markdown h2, .dsx-markdown h3, .dsx-markdown h4,
  .dsx-markdown h5, .dsx-markdown h6 {
    color: var(--dsx-label);
    text-wrap: balance;
  }
  .dsx-markdown h1 {
    font-size: var(--dsx-type-display-size-fluid);
    font-weight: var(--dsx-type-display-weight);
    letter-spacing: var(--dsx-type-display-tracking);
    line-height: var(--dsx-type-display-leading);
    margin-block: 0 0.55em;
  }
  .dsx-markdown h2 {
    font-size: var(--dsx-type-title2-size-fluid);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-title1-tracking);
    line-height: var(--dsx-type-title3-leading);
    margin-block: 2.2em 0.65em;
  }
  .dsx-markdown h3 {
    font-size: var(--dsx-type-title3-size-fluid);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-title2-tracking);
    line-height: var(--dsx-type-headline-leading);
    margin-block: 2em 0.6em;
  }
  .dsx-markdown h4 {
    font-size: var(--dsx-type-title3-size);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-headline-tracking);
    line-height: var(--dsx-type-footnote-leading);
    margin-block: 1.6em 0.5em;
  }
  .dsx-markdown h5, .dsx-markdown h6 {
    font-size: var(--dsx-type-body-size);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-callout-tracking);
    line-height: var(--dsx-type-footnote-leading);
    margin-block: 1.5em 0.5em;
  }
  .dsx-markdown h6 { color: var(--dsx-secondary-label); }
  /* a heading directly after a heading closes up: it is a subtitle, not a new band */
  .dsx-markdown :is(h1, h2, h3, h4) + :is(h2, h3, h4, h5, h6) { margin-block-start: 0.35em; }

  .dsx-markdown p { margin-block: 1.1em; }
  /* the lede convention: the first paragraph after the page h1 reads as a deck */
  .dsx-markdown h1 + p {
    font-size: 1.1875em;
    line-height: var(--dsx-type-body-leading);
    color: var(--dsx-secondary-label);
    letter-spacing: var(--dsx-type-title3-tracking);
  }

  /* links: accent ink over a quiet underline that fills on hover */
  .dsx-markdown a {
    color: var(--dsx-accent);
    text-decoration-line: underline;
    text-decoration-color: color-mix(in srgb, var(--dsx-accent) 35%, transparent);
    text-decoration-thickness: 1px;
    text-underline-offset: 0.2em;
    transition: text-decoration-color var(--dsx-dur-fast) var(--dsx-ease-out);
  }
  .dsx-markdown a:hover { text-decoration-color: var(--dsx-accent); }

  /* inline code: a chip. Fenced code resets the chip below. */
  .dsx-markdown code {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    font-variant-ligatures: none;
    font-size: 0.9em;
    background: var(--dsx-fill);
    border-radius: var(--dsx-radius-sm);
    padding: 0.1em 0.35em;
  }

  /* kbd: a bordered key cap with a bottom edge */
  .dsx-markdown kbd {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    font-size: var(--dsx-type-footnote-size);
    font-weight: var(--dsx-type-label-weight);
    color: var(--dsx-secondary-label);
    background: var(--dsx-surface-raised);
    border-radius: var(--dsx-radius-sm);
    padding: 0.15em 0.5em;
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-separator),
      inset 0 -2px 0 var(--dsx-separator);
    padding-block-end: calc(0.15em + 1px);
  }

  /* fenced code: an elevated surface — secondary surface, hairline ring, card radius */
  .dsx-markdown pre {
    background: var(--dsx-secondary-background);
    border-radius: var(--dsx-radius-card);
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
    padding: var(--dsx-space-4) var(--dsx-space-5);
    margin-block: 1.5em;
    overflow-x: auto;
    font-size: var(--dsx-type-callout-size);
    line-height: var(--dsx-type-reading-leading);
  }
  .dsx-markdown pre code {
    display: block;
    background: none;
    border-radius: 0;
    padding: 0;
    font-size: inherit;
  }

  /* the syntax tint (scheme tables above; every color clears AA on the code surface) */
  .dsx-markdown .dsx-tok-kw { color: var(--dsx-code-keyword); }
  .dsx-markdown .dsx-tok-str { color: var(--dsx-code-string); }
  .dsx-markdown .dsx-tok-com { color: var(--dsx-code-comment); font-style: italic; }
  .dsx-markdown .dsx-tok-num { color: var(--dsx-code-number); }
  .dsx-markdown .dsx-tok-typ { color: var(--dsx-code-type); }
  .dsx-markdown .dsx-tok-pun { color: var(--dsx-code-punct); }
  .dsx-markdown .dsx-tok-fn { color: var(--dsx-code-function); }
  .dsx-markdown .dsx-tok-att { color: var(--dsx-code-attribute); }
  .dsx-markdown .dsx-tok-tag { color: var(--dsx-code-tag); }
  .dsx-markdown .dsx-tok-cst { color: var(--dsx-code-constant); }
  .dsx-markdown .dsx-tok-op { color: var(--dsx-code-operator); }

  /* tables: a padded elevated card whose header is a BAND, not a border */
  .dsx-md-table-wrap {
    overflow-x: auto;
    background: var(--dsx-surface-raised);
    border-radius: var(--dsx-radius-card);
    box-shadow: var(--dsx-shadow-1);
    padding: var(--dsx-space-2);
    margin-block: 1.5em;
  }
  .dsx-md-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: var(--dsx-type-body-size);
    line-height: var(--dsx-type-body-leading);
    font-variant-numeric: tabular-nums;
  }
  .dsx-md-table th, .dsx-md-table td {
    text-align: start;
    padding: var(--dsx-space-2) var(--dsx-space-3);
    vertical-align: top;
  }
  .dsx-md-table thead th {
    background: var(--dsx-fill);
    background-clip: padding-box;
    /* the 5px spacer between band and rows, carried as transparent border so the
       fill stops with the band instead of bleeding into the body */
    border-block-end: 5px solid transparent;
    height: 2.25rem;
    font-size: var(--dsx-type-caption-size);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-label-tracking);
    color: var(--dsx-secondary-label);
    vertical-align: middle;
  }
  .dsx-md-table thead th:first-child {
    border-start-start-radius: var(--dsx-radius-sm);
    border-end-start-radius: var(--dsx-radius-sm);
  }
  .dsx-md-table thead th:last-child {
    border-start-end-radius: var(--dsx-radius-sm);
    border-end-end-radius: var(--dsx-radius-sm);
  }
  .dsx-md-table tbody tr + tr td {
    border-block-start: var(--dsx-hairline) solid var(--dsx-outline-soft);
  }
  @media (hover: hover) {
    .dsx-md-table tbody tr:hover td {
      background: color-mix(in srgb, var(--dsx-fill) 55%, transparent);
    }
    .dsx-md-table tbody tr:last-child td:first-child { border-end-start-radius: var(--dsx-radius-sm); }
    .dsx-md-table tbody tr:last-child td:last-child { border-end-end-radius: var(--dsx-radius-sm); }
  }

  /* blockquote: the timeless form - a 2px neutral rail, no wash, muted ink */
  .dsx-md-quote {
    margin-block: 1.5em;
    margin-inline: 0;
    padding-block: 0.125em;
    padding-inline: var(--dsx-space-5) 0;
    border-inline-start: 2px solid var(--dsx-separator);
    color: var(--dsx-secondary-label);
  }
  .dsx-md-quote > :first-child { margin-block-start: 0; }
  .dsx-md-quote > :last-child { margin-block-end: 0; }

  .dsx-md-rule {
    border: none;
    height: var(--dsx-hairline);
    background: var(--dsx-separator);
    margin-block: 2.5em;
  }

  .dsx-md-image {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: var(--dsx-radius-card);
    outline: var(--dsx-hairline) solid var(--dsx-outline-soft);
    outline-offset: calc(-1 * var(--dsx-hairline));
    margin-block: 1.5em;
  }

  .dsx-md-list {
    margin-block: 1.1em;
    padding-inline-start: 1.5em;
  }
  .dsx-md-list li { margin-block: 0.375em; }
  .dsx-md-list li::marker {
    color: var(--dsx-tertiary-label);
    font-variant-numeric: tabular-nums;
  }
  .dsx-md-list .dsx-md-list { margin-block: 0.375em; }

  /* print: the plane flattens — hairline borders stand in for elevation */
  @media print {
    .dsx-md-table-wrap, .dsx-markdown pre {
      box-shadow: none;
      border: 1px solid var(--dsx-separator);
    }
    .dsx-markdown kbd { box-shadow: none; border: 1px solid var(--dsx-separator); }
  }
}`;
