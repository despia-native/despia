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

const FACTS = loadFacts();
const BUILTIN = new Set(FACTS.builtinTags);
const DECL = new Set(FACTS.declTags);
const IDENTIFIER_TAGS = new Set(FACTS.identifierTags);
const KEYED = new Set(FACTS.keyedCollections);
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
      if (rank === 3 && /computed\s*=\s*["']true["']/.test(attrs)) rank = FACTS.headComputedRank;
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
    // G4 unified input (dsx-game.md §2): `input` is BOTH a body form element (builtinTags,
    // unchanged) and a head DEVICE-BINDING declaration — POSITION is the disambiguation, which
    // is why it carries a headRank but is deliberately absent from declTags/identifierTags.
    // The identifier discipline therefore applies POSITIONALLY.
    if (tag === "input" && inHead && !/\bas\s*=/.test(attrs)) {
      report(line, "error", "missing-as", "<input> missing as= — registration is a silent no-op at runtime");
    }
    if (tag === "expects" && !/\bvariable\s*=/.test(attrs)) {
      report(line, "error", "expects-variable", "<expects> missing variable= — declare the seeded state it stands for");
    }
    if (KEYED.has(tag) && /\bbind\s*=/.test(attrs) && !/\bkey\s*=/.test(attrs)) {
      report(line, "warning", "bind-without-key", `<${tag} bind=…> without key= — rows need a stable identity (key="id", or key="index" for static data)`);
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
