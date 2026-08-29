//
//  prose.test.ts — the PROSE PLANE gate (web-face F1): `.dsx-markdown` ships a real
//  default skin. Pins the load-bearing rules (band-header card tables, the elevated
//  code surface, the inline chip), the tint palette's four scheme tables, the DOM/SSR
//  markup identity for tinted code, the tokenizer's language coverage and hostile-input
//  behavior, and the wiring that carries the sheet to boot + SSR without growing an
//  unrelated embed.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PROSE_CSS, CODE_TINT_LIMITS, tokenizeCode, type CodeToken } from "../src/prose.ts";
import { TOKENS_CSS } from "../src/theme.ts";
import { markdownBlocksFragment, markdownBlocksHtml } from "../src/markdown-blocks.ts";

const PALETTE_TOKENS = [
  "--dsx-code-keyword", "--dsx-code-string", "--dsx-code-comment",
  "--dsx-code-number", "--dsx-code-type", "--dsx-code-punct",
  "--dsx-code-function", "--dsx-code-attribute", "--dsx-code-tag",
  "--dsx-code-constant", "--dsx-code-operator",
];

// ── the sheet ───────────────────────────────────────────────────────────────────────

test("the sheet lives in the weak element layer and stays overridable", () => {
  assert.ok(PROSE_CSS.startsWith("@layer dsx-elements {"), "prose skin rides @layer dsx-elements");
  assert.ok(!PROSE_CSS.includes("!important"), "authors can replace prose defaults normally");
  assert.ok(!PROSE_CSS.includes("light-dark("), "no bare light-dark() below the Safari 16.4 floor");
  let depth = 0;
  for (const ch of PROSE_CSS.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, "never closes an unopened block");
  }
  assert.equal(depth, 0, "closes every block");
});

test("the tint palette ships as floor-safe scheme twins — all four tables, every token", () => {
  const rootStart = PROSE_CSS.indexOf(":root, :host {");
  const mediaStart = PROSE_CSS.indexOf("@media (prefers-color-scheme: dark)");
  const darkPinStart = PROSE_CSS.indexOf(`[data-dsx-theme="dark"]`);
  const lightPinStart = PROSE_CSS.indexOf(`[data-dsx-theme="light"]`);
  const rulesStart = PROSE_CSS.indexOf(".dsx-markdown {");
  assert.ok(rootStart >= 0 && mediaStart > rootStart && darkPinStart > mediaStart
    && lightPinStart > darkPinStart && rulesStart > lightPinStart,
    "ratified table order: base → OS-dark media → dark pin → light pin → rules");
  const rootBlock = PROSE_CSS.slice(rootStart, mediaStart);
  const mediaBlock = PROSE_CSS.slice(mediaStart, darkPinStart);
  const darkPin = PROSE_CSS.slice(darkPinStart, lightPinStart);
  const lightPin = PROSE_CSS.slice(lightPinStart, rulesStart);
  const value = (block: string, token: string): string => {
    const m = block.match(new RegExp(`${token}: (#[0-9a-f]{6});`));
    assert.ok(m !== null, `${token} declared with a literal value`);
    return m![1]!;
  };
  for (const token of PALETTE_TOKENS) {
    const light = value(rootBlock, token);
    const dark = value(mediaBlock, token);
    assert.equal(value(darkPin, token), dark, `${token}: dark pin matches the OS-dark twin`);
    assert.equal(value(lightPin, token), light, `${token}: light pin matches the base twin`);
    assert.notEqual(light, dark, `${token}: the schemes are actually twins, not one value`);
  }
  // explicit pins carry :host twins so an embed host can pin its scheme by hand
  assert.ok(darkPin.includes(':host([data-dsx-theme="dark"])'));
  assert.ok(lightPin.includes(':host([data-dsx-theme="light"])'));
  // the RULES half is tokens-only: every literal color lives in the tables above
  const rules = PROSE_CSS.slice(rulesStart);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rules), "no raw hex outside the palette tables");
  assert.ok(!/\brgba?\(/.test(rules), "no raw rgb()/rgba() outside the palette tables");
});

test("palette twins clear WCAG AA on the code surface and the page in their scheme", () => {
  const luminance = (hex: string): number => {
    const c = hex.slice(1).match(/../g)!.map((p) => parseInt(p, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const mediaStart = PROSE_CSS.indexOf("@media (prefers-color-scheme: dark)");
  const darkPinStart = PROSE_CSS.indexOf(`[data-dsx-theme="dark"]`);
  const lightBlock = PROSE_CSS.slice(0, mediaStart);
  const darkBlock = PROSE_CSS.slice(mediaStart, darkPinStart);
  for (const token of PALETTE_TOKENS) {
    const light = lightBlock.match(new RegExp(`${token}: (#[0-9a-f]{6});`))![1]!;
    const dark = darkBlock.match(new RegExp(`${token}: (#[0-9a-f]{6});`))![1]!;
    // light code surface #f5f5f7 (secondary background) and page #ffffff
    for (const surface of ["#f5f5f7", "#ffffff"]) {
      assert.ok(contrast(light, surface) >= 4.5, `${token} ${light} clears AA on ${surface}`);
    }
    // dark code surface #141416 and page #101012
    for (const surface of ["#141416", "#101012"]) {
      assert.ok(contrast(dark, surface) >= 4.5, `${token} ${dark} clears AA on ${surface}`);
    }
  }
});

test("the load-bearing rules: band header, elevated code surface, chip, kbd, quote rail", () => {
  // tables: a padded elevated card wrapping its own horizontal scroller
  const wrap = PROSE_CSS.match(/\.dsx-md-table-wrap \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(wrap, /overflow-x: auto;/, "the card is its OWN overflow container");
  assert.match(wrap, /background: var\(--dsx-surface-raised\);/, "content surface");
  assert.match(wrap, /border-radius: var\(--dsx-radius-card\);/, "card radius");
  assert.match(wrap, /box-shadow: var\(--dsx-shadow-1\);/, "small elevation");
  // the header is a BAND (subtle fill, tiny semibold muted text), never a border
  const band = PROSE_CSS.match(/\.dsx-md-table thead th \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(band, /background: var\(--dsx-fill\);/, "band fill");
  // both came off the type ramp in the design-system burn-down: assert the rung the rule
  // reads AND the rung's value, so the band's intent survives the tokenisation
  assert.match(band, /font-size: var\(--dsx-type-caption-size\);/, "tiny header type");
  assert.match(band, /font-weight: var\(--dsx-type-headline-weight\);/, "semibold header type");
  assert.match(TOKENS_CSS, /--dsx-type-caption-size: 0\.75rem;/, "and tiny is still 0.75rem");
  assert.match(TOKENS_CSS, /--dsx-type-headline-weight: 600;/, "and semibold is still 600");
  assert.match(band, /color: var\(--dsx-secondary-label\);/, "muted header ink");
  assert.match(band, /border-block-end: 5px solid transparent;/, "the 5px spacer, not a heavy rule");
  assert.ok(PROSE_CSS.includes(".dsx-md-table thead th:first-child"), "the band rounds into a pill");
  assert.match(PROSE_CSS, /\.dsx-md-table tbody tr:hover td/, "rows get a hover wash");
  assert.ok(!band.includes("border-inline"), "no vertical rules in the band");
  assert.match(PROSE_CSS, /\.dsx-md-table \{[^}]*font-variant-numeric: tabular-nums;/s, "tables align digits");

  // fenced code: elevated secondary surface, hairline ring, card radius, its own scroller
  const pre = PROSE_CSS.match(/\.dsx-markdown pre \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(pre, /background: var\(--dsx-secondary-background\);/);
  // the burn-down put the code surface on the SAME rung as the table card beside it
  assert.match(pre, /border-radius: var\(--dsx-radius-card\);/);
  assert.match(TOKENS_CSS, /--dsx-radius-card: var\(--dsx-radius-lg\);/, "and the card rung is the lg rung");
  assert.match(pre, /box-shadow: inset 0 0 0 var\(--dsx-hairline\) var\(--dsx-outline-soft\);/);
  assert.match(pre, /overflow-x: auto;/);
  const mono = PROSE_CSS.match(/\.dsx-markdown code \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(mono, /font-family: ui-monospace/, "a real mono stack");
  assert.match(mono, /font-variant-ligatures: none;/, "ligatures off in code");

  // inline code: the chip (fill + radius 6 + 0.9em + padding)
  assert.match(mono, /background: var\(--dsx-fill\);/);
  assert.match(mono, /border-radius: var\(--dsx-radius-sm\);/);
  assert.match(mono, /font-size: 0\.9em;/);
  assert.match(mono, /padding: 0\.1em 0\.35em;/);
  // and the chip resets inside a fenced block
  assert.match(PROSE_CSS, /\.dsx-markdown pre code \{[^}]*background: none;/s);

  // kbd: bordered chip with a bottom edge
  const kbd = PROSE_CSS.match(/\.dsx-markdown kbd \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(kbd, /inset 0 0 0 var\(--dsx-hairline\) var\(--dsx-separator\)/);
  assert.match(kbd, /inset 0 -2px 0 var\(--dsx-separator\)/);

  // quote: the timeless form - a 2px neutral rail, no wash, muted ink
  const quote = PROSE_CSS.match(/\.dsx-md-quote \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(quote, /border-inline-start: 2px solid var\(--dsx-separator\);/);
  assert.ok(!quote.includes("background"), "no wash behind a quote");
  assert.match(quote, /color: var\(--dsx-secondary-label\);/);

  // links, rule, images, list markers, lede
  const link = PROSE_CSS.match(/\.dsx-markdown a \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(link, /color: var\(--dsx-accent\);/);
  assert.match(link, /text-underline-offset: 0\.2em;/);
  assert.match(PROSE_CSS, /\.dsx-markdown a:hover \{ text-decoration-color: var\(--dsx-accent\); \}/);
  assert.match(PROSE_CSS, /\.dsx-md-rule \{[^}]*height: var\(--dsx-hairline\);/s);
  assert.match(PROSE_CSS, /\.dsx-md-image \{[^}]*max-width: 100%;/s);
  assert.match(PROSE_CSS, /\.dsx-md-list li::marker \{[^}]*color: var\(--dsx-tertiary-label\);/s);
  assert.match(PROSE_CSS, /\.dsx-markdown h1 \+ p \{[^}]*font-size: 1\.1875em;/s, "the lede convention");
  // first/last-child trim
  assert.ok(PROSE_CSS.includes(".dsx-markdown > :first-child { margin-block-start: 0; }"));
  assert.ok(PROSE_CSS.includes(".dsx-markdown > :last-child { margin-block-end: 0; }"));
  // fluid heads with tracking tightening upward. The burn-down moved the clamp itself onto
  // the ramp - the prose plane no longer owns the curve, it reads the rung that carries it.
  assert.match(PROSE_CSS, /\.dsx-markdown h1 \{[^}]*font-size: var\(--dsx-type-display-size-fluid\);/s);
  assert.match(TOKENS_CSS, /--dsx-type-display-size-fluid: clamp\(/, "and that rung is still fluid");
  assert.match(PROSE_CSS, /\.dsx-markdown h1 \{[^}]*letter-spacing: var\(--dsx-type-display-tracking\);/s);
});

test("motion collapses through tokens and print flattens the elevation", () => {
  // the only transition rides the motion tokens, which reduced-motion zeroes globally
  assert.ok(!/transition:[^;]*\d+ms/.test(PROSE_CSS), "no literal durations outside the token plane");
  assert.match(PROSE_CSS, /transition: text-decoration-color var\(--dsx-dur-fast\) var\(--dsx-ease-out\);/);
  assert.ok(!PROSE_CSS.includes("animation"), "the prose plane declares no keyframe motion");
  const print = PROSE_CSS.match(/@media print \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(print, /box-shadow: none;/, "print drops elevation");
  assert.match(print, /border: 1px solid var\(--dsx-separator\);/, "print keeps the boundary as a border");
});

// ── wiring: boot + SSR carry the sheet; the embed closure does not ──────────────────

test("the sheet reaches boot inside the markdown fold and the SSR document assembly", () => {
  const boot = readFileSync(new URL("../src/boot.ts", import.meta.url), "utf8");
  const fold = boot.match(/__DSX_OPTIONAL_MARKDOWN__ !== false\) \{\n    injectStyle\(PROSE_CSS, "dsx-prose"\);/);
  assert.ok(fold !== null, "boot injects dsx-prose gated on the markdown fold (the flag INSIDE the condition)");
  const page = readFileSync(new URL("../../server/src/page-render.ts", import.meta.url), "utf8");
  assert.ok(page.includes("PROSE_CSS"), "SSR page assembly inlines the prose sheet");
});

// ── DOM/SSR identity: one tokenizer, two consumers, congruent trees ─────────────────

type FakeText = { nodeType: 3; textContent: string };
type FakeElement = {
  nodeType: 1; tagName: string; className: string; attrs: [string, string][];
  children: (FakeElement | FakeText)[];
  readonly lastChild: FakeElement | FakeText | null;
  setAttribute(k: string, v: string): void;
  appendChild(c: unknown): unknown;
  textContent: string;
};
const VOID_TAGS = new Set(["img", "hr", "br"]);
function fakeElement(tag: string): FakeElement {
  const node = {
    nodeType: 1 as const, tagName: tag, className: "", attrs: [] as [string, string][],
    children: [] as (FakeElement | FakeText)[],
    get lastChild(): FakeElement | FakeText | null { return node.children[node.children.length - 1] ?? null; },
    setAttribute(k: string, v: string): void { node.attrs.push([k, v]); },
    appendChild(c: unknown): unknown {
      // a real appendChild SPLICES a fragment's children in; mirror that
      const child = c as FakeElement | FakeText | { nodeType: 11; children: (FakeElement | FakeText)[] };
      if (child.nodeType === 11) node.children.push(...child.children.splice(0));
      else node.children.push(child);
      return c;
    },
    set textContent(v: string) { node.children = [{ nodeType: 3, textContent: v }]; },
  };
  return node as FakeElement;
}
const fakeDoc = {
  createElement: fakeElement,
  createTextNode: (v: string): FakeText => ({ nodeType: 3, textContent: v }),
  createDocumentFragment(): { nodeType: 11; children: (FakeElement | FakeText)[]; appendChild(c: unknown): void; readonly lastChild: FakeElement | FakeText | null } {
    const children: (FakeElement | FakeText)[] = [];
    return {
      nodeType: 11 as const,
      children,
      appendChild: (c: unknown) => {
        const child = c as FakeElement | FakeText | { nodeType: 11; children: (FakeElement | FakeText)[] };
        if (child.nodeType === 11) children.push(...child.children.splice(0));
        else children.push(child);
      },
      get lastChild(): FakeElement | FakeText | null { return children[children.length - 1] ?? null; },
    };
  },
};
const escapeText = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (v: string): string => escapeText(v).replace(/"/g, "&quot;");
function serialize(node: FakeElement | FakeText): string {
  if (node.nodeType === 3) return escapeText(node.textContent);
  const cls = node.className.length > 0 ? ` class="${escapeAttr(node.className)}"` : "";
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  const open = `<${node.tagName}${cls}${attrs}>`;
  if (VOID_TAGS.has(node.tagName)) return open;
  return `${open}${node.children.map(serialize).join("")}</${node.tagName}>`;
}

test("DOM and SSR emit identical markup for tinted code, wrapped tables, and prose blocks", () => {
  (globalThis as { document?: unknown }).document = fakeDoc;
  try {
    const source = [
      "# Title", "", "A paragraph with **bold** and `chip`.", "",
      "```ts", 'const greeting: string = "hello"; // say it', "```", "",
      "| Name | Count |", "| --- | --- |", "| alpha | 12 |", "",
      "- one", "- two", "", "---",
    ].join("\n");
    const fragment = markdownBlocksFragment(source, fakeDoc as unknown as Document);
    const dom = (fragment as unknown as { children: (FakeElement | FakeText)[] }).children.map(serialize).join("");
    const ssr = markdownBlocksHtml(source);
    assert.equal(dom, ssr, "the two consumers of the neutral tree are byte-identical");
    assert.match(ssr, /<div class="dsx-md-table-wrap"><table class="dsx-md-table">/, "tables ride the card wrap");
    assert.match(ssr, /<span class="dsx-tok-kw">const<\/span>/, "keywords tint");
    assert.match(ssr, /<span class="dsx-tok-typ">string<\/span>/, "builtin types tint");
    assert.match(ssr, /<span class="dsx-tok-str">"hello"<\/span>/, "strings tint");
    assert.match(ssr, /<span class="dsx-tok-com">\/\/ say it<\/span>/, "comments tint");
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

// ── the tokenizer ───────────────────────────────────────────────────────────────────

const concat = (tokens: CodeToken[]): string => tokens.map((t) => t.text).join("");
const kindsOf = (tokens: CodeToken[], kind: string): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text);

test("tokenizer: typescript keywords, builtin types, constants, operators", () => {
  const src = 'const n: number = 42;\nexport class Store { /* state */ }';
  const tokens = tokenizeCode("ts", src);
  assert.equal(concat(tokens), src, "tint never rewrites a byte");
  assert.deepEqual(kindsOf(tokens, "kw"), ["const", "export", "class"]);
  assert.deepEqual(kindsOf(tokens, "typ"), ["number", "Store"], "builtin types ride the type plane");
  assert.deepEqual(kindsOf(tokens, "num"), ["42"]);
  assert.deepEqual(kindsOf(tokens, "com"), ["/* state */"]);
  assert.deepEqual(kindsOf(tokens, "op"), ["="], "operators split from dimmed punctuation");
  const literals = tokenizeCode("ts", "const MAX_RETRIES = 3, ok = true, missing = null;");
  assert.deepEqual(kindsOf(literals, "cst"), ["MAX_RETRIES", "true", "null"],
    "SCREAMING_CASE and value literals read as constants");
});

test("tokenizer: typescript call positions, decorators, template interpolation", () => {
  const src = '@Component()\nexport function greet(name: string): void {\n  return fmt(`hi ${name.trim()}!`);\n}';
  const tokens = tokenizeCode("ts", src);
  assert.equal(concat(tokens), src);
  assert.deepEqual(kindsOf(tokens, "att"), ["@Component"], "decorators ride the attribute plane");
  assert.deepEqual(kindsOf(tokens, "fn"), ["greet", "fmt", "trim"],
    "declaration names and call positions read as functions");
  assert.deepEqual(kindsOf(tokens, "typ"), ["string", "void"]);
  assert.deepEqual(kindsOf(tokens, "str"), ["`hi ", "!`"], "template splits around the interpolation");
  assert.deepEqual(kindsOf(tokens, "op"), ["${", "}"], "interpolation delimiters stay visible");
});

test("tokenizer: bash command position, flags, variables", () => {
  const src = '# install\nexport DSX_HOME="$HOME/dsx"\nnpm install -g @despia-native/cli && echo $HOME';
  const tokens = tokenizeCode("bash", src);
  assert.equal(concat(tokens), src);
  assert.deepEqual(kindsOf(tokens, "com"), ["# install"]);
  assert.deepEqual(kindsOf(tokens, "kw"), ["export"]);
  assert.deepEqual(kindsOf(tokens, "str"), ['"$HOME/dsx"']);
  assert.deepEqual(kindsOf(tokens, "fn"), ["npm", "echo"], "the command position tints, args stay plain");
  assert.deepEqual(kindsOf(tokens, "att"), ["-g"], "flags ride the attribute plane");
  assert.deepEqual(kindsOf(tokens, "cst"), ["DSX_HOME", "$HOME"], "assignments and expansions read as variables");
  assert.ok(kindsOf(tokens, "plain").some((t) => t.includes("install")), "arguments stay untinted");
  const prompt = tokenizeCode("console", "$ npm run build");
  assert.deepEqual(kindsOf(prompt, "fn"), ["npm"], "a $ prompt still leaves the command position armed");
});

test("tokenizer: dsx markup trichromacy — tag, attribute, string", () => {
  const src = '<vstack spacing="8">\n  <text value="{{ dsx.variable.name }}"/>\n  <!-- chrome -->\n</vstack>';
  const tokens = tokenizeCode("dsx", src);
  assert.equal(concat(tokens), src);
  assert.deepEqual(kindsOf(tokens, "tag"), ["vstack", "text", "vstack"]);
  assert.deepEqual(kindsOf(tokens, "att"), ["spacing", "value"]);
  assert.deepEqual(kindsOf(tokens, "str"), ['"8"', '"{{ dsx.variable.name }}"']);
  assert.deepEqual(kindsOf(tokens, "com"), ["<!-- chrome -->"]);
});

test("tokenizer: json keys read as properties, value strings stay strings", () => {
  const tokens = tokenizeCode("json", '{ "name": "dsx", "on": true, "count": 3 }');
  assert.deepEqual(kindsOf(tokens, "att"), ['"name"', '"on"', '"count"']);
  assert.deepEqual(kindsOf(tokens, "str"), ['"dsx"']);
  assert.deepEqual(kindsOf(tokens, "cst"), ["true"]);
  assert.deepEqual(kindsOf(tokens, "num"), ["3"]);
});

test("tokenizer: css selector, property, value planes", () => {
  const src = "@media print { .card { color: #17171b; margin: 12px; } }";
  const css = tokenizeCode("css", src);
  assert.equal(concat(css), src);
  assert.deepEqual(kindsOf(css, "kw"), ["@media"]);
  assert.ok(kindsOf(css, "tag").includes(".card"), "selectors ride the tag plane");
  assert.ok(kindsOf(css, "num").includes("#17171b") && kindsOf(css, "num").includes("12px"));
  assert.deepEqual(kindsOf(css, "att"), ["color", "margin"], "properties ride the attribute plane");
  const value = tokenizeCode("css", ".card:hover { color: var(--dsx-accent); margin: 12px auto; }");
  assert.deepEqual(kindsOf(value, "tag"), [".card:hover"]);
  assert.deepEqual(kindsOf(value, "fn"), ["var"]);
  assert.deepEqual(kindsOf(value, "att"), ["color", "--dsx-accent", "margin"]);
  assert.deepEqual(kindsOf(value, "cst"), ["auto"], "value keywords read as constants");
});

test("tokenizer: yaml keys, booleans, and plain values", () => {
  const src = "name: dsx\non: push\nurl: https://despia.com\nready: true";
  const tokens = tokenizeCode("yaml", src);
  assert.equal(concat(tokens), src);
  assert.deepEqual(kindsOf(tokens, "att"), ["name", "on", "url", "ready"],
    "line-leading keys tint even when the word is a boolean spelling");
  assert.deepEqual(kindsOf(tokens, "cst"), ["true"]);
  assert.ok(kindsOf(tokens, "plain").some((t) => t.includes("despia")), "a URL value never reads as a key");
});

test("tokenizer: swift, kotlin, ruby, python, java ride the same kind set", () => {
  const swift = tokenizeCode("swift", '@MainActor\nfunc greet(name: String) -> String { return "hi" }');
  assert.ok(kindsOf(swift, "kw").includes("func") && kindsOf(swift, "kw").includes("return"));
  assert.deepEqual(kindsOf(swift, "typ"), ["String", "String"]);
  assert.deepEqual(kindsOf(swift, "att"), ["@MainActor"]);
  assert.deepEqual(kindsOf(swift, "fn"), ["greet"]);
  assert.deepEqual(kindsOf(swift, "op"), ["->"]);
  const kotlin = tokenizeCode("kotlin", 'val store = ReactiveStore() // shared\n@JvmStatic fun load() = null');
  assert.ok(kindsOf(kotlin, "kw").includes("val") && kindsOf(kotlin, "kw").includes("fun"));
  assert.ok(kindsOf(kotlin, "typ").includes("ReactiveStore"));
  assert.deepEqual(kindsOf(kotlin, "com"), ["// shared"]);
  assert.deepEqual(kindsOf(kotlin, "att"), ["@JvmStatic"]);
  assert.deepEqual(kindsOf(kotlin, "fn"), ["load"]);
  assert.deepEqual(kindsOf(kotlin, "cst"), ["null"]);
  const ruby = tokenizeCode("ruby", 'def check!\n  raise "boom" unless @ok\n  emit :done\nend');
  assert.ok(kindsOf(ruby, "kw").includes("def") && kindsOf(ruby, "kw").includes("unless"));
  assert.deepEqual(kindsOf(ruby, "fn"), ["check"]);
  assert.deepEqual(kindsOf(ruby, "cst"), ["@ok", ":done"], "ivars and symbols read as constants");
  const python = tokenizeCode("python", "@dataclass\ndef load(path):\n    return None");
  assert.deepEqual(kindsOf(python, "att"), ["@dataclass"]);
  assert.deepEqual(kindsOf(python, "fn"), ["load"]);
  assert.deepEqual(kindsOf(python, "cst"), ["None"]);
  const java = tokenizeCode("java", "int x = 0; @Override void run() { helper(); }");
  assert.deepEqual(kindsOf(java, "typ"), ["int", "void"], "primitives ride the type plane");
  assert.deepEqual(kindsOf(java, "att"), ["@Override"]);
  assert.deepEqual(kindsOf(java, "fn"), ["run", "helper"]);
});

test("tokenizer: unknown languages and the bare fence stay one plain token", () => {
  assert.deepEqual(tokenizeCode("", "plain text"), [{ kind: "plain", text: "plain text" }]);
  assert.deepEqual(tokenizeCode("brainfuck", "+-<>"), [{ kind: "plain", text: "+-<>" }]);
  assert.deepEqual(tokenizeCode("ts", ""), []);
});

test("tokenizer: hostile input terminates fast, never drops a byte, and honors the ceiling", () => {
  const cases = [
    ["ts", `"${"\\\"".repeat(30_000)}`],            // one endless escaped string
    ["ts", "/*".repeat(30_000)],                       // unterminated nested-looking comments
    ["ts", `\`${"${".repeat(20_000)}`],                // interpolation-open spam in a template
    ["ts", `\`${"${`x`}".repeat(6_000)}`],             // nested templates past the re-entry cap
    ["ts", `\`\${${"{".repeat(40_000)}`],              // one endless unbalanced interpolation
    ["dsx", "<".repeat(60_000)],                       // tag-open spam
    ["dsx", `<a ${'x="y" '.repeat(9_000)}`],           // an unterminated attribute run
    ["bash", `$\{${"a".repeat(60_000)}`],              // an unterminated expansion
    ["json", '"k" '.repeat(12_000)],                   // key-peek spam (gaps stay disjoint)
    ["css", `#${"f".repeat(60_000)}`],                 // one enormous hex "color"
    ["css", `.a{${"x:y;".repeat(12_000)}`],            // an unterminated declaration run
  ] as const;
  for (const [language, source] of cases) {
    const start = performance.now();
    const tokens = tokenizeCode(language, source);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1_000, `${language} hostile case stays linear (${elapsed.toFixed(0)}ms)`);
    assert.equal(concat(tokens), source, `${language} hostile case preserves every byte`);
  }
  // past the ceiling the remainder rides one plain tail — still byte-complete
  const long = `const x = 1;\n${"y".repeat(CODE_TINT_LIMITS.characters + 5_000)}`;
  const tokens = tokenizeCode("ts", long);
  assert.equal(concat(tokens), long);
  assert.equal(tokens[tokens.length - 1]!.kind, "plain");
});

test("tokenizer: adjacent same-kind runs coalesce, so the two consumers stay congruent", () => {
  for (const tokens of [tokenizeCode("ts", "a + b - c;"), tokenizeCode("dsx", "<a b=1></a>")]) {
    for (let i = 1; i < tokens.length; i += 1) {
      assert.notEqual(tokens[i]!.kind, tokens[i - 1]!.kind,
        `no adjacent twins: ${JSON.stringify(tokens)}`);
    }
  }
});
