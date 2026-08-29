//
//  lint.ts - the TS lint twin (doc 09 "Linter strategy — one rule source, two runners",
//  step 2). The Ruby linters (`lint_dsx.rb`/`lint_dsx_css.rb`) remain the repo's
//  authoritative per-PR gate — nothing here removes or weakens them. This runner exists
//  for the DEV LOOP (in-process, incremental, editor diagnostics) and for the WEB-ONLY
//  checks the Ruby side never owned (the `<api>` rules from doc 05, the route-table
//  checks from doc 04).
//
//  Rule FACTS load from the SHARED facts file (`OpenSource/Conformance/lint/facts.json`)
//  — the same bytes lint_dsx.rb reads, so facts cannot drift. Rule LOGIC is anti-drifted
//  by the fixture corpus beside it: `cases/shared/` runs on BOTH runners
//  (lint_conformance.rb drives the Ruby side), `cases/web/` on this one only.
//
//  Diagnostics carry a stable RULE ID — the corpus compares (line, level, rule), never
//  message wording, so either side can improve its prose without breaking the other.
//

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyBody } from "@despia/kernel";

export type LintLevel = "error" | "warning" | "notice";

export type LintDiagnostic = {
  file: string;
  line: number;         // 1-based
  level: LintLevel;
  rule: string;         // stable id — the corpus key
  message: string;
};

type Facts = {
  builtinTags: string[];
  codeTags: string[];
  declTags: string[];
  headRank: { [tag: string]: number };
  headComputedRank: number;
  headOrderHint: string;
  handlerMaxStatements: number;
  handlerMaxChars: number;
  identifierTags: string[];
  keyedCollections: string[];
  valuelessInputTags?: string[];
  harnessAttrs?: string[];
};

/** Locate the SHARED facts file by walking up from this module (works from src and
 *  dist alike — the repo layout is the anchor, not a relative depth). Node-side dev
 *  tooling by design: this module is deliberately NOT exported from the package index,
 *  so the browser-bundled compiler surface never carries node:fs. */
function loadFacts(): Facts {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "OpenSource", "Conformance", "lint", "facts.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")) as Facts;
    const alt = join(dir, "Conformance", "lint", "facts.json");   // when anchored inside OpenSource/
    if (existsSync(alt)) return JSON.parse(readFileSync(alt, "utf8")) as Facts;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("lint facts not found — OpenSource/Conformance/lint/facts.json (run from the repo)");
}

/** The attribute census (R9): per-element vocabulary from the same reference catalogs
 *  the Ruby gate and the CLI twin read. Walk-up anchored like loadFacts; null when the
 *  catalogs are out of reach (the rule stands down — a dev-loop runner outside the repo
 *  cannot judge vocabulary it cannot see). */
type AttributeCensus = {
  attrs: Map<string, Set<string>>;
  aliases: Map<string, string>;
  structural: Set<string>;
  universal: Set<string>;
  childMarkers: Set<string>;
  styleKeys: Set<string>;
  harness: Set<string>;
};

function loadCensus(): AttributeCensus | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const ref = existsSync(join(dir, "OpenSource", "Documentation", "reference", "stack-elements.json"))
      ? join(dir, "OpenSource", "Documentation", "reference")
      : existsSync(join(dir, "Documentation", "reference", "stack-elements.json"))
        ? join(dir, "Documentation", "reference")
        : null;
    if (ref !== null) {
      try {
        const elements = JSON.parse(readFileSync(join(ref, "stack-elements.json"), "utf8")) as {
          elements: Record<string, { category?: string; attributes?: Record<string, unknown> }>;
          aliases: Record<string, string>;
          universalAttributes: Record<string, unknown>;
          childMarkers: Record<string, unknown>;
        };
        const style = JSON.parse(readFileSync(join(ref, "stack-style-properties.json"), "utf8")) as {
          groups: Array<{ properties: Array<{ key: string }> }>;
        };
        const attrs = new Map<string, Set<string>>();
        const structural = new Set<string>();
        for (const [tag, el] of Object.entries(elements.elements)) {
          attrs.set(tag, new Set(Object.keys(el.attributes ?? {})));
          if (el.category === "structural") structural.add(tag);
        }
        return {
          attrs,
          aliases: new Map(Object.entries(elements.aliases)),
          structural,
          universal: new Set(Object.keys(elements.universalAttributes)),
          childMarkers: new Set(Object.keys(elements.childMarkers)),
          styleKeys: new Set(style.groups.flatMap((g) => g.properties.map((pr) => pr.key))),
          harness: new Set(FACTS.harnessAttrs ?? []),
        };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The confusions people actually type, mapped to the element's own spelling. */
const ATTR_CONFUSIONS = new Map<string, string>([
  ["button value", "label"],
  ["text label", "value"],
  ["image source", "src"],
  ["textfield value", "bind"],
  ["textarea value", "bind"],
  ["searchbar value", "bind"],
]);

function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur.push(Math.min(prev[j + 1]! + 1, cur[j]! + 1, prev[j]! + (a[i] === b[j] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const FACTS = loadFacts();
const CENSUS = loadCensus();

// ── the style-override plane (Conformance/overrides — twins of lint_dsx.rb's block) ──
const OVERRIDE_TYPES = ["number", "length", "enum", "multiEnum", "color", "gradient", "ratio", "boolean", "text", "css"];
const OVERRIDE_RESERVED = ["ios", "android", "web", "watch", "wear", "macos", "windows", "linux", "native", "desktop"] as const;
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
const BUILTIN = new Set(FACTS.builtinTags);
const DECL = new Set(FACTS.declTags);
const IDENTIFIER_TAGS = new Set(FACTS.identifierTags);
const KEYED = new Set(FACTS.keyedCollections);
const VALUELESS_INPUTS = new Set<string>(FACTS.valuelessInputTags ?? []);
const STATE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type LintOptions = {
  file?: string;
  /** Known component tags (folder `.dsx` names, native globals) — spares unknown-tag noise. */
  knownComponents?: Iterable<string>;
  /** /web/15 law 4's app-level strict mode: every JS-tier action body becomes an ERROR
   *  (guaranteed-portable, interpreter-only decks with one switch). Default off: a
   *  JS-tier body is a NOTICE — visible, never silent, never blocking. */
  strictTiers?: boolean;
};

/** Blank comments + code-element bodies LINE-STABLY (the lint_dsx.rb lift — raw JS in
 *  `<script>`/`<action>` bodies must not read as markup, and line numbers must stay
 *  source-true). */
function lineStableLift(source: string): string {
  const blank = (s: string, re: RegExp, group: number): string => {
    let out = s;
    const matches = [...s.matchAll(re)].reverse();
    for (const m of matches) {
      const whole = m[0];
      const inner = m[group];
      if (inner === undefined || inner.length === 0) continue;
      const at = (m.index ?? 0) + whole.indexOf(inner);
      const blanked = inner.replace(/[^\n]/g, " ");
      out = out.slice(0, at) + blanked + out.slice(at + inner.length);
    }
    return out;
  };
  let s = blank(source, /<!--([\s\S]*?)-->/g, 1);
  const code = FACTS.codeTags.join("|");
  s = blank(s, new RegExp(`<(?:${code})\\b[^>]*?>([\\s\\S]*?)</(?:${code})>`, "g"), 1);
  return s;
}

/** Lint one `.dsx` source. The scan mirrors lint_dsx.rb's tag walk for the SHARED rules
 *  (corpus-pinned) and adds the web-only `<api>` rules (doc 05). */
export function lintSource(source: string, opts: LintOptions = {}): LintDiagnostic[] {
  const file = opts.file ?? "input.dsx";
  const known = new Set([...(opts.knownComponents ?? [])]);
  const out: LintDiagnostic[] = [];
  const report = (line: number, level: LintLevel, rule: string, message: string): void => {
    out.push({ file, line, level, rule, message });
  };

  const lifted = lineStableLift(source);
  const rawLines = lifted.split("\n");
  type Frame = { tag: string; line: number; lastRank: number; lastRankTag: string | null };
  const stack: Frame[] = [];
  const apiNames = new Map<string, number>();   // as → first line (duplicate detection)
  let line = 1;
  let last = 0;

  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  for (const m of lifted.matchAll(tagRe)) {
    const at = m.index ?? 0;
    for (let i = last; i < at; i++) if (lifted[i] === "\n") line += 1;
    last = at;
    const [, closing, tag, attrs, selfclose] = m as unknown as [string, string, string, string, string];
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) { stack.splice(i); break; }
      }
      continue;
    }

    const parent = stack[stack.length - 1] ?? null;
    const inHead = parent !== null && parent.tag === "head";

    // ── SHARED rules (corpus cases/shared — lint_dsx.rb is the co-runner) ──────────
    if (/^[a-z]/.test(tag) && !tag.includes(".") && !BUILTIN.has(tag) && !known.has(tag)) {
      report(line, "warning", "unknown-tag", `<${tag}>: unknown element tag (typo, or extend the shared facts)`);
    }
    if (DECL.has(tag) && !inHead) {
      report(line, "warning", "decl-outside-head", `<${tag}> outside <head> — declarations live in the document head (dsx-anatomy.md)`);
    }
    if (tag === "watch" && !inHead && !stack.some((e) => KEYED.has(e.tag))) {
      report(line, "warning", "watch-outside-head", "<watch> outside <head> — screen-level watches live in the head (only a list/grid/pager row hosts a per-row watch)");
    }
    if (inHead && parent !== null) {
      let rank: number | undefined = FACTS.headRank[tag];
      if (rank === FACTS.headRank["variable"] && /computed\s*=\s*["']true["']/.test(attrs)) rank = FACTS.headComputedRank;
      if (rank === undefined) {
        report(line, "warning", "head-purity", `<${tag}> inside <head> — only declarations belong in the head (${FACTS.headOrderHint})`);
      } else if (rank < parent.lastRank) {
        report(line, "warning", "head-order", `head order: <${tag}> after <${parent.lastRankTag}> — keep the canonical order ${FACTS.headOrderHint} (same-kind declarations contiguous)`);
      } else if (rank > parent.lastRank) {
        parent.lastRank = rank;
        parent.lastRankTag = tag === "variable" && rank === FACTS.headComputedRank ? "variable computed" : tag;
      }
    }
    if (IDENTIFIER_TAGS.has(tag)) {
      if (!/\bas\s*=/.test(attrs)) {
        if (/\bname\s*=/.test(attrs) && tag !== "action" && tag !== "formula") {
          report(line, "error", "legacy-name", `<${tag} name=…>: the legacy name= identifier was removed — the identifier is as=`);
        } else {
          report(line, "error", "missing-as", `<${tag}> missing as= — registration is a silent no-op at runtime`);
        }
      }
    }
    // R10 — the SILENT STYLE DROP (the feedback-loop law: nothing is dropped silently).
    // `style=""` is parsed by splitting on `;` FIRST and keeping only fragments that carry a
    // `:` (compiler/src/cssmap.ts parseStyleAttr). So a whole-value hole composed with other
    // declarations — `style="{{ shell }}; height: 100%"` — loses the hole entirely: the
    // interpolation never runs, the extras apply, and nothing anywhere reports it. The
    // whole-attribute spelling (`style="{{ oneComputedList }}"`) IS a first-class door, which
    // is exactly what makes the composed spelling look reasonable.
    {
      const sm = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
      const styleValue = sm?.[1] ?? sm?.[2];
      if (styleValue !== undefined && styleValue.includes("{{")) {
        const parts = styleValue.split(";");
        if (parts.length > 1) {
          for (const part of parts) {
            const frag = part.trim();
            if (frag.length === 0 || frag.includes(":") || !frag.includes("{{")) continue;
            report(line, "error", "style-hole-dropped",
              `<${tag} style="… ${frag} …">: this hole is DISCARDED — style="" splits on ';' before `
              + `interpolating, and a fragment with no ':' is skipped, so ${frag} never reaches the `
              + `element while the declarations beside it apply. Fold the whole list into ONE computed `
              + `value and use it as the whole attribute (style="{{ oneList }}"), or give the hole its `
              + `own declaration (prop: {{ value }}).`);
          }
        }
      }
    }

    // G4 unified input (dsx-game.md §2): `input` is BOTH a body form element (builtinTags,
    // unchanged) and a head DEVICE-BINDING declaration — POSITION is the disambiguation, which
    // is why it carries a headRank but is deliberately absent from declTags/identifierTags.
    // The identifier discipline therefore applies POSITIONALLY.
    if (tag === "input" && inHead && !/\bas\s*=/.test(attrs)) {
      report(line, "error", "missing-as", "<input> missing as= — registration is a silent no-op at runtime");
    }
    // <tool action= description= as= mutates=/> — the AGENT interface row
    // (proposals/webmcp.md). `as` is OPTIONAL and defaults to the action name (the
    // <server><tool> rule), which is why `tool` is deliberately absent from identifierTags;
    // `action` is the identifier that must be there, because a row naming nothing has
    // nothing to expose.
    if (tag === "tool") {
      if (!/\baction\s*=/.test(attrs)) {
        report(line, "error", "tool-action", "<tool> missing action= — an agent tool names the declared action it exposes");
      }
      if (!/\bdescription\s*=/.test(attrs)) {
        report(line, "error", "tool-description", "<tool> missing description= — the description is the whole basis on which an agent chooses this tool");
      }
      const tm = attrs.match(/\bas\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const toolName = tm === null ? null : (tm[1] ?? tm[2] ?? "");
      if (toolName !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(toolName)) {
        report(line, "error", "tool-name", '<tool as=...> must be 1 to 128 characters of ASCII letters, digits, "_", "-" or "." (the WebMCP tool-name grammar)');
      }
    }
    if (tag === "expects" && !/\bvariable\s*=/.test(attrs)) {
      report(line, "error", "expects-variable", "<expects> missing variable= — declare the seeded state it stands for");
    }
    // <override> declaration discipline (the style contract — Conformance/overrides):
    // a knob the runtime cannot resolve silently answers its default, so every
    // declaration fact is checked where it is written. Twin of lint_dsx.rb's block.
    if (tag === "override") {
      const attrOf = (name: string): string | undefined => {
        const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
        return m === null ? undefined : (m[1] ?? m[2]);
      };
      const oAs = attrOf("as");
      const oType = attrOf("type");
      const oOptions = attrOf("options");
      const oDefault = attrOf("default");
      if (oAs !== undefined && oAs.length > 0) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(oAs)) {
          report(line, "error", "override-name", `<override as="${oAs}">: an override name is an identifier — dsx.override.${oAs} must be a legal member read`);
        }
        if ((OVERRIDE_RESERVED as readonly string[]).includes(oAs)) {
          report(line, "error", "override-reserved-name", `<override as="${oAs}">: '${oAs}' is a platform-suffix word — the platform fold consumes override:${oAs}= before the split ever runs, so this knob could never be set; pick another name`);
        }
      }
      if (oType !== undefined && !OVERRIDE_TYPES.includes(oType)) {
        report(line, "error", "override-type", `<override type="${oType}">: not an override type — the vocabulary is ${OVERRIDE_TYPES.join(" ")} (the style catalog's control set + css)`);
      }
      if ((oType === "enum" || oType === "multiEnum") && (oOptions === undefined || oOptions.trim().length === 0)) {
        report(line, "error", "override-options", `<override type="${oType}"> without options= — an enum knob with no members can never accept a value (every read answers the default)`);
      }
      for (const bound of ["min", "max"]) {
        const b = attrOf(bound);
        if (b !== undefined && !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(b.trim())) {
          report(line, "error", "override-min-max", `<override ${bound}="${b}">: ${bound}= is a number (the clamp bound)`);
        }
      }
      if (oDefault !== undefined && oDefault.includes("{{")) {
        report(line, "error", "override-default-bound", '<override default=…>: a default is a LITERAL style value, never a binding — {{ }} belongs at the usage site (override:name="{{ … }}")');
      } else if (oDefault !== undefined) {
        const why = overrideLiteralError(oType ?? "text", oDefault, oOptions);
        if (why !== null) {
          report(line, "error", "override-default", `<override default="${oDefault}">: the default is not ${why} — an invalid default resolves null, so the knob has no fallback at all`);
        }
      }
    }
    // sample= — the unit-test sample value (master plan P3). JSON on every runner
    // (decision 10), v1 kinds only (decision 11): on <formula>/<action> every head parser
    // today folds unknown attributes into input bindings, so a sample there is ACTIVE
    // runtime state until all four parsers learn the skip — an error naming the deferral.
    {
      const sm = attrs.match(/\bsample\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      if (sm !== null) {
        const sampleText = (sm[1] ?? sm[2] ?? "")
          .replaceAll("&quot;", '"').replaceAll("&#39;", "'")
          .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
        if (tag === "formula" || tag === "action") {
          report(line, "error", "sample-deferred",
            `sample= on <${tag}> is deferred — it becomes an input binding evaluated at call time; declare samples on variable/event/api/attribute (master plan P3)`);
        } else if (["variable", "var", "let", "event", "api", "attribute"].includes(tag)) {
          try {
            JSON.parse(sampleText);
          } catch {
            report(line, "error", "sample-json",
              "sample= is not valid JSON — a sample is a JSON literal on every runner; quote strings (sample='\"Spring sale\"'), use [] and {} for structure");
          }
        }
      }
    }
    if (KEYED.has(tag) && /\bbind\s*=/.test(attrs) && !/\bkey\s*=/.test(attrs)) {
      report(line, "warning", "bind-without-key", `<${tag} bind=…> without key= — rows need a stable identity (key="id", or key="index" for static data)`);
    }
    // A text input reads its content from `bind=` and never looks at `value=`, on every
    // renderer — so `value=` here parses, renders an empty field, and reports nothing. It is
    // the spelling for what a <text>/<image>/<progress> SHOWS, which is exactly why an author
    // reaches for it. A NOTICE: `value` is a legal attribute name and someone's own component
    // may consume it; the rule is aimed at the canonical inputs, where it is provably inert.
    if (VALUELESS_INPUTS.has(tag) && /(?:^|\s)value\s*=/.test(attrs)) {
      report(line, "notice", "input-value-inert",
        `<${tag} value=…> is inert — a text input reads its content from bind= (path-aware, including the current row). value= parses, renders nothing, and reports no error. Did you mean bind=?`);
    }
    // R9 — the attribute vocabulary (third runner of the same corpus rule: lint_dsx.rb
    // is the CI gate, the CLI twin the shipped `dsx lint`, this one the dev loop).
    // Main-surface dialect only: extension apps and Live Activity layouts (markup
    // inside a JSE string) keep their own grammars. Stands down without the census.
    if (CENSUS !== null && !file.includes("/Extensions/")
        && !(rawLines[line - 1] ?? "").includes("return '<")) {
      const catalogTag = CENSUS.aliases.get(tag) ?? tag;
      const known = CENSUS.structural.has(catalogTag) || DECL.has(tag)
        ? undefined
        : CENSUS.attrs.get(catalogTag);
      if (known !== undefined) {
        for (const am of attrs.matchAll(/([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)) {
          const key = am[1]!;
          if (key.startsWith("override:")) {
            // the style contract is COMPONENT grammar: an element's attributes ARE its
            // style surface, so an override: here can only be a misplaced habit
            report(line, "warning", "override-on-element",
              `<${tag}> ${key}=: override: is the component style contract — <${tag}> is an element; set the style attribute directly (its attributes are the style surface)`);
            continue;
          }
          let base = key.replace(/:(ios|android|watch|web|desktop|macos|windows|linux)$/, "");
          base = base.replace(/-(web|ios|android|watch|desktop)$/, "");
          if (base.startsWith("on:") || base.startsWith("__")) continue;
          if (known.has(base) || CENSUS.universal.has(base) || CENSUS.childMarkers.has(base)) continue;
          if (CENSUS.harness.has(base) || CENSUS.styleKeys.has(base)) continue;
          const confusion = ATTR_CONFUSIONS.get(`${catalogTag} ${base}`);
          const candidates = [...known, ...CENSUS.universal, ...CENSUS.harness, ...CENSUS.styleKeys];
          let nearest = confusion ?? candidates[0] ?? "";
          if (confusion === undefined) {
            for (const c of candidates) if (editDistance(base, c) < editDistance(base, nearest)) nearest = c;
          }
          if (confusion !== undefined) {
            report(line, "error", "attr-unknown",
              `<${tag}> ${key}=: not an attribute this element honours — this element spells it ${confusion}=. The runtime drops unknown attributes silently, so the element renders as if you never wrote it.`);
          } else if (nearest !== "" && editDistance(base, nearest) <= 2 && base.length >= 3) {
            report(line, "error", "attr-unknown",
              `<${tag}> ${key}=: not an attribute this element honours — did you mean ${nearest}=? The runtime drops unknown attributes silently, so the element renders as if you never wrote it.`);
          } else {
            report(line, "notice", "attr-census-gap",
              `<${tag}> ${key}=: not in the census for this element (stack-elements.json) — a typo dies here, a real word belongs in the census so every surface learns it`);
          }
        }
      }
    }

    // ── the `<api>` rules (doc 05 — WEB-ONLY, cases/web) ───────────────────────────
    if (tag === "api") {
      const asMatch = attrs.match(/\bas\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const asName = asMatch === null ? null : (asMatch[1] ?? asMatch[2] ?? "");
      if (asName !== null && asName.length > 0) {
        if (!STATE_IDENTIFIER_RE.test(asName)) {
          report(line, "error", "api-as-identifier", "<api as=...> must be an ASCII identifier of at most 128 characters");
        }
        const first = apiNames.get(asName);
        if (first !== undefined) {
          report(line, "error", "api-duplicate-as", `<api as="${asName}"> duplicates the block declared on line ${first} — reserved paths would collide`);
        } else {
          apiNames.set(asName, line);
        }
      }
      const method = (attrs.match(/\bmethod\s*=\s*(?:"([^"]*)"|'([^']*)')/)?.[1] ?? attrs.match(/\bmethod\s*=\s*(?:"([^"]*)"|'([^']*)')/)?.[2] ?? "GET").toUpperCase();
      if (method !== "GET") {
        if (/\bssr\s*=\s*["'](?:true|1)?["']/.test(attrs)) {
          report(line, "warning", "api-ssr-non-get", `<api method="${method}" ssr=…> — SSR never runs a mutation; the flag is inert (doc 05)`);
        }
        if (/\bdefer\s*=\s*["'](?:true|1)?["']/.test(attrs)) {
          report(line, "warning", "api-defer-non-get", `<api method="${method}" defer=…> — only GETs stream; the flag is inert (doc 02)`);
        }
      }
    }

    // ── the W9 tier rules (/web/15 law 4 — WEB-ONLY runner, one shared classifier) ──
    // `on:*` handlers are action-tier bodies: classify each, surface the verdict.
    const tierAssert = /\btier\s*=\s*["']jse["']/.test(attrs);
    for (const h of attrs.matchAll(/\bon:[\w.-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const body = h[1] ?? h[2] ?? "";
      if (body.length === 0) continue;
      const verdict = classifyBody(body);
      if (verdict.tier === "jse") continue;
      if (tierAssert) {
        report(line, "error", "tier-assert", `tier="jse" asserted but the handler escalates: ${verdict.reason ?? "beyond the JSE subset"}`);
      } else if (opts.strictTiers === true) {
        report(line, "error", "strict-escalation", `strict tiers: this handler runs on the JS tier (${verdict.reason ?? "beyond the JSE subset"})`);
      } else {
        report(line, "notice", "js-tier", `this handler runs on the JS tier (${verdict.reason ?? "beyond the JSE subset"}) — pin with tier="jse" to require the fast path`);
      }
    }

    if (selfclose !== "/") {
      stack.push({ tag, line, lastRank: -1, lastRankTag: null });
    }
  }

  // ── `<action>` bodies (from the RAW source — the lift blanked them above) ────────
  for (const m of source.matchAll(/<action\b((?:"[^"]*"|'[^']*'|[^>"'])*?)>([\s\S]*?)<\/action>/g)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (body.trim().length === 0) continue;
    const bodyLine = 1 + source.slice(0, m.index ?? 0).split("\n").length - 1;
    const verdict = classifyBody(body);
    if (verdict.tier === "jse") continue;
    if (/\btier\s*=\s*["']jse["']/.test(attrs)) {
      report(bodyLine, "error", "tier-assert", `tier="jse" asserted but the action escalates: ${verdict.reason ?? "beyond the JSE subset"}`);
    } else if (opts.strictTiers === true) {
      report(bodyLine, "error", "strict-escalation", `strict tiers: this action runs on the JS tier (${verdict.reason ?? "beyond the JSE subset"})`);
    } else {
      report(bodyLine, "notice", "js-tier", `this action runs on the JS tier (${verdict.reason ?? "beyond the JSE subset"}) — pin with tier="jse" to require the fast path`);
    }
  }
  return out;
}

// ── the route-table checks (doc 04 — WEB-ONLY) ─────────────────────────────────────────

export type RouteEntryLike = {
  path?: unknown; component?: unknown; redirect?: unknown; requires?: unknown;
};

/** Lint a route table (the registry/routes.json shape). Structural checks only — the
 *  server's assertSafeRouteTable stays the runtime enforcement; this catches the same
 *  classes at AUTHORING time with rule ids. */
export function lintRoutes(routes: readonly RouteEntryLike[], opts: { file?: string; knownComponents?: Iterable<string> } = {}): LintDiagnostic[] {
  const file = opts.file ?? "routes.json";
  const known = new Set([...(opts.knownComponents ?? [])]);
  const out: LintDiagnostic[] = [];
  const seen = new Map<string, number>();
  routes.forEach((route, i) => {
    const line = i + 1;   // entry index — routes.json carries no source lines
    const path = typeof route.path === "string" ? route.path : "";
    if (path.length === 0 || !path.startsWith("/")) {
      out.push({ file, line, level: "error", rule: "route-bad-path", message: `route ${i}: path must be a non-empty string starting with "/"` });
      return;
    }
    if (path.split("/").some((seg) => seg === "." || seg === "..")) {
      out.push({ file, line, level: "error", rule: "route-unsafe-path", message: `route ${i}: "${path}" traverses with "." or ".." segments` });
    }
    const dup = seen.get(path);
    if (dup !== undefined) {
      out.push({ file, line, level: "error", rule: "route-duplicate-path", message: `route ${i}: "${path}" duplicates entry ${dup} — first match wins, this entry is dead` });
    } else {
      seen.set(path, i);
    }
    const hasComponent = typeof route.component === "string" && route.component.length > 0;
    const hasRedirect = typeof route.redirect === "string" && route.redirect.length > 0;
    if (!hasComponent && !hasRedirect) {
      out.push({ file, line, level: "error", rule: "route-empty-entry", message: `route ${i}: "${path}" declares neither component nor redirect — the entry can never resolve` });
    }
    if (hasRedirect) {
      const target = route.redirect as string;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target) && !/^https?:/i.test(target)) {
        out.push({ file, line, level: "error", rule: "route-unsafe-redirect", message: `route ${i}: redirect "${target}" uses a non-http(s) scheme` });
      }
    }
    if (hasComponent && known.size > 0 && !known.has(route.component as string)) {
      out.push({ file, line, level: "error", rule: "route-unknown-component", message: `route ${i}: component "${String(route.component)}" is not in this build's registry` });
    }
  });
  return out;
}
