//
//  Block-level markdown (A4), driven by OpenSource/Conformance/markdown/blocks.json.
//
//  The corpus asserts the NEUTRAL TREE, not DOM and not HTML, which is what lets the
//  Kotlin and Swift renderers implement the same file. The two renderers here are checked
//  separately, and only for the properties that must hold on every host: no innerHTML, no
//  live element for a refused target, code bytes preserved.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  MARKDOWN_BLOCK_LIMITS, markdownBlocksHtml, parseMarkdownBlocks, type MarkdownBlock,
} from "../src/markdown-blocks.ts";

const corpusPath = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "markdown", "blocks.json");

interface Case { name: string; source: string; blocks: unknown[] }

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  limits: { characters: number; blocks: number; listDepth: number };
  cases: Case[];
};

/** The tree, reduced to exactly what the corpus states — optional keys omitted when
 *  absent, so a case never has to spell out a default it does not care about. */
function shape(block: MarkdownBlock): Record<string, unknown> {
  switch (block.type) {
    case "list": {
      const out: Record<string, unknown> = {
        type: "list",
        ordered: block.ordered,
        items: block.items.map((item) => (
          item.blocks === undefined || item.blocks.length === 0
            ? { inline: item.inline }
            : { inline: item.inline, blocks: item.blocks.map(shape) }
        )),
      };
      if (block.ordered && block.start !== undefined && block.start !== 1) out["start"] = block.start;
      return out;
    }
    case "quote":
      return { type: "quote", blocks: block.blocks.map(shape) };
    default:
      return { ...block } as Record<string, unknown>;
  }
}

test("the corpus limits are the implementation's limits", () => {
  assert.equal(MARKDOWN_BLOCK_LIMITS.characters, corpus.limits.characters);
  assert.equal(MARKDOWN_BLOCK_LIMITS.blocks, corpus.limits.blocks);
  assert.equal(MARKDOWN_BLOCK_LIMITS.listDepth, corpus.limits.listDepth);
});

test("markdown block corpus", async (t) => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    await t.test(testCase.name, () => {
      assert.deepEqual(parseMarkdownBlocks(testCase.source).map(shape), testCase.blocks);
    });
  }
});

test("the SSR renderer never emits raw HTML from the source", () => {
  // The XSS pin at the OUTPUT boundary: the corpus proves it stays text in the tree,
  // this proves the html renderer escapes it rather than passing it through.
  const html = markdownBlocksHtml("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  // What matters is that no ELEMENT is emitted for either. The strings `onerror=alert(1)`
  // and `alert(1)` do survive as escaped text content, and that is correct: they are the
  // author's characters, inert inside a <p>. Asserting their absence would be asserting
  // that we silently delete input.
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("fenced code survives byte for byte through the SSR renderer", () => {
  const html = markdownBlocksHtml("```ts\nconst a = *not emphasis* && b < c;\n```");
  assert.match(html, /<pre class="dsx-md-code"><code class="language-ts">/);
  // The prose plane's syntax tint (prose.ts) wraps runs in spans, but the TEXT is the
  // sample byte for byte: strip the tint markup and the escaped source remains intact.
  const text = html
    .replace(/<pre class="dsx-md-code"><code class="language-ts">|<\/code><\/pre>/g, "")
    .replace(/<span class="dsx-tok-[a-z]+">|<\/span>/g, "");
  assert.equal(text, "const a = *not emphasis* &amp;&amp; b &lt; c;");
  assert.match(html, /<span class="dsx-tok-kw">const<\/span>/, "a known language is tinted");
  // the inline parser must not have run over it
  assert.ok(!html.includes("<em>"), html);
});

test("an unknown fence language stays completely untinted", () => {
  const html = markdownBlocksHtml("```brainfuck\n+ - < >\n```");
  assert.equal(html, `<pre class="dsx-md-code"><code class="language-brainfuck">+ - &lt; &gt;</code></pre>`);
});

test("a refused image target is prose in both renderers, never a live element", () => {
  for (const source of ["![x](javascript:alert(1))", "![x](data:text/html;base64,PHNjcmlwdD4=)"]) {
    const html = markdownBlocksHtml(source);
    assert.ok(!html.includes("<img"), `${source} → ${html}`);
    assert.match(html, /dsx-md-paragraph/);
  }
});

test("a document past the block ceiling truncates rather than allocating without limit", () => {
  const many = Array.from({ length: MARKDOWN_BLOCK_LIMITS.blocks + 50 }, (_, i) => `para ${i}`).join("\n\n");
  assert.equal(parseMarkdownBlocks(many).length, MARKDOWN_BLOCK_LIMITS.blocks);
});

test("a document past the character ceiling still parses what it read", () => {
  const long = `# head\n\n${"x".repeat(MARKDOWN_BLOCK_LIMITS.characters + 1_000)}`;
  const blocks = parseMarkdownBlocks(long);
  assert.equal(blocks[0]?.type, "heading");
  assert.ok(blocks.length >= 1);
});
