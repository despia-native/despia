//
//  mcp-transport-runner.ts — the shared executor for the MCP server-transport corpus
//  (OpenSource/Conformance/ai/mcp/server-transport.json). Platform-free for the same reason
//  api-corpus-engine.ts is: the node leg and the workerd leg must run the SAME cases through
//  the SAME assertions, differing only in what stands between the case and the face — nothing
//  on node, the whole bundled bootloader under workerd.
//

import type { McpToolRow } from "../src/mcp-face.ts";
import type { HostConfig } from "../src/host.ts";

export interface McpTransportCase {
  name: string;
  /** a resolved identity handed to the face — cases carrying one run only where the runner
   *  can inject it (the node leg drives the face directly; the workerd leg has no minter) */
  identity?: Record<string, unknown> | null;
  request: {
    method?: string;
    body?: unknown;
    rawBody?: string;
  };
  expect: {
    status: number;
    /** deep SUBSET of the parsed JSON body — extra keys in the answer are legal */
    body?: unknown;
    bodyContains?: string[];
    bodyNotContains?: string[];
    header?: Record<string, string>;
    headerAbsent?: string[];
  };
}

export interface McpTransportCorpus {
  tools: McpToolRow[];
  /** action name → behavior: `returns: "arguments"` echoes, any other value returns it,
   *  `throws` raises an Error with that text (which must never reach the wire) */
  actions: Record<string, { returns?: unknown; throws?: string }>;
  cases: McpTransportCase[];
}

/** Build the fixture handlers barrel the corpus's tool rows dispatch into. */
export function corpusHandlers(corpus: McpTransportCorpus): HostConfig["handlers"] {
  const fixture: Record<string, (args: Record<string, unknown>) => unknown> = {};
  for (const [action, behavior] of Object.entries(corpus.actions)) {
    fixture[action] = (args) => {
      if (behavior.throws !== undefined) throw new Error(behavior.throws);
      return behavior.returns === "arguments" ? args : behavior.returns;
    };
  }
  return { fixture };
}

/** true when `expected` is a deep subset of `actual` (arrays match index-wise, same length). */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => isSubset(e, actual[i]));
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => isSubset(v, (actual as Record<string, unknown>)[k]));
  }
  return Object.is(expected, actual);
}

/** Build the Request one corpus case describes, aimed at `origin`/mcp. */
export function caseRequest(c: McpTransportCase, origin: string): Request {
  const method = (c.request.method ?? "POST").toUpperCase();
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.body = c.request.rawBody ?? JSON.stringify(c.request.body ?? null);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`${origin}/mcp`, init);
}

/** Assert one case against a Response. Empty list = pass; entries are failed expectations. */
export async function checkCase(c: McpTransportCase, res: Response): Promise<string[]> {
  const failures: string[] = [];
  if (res.status !== c.expect.status) failures.push(`status ${res.status} (expected ${c.expect.status})`);
  const raw = await res.text();
  if (c.expect.body !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      failures.push(`body is not JSON: ${raw.slice(0, 120)}`);
      parsed = undefined;
    }
    if (parsed !== undefined && !isSubset(c.expect.body, parsed)) {
      failures.push(`body ${raw.slice(0, 300)} lacks expected subset ${JSON.stringify(c.expect.body)}`);
    }
  }
  for (const needle of c.expect.bodyContains ?? []) {
    if (!raw.includes(needle)) failures.push(`body lacks ${JSON.stringify(needle)}`);
  }
  for (const needle of c.expect.bodyNotContains ?? []) {
    if (raw.includes(needle)) failures.push(`body LEAKS ${JSON.stringify(needle)}`);
  }
  for (const [name, value] of Object.entries(c.expect.header ?? {})) {
    if (res.headers.get(name) !== value) failures.push(`header ${name}=${res.headers.get(name)} (expected ${value})`);
  }
  for (const name of c.expect.headerAbsent ?? []) {
    if (res.headers.get(name) !== null) failures.push(`header ${name} present, expected absent`);
  }
  return failures;
}
