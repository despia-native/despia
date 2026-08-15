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

import { parseDsx, DsxParseError } from "@despia/compiler";

export type Level = "error" | "warning" | "notice";
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
  /** false when the scheme universe is only partially known — softens the
   *  `dsx.module.<scheme>` rule from error to warning and says why */
  schemesComplete: boolean;
};

// ── ground truth (the same table Conformance/lint/facts.json carries) ──────────────────
//
// This list is a COPY, and copies drift — this one had drifted (the twelve scene-3D tags
// were missing) before packages/cli/test/lint-corpus.test.ts started asserting it equals
// facts.json's builtinTags byte for byte. It stays a literal rather than a runtime read
// because this file ships in @despia/cli and runs on machines with no repo checkout;
// facts.json is the repo's ground truth and the test is the tether.

/** Built-in lowercase tags: engine specials + Foundation components + documented aliases. */
export const BUILTIN_TAGS: ReadonlySet<string> = new Set([
  "stack", "vstack", "hstack", "zstack", "scroll", "spacer", "divider", "text", "label", "image", "svg",
  "button", "glassButton", "transport", "pressable", "row", "progress", "capsuleProgress", "spinner",
  "activity", "textfield", "input", "toggle", "switch", "slider", "list", "grid", "pager", "sheet",
  "contextmenu", "video", "audio", "chart", "map", "field", "form", "tabs", "scaffold", "refreshable",
  "datepicker", "date", "picker", "segmented", "stepper", "gauge", "textarea", "otp", "searchbar",
  "combobox", "rangeslider", "wheelpicker", "segmentedButton", "stars", "alert", "confirmDialog", "menu",
  "popover", "carousel", "toolbar", "flow", "lockscreen", "small", "island", "compact", "expanded",
  "minimal", "leading", "trailing", "center", "bottom", "head", "event", "expects", "api", "action",
  "variable", "var", "let", "formula", "script", "functions", "watch", "attribute", "style", "slot",
  "node", "dynamic", "component", "qrcode", "calendar", "lightbox", "lottie", "markdown",
  "scene", "camera", "light", "group", "box", "sphere", "plane", "model", "text3d", "anchor", "animate", "sprite",
]);

/** Tags whose bodies are raw JS, lifted before the structural scans (StackXML.codeTags). */
const CODE_TAGS = ["script", "functions", "action", "formula", "variable", "var", "let"] as const;

/** Declarations that belong in <head> (dsx-anatomy.md). <watch> is handled separately. */
const DECL_TAGS: ReadonlySet<string> = new Set([
  "action", "variable", "var", "let", "formula", "script", "functions", "style", "attribute",
  "component", "event", "expects", "api",
]);

/** Canonical <head> order; a monotonic rank also enforces same-kind contiguity. */
const HEAD_RANK: { readonly [tag: string]: number } = {
  attribute: 0, expects: 1, event: 2,
  api: 3, variable: 3, var: 3, let: 3,      // rank 4 when computed="true"
  formula: 5, action: 6, script: 7, functions: 7,
  watch: 8, style: 9, component: 10,
};
const HEAD_ORDER_HINT =
  "attribute → expects → event → api/variable (plain → computed) → formula → action → script → watch → style → component";

const HANDLER_MAX_STATEMENTS = 2;
const HANDLER_MAX_CHARS = 120;
const STATE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SETTLE_ATTR_RE = /\bsettle\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const SETTLED_CALL_RE = /\bdsx\.screen\.settled\s*\(/;

const JSE_ROOTS: ReadonlySet<string> = new Set([
  "dsx.variable", "dsx.attribute", "dsx.action", "dsx.module", "dsx.component", "dsx.event",
  "dsx.error", "dsx.log", "dsx.this", "dsx.item", "dsx.index", "dsx.cookie", "dsx.global",
  "dsx.route", "dsx.query", "dsx.formula", "dsx.app", "dsx.screen", "dsx.element", "dsx.params",
  "dsx.path",
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
  for (const ch of body) {
    if (quote !== null) {
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
  const report = (level: Level, line: number, message: string): void => {
    findings.push({ file, line, level, message });
  };
  const src = stripComments(raw);
  const lifted = liftCodeBodies(src);
  const localScheme = ctx.schemeOf(dirname(file));

  // 0 ── strict well-formedness, through the RUNTIME's own parser (@despia/compiler parseDsx
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
  for (const m of raw.matchAll(/<!--[\s\S]*?-->/g)) {
    const hit = /<\s*(script|action|formula|variable|var|let)\b/.exec(m[0]);
    if (hit === null) continue;
    report("warning", lineAt(raw, m.index),
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
      if (rank === 3 && /computed\s*=\s*["']true["']/.test(t.attrs)) rank = 4;
      if (rank === undefined) {
        report("warning", t.line, `<${t.tag}> inside <head> — only declarations belong in the head (${HEAD_ORDER_HINT})`);
      } else if (rank < parent.lastRank) {
        report("warning", t.line,
          `head order: <${t.tag}> after <${parent.lastRankTag}> — keep the canonical order ` +
          `${HEAD_ORDER_HINT} (same-kind declarations contiguous)`);
      } else if (rank > parent.lastRank) {
        parent.lastRank = rank;
        parent.lastRankTag = t.tag === "variable" && rank === 4 ? "variable computed" : t.tag;
      }
    }

    // identifier discipline: as= is REQUIRED; the legacy name= identifier alias is removed
    if (["action", "variable", "var", "let", "formula", "style", "component", "attribute", "event", "api"].includes(t.tag)) {
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
    if (t.tag === "expects" && !/\bvariable\s*=/.test(t.attrs)) {
      report("error", t.line, "<expects> missing variable= — declare the seeded state it stands for");
    }

    if (["list", "grid", "pager"].includes(t.tag) && /\bbind\s*=/.test(t.attrs) && !/\bkey\s*=/.test(t.attrs)) {
      report("warning", t.line,
        `<${t.tag} bind=…> without key= — rows need a stable identity (key="id", or key="index" for static data)`);
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
        const resolvable = (localScheme !== null && scopes.includes(localScheme)) || scopes.includes(null) || localDefs.has(t.tag);
        if (!resolvable) report("error", t.line, `<${t.tag}>: unresolved component (not in this package, not global)`);
      }
    } else if (!BUILTIN_TAGS.has(t.tag)) {
      report("warning", t.line, `<${t.tag}>: unknown element tag (typo, or extend BUILTIN_TAGS in the linter)`);
    }

    for (const { key, value } of attrPairs(t.attrs)) {
      let exprs = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!);
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
    const seenEvent = new Set<string>();
    for (const m of src.matchAll(/dsx\.event\(\s*['"]([\w:.-]+)['"]/g)) {
      const name = m[1]!;
      if (declaredEvents.has(name) || seenEvent.has(name)) continue;
      seenEvent.add(name);
      report("warning", lineAt(src, m.index),
        `dsx.event('${name}') is not declared — add <event as="${name}"/> to <head> (the component's outbound contract)`);
    }
    const seenVar = new Set<string>();
    for (const m of src.matchAll(/dsx\.variable\.(\w+)/g)) {
      const name = m[1]!;
      if (declaredVars.has(name) || seenVar.has(name)) continue;
      seenVar.add(name);
      report("warning", lineAt(src, m.index),
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
  for (const m of body.matchAll(/\bdsx\.(\w+)/g)) {
    const root = `dsx.${m[1]}`;
    if (JSE_ROOTS.has(root)) continue;
    report("warning", line, `${where}: unknown namespace '${root}' (JSE roots: ${[...JSE_ROOTS].join(" ")})`);
  }
  for (const m of body.matchAll(/\bdsx\.module\.(\w[\w-]*)/g)) {
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
  if (body.includes("crypto.subtle")) {
    for (const m of body.matchAll(/crypto\.subtle\.\w+\(\s*'([^']+)'/g)) {
      if (!CRYPTO_ALGS.has(m[1]!)) report("warning", line, `${where}: crypto algorithm '${m[1]}' not in the supported set`);
    }
    for (const m of body.matchAll(/name:\s*'([^']+)'/g)) {
      const alg = m[1]!;
      if (CRYPTO_ALGS.has(alg) || !/^[A-Z0-9-]/.test(alg)) continue;
      report("warning", line, `${where}: crypto algorithm '${alg}' not in the supported set`);
    }
  }
  if (/new WebSocket\(/.test(body) && !/key\s*:/.test(body)) {
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
