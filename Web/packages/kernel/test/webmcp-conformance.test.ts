//
//  webmcp-conformance.test.ts - the SHARED WebMCP corpus (OpenSource/Conformance/webmcp/
//  {project,registry}.json) through the TS fold. The Kotlin (WebMcpConformanceTest.kt) and
//  Swift (WebMcpConformance, via RecordMain.swift) twins run the SAME two files, because
//  the `<tool>` row is an authoring surface and the page table's law must be identical
//  wherever a shell implements it (proposals/webmcp.md).
//
//  Missing corpus = loud failure, never a silent zero-case pass.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  projectTools, webMcpResult, webMcpErrorResult, PageToolTable,
  type ToolRow, type PageToolRegistration, type PageToolRejection,
} from "../src/mcp/webmcp.ts";

function corpusFile(name: string): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, `OpenSource/Conformance/webmcp/${name}`);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`webmcp corpus ${name} not found`);
    dir = parent;
  }
}

type ProjectCase = {
  name: string;
  actions?: { [k: string]: { inputs?: string[] } };
  tools?: ToolRow[];
  result?: { value?: unknown; thrown?: unknown; correlationId?: string };
  expect?: {
    descriptors?: unknown[];
    descriptorNames?: string[];
    result?: unknown;
  };
  expectError?: { code: string; names: string[] };
};

type RegistryStep = {
  register?: { surface: string; origin: string; tool: PageToolRegistration };
  commit?: { surface: string; origin: string };
  abort?: { surface: string; name: string };
};

type RegistryCase = {
  name: string;
  steps: RegistryStep[];
  expect?: {
    tools?: unknown[];
    toolNames?: string[];
    rejections?: unknown[];
    events?: Array<{ event: string; surface: string }>;
  };
};

const projectDoc = JSON.parse(readFileSync(corpusFile("project.json"), "utf-8")) as { cases: ProjectCase[] };
const registryDoc = JSON.parse(readFileSync(corpusFile("registry.json"), "utf-8")) as { cases: RegistryCase[] };
assert.ok(projectDoc.cases.length > 0, "webmcp project corpus is empty");
assert.ok(registryDoc.cases.length > 0, "webmcp registry corpus is empty");

for (const c of projectDoc.cases) {
  test(`webmcp-project/${c.name}`, () => {
    if (c.result !== undefined) {
      const actual = "thrown" in c.result && c.result.thrown !== undefined
        ? webMcpErrorResult(c.result.correlationId ?? "")
        : webMcpResult(c.result.value);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), c.expect?.result);
      return;
    }

    const inputs = new Map<string, readonly string[]>();
    for (const [name, decl] of Object.entries(c.actions ?? {})) inputs.set(name, decl.inputs ?? []);
    const { descriptors, errors } = projectTools(c.tools ?? [], inputs);

    if (c.expectError !== undefined) {
      assert.ok(errors.length > 0, `expected ${c.expectError.code}, got a clean projection`);
      assert.deepEqual(errors.map((e) => e.code), errors.map(() => c.expectError!.code));
      assert.deepEqual(errors.map((e) => e.name), c.expectError.names);
      // Every error carries a message that names the offending tool: a build failure whose
      // text does not say WHICH row is broken sends the author hunting.
      for (const e of errors) assert.ok(e.message.length > 0, "an error must carry a message");
      return;
    }

    assert.deepEqual(errors, [], `unexpected projection errors: ${JSON.stringify(errors)}`);
    if (c.expect?.descriptorNames !== undefined) {
      assert.deepEqual(descriptors.map((d) => d.name), c.expect.descriptorNames);
    }
    if (c.expect?.descriptors !== undefined) {
      assert.deepEqual(JSON.parse(JSON.stringify(descriptors)), c.expect.descriptors);
    }
  });
}

for (const c of registryDoc.cases) {
  test(`webmcp-registry/${c.name}`, () => {
    const events: Array<{ event: string; surface: string }> = [];
    const table = new PageToolTable((surface) => events.push({ event: "toolchange", surface }));
    const rejections: PageToolRejection[] = [];

    for (const step of c.steps) {
      if (step.register !== undefined) {
        const rejected = table.register(step.register.surface, step.register.origin, step.register.tool);
        if (rejected !== null) rejections.push(rejected);
      } else if (step.commit !== undefined) {
        table.commit(step.commit.surface, step.commit.origin);
      } else if (step.abort !== undefined) {
        table.abort(step.abort.surface, step.abort.name);
      } else {
        throw new Error(`unknown step: ${JSON.stringify(step)}`);
      }
    }

    if (c.expect?.tools !== undefined) {
      assert.deepEqual(JSON.parse(JSON.stringify(table.tools())), c.expect.tools);
    }
    if (c.expect?.toolNames !== undefined) {
      assert.deepEqual(table.tools().map((t) => t.name), c.expect.toolNames);
    }
    if (c.expect?.rejections !== undefined) {
      assert.deepEqual(JSON.parse(JSON.stringify(rejections)), c.expect.rejections);
    }
    if (c.expect?.events !== undefined) {
      assert.deepEqual(events, c.expect.events);
    }
  });
}
