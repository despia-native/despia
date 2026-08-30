//
//  lint.ts — the TypeScript twin of ClosedSource/scripts/lint_dsx.rb, for the surface a
//  CLI can see. Same findings, same wording class, same severity ladder
//  (error / warning / notice, where a notice is printed and NEVER counted by --strict).
//
//  It is a SUBSET by construction, and the subset is declared, never implied:
//    • the component POOL and the SCHEME universe are built from the roots the caller
//      configures (a project's own package + any `packages` it lists), not from a scan of
//      ClosedSource/DSX/Modules — a CLI outside the monorepo cannot see that tree. Rules
//      that depend on the universe therefore stand down or soften, and say so (see
//      `dsx.module.<scheme>` below and README.md "Gated parity, two tethers").
//    • the Swift/Kotlin constitution rules of check_module_rules.rb and the DSX-CSS rules
//      of lint_dsx_css.rb are NOT here at all.
//
//  Everything else is ported rule-for-rule from the Ruby, including its helpers
//  (strip_comments / lift_code_bodies / jse_balanced? / nested_ternary? / edit_distance)
//  so the two implementations agree on the same document.
//

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { parseDsx, DsxParseError } from "@despia-native/compiler";

export type Level = "error" | "warning" | "notice";

export type AttributeCensus = {
  attrs: Map<string, Set<string>>;
  aliases: Map<string, string>;
  structural: Set<string>;
  universal: Set<string>;
  childMarkers: Set<string>;
  styleKeys: Set<string>;
  harness: Set<string>;
  /** The style-plane VALUE grammar (R9v), from the same catalog: alias spelling → canonical
   *  key, then the typed grammars. The runtimes drop an unparseable value as silently as an
   *  unknown attribute, so `width="100%"` and `fontWeight="800"` have to die here. */
  styleAlias: Map<string, string>;
  styleNumber: Map<string, string>;
  styleLength: Set<string>;
  styleEnums: Map<string, Set<string>>;
  styleEnumsByElement: Map<string, Map<string, Set<string>>>;
};

/** CSS property names written as ATTRIBUTES — the habit every ex-web author (and every AI)
 *  brings. Each is real vocabulary in exactly one place, the style plane
 *  (dsx-css-properties.json), so the fix is a spelling move, not a rejection: the message
 *  hands back the style= form verbatim. Names that ARE element vocabulary (gap, position,
 *  inset, display) stay out of this map by construction. */
export const CSS_HABIT_ATTRS = new Map<string, string>([
  ["margin", "margin"],
  ["marginTop", "margin-top"],
  ["marginBottom", "margin-bottom"],
  ["marginLeft", "margin-left"],
  ["marginRight", "margin-right"],
  ["flex", "flex"],
  ["flexGrow", "flex-grow"],
  ["flexShrink", "flex-shrink"],
  ["flexBasis", "flex-basis"],
  ["flexWrap", "flex-wrap"],
  ["order", "order"],
  ["justifyContent", "justify-content"],
  ["justifySelf", "justify-self"],
  ["alignSelf", "align-self"],
  ["alignContent", "align-content"],
  ["rowGap", "row-gap"],
  ["columnGap", "column-gap"],
  ["lineHeight", "line-height"],
  ["textTransform", "text-transform"],
  ["whiteSpace", "white-space"],
  ["overflow", "overflow"],
  ["overflowX", "overflow-x"],
  ["overflowY", "overflow-y"],
  ["borderRadius", "border-radius"],
  ["border", "border"],
  ["boxShadow", "box-shadow"],
  ["backgroundColor", "background"],
  ["fontStyle", "font-style"],
  ["textDecoration", "text-decoration"],
  ["transform", "transform"],
]);

const CSS_HABIT_PX = new Set(["margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "row-gap", "column-gap", "border-radius"]);

export function cssHabitError(tag: string, key: string, base: string, rawValue: string): string | null {
  const css = CSS_HABIT_ATTRS.get(base);
  if (css === undefined) return null;
  const v = rawValue.trim();
  const spelled = /^-?\d+(\.\d+)?$/.test(v) && CSS_HABIT_PX.has(css) ? `${v}px` : v;
  return `<${tag}> ${key}=: not an attribute this element honours - ${css} is CSS and lives on the style plane: `
    + `style="${css}: ${spelled === "" ? "…" : spelled}". The runtime drops unknown attributes silently, `
    + `so the element renders as if you never wrote it.`;
}

/** The confusions people actually type, mapped to the element's own spelling. */
const ATTR_CONFUSIONS = new Map<string, string>([
  ["button\u0000value", "label"],
  ["text\u0000label", "value"],
  ["image\u0000source", "src"],
  ["textfield\u0000value", "bind"],
  ["textarea\u0000value", "bind"],
  ["searchbar\u0000value", "bind"],
]);
export type Finding = { file: string; line: number; level: Level; message: string };

/** Everything a file is judged against. Built by `lintContext` (config.ts feeds it). */
export type LintContext = {
  /** component name → owning schemes (`null` = the global/shared pool) */
  pool: Map<string, Array<string | null>>;
  /** every scheme a `dsx.module.<head>` call may name */
  schemes: Set<string>;
  /** scheme of the package a file belongs to (path prefix → scheme) */
  schemeOf: (dir: string) => string | null;
  /** style-catalog keys classified `systemPath: "ejects"`; empty = the notice stands down */
  styleEjects: Set<string>;
  /** The attribute census (R9): per-element vocabulary + the planes legal everywhere.
   *  Null when the references are not reachable - the rule stands down, declared. */
  census: AttributeCensus | null;
  /** false when the scheme universe is only partially known — softens the
   *  `dsx.module.<scheme>` rule from error to warning and says why */
  schemesComplete: boolean;
};

// ── ground truth (the same table Conformance/lint/facts.json carries) ──────────────────
//
// This list is a COPY, and copies drift — this one had drifted (the twelve scene-3D tags
// were missing) before packages/cli/test/lint-corpus.test.ts started asserting it equals
// facts.json's builtinTags byte for byte. It stays a literal rather than a runtime read
// because this file ships in @despia-native/cli and runs on machines with no repo checkout;
// facts.json is the repo's ground truth and the test is the tether.

/** Built-in lowercase tags: engine specials + Foundation components + documented aliases. */
/** TETHERED LITERAL (this file ships with no repo checkout): the canonical text inputs, whose
 *  factories read `bind=` and never `value=`. `lint-corpus.test.ts` asserts this equals
 *  facts.json's `valuelessInputTags`, because a copied rule table is precisely the thing that
 *  drifts — and in this file it already had, once. */
export const VALUELESS_INPUT_TAGS: ReadonlySet<string> = new Set(["textfield", "textarea", "searchbar"]);

/** Attributes every renderer reads through `bindValue`: the RAW string is evaluated as one
 *  JSE expression, so a `{{ }}` wrapper is a dict literal rather than the value. Mirrors
 *  Conformance/lint/facts.json `bareExpressionAttrs`. */
export const BARE_EXPRESSION_ATTRS: ReadonlySet<string> = new Set([
  "visible-if", "disabled-if", "bind", "commands", "a11yChildren",
]);

export const BUILTIN_TAGS: ReadonlySet<string> = new Set([
  "stack", "vstack", "hstack", "zstack", "scroll", "spacer", "divider", "text", "label", "image", "svg",
  "button", "glassButton", "transport", "pressable", "row", "progress", "capsuleProgress", "spinner",
  "activity", "textfield", "input", "toggle", "switch", "slider", "list", "grid", "pager", "sheet",
  "contextmenu", "video", "audio", "chart", "map", "field", "form", "tabs", "split", "scaffold", "refreshable",
  "datepicker", "date", "picker", "segmented", "stepper", "gauge", "textarea", "otp", "searchbar",
  "combobox", "rangeslider", "wheelpicker", "segmentedButton", "stars", "alert", "confirmDialog", "menu",
  "popover", "carousel", "toolbar", "flow", "lockscreen", "small", "island", "compact", "expanded",
  "minimal", "leading", "trailing", "center", "bottom", "head", "event", "expects", "tool", "api", "action",
  "variable", "var", "let", "formula", "script", "functions", "watch", "attribute", "override", "style", "slot",
  "node", "dynamic", "component", "qrcode", "calendar", "lightbox", "lottie", "rive", "markdown",
  "scene", "canvas", "path", "circle", "ellipse", "line", "polygon", "polyline", "blur", "shadow",
  "blend", "gradient", "stop",
  "camera", "light", "group", "box", "sphere", "plane", "model", "text3d", "anchor", "animate", "sprite",
]);

/** Capitalized tags that are kernel GLOBAL ELEMENTS, not components — the runtime resolves
 *  them from GLOBAL_ELEMENTS (dom data-controls), the natives from the Foundation component
 *  pool, so they need no package component. Tethered to facts.json's globalElementTags by
 *  the same corpus test that tethers BUILTIN_TAGS. */
export const GLOBAL_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "Accordion", "ChatBubble", "Checkbox", "Drawer", "MenuBar", "ProgressRing",
  "RadioGroup", "Skeleton", "Table",
]);

/** Tags whose bodies are raw JS, lifted before the structural scans (StackXML.codeTags). */
const CODE_TAGS = ["script", "functions", "action", "formula", "variable", "var", "let"] as const;

/** Declarations that belong in <head> (dsx-anatomy.md). <watch> is handled separately. */
const DECL_TAGS: ReadonlySet<string> = new Set([
  "action", "variable", "var", "let", "formula", "script", "functions", "style", "attribute",
  "override", "component", "event", "expects", "tool", "api",
]);

/** Canonical <head> order; a monotonic rank also enforces same-kind contiguity. */
const HEAD_RANK: { readonly [tag: string]: number } = {
  attribute: 0, override: 1, expects: 2, event: 3, tool: 3,
  api: 4, variable: 4, var: 4, let: 4,      // rank 5 when computed="true"
  formula: 6, action: 7, script: 8, functions: 8,
  watch: 9, style: 10, component: 11,
};
const HEAD_COMPUTED_RANK = 5;
const HEAD_ORDER_HINT =
  "attribute → override → expects → event/input/tool → api/variable (plain → computed) → formula → action → script → watch → style → component";

// ── the style-override plane (Conformance/overrides — twin of lint_dsx.rb's block) ──
const OVERRIDE_TYPES = ["number", "length", "enum", "multiEnum", "color", "gradient", "ratio", "boolean", "text", "css"];
const OVERRIDE_RESERVED: ReadonlySet<string> = new Set([
  "ios", "android", "web", "watch", "wear", "macos", "windows", "linux", "native", "desktop",
]);
const OVERRIDE_NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** What a LITERAL override value must look like per declared type — the expected
 *  description on a mismatch, null when fine (bound values are runtime business). */
function overrideLiteralError(type: string, value: string, options: string | undefined): string | null {
  const v = value.trim();
  if (v.length === 0 || v.includes("{{")) return null;
  const opts = (options ?? "").split(/\s+/).filter((o) => o.length > 0);
  switch (type) {
    case "number":
      return OVERRIDE_NUMERIC_RE.test(v) ? null : "a number";
    case "length":
      if (OVERRIDE_NUMERIC_RE.test(v)) return null;
      return /[;{}]/.test(v) ? "a length (a number, keyword, or unit value — never a declaration list)" : null;
    case "boolean":
      return v === "true" || v === "false" ? null : "'true' or 'false'";
    case "enum":
      return opts.includes(v) ? null : `one of: ${opts.join(" ")}`;
    case "multiEnum":
      return v.split(/\s+/).every((t) => opts.includes(t)) ? null : `space-separated members of: ${opts.join(" ")}`;
    case "color":
      if (v.startsWith("#")) return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v) ? null : "a color (#RGB / #RGBA / #RRGGBB / #AARRGGBB hex)";
      if (/^(rgb|rgba|hsl|hsla)\([\s\S]*\)$/.test(v)) return null;
      return /^[A-Za-z]+$/.test(v) ? null : "a color (hex, rgb()/hsl(), or a semantic token name)";
    case "gradient":
    case "ratio":
      return /[;{}]/.test(v) ? `a ${type} value (never a declaration list)` : null;
    case "css":
      return /[{}]/.test(v) ? "a declaration list (declarations only — no braces, never a rule)" : null;
    default:
      return null;
  }
}

const HANDLER_MAX_STATEMENTS = 2;
const HANDLER_MAX_CHARS = 120;
const STATE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SETTLE_ATTR_RE = /\bsettle\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const SETTLED_CALL_RE = /\bdsx\.screen\.settled\s*\(/;

const JSE_ROOTS: ReadonlySet<string> = new Set([
  "dsx.variable", "dsx.attribute", "dsx.override", "dsx.action", "dsx.module", "dsx.component", "dsx.event",
  "dsx.error", "dsx.log", "dsx.this", "dsx.item", "dsx.index", "dsx.cookie", "dsx.global",
  "dsx.route", "dsx.query", "dsx.formula", "dsx.app", "dsx.screen", "dsx.element", "dsx.params",
  "dsx.path",
  // store-alias roots the JSE resolver folds onto the global plane (kernel jse.ts):
  // dsx.source.* (provenance, source-plane.md) · dsx.const.* (App.json consts) ·
  // dsx.input.* (unified input) — real grammar on all three renderers.
  "dsx.source", "dsx.const", "dsx.input",
]);

const CRYPTO_ALGS: ReadonlySet<string> = new Set([
  "SHA-1", "SHA-256", "SHA-384", "SHA-512", "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW", "RSA-OAEP",
  "HMAC", "ECDSA", "Ed25519", "RSASSA-PKCS1-v1_5", "RSA-PSS", "PBKDF2", "HKDF", "ECDH", "X25519",
]);

/** The platform-suffix vocabulary (Conformance/platform/platform.json; /web/14). */
const PLATFORM_SUFFIXES = ["ios", "android", "web", "watch", "wear", "macos", "windows", "linux", "desktop", "native"] as const;

/** The elements whose renderers actually gate on styling today (system-defaults.md). */
const SYSTEM_PATH_TAGS: ReadonlySet<string> = new Set(["list", "button"]);

/** The platform facet folder names that may never appear inside `Components/`. */
const PLATFORM_FACETS = ["swift", "kotlin", "ios", "android", "web", "watch", "wear", "macos", "windows", "linux"] as const;

const TAG_RE = /<(\/?)([A-Za-z][\w.]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/gm;
const ATTR_RE = /([\w:.-]+)=(?:"([^"]*)"|'([^']*)')/g;

// ── helpers (1:1 with the Ruby) ────────────────────────────────────────────────────────

/** Blank every comment, keeping line numbers stable. */
export function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
}

/** Blank the BODY of every code element, line-stably — the twin of StackNode.liftCode, so
 *  raw JS (`a < b`, `x && y`) can never be misread as markup by the structural scans. */
export function liftCodeBodies(src: string): string {
  const re = new RegExp(`<(${CODE_TAGS.join("|")})\\b((?:"[^"]*"|'[^']*'|[^<>"'/])*?)>([\\s\\S]*?)</\\1>`, "g");
  return src.replace(re, (_all, tag: string, attrs: string, body: string) =>
    `<${tag}${attrs}>${body.replace(/[^\n]/g, " ")}</${tag}>`);
}

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Balanced (){}[] with quote awareness — the same total pass the Ruby runs. */
export function jseBalanced(body: string): boolean {
  const depth: { [open: string]: number } = { "(": 0, "[": 0, "{": 0 };
  const pairs: { [close: string]: string } = { ")": "(", "]": "[", "}": "{" };
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote !== null) {
      // A backslash escapes the next character — without this, a body containing `\"`
      // "closes" the string at the escaped quote and everything after is miscounted
      // (measured: any JSON-encoded payload in a <variable> body reported unbalanced).
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth[ch] += 1; continue; }
    const open = pairs[ch];
    if (open !== undefined) {
      depth[open] -= 1;
      if (depth[open]! < 0) return false;
    }
  }
  return quote === null && Object.values(depth).every((n) => n === 0);
}

/** Replace the INTERIOR of JSE string literals with spaces, length-preserving and
 *  escape-aware, so textual scans (namespace roots, declared-variable uses) never read
 *  data as code. Newlines inside a literal survive, so every line number stays true. */
export function blankJseStrings(code: string): string {
  const out = code.split("");
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (quote !== null) {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < code.length && code[i + 1] !== "\n") out[i + 1] = " ";
        i += 1;
        continue;
      }
      if (ch === quote) { quote = null; continue; }
      if (ch !== "\n") out[i] = " ";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return out.join("");
}

/** ≥ 2 ternaries in one expression (string literals stripped first). */
export function nestedTernary(expr: string): boolean {
  return (expr.replace(/'[^']*'|"[^"]*"/g, "").match(/\?/g) ?? []).length >= 2;
}

export function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur.push(Math.min(prev[j + 1]! + 1, cur[j]! + 1, prev[j]! + (a[i] === b[j] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[prev.length - 1]!;
}

function lineAt(source: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") n += 1;
  return n;
}

/** Attribute pairs of one tag's attribute run, in source order. */
function attrPairs(attrs: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(attrs); m !== null; m = ATTR_RE.exec(attrs)) {
    out.push({ key: m[1]!, value: m[2] ?? m[3] ?? "" });
  }
  return out;
}

/** Every open/close tag of a document, with its 1-based source line. */
type Tag = { closing: boolean; tag: string; attrs: string; selfClose: boolean; line: number };
function scanTags(lifted: string): Tag[] {
  const out: Tag[] = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(lifted); m !== null; m = TAG_RE.exec(lifted)) {
    out.push({
      closing: m[1] === "/", tag: m[2]!, attrs: m[3] ?? "", selfClose: m[4] === "/",
      line: lineAt(lifted, m.index),
    });
  }
  return out;
}

// ── the file linter ────────────────────────────────────────────────────────────────────

/** Lint one .dsx document. `file` is only a label — nothing is read from disk here, which
 *  is what makes every rule unit-testable from a string. */
export function lintSource(file: string, raw: string, ctx: LintContext): Finding[] {
  const findings: Finding[] = [];
  const sharedIdLines = new Map<string, number>();   // shared= match id → first line (U03)
  const report = (level: Level, line: number, message: string): void => {
    findings.push({ file, line, level, message });
  };
  const src = stripComments(raw);
  const lifted = liftCodeBodies(src);
  const localScheme = ctx.schemeOf(dirname(file));

  // 0 ── strict well-formedness, through the RUNTIME's own parser (@despia-native/compiler parseDsx
  // is the TS twin of StackXML): a document that fails it registers NO component, so every
  // push of it renders an EMPTY screen with only a log line to show for it.
  try {
    parseDsx(raw);
  } catch (e) {
    const line = e instanceof DsxParseError ? (e.line === 0 ? 1 : e.line) : 1;
    const message = e instanceof Error ? e.message : String(e);
    report("error", line,
      `not well-formed DSX — the runtime registers NO component and renders it EMPTY: ${message}`);
  }

  // 0a ── `--` INSIDE A COMMENT. XML forbids it; the comment ENDS at the stray `--` and the
  // rest of the file becomes junk. `raw`, not `src` — comments are blank space by now.
  for (const m of raw.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (!m[1]!.includes("--")) continue;
    report("error", lineAt(raw, m.index),
      'comment contains "--" — illegal in XML: the comment ENDS there and the rest of the file ' +
      "becomes junk, so the runtime registers NO component. Reword it — a literal double hyphen " +
      "cannot appear in a comment.");
  }

  // 0b ── a code-tag NAME inside a comment. No longer fatal (the kernel skips comments when
  // lifting code) but it broke whole surfaces on older kernels — keep tag names out of prose.
  // String DATA inside code bodies is blanked first (length-preserving): a page whose
  // markdown PAYLOAD quotes a commented `<action>` example is carrying prose, not markup.
  let rawScan = raw;
  for (const m of raw.matchAll(/<(action|formula|variable|script)\s[^>]*>([\s\S]*?)<\/\1>/g)) {
    const body = m[2]!;
    const bodyStart = m.index + m[0].length - `</${m[1]!}>`.length - body.length;
    rawScan = rawScan.slice(0, bodyStart) + blankJseStrings(body) + rawScan.slice(bodyStart + body.length);
  }
  for (const m of rawScan.matchAll(/<!--[\s\S]*?-->/g)) {
    const hit = /<\s*(script|action|formula|variable|var|let)\b/.exec(m[0]);
    if (hit === null) continue;
    report("warning", lineAt(rawScan, m.index),
      `code-tag <${hit[1]}> written inside a comment — drop the angle brackets (reads as markup; ` +
      "broke parsing on kernels before the liftCode comment-skip)");
  }

  // 1 ── structure: balance · ONE root · <head> placement + canonical order ·
  //      declarations-in-head · identifier discipline · removed legacy spellings
  type Frame = { tag: string; line: number; children: number; heads: number; lastRank: number; lastRankTag: string | null };
  const stack: Frame[] = [];
  let roots = 0;
  let hasHead = false;
  let balanced = true;
  let rootSettle: string | null = null;
  let rootSettleLine = 1;

  for (const t of scanTags(lifted)) {
    if (t.closing) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.tag !== t.tag) {
        report("error", t.line,
          `unbalanced </${t.tag}> (open stack: ${stack.slice(-3).map((e) => e.tag).join(" > ")})`);
        balanced = false;
        break; // cascades aren't useful
      }
      stack.pop();
      continue;
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots += 1;
      if (roots === 1) {
        const m = SETTLE_ATTR_RE.exec(t.attrs);
        rootSettle = ((m?.[1] ?? m?.[2]) ?? "").trim().toLowerCase();
        rootSettleLine = t.line;
      }
      if (roots === 2) {
        report("error", t.line,
          "multiple root elements — a .dsx file is ONE component with ONE root (the runtime XML " +
          "parser rejects extra roots and silently drops the whole component)");
      }
    } else {
      parent.children += 1;
      if (SETTLE_ATTR_RE.test(t.attrs)) {
        report("warning", t.line,
          `<${t.tag} settle=…>: settle is ROOT-ONLY — on a nested element it is silently ignored ` +
          "(reference/screen-lifecycle.md)");
      }
    }

    if (t.tag === "native") {
      report("error", t.line, "<native> was removed — write the component tag directly (<x/> resolves registered surfaces too)");
    } else if (t.tag === "prop") {
      report("error", t.line, '<prop> was removed — declare props with <attribute as="…" default="…"/>');
    }

    if (t.tag === "head") {
      hasHead = true;
      if (parent === undefined) {
        report("error", t.line, "<head> cannot be the document root — it is the FIRST child of the root view element");
      } else {
        if (parent.children > 1) report("warning", t.line, "<head> must be the FIRST child of the root element (dsx-anatomy.md)");
        if (parent.heads >= 1) report("warning", t.line, "duplicate <head> — one declaration section per element");
        parent.heads += 1;
      }
    }

    const inHead = parent !== undefined && parent.tag === "head";

    if (DECL_TAGS.has(t.tag) && !inHead) {
      report("warning", t.line, `<${t.tag}> outside <head> — declarations live in the document head (dsx-anatomy.md)`);
    }
    if (t.tag === "watch" && !inHead && !stack.some((e) => e.tag === "list" || e.tag === "grid" || e.tag === "pager")) {
      report("warning", t.line,
        "<watch> outside <head> — screen-level watches live in the head (only a list/grid/pager row hosts a per-row watch)");
    }

    if (inHead && parent !== undefined) {
      let rank = HEAD_RANK[t.tag];
      if (rank === HEAD_RANK["variable"] && /computed\s*=\s*["']true["']/.test(t.attrs)) rank = HEAD_COMPUTED_RANK;
      if (rank === undefined) {
        report("warning", t.line, `<${t.tag}> inside <head> — only declarations belong in the head (${HEAD_ORDER_HINT})`);
      } else if (rank < parent.lastRank) {
        report("warning", t.line,
          `head order: <${t.tag}> after <${parent.lastRankTag}> — keep the canonical order ` +
          `${HEAD_ORDER_HINT} (same-kind declarations contiguous)`);
      } else if (rank > parent.lastRank) {
        parent.lastRank = rank;
        parent.lastRankTag = t.tag === "variable" && rank === HEAD_COMPUTED_RANK ? "variable computed" : t.tag;
      }
    }

    // identifier discipline: as= is REQUIRED; the legacy name= identifier alias is removed
    if (["action", "variable", "var", "let", "formula", "style", "component", "attribute", "override", "event", "api"].includes(t.tag)) {
      if (!/\bas\s*=/.test(t.attrs)) {
        if (/\bname\s*=/.test(t.attrs) && t.tag !== "action" && t.tag !== "formula") {
          report("error", t.line, `<${t.tag} name=…>: the legacy name= identifier was removed — the identifier is as=`);
        } else {
          report("error", t.line, `<${t.tag}> missing as= — registration is a silent no-op at runtime`);
        }
      }
    }
    if (t.tag === "api") {
      const m = /\bas\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t.attrs);
      const asName = m?.[1] ?? m?.[2];
      if (asName !== undefined && !STATE_IDENTIFIER_RE.test(asName)) {
        report("error", t.line, "<api as=...> must be an ASCII identifier of at most 128 characters");
      }
    }
    // <tool action= description= as= mutates=/> — the AGENT interface row
    // (proposals/webmcp.md). `as` is OPTIONAL and defaults to the action name, which is why
    // `tool` is absent from the identifier tags; `action` is the identifier that must be
    // there, because a row naming nothing has nothing to expose.
    if (t.tag === "tool") {
      if (!/\baction\s*=/.test(t.attrs)) {
        report("error", t.line, "<tool> missing action= — an agent tool names the declared action it exposes");
      }
      if (!/\bdescription\s*=/.test(t.attrs)) {
        report("error", t.line, "<tool> missing description= — the description is the whole basis on which an agent chooses this tool");
      }
      const tm = t.attrs.match(/\bas\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const toolName = tm === null ? null : (tm[1] ?? tm[2] ?? "");
      if (toolName !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(toolName)) {
        report("error", t.line, '<tool as=...> must be 1 to 128 characters of ASCII letters, digits, "_", "-" or "." (the WebMCP tool-name grammar)');
      }
    }
    if (t.tag === "expects" && !/\bvariable\s*=/.test(t.attrs)) {
      report("error", t.line, "<expects> missing variable= — declare the seeded state it stands for");
    }
    // <override> declaration discipline (the style contract — Conformance/overrides):
    // a knob the runtime cannot resolve silently answers its default, so every
    // declaration fact is checked where it is written. Twin of lint_dsx.rb's block.
    if (t.tag === "override") {
      const attrOf = (name: string): string | undefined => {
        const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(t.attrs);
        return m === null ? undefined : (m[1] ?? m[2]);
      };
      const oAs = attrOf("as");
      const oType = attrOf("type");
      const oOptions = attrOf("options");
      const oDefault = attrOf("default");
      if (oAs !== undefined && oAs.length > 0) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(oAs)) {
          report("error", t.line, `<override as="${oAs}">: an override name is an identifier — dsx.override.${oAs} must be a legal member read`);
        }
        if (OVERRIDE_RESERVED.has(oAs)) {
          report("error", t.line, `<override as="${oAs}">: '${oAs}' is a platform-suffix word — the platform fold consumes override:${oAs}= before the split ever runs, so this knob could never be set; pick another name`);
        }
      }
      if (oType !== undefined && !OVERRIDE_TYPES.includes(oType)) {
        report("error", t.line, `<override type="${oType}">: not an override type — the vocabulary is ${OVERRIDE_TYPES.join(" ")} (the style catalog's control set + css)`);
      }
      if ((oType === "enum" || oType === "multiEnum") && (oOptions === undefined || oOptions.trim().length === 0)) {
        report("error", t.line, `<override type="${oType}"> without options= — an enum knob with no members can never accept a value (every read answers the default)`);
      }
      for (const bound of ["min", "max"]) {
        const b = attrOf(bound);
        if (b !== undefined && !OVERRIDE_NUMERIC_RE.test(b.trim())) {
          report("error", t.line, `<override ${bound}="${b}">: ${bound}= is a number (the clamp bound)`);
        }
      }
      if (oDefault !== undefined && oDefault.includes("{{")) {
        report("error", t.line, '<override default=…>: a default is a LITERAL style value, never a binding — {{ }} belongs at the usage site (override:name="{{ … }}")');
      } else if (oDefault !== undefined) {
        const why = overrideLiteralError(oType ?? "text", oDefault, oOptions);
        if (why !== null) {
          report("error", t.line, `<override default="${oDefault}">: the default is not ${why} — an invalid default resolves null, so the knob has no fallback at all`);
        }
      }
    }

    // sample= — the unit-test sample value (master plan P3): JSON on every runner
    // (decision 10), v1 kinds only (decision 11) — on <formula>/<action> every head
    // parser folds unknown attributes into input bindings, so a sample there is active
    // runtime state until all four parsers learn the skip.
    {
      const sm = /\bsample\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t.attrs);
      if (sm !== null) {
        const sampleText = (sm[1] ?? sm[2] ?? "")
          .replaceAll("&quot;", '"').replaceAll("&#39;", "'")
          .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
        if (t.tag === "formula" || t.tag === "action") {
          report("error", t.line,
            `sample= on <${t.tag}> is deferred — it becomes an input binding evaluated at call time; declare samples on variable/event/api/attribute (master plan P3)`);
        } else if (["variable", "var", "let", "event", "api", "attribute"].includes(t.tag)) {
          try {
            JSON.parse(sampleText);
          } catch {
            report("error", t.line,
              "sample= is not valid JSON — a sample is a JSON literal on every runner; quote strings (sample='\"Spring sale\"'), use [] and {} for structure");
          }
        }
      }
    }

    if (["list", "grid", "pager"].includes(t.tag) && /\bbind\s*=/.test(t.attrs) && !/\bkey\s*=/.test(t.attrs)) {
      report("warning", t.line,
        `<${t.tag} bind=…> without key= — rows need a stable identity (key="id", or key="index" for static data)`);
    }

    // A text input reads its content from `bind=` and never looks at `value=`. Written here,
    // `value=` parses, renders an empty field and reports nothing — the spelling is right for
    // a <text>/<image>/<progress>, which is exactly why an author reaches for it.
    // An authored `data-*` never reaches the element. Dropping it is the RIGHT call - a sheet
    // keyed on an attribute selector would work on web and quietly do nothing on the native
    // twins - but the drop is silent, and the state class the author wanted simply never
    // applies. A class formula is the spelling all three renderers honour.
    for (const authored of t.attrs.matchAll(/(?:^|\s)(data-[\w-]+)\s*=/g)) {
      report("error", t.line,
        `<${t.tag} ${authored[1]}=…>: an authored data- attribute is dropped by every renderer, ` +
        `so the sheet rule keyed on it never matches. Put the state in the class instead: ` +
        `class="row {{ selected ? 'row-on' : 'row-off' }}"`);
    }

    // A shared-element match id names ONE rect per frame (U03: "unique within a frame; a
    // duplicate is a lint error"). Two rails that both render the same row each declare
    // shared="poster-{{ item.id }}", so one id names two live rects and the flight
    // animates to whichever the DOM ordered first — the transition reads as broken with
    // nothing anywhere reporting it.
    {
      const shm = /\bshared\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t.attrs);
      const sharedId = (shm?.[1] ?? shm?.[2] ?? "").trim();
      if (sharedId.length > 0) {
        const seenAt = sharedIdLines.get(sharedId);
        if (seenAt !== undefined) {
          report("error", t.line,
            `<${t.tag} shared="${sharedId}">: this match id is already declared on line ${seenAt}. A shared id names ONE rect per frame — with two, the flight animates to whichever the DOM ordered first and the transition reads as broken. Give each end its own id, or declare the pairing in exactly one place.`);
        } else {
          sharedIdLines.set(sharedId, t.line);
        }
      }
    }

    // A whole-value hole composed with other declarations is DISCARDED: style="" splits on
    // ';' before interpolating, and a fragment with no ':' is skipped — so the hole never
    // reaches the element while the declarations beside it apply.
    {
      const stm = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t.attrs);
      const styleValue = stm?.[1] ?? stm?.[2];
      if (styleValue !== undefined && styleValue.includes("{{")) {
        const parts = styleValue.split(";");
        if (parts.length > 1) {
          for (const part of parts) {
            const frag = part.trim();
            if (frag.length === 0 || frag.includes(":") || !frag.includes("{{")) continue;
            report("error", t.line,
              `<${t.tag} style="… ${frag} …">: this hole is DISCARDED — style="" splits on ';' before interpolating, and a fragment with no ':' is skipped, so ${frag} never reaches the element while the declarations beside it apply. Fold the whole list into ONE computed value and use it as the whole attribute (style="{{ oneList }}"), or give the hole its own declaration (prop: {{ value }}).`);
          }
        }
      }
    }

    if (VALUELESS_INPUT_TAGS.has(t.tag) && /(?:^|\s)value\s*=/.test(t.attrs)) {
      report("notice", t.line,
        `<${t.tag} value=…> is inert — a text input reads its content from bind= (path-aware, including the current row). value= parses, renders nothing, and reports no error. Did you mean bind=?`);
    }

    if (!t.selfClose) {
      stack.push({ tag: t.tag, line: t.line, children: 0, heads: 0, lastRank: -1, lastRankTag: null });
    }
  }
  if (balanced) {
    for (const e of stack) report("error", e.line, `<${e.tag}> never closed`);
    if (roots === 0 && lifted.trim().length > 0) report("error", 1, "no root element found");
  }

  // SCREEN READINESS — a root that owns its readiness must actually report it. Checked
  // against `src` (comments stripped, CODE BODIES INTACT): the call lives in an action body.
  if (rootSettle === "manual" && !SETTLED_CALL_RE.test(src)) {
    report("error", rootSettleLine,
      "settle=\"manual\" without any dsx.screen.settled() in this file — the screen NEVER reports " +
      "readiness, so the shell sits in `loading` (splash never reveals, spinner never clears; on a " +
      "hybrid app the web surface's consumers freeze too — one shared phase) until the reporter's " +
      "bounded deadline fails it open. Call dsx.screen.settled() on every settling path (an <api> " +
      "on:success AND on:error), or drop settle= and let the screen settle on its first render.");
  } else if (rootSettle !== null && rootSettle.length > 0 && rootSettle !== "auto" && rootSettle !== "manual") {
    report("error", rootSettleLine,
      `settle="${rootSettle}" is not a readiness mode — the only values are auto (the default: settle ` +
      "on the first render pass) and manual (this screen calls dsx.screen.settled())");
  }

  const localDefs = new Set([...lifted.matchAll(/<component\s[^>]*as="([^"]+)"/g)].map((m) => m[1]!));
  const localActions = new Set([...lifted.matchAll(/<action\s[^>]*as="([^"]+)"/g)].map((m) => m[1]!));

  const rawLines = lifted.split("\n");
  // 2 ── per-tag: component resolution · on:* JSE + budget · nested ternaries · suffix typos
  for (const t of scanTags(lifted)) {
    if (t.closing) continue;

    if (/^[A-Z]/.test(t.tag) || t.tag.includes(".")) {
      if (t.tag.includes(".")) {
        const dot = t.tag.indexOf(".");
        const ns = t.tag.substring(0, dot);
        const name = t.tag.substring(dot + 1);
        const scopes = ctx.pool.get(name) ?? [];
        if (ns === "shared" || ns === "global") {
          if (!scopes.includes(null)) report("error", t.line, `<${t.tag}>: no global component '${name}'`);
        } else if (!scopes.includes(ns)) {
          report("error", t.line, `<${t.tag}>: no component '${name}' in scheme '${ns}'`);
        }
      } else {
        const scopes = ctx.pool.get(t.tag) ?? [];
        const resolvable = (localScheme !== null && scopes.includes(localScheme)) || scopes.includes(null)
          || localDefs.has(t.tag) || GLOBAL_ELEMENT_TAGS.has(t.tag);
        if (!resolvable) report("error", t.line, `<${t.tag}>: unresolved component (not in this package, not global)`);
      }
    } else if (!BUILTIN_TAGS.has(t.tag)) {
      report("warning", t.line, `<${t.tag}>: unknown element tag (typo, or extend BUILTIN_TAGS in the linter)`);
    }

    // R9 - the attribute vocabulary (twin of lint_dsx.rb). Main-surface dialect only:
    // extension apps and Live Activity layouts (markup inside a JSE string) have their
    // own grammars. Skips head grammar and stands down without the census.
    if (ctx.census !== null && !file.includes("/Extensions/")
        && !(rawLines[t.line - 1] ?? "").includes("return '<")) {
      const catalogTag = ctx.census.aliases.get(t.tag) ?? t.tag;
      const known = ctx.census.structural.has(catalogTag) || DECL_TAGS.has(t.tag)
        ? undefined
        : ctx.census.attrs.get(catalogTag);
      if (known !== undefined) {
        for (const { key, value } of attrPairs(t.attrs)) {
          if (key.startsWith("override:")) {
            // the style contract is COMPONENT grammar: an element's attributes ARE its
            // style surface, so an override: here can only be a misplaced habit
            report("warning", t.line,
              `<${t.tag}> ${key}=: override: is the component style contract — <${t.tag}> is an element; set the style attribute directly (its attributes are the style surface)`);
            continue;
          }
          let base = key.replace(/:(ios|android|watch|web|desktop|macos|windows|linux)$/, "");
          base = base.replace(/-(web|ios|android|watch|desktop)$/, "");
          if (base.startsWith("on:") || base.startsWith("__")) continue;
          const styleError = styleValueError(ctx.census, catalogTag, t.tag, key, base, value);
          if (styleError !== null) report("error", t.line, styleError);
          const habit = cssHabitError(t.tag, key, base, value);
          if (habit !== null
              && !known.has(base) && !ctx.census.universal.has(base) && !ctx.census.childMarkers.has(base)
              && !ctx.census.harness.has(base) && !ctx.census.styleKeys.has(base)) {
            report("error", t.line, habit);
            continue;
          }
          if (known.has(base) || ctx.census.universal.has(base) || ctx.census.childMarkers.has(base)) continue;
          if (ctx.census.harness.has(base) || ctx.census.styleKeys.has(base)) continue;
          const confusion = ATTR_CONFUSIONS.get(`${catalogTag}\u0000${base}`);
          const candidates = [...known, ...ctx.census.universal, ...ctx.census.harness, ...ctx.census.styleKeys];
          let nearest = confusion ?? candidates[0] ?? "";
          if (confusion === undefined) {
            for (const c of candidates) if (editDistance(base, c) < editDistance(base, nearest)) nearest = c;
          }
          if (confusion !== undefined) {
            report("error", t.line,
              `<${t.tag}> ${key}=: not an attribute this element honours - this element spells it ` +
              `${confusion}=. The runtime drops unknown attributes silently, so the element ` +
              `renders as if you never wrote it.`);
          } else if (nearest !== "" && editDistance(base, nearest) <= 2 && base.length >= 3) {
            report("error", t.line,
              `<${t.tag}> ${key}=: not an attribute this element honours - did you mean ${nearest}=? ` +
              `The runtime drops unknown attributes silently, so the element renders as if you ` +
              `never wrote it.`);
          } else {
            report("notice", t.line,
              `<${t.tag}> ${key}=: not in the census for this element (stack-elements.json) - ` +
              `a typo dies here, a real word belongs in the census so every surface learns it`);
          }
        }
      }
    }

    for (const { key, value } of attrPairs(t.attrs)) {
      let exprs = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!);
      if (BARE_EXPRESSION_ATTRS.has(key) && value.trimStart().startsWith("{{")) {
        // The braces turn the expression into a dict literal, and every one of these
        // attributes then fails SILENTLY in its own way: visible-if is truthy forever so the
        // element never hides (found live: the example's offline banner), and a data
        // attribute like commands= resolves to nothing so the surface renders empty with no
        // error anywhere. These are BARE expression attrs (StackReference "Bindings"),
        // unlike the interpolated value attrs the same braces are right for.
        report("error", t.line,
          `${key}: drop the '{{ }}' braces — ${key} takes a bare JSE expression ` +
          `(braces read as a dict literal, so the attribute never sees the value you wrote)`);
      }
      if (key === "visible-if" && exprs.length === 0) exprs = [decodeEntities(value)];
      for (const e of exprs) {
        if (nestedTernary(e)) {
          report("warning", t.line, `${key}: nested ternary — extract to a computed <variable>/<formula> in <head>`);
        }
      }
      const colon = key.lastIndexOf(":");
      if (colon > 0) {
        const suffix = key.substring(colon + 1);
        if (!(PLATFORM_SUFFIXES as readonly string[]).includes(suffix) && suffix.length >= 3) {
          let near: string = PLATFORM_SUFFIXES[0];
          for (const w of PLATFORM_SUFFIXES) if (editDistance(suffix, w) < editDistance(suffix, near)) near = w;
          if (editDistance(suffix, near) <= 2) {
            report("warning", t.line,
              `${key}: suffix ':${suffix}' is not a platform word — did you mean ':${near}'? ` +
              `(platform suffixes: ${PLATFORM_SUFFIXES.join(" ")})`);
          }
        }
      }
    }

    // JSE bodies: every on:* attribute value
    for (const m of t.attrs.matchAll(/(on:[\w.]+)=(?:"([^"]*)"|'([^']*)')/g)) {
      const key = m[1]!;
      const body = decodeEntities(m[2] ?? m[3] ?? "");
      if (!jseBalanced(body)) report("error", t.line, `${key}: unbalanced (){}[] or unterminated string`);
      lintJse(report, t.line, key, body, ctx);
      const stmts = body.split(";").map((s) => s.trim()).filter((s) => s.length > 0).length;
      if (stmts > HANDLER_MAX_STATEMENTS || body.length > HANDLER_MAX_CHARS) {
        report("warning", t.line,
          `${key}: inline handler over budget (${stmts} stmts, ${body.length} chars) — extract to a named <action> in <head>`);
      }
    }

    if (SYSTEM_PATH_TAGS.has(t.tag)) ejectionNotice(report, t.line, t.tag, t.attrs, ctx);
  }

  // 3 ── interface contract (files that opted into a <head>)
  if (hasHead) {
    const declaredEvents = new Set([...lifted.matchAll(/<event\s[^>]*as="([^"]+)"/g)].map((m) => m[1]!));
    const declaredVars = new Set([
      ...[...lifted.matchAll(/<(?:variable|var|let)\s[^>]*as="([^"]+)"/g)].map((m) => m[1]!),
      ...[...lifted.matchAll(/<expects\s[^>]*variable="([^"]+)"/g)].map((m) => m[1]!),
    ]);
    // Blank string DATA inside code bodies before scanning for uses — length-preserving,
    // so every reported line number stays true. A page carrying documentation in a string
    // literal must not be told its prose uses undeclared variables.
    let scanSrc = src;
    for (const m of src.matchAll(/<(action|formula|variable|script)\s[^>]*>([\s\S]*?)<\/\1>/g)) {
      const body = m[2]!;
      const bodyStart = m.index + m[0].length - `</${m[1]!}>`.length - body.length;
      scanSrc = scanSrc.slice(0, bodyStart) + blankJseStrings(body) + scanSrc.slice(bodyStart + body.length);
    }
    // Events: the NAME legitimately lives inside a string literal, so the match runs on
    // the original source — and counts only where the `dsx.event(` token itself survived
    // the blanking (a docs page QUOTING the call has the whole thing inside a literal).
    const seenEvent = new Set<string>();
    for (const m of src.matchAll(/dsx\.event\(\s*['"]([\w:.-]+)['"]/g)) {
      const name = m[1]!;
      if (declaredEvents.has(name) || seenEvent.has(name)) continue;
      if (!scanSrc.startsWith("dsx.event", m.index)) continue;
      seenEvent.add(name);
      report("warning", lineAt(src, m.index),
        `dsx.event('${name}') is not declared — add <event as="${name}"/> to <head> (the component's outbound contract)`);
    }
    const seenVar = new Set<string>();
    for (const m of scanSrc.matchAll(/dsx\.variable\.(\w+)/g)) {
      const name = m[1]!;
      if (declaredVars.has(name) || seenVar.has(name)) continue;
      seenVar.add(name);
      report("warning", lineAt(scanSrc, m.index),
        `dsx.variable.${name} is not declared — add <variable as="${name}">…</variable> (own state) or ` +
        `<expects variable="${name}"/> (seeded/shared) to <head>`);
    }
  }

  // 4 ── action/computed element BODIES (text content, UN-lifted)
  for (const m of src.matchAll(/<(action|formula|variable)\s([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const el = m[1]!;
    const body = decodeEntities(m[3]!);
    const line = lineAt(src, m.index);
    if (!jseBalanced(body)) report("error", line, `<${el}> body: unbalanced (){}[] or unterminated string`);
    // RETIRED (2026-08-22): the loop-in-value-body error. Expression blocks run the full
    // loop grammar now, BUDGETED (kernel JSEval, corpus jse/core-004), so a loop in a
    // <variable>/<formula> body is legal and terminates — the restriction this rule
    // guarded fell with it (runtime-pressure R11).
    lintJse(report, line, `<${el}>`, body, ctx);
  }

  // 5 ── watch cycles: a watch whose handler writes the key it watches
  for (const m of src.matchAll(/<watch\s[^>]*value="dsx\.variable\.(\w+)"[^>]*on:change="([^"]*)"/g)) {
    const key = m[1]!;
    if (new RegExp(`dsx\\.variable\\.${key}\\s*=[^=]`).test(m[2]!)) {
      report("warning", lineAt(src, m.index), `<watch dsx.variable.${key}> writes its own watched key — reactive cycle`);
    }
  }

  // 6 ── THE ONE-MARKUP-CORPUS LAW: Components/ is platform-NEUTRAL.
  const facetHit = new RegExp(`[\\\\/]Components[\\\\/](?:.*[\\\\/])?(${PLATFORM_FACETS.join("|")})[\\\\/]`).exec(file);
  if (facetHit !== null) {
    report("error", 1,
      `platform folder '${facetHit[1]}/' inside Components/ — markup is never platform-forked (it ` +
      "compiles into ALL renderers). A platform-specific component is a native class in the module's " +
      `${facetHit[1]}/ facet folder under the same tag name; markup adapts with conditional words, ` +
      "not forked files (facet-contracts.md).");
  }

  return findings;
}

function lintJse(
  report: (level: Level, line: number, message: string) => void,
  line: number, where: string, body: string, ctx: LintContext,
): void {
  // Identifier scans run over the body with string INTERIORS blanked (data is not code);
  // the crypto/socket scans below read names that legitimately LIVE in strings, so they
  // match the original and count only where the call token itself survived the blanking.
  const scan = blankJseStrings(body);
  for (const m of scan.matchAll(/\bdsx\.(\w+)/g)) {
    const root = `dsx.${m[1]}`;
    if (JSE_ROOTS.has(root)) continue;
    report("warning", line, `${where}: unknown namespace '${root}' (JSE roots: ${[...JSE_ROOTS].join(" ")})`);
  }
  for (const m of scan.matchAll(/\bdsx\.module\.(\w[\w-]*)/g)) {
    const scheme = m[1]!;
    if (ctx.schemes.has(scheme)) continue;
    if (ctx.schemesComplete) {
      report("error", line, `${where}: dsx.module.${scheme} — no package claims scheme '${scheme}'`);
    } else {
      report("warning", line,
        `${where}: dsx.module.${scheme} — no CONFIGURED package claims scheme '${scheme}'. The CLI only ` +
        "sees the roots in dsx.config.json (`packages`); lint_dsx.rb proves this against the whole " +
        "module tree and reports it as an ERROR there.");
    }
  }
  if (scan.includes("crypto.subtle")) {
    for (const m of body.matchAll(/crypto\.subtle\.\w+\(\s*'([^']+)'/g)) {
      if (!scan.startsWith("crypto.subtle", m.index)) continue;
      if (!CRYPTO_ALGS.has(m[1]!)) report("warning", line, `${where}: crypto algorithm '${m[1]}' not in the supported set`);
    }
    for (const m of body.matchAll(/name:\s*'([^']+)'/g)) {
      if (!scan.startsWith("name", m.index)) continue;
      const alg = m[1]!;
      if (CRYPTO_ALGS.has(alg) || !/^[A-Z0-9-]/.test(alg)) continue;
      report("warning", line, `${where}: crypto algorithm '${alg}' not in the supported set`);
    }
  }
  if (/new WebSocket\(/.test(scan) && !/key\s*:/.test(scan)) {
    report("warning", line, `${where}: new WebSocket(…) without { key: '…' } — re-runs replace by URL only`);
  }
}

/** The system-path ejection NOTICE (system-defaults.md "Ejection is explicit, never silent").
 *  Printed, never counted by --strict. Stands down when the style catalog is unavailable —
 *  exactly like the Ruby's rescue, never a crash. */
function ejectionNotice(
  report: (level: Level, line: number, message: string) => void,
  line: number, tag: string, attrs: string, ctx: LintContext,
): void {
  if (ctx.styleEjects.size === 0 || /\bappearance\s*=\s*["']custom["']/.test(attrs)) return;
  const keys = attrPairs(attrs).map((p) => p.key);
  if (tag === "list") {
    if (/\b(?:axis|direction)\s*=\s*["']horizontal["']/.test(attrs) || /\bscroll\s*=\s*["']false["']/.test(attrs)) return;
  } else if (!keys.includes("variant") && !/\brole\s*=\s*["'](?:destructive|cancel)["']/.test(attrs)) {
    return;
  }
  const ejecting = [...new Set(
    keys.filter((k) => !k.startsWith("on:") && !k.startsWith("arg:"))
      .map((k) => k.split(":")[0]!)
      .filter((b) => ctx.styleEjects.has(b)),
  )];
  if (ejecting.length === 0) return;
  const trade = tag === "list"
    ? "the list leaves the platform system list (iOS insetGrouped, wrist platters) for the custom path"
    : "the authored look ejects the button off the system path, so the variant/role system word goes inert";
  report("notice", line,
    `<${tag}> carries ${ejecting.join("= ")}= — systemPath:ejects (stack-style-properties.json): ` +
    `${trade} (system-defaults.md). Intentional? say so: appearance="custom" silences this notice`);
}

// ── context construction ───────────────────────────────────────────────────────────────

/** Read the style catalog's `systemPath: "ejects"` keys, if the repo copy is reachable.
 *  Missing/malformed → an empty set and the notice stands down (never a crash). */
/** Build the R9 census from the two reference catalogs + the shared facts file. */
export function readAttributeCensus(elementsPath: string, stylePath: string, factsPath: string): AttributeCensus | null {
  try {
    const elements = JSON.parse(readFileSync(elementsPath, "utf8")) as {
      elements: Record<string, { category?: string; attributes?: Record<string, unknown> }>;
      aliases: Record<string, string>;
      universalAttributes: Record<string, unknown>;
      childMarkers: Record<string, unknown>;
    };
    const style = JSON.parse(readFileSync(stylePath, "utf8")) as {
      groups: Array<{ properties: Array<StyleCatalogProperty> }>;
    };
    const facts = JSON.parse(readFileSync(factsPath, "utf8")) as { harnessAttrs?: string[] };
    const attrs = new Map<string, Set<string>>();
    const structural = new Set<string>();
    for (const [tag, el] of Object.entries(elements.elements)) {
      attrs.set(tag, new Set(Object.keys(el.attributes ?? {})));
      if (el.category === "structural") structural.add(tag);
    }
    const properties = style.groups.flatMap((g) => g.properties);
    const styleAlias = new Map<string, string>();
    const styleNumber = new Map<string, string>();
    const styleLength = new Set<string>();
    const styleEnums = new Map<string, Set<string>>();
    const styleEnumsByElement = new Map<string, Map<string, Set<string>>>();
    const words = (options: Array<{ value: string; aliases?: string[] }>): Set<string> =>
      new Set(options.flatMap((o) => [o.value, ...(o.aliases ?? [])]));
    for (const p of properties) {
      for (const alias of p.aliases ?? []) styleAlias.set(alias, p.key);
      if (p.control === "number") styleNumber.set(p.key, p.unit ?? "");
      else if (p.control === "length") styleLength.add(p.key);
      else if (p.control === "enum") {
        // A single-option enum (fontFamily's "system") is an OPEN vocabulary wearing an
        // editor control; only a set of 2+ is a closed grammar worth enforcing.
        if (p.options !== undefined && p.options.length >= 2) styleEnums.set(p.key, words(p.options));
        if (p.optionsByElement !== undefined) {
          styleEnumsByElement.set(p.key, new Map(
            Object.entries(p.optionsByElement).map(([tag, options]) => [tag, words(options)]),
          ));
        }
      }
    }
    return {
      attrs,
      aliases: new Map(Object.entries(elements.aliases)),
      structural,
      universal: new Set(Object.keys(elements.universalAttributes)),
      childMarkers: new Set(Object.keys(elements.childMarkers)),
      // alias spellings (paddingX, offset, fullBleed, ...) are documented vocabulary too
      styleKeys: new Set([...properties.map((pr) => pr.key), ...styleAlias.keys()]),
      harness: new Set(facts.harnessAttrs ?? []),
      styleAlias, styleNumber, styleLength, styleEnums, styleEnumsByElement,
    };
  } catch {
    return null;
  }
}

type StyleCatalogProperty = {
  key: string; control?: string; unit?: string; aliases?: string[];
  options?: Array<{ value: string; aliases?: string[] }>;
  optionsByElement?: Record<string, Array<{ value: string; aliases?: string[] }>>;
};

const STYLE_NUMBER_RE = /^-?\d+(\.\d+)?$/;
const STYLE_UNIT_WORD: { [unit: string]: string } = { pt: " in points", deg: " in degrees", s: " in seconds", lines: " of lines" };

/** R9v — the style-plane VALUE check. Returns the error message, or null when the value is
 *  lawful, bound (`{{ }}`), or the key carries no closed grammar. The runtimes drop a value
 *  they cannot parse exactly as silently as an unknown attribute, which is how
 *  `width="100%"` renders full-width on one renderer's habits and as nothing on the rest. */
export function styleValueError(
  census: AttributeCensus, catalogTag: string, tag: string, key: string, base: string, rawValue: string,
): string | null {
  if (rawValue.includes("{{")) return null;
  const value = rawValue.trim();
  if (value === "") return null;
  const canonical = census.styleAlias.get(base) ?? base;
  const sizeHint = /^(width|height|minWidth|maxWidth|minHeight|maxHeight)$/.test(canonical)
    ? ` grow="width" fills the parent; percents live on the CSS plane (style="width: 100%").`
    : "";
  const percent = /%$/.test(value)
    ? `<${tag}> ${key}="${value}": ${key}= takes points, never a percent — every renderer drops the value, so the element renders as if you never wrote it.${sizeHint}`
    : null;
  const unit = census.styleNumber.get(canonical);
  if (unit !== undefined) {
    if (STYLE_NUMBER_RE.test(value)) return null;
    return percent ?? `<${tag}> ${key}="${value}": ${key}= takes a plain number${STYLE_UNIT_WORD[unit] ?? ""} — the value does not parse and is dropped silently, so the element renders as if you never wrote it.`;
  }
  if (census.styleLength.has(canonical)) {
    if (STYLE_NUMBER_RE.test(value) || value === "fit" || value === "fit-content") return null;
    return percent ?? `<${tag}> ${key}="${value}": ${key}= takes a number in points or fit — the value does not parse and is dropped silently, so the element renders as if you never wrote it.`;
  }
  const byElement = census.styleEnumsByElement.get(canonical);
  const allowed = byElement !== undefined ? byElement.get(catalogTag) : census.styleEnums.get(canonical);
  if (allowed !== undefined && !allowed.has(value)) {
    return `<${tag}> ${key}="${value}": ${key}= is one of ${[...allowed].join(" | ")} — an unknown word is dropped silently and the element renders with the default (stack-style-properties.json owns the vocabulary).`;
  }
  return null;
}

export function readStyleEjects(catalogPath: string): Set<string> {
  const out = new Set<string>();
  try {
    const doc = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      groups?: Array<{ properties?: Array<{ key?: string; aliases?: string[]; systemPath?: string }> }>;
    };
    for (const group of doc.groups ?? []) {
      for (const property of group.properties ?? []) {
        if (property.systemPath !== "ejects") continue;
        if (typeof property.key === "string") out.add(property.key);
        for (const alias of property.aliases ?? []) out.add(alias);
      }
    }
  } catch { /* the catalog gates itself; the notice stands down */ }
  return out;
}

/** Walk up from `dir` for the nearest dsx.json and return its `scheme`. */
export function schemeForDir(dir: string, stopAt: string): string | null {
  let cursor = dir;
  for (;;) {
    const manifest = join(cursor, "dsx.json");
    if (existsSync(manifest)) {
      try {
        const scheme = (JSON.parse(readFileSync(manifest, "utf8")) as { scheme?: string }).scheme;
        if (typeof scheme === "string" && scheme.length > 0) return scheme;
      } catch { /* a broken manifest is the compiler's finding, not the linter's */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor || !cursor.startsWith(stopAt)) return null;
    cursor = parent;
  }
}

/** Fold a whole TREE of packages: every folder under `root` that holds a dsx.json, plus the
 *  global components Swift modules declare (`override class var tag`). Pointed at
 *  ClosedSource/DSX/Modules this reproduces lint_dsx.rb's own component pool and scheme
 *  universe; pointed at one package folder it folds exactly that package. */
export function foldPackageTree(
  root: string, pool: Map<string, Array<string | null>>, schemes: Set<string>,
  componentsOf: (packageRoot: string) => string[],
): number {
  let packages = 0;
  const skip: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "Pods", ".build"]);
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (existsSync(join(dir, "dsx.json"))) {
      foldPackage(dir, pool, schemes, componentsOf(dir));
      packages += 1;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        // a Swift-defined GLOBAL component is resolvable everywhere (the Ruby pool's third source)
        const source = readFileSync(join(dir, entry.name), "utf8");
        for (const m of source.matchAll(/override class var tag: String \{ "(\w+)" \}/g)) {
          const tag = m[1]!;
          if (/^[A-Z]/.test(tag)) pool.set(tag, [...(pool.get(tag) ?? []), null]);
        }
      }
    }
  };
  walk(root);
  return packages;
}

/** Fold one package root (a folder holding dsx.json + Components/) into a pool + scheme set. */
export function foldPackage(
  root: string, pool: Map<string, Array<string | null>>, schemes: Set<string>, files: string[],
): void {
  const manifestPath = join(root, "dsx.json");
  let scheme: string | null = null;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        scheme?: string; aliases?: string[]; web?: { components?: Array<string | { name?: string }> };
      };
      if (typeof manifest.scheme === "string" && manifest.scheme.length > 0) scheme = manifest.scheme;
      if (scheme !== null) schemes.add(scheme);
      for (const alias of manifest.aliases ?? []) if (typeof alias === "string") schemes.add(alias);
      // /web/18: a module-provided web component is resolvable in its own package
      for (const entry of manifest.web?.components ?? []) {
        const name = typeof entry === "string" ? entry : entry.name;
        if (typeof name === "string" && /^[A-Z]/.test(name)) {
          pool.set(name, [...(pool.get(name) ?? []), scheme]);
        }
      }
    } catch { /* a broken manifest is the compiler's finding */ }
  }
  for (const file of files) {
    if (!file.startsWith(root + sep) && file !== root) continue;
    const name = basename(file, ".dsx");
    pool.set(name, [...(pool.get(name) ?? []), scheme]);
  }
}

/** Format one finding exactly like lint_dsx.rb prints it. */
export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: ${f.level}: ${f.message}`;
}

/** error/warning/notice tallies for a run. */
export function tally(findings: readonly Finding[]): { errors: number; warnings: number; notices: number } {
  return {
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    notices: findings.filter((f) => f.level === "notice").length,
  };
}
