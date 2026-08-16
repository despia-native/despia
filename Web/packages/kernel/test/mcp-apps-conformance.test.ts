//
//  The MCP Apps view-protocol corpus, run against the TS bridge.
//  Corpus: OpenSource/Conformance/mcp-apps/apps.json — platform-neutral, so a future
//  Kotlin/Swift view host runs the same file. Deterministic: the transport is a double,
//  no DOM, no timers, no network.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createAppBridge, type AppFrame, type AppToolResult } from "../src/mcp/apps.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    try {
      readFileSync(join(dir, "OpenSource/Conformance/README.md"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("repo root not found");
      dir = parent;
    }
  }
}

type Case = {
  name: string;
  host?: { hostInfo?: unknown; hostContext?: unknown; capabilities?: unknown };
  steps: Array<Record<string, any>>;
  expect: Record<string, any>;
};

const corpus = JSON.parse(
  readFileSync(join(repoRoot(), "OpenSource/Conformance/mcp-apps/apps.json"), "utf8"),
) as { cases: Case[] };

/** Frames the view emitted, with generated ids masked so a case can assert order and shape. */
function mask(frames: AppFrame[]): AppFrame[] {
  return frames.map((f) => {
    if (f.id === undefined) return f;
    // Ids the VIEW generated are opaque; ids it echoes back to the host are not.
    const generated = typeof f.id === "string" && f.id.startsWith("dsx-");
    return { ...f, id: generated ? "<id>" : f.id };
  });
}

for (const testCase of corpus.cases) {
  test(`mcp-apps: ${testCase.name}`, async () => {
    const sent: AppFrame[] = [];
    const bridge = createAppBridge({ send: (frame) => void sent.push(frame) });

    /** Every request the view has emitted, in order — `respond` indexes into this. */
    const requests = (): AppFrame[] => sent.filter((f) => f.id !== undefined && f.method !== undefined);
    const calls: AppToolResult[] = [];
    const inFlight: Array<Promise<void>> = [];

    for (const step of testCase.steps) {
      if (step.deliver !== undefined) {
        bridge.receive(step.deliver as AppFrame);
        continue;
      }
      if (step.callTool !== undefined) {
        inFlight.push(
          bridge
            .callTool(step.callTool.name as string, step.callTool.arguments as Record<string, unknown>)
            .then((r) => void calls.push(r)),
        );
        continue;
      }
      if (step.resize !== undefined) {
        bridge.reportSize(step.resize.width as number, step.resize.height as number);
        continue;
      }
      if (step.respond !== undefined) {
        const target = requests()[step.respond.request as number];
        assert.ok(target !== undefined, `case names request ${step.respond.request}, which was never sent`);
        const frame: AppFrame = { jsonrpc: "2.0", id: target.id };
        if (step.respond.error !== undefined) frame.error = step.respond.error;
        else if (target.method === "ui/initialize") {
          frame.result = {
            hostCapabilities: testCase.host?.capabilities ?? {},
            hostInfo: testCase.host?.hostInfo ?? null,
            hostContext: testCase.host?.hostContext ?? {},
          };
        } else frame.result = step.respond.result ?? null;
        bridge.receive(frame);
        // A settled promise resolves on the microtask queue; let it land before the next step.
        await Promise.resolve();
        continue;
      }
      assert.fail(`unknown step: ${JSON.stringify(step)}`);
    }

    await Promise.all(inFlight);

    const expected = testCase.expect;
    if (expected.sent !== undefined) assert.deepEqual(mask(sent), expected.sent);
    if (expected.ready !== undefined) assert.equal(bridge.isReady(), expected.ready);
    if (expected.handshakeFailed !== undefined) {
      assert.equal(bridge.handshakeFailed(), expected.handshakeFailed);
    }
    if (expected.data !== undefined) assert.deepEqual(bridge.data(), expected.data);
    if (expected.input !== undefined) assert.deepEqual(bridge.input(), expected.input);
    if (expected.partial !== undefined) assert.deepEqual(bridge.partial(), expected.partial);
    if (expected.tokens !== undefined) assert.deepEqual(bridge.tokens(), expected.tokens);
    if (expected.hostInfo !== undefined) assert.deepEqual(bridge.hostInfo(), expected.hostInfo);
    if (expected.buffered !== undefined) assert.equal(bridge.bufferedCount(), expected.buffered);
    if (expected.calls !== undefined) assert.deepEqual(calls, expected.calls);
  });
}
