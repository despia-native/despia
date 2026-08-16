//
//  third-party.test.ts — someone else's CLI, built on the node.
//
//  `dsx` running on `dsx.cli.dsx` proves we use our own surface. This proves the surface is
//  USABLE BY SOMEONE ELSE, which is a different claim and the one that decides whether the CLI
//  node is a feature or a private convenience. Everything here goes through the package's
//  public exports only — no reaching into src/, no host handler, no privileged seam.
//

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dispatch, readCliDocument, runDeclaredCommand, usage } from "../src/index.ts";

// A complete, useful little program: it counts words in files under a declared root and can
// be told to fail when a file is over a limit. Nothing about it is DSX-specific except that
// it is written in DSX.
const SOURCE = `<cli as="wc" version="2.1.0" summary="count words in a project">
  <head>
    <root as="here" path="."/>

    <action as="count" inputs="files, max, verbose">
      dsx.variable.total = 0
      dsx.variable.over = 0
      for (const name of files) {
        const read = await dsx.module.fs.read({ root: 'here', path: name })
        if (!read.ok) { throw { reason: 'not_found', message: name + ' is not readable' } }
        const words = read.data.split(/\\s+/).filter(w => w.length > 0)
        dsx.variable.total = dsx.variable.total + words.length
        if (verbose) { dsx.module.out.print({ text: words.length + '\\t' + name }) }
        if (max && words.length > max) {
          dsx.variable.over = dsx.variable.over + 1
          dsx.module.out.warn({ text: name + ' has ' + words.length + ' words (limit ' + max + ')' })
        }
      }
      dsx.module.out.print({ text: 'total ' + dsx.variable.total })
      if (dsx.variable.over > 0) { throw { reason: 'failed', message: dsx.variable.over + ' file(s) over the limit' } }
      return 0
    </action>
  </head>

  <command as="count" action="count" summary="count words">
    <flag as="max" type="string" summary="fail when a file exceeds this many words"/>
    <flag as="verbose" type="boolean" summary="print a line per file"/>
    <positional as="files" variadic="true" summary="files to count"/>
  </command>
</cli>
`;

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-third-party-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return { out: (l: string) => out.push(l), err: (l: string) => err.push(l), stdout: out, stderr: err };
}

async function run(argv: string[], cwd: string) {
  const document = readCliDocument(SOURCE, "wc.cli.dsx");
  const invocation = dispatch(document, argv);
  const io = recorder();
  const action = document.actions.get(invocation.command.action!)!;
  const result = await runDeclaredCommand(document, action, invocation.inputs, { cwd, io });
  return { result, io, document };
}

test("a third-party CLI document yields its own usage text", () => {
  const document = readCliDocument(SOURCE, "wc.cli.dsx");
  const text = usage(document);
  assert.match(text, /wc — count words in a project/);
  assert.match(text, /wc count \[--max <max>\] \[--verbose\] \[<files> …\]/);
  assert.match(text, /--max\s+fail when a file exceeds this many words/);
});

test("it counts, prints per file, and exits 0", async () => {
  const cwd = workspace({ "a.txt": "one two three", "b.txt": "four five" });
  const { result, io } = await run(["count", "--verbose", "a.txt", "b.txt"], cwd);
  assert.equal(result.code, 0, `${result.reason}: ${result.message}`);
  assert.deepEqual(io.stdout, ["3\ta.txt", "2\tb.txt", "total 5"]);
  assert.deepEqual(io.stderr, []);
});

test("it enforces its own limit and exits non-zero, with diagnostics on stderr", async () => {
  const cwd = workspace({ "a.txt": "one two three four", "b.txt": "one" });
  const { result, io } = await run(["count", "--max", "2", "a.txt", "b.txt"], cwd);
  assert.equal(result.code, 1);
  assert.equal(result.reason, "failed");
  assert.match(result.message ?? "", /1 file\(s\) over the limit/);
  assert.deepEqual(io.stderr, ["a.txt has 4 words (limit 2)"]);
  assert.ok(io.stdout.includes("total 5"));
});

test("its own not_found rejection becomes the documented exit code", async () => {
  const cwd = workspace({ "a.txt": "x" });
  const { result } = await run(["count", "missing.txt"], cwd);
  assert.equal(result.code, 3);
  assert.equal(result.reason, "not_found");
});

test("a third-party body is confined by ITS OWN declaration, not by ours", async () => {
  const cwd = workspace({ "a.txt": "x" });
  const { result } = await run(["count", "../../../etc/passwd"], cwd);
  // The root resolves at the cwd it was handed, so the traversal never leaves it: the seam
  // refuses, the body's own `if (!read.ok)` turns that into its own rejection.
  assert.equal(result.code, 3);
  assert.equal(result.reason, "not_found");
});
