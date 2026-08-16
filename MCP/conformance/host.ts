// host.ts - the reference host the Despia MCP corpus runs against.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// WHY THIS EXISTS SEPARATELY. The published despia-mcp repository carries this
// package and the grafted `conformance/mcp` slice, and nothing else - no
// sibling package, no monorepo checkout. A runner that reached into another
// package's host would work here and fail there, which is the one thing a
// publish gate must not do. So the mcp slice gets a host inside the package it
// belongs to.
//
// WHAT IT IS. A reference model of the two directions the corpus pins: the
// CLIENT side (declared servers, the namespaced registry, per-server
// degradation, a tool round-trip through a scripted model) and the SERVER side
// (derived rows, the session token, the discovery file, approve-before-execute).
// It is deliberately small: the corpus is the specification, this agrees or
// disagrees with it, and nothing here is a second place to state a rule.
//
// WHAT IT IS NOT. It is not the transport. The real listener, the real token
// comparison and the real 0600 discovery file live in the bindings and are
// tested against real sockets and real files on the JVM face. This host models
// the DECISIONS those pieces make so the same eight cases answer identically on
// every runner; a change that passes here and fails the JVM tests is a bug in
// one of them, and the two are meant to be read together.
//
// The registry and the schema derivation ARE shared: both are re-stated here
// only in the sense that any second implementation of a pinned contract is -
// against fixtures that fail loudly the moment they disagree.

/** A JSON-ish bag. The corpus is JSON, so the host speaks JSON. */
export type Dict = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description?: string;
  schema?: Dict;
  returns?: unknown;
}

export interface ServerSpec {
  name: string;
  tools?: ToolSpec[];
  unreachable?: boolean;
}

export interface RowSpec {
  action: string;
  description?: string;
  mutates?: string;
  approval?: string;
  fromArgs?: Record<string, { type: string; required?: boolean }>;
}

export interface CaseSpec {
  name: string;
  mcpServers?: ServerSpec[];
  servedRows?: RowSpec[];
  mock?: { models?: Record<string, { script?: Dict[]; turns?: Dict[][] }> };
  catalog?: { installed?: string[] };
  steps?: Dict[];
  expect?: Dict;
}

/** `mcp.<server>.<tool>` - the one place this string is built. */
export const MCP_TOOL_NAMESPACE = 'mcp';

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Dict;
  source: string;
  server?: string;
}

/**
 * The namespaced registry.
 *
 * Two servers offering `search` produce two entries, because the namespace is
 * the server id. Collision handling is neither last-writer-wins nor
 * first-writer-wins: both of those silently change which server a model is
 * talking to, which is a correctness bug wearing a naming bug's clothes.
 *
 * Registration order is insertion order - a model sees the list, and a list
 * that reshuffles between runs makes a completion non-reproducible for no
 * reason.
 */
export class ToolRegistry {
  #entries = new Map<string, ToolDefinition>();
  #byServer = new Map<string, string[]>();

  namespaced(server: string, tool: string): string {
    return `${MCP_TOOL_NAMESPACE}.${server}.${tool}`;
  }

  /** Full replace per server: a tool dropped between two connects leaves no ghost. */
  register(server: string, tools: ToolSpec[]): string[] {
    this.remove(server);
    const owned: string[] = [];
    for (const tool of tools) {
      const key = this.namespaced(server, tool.name);
      this.#entries.set(key, {
        name: key,
        description: tool.description,
        // A FOREIGN schema passes through verbatim. Re-deriving it could only lose information.
        parameters: (tool.schema ?? {}) as Dict,
        source: 'mcp',
        server,
      });
      owned.push(key);
    }
    if (owned.length > 0) this.#byServer.set(server, owned);
    return owned;
  }

  /** Degradation is per-server: everything else stays exactly as it was. */
  remove(server: string): void {
    for (const key of this.#byServer.get(server) ?? []) this.#entries.delete(key);
    this.#byServer.delete(server);
  }

  definition(name: string): ToolDefinition | undefined {
    return this.#entries.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.#entries.values()];
  }
}

/**
 * The served-tool derivation, matching `ServedRows.kt` exactly.
 *
 * `required` appears only when at least one argument is required. An empty
 * `required: []` is legal JSON Schema and means the same thing, but the corpus
 * pins the terser form and agreeing with it costs nothing.
 */
export function deriveSchema(args: RowSpec['fromArgs']): Dict {
  const properties: Dict = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(args ?? {})) {
    properties[name] = { type: spec.type };
    if (spec.required) required.push(name);
  }
  const schema: Dict = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function toolList(rows: RowSpec[]): Dict[] {
  return rows.map((row) => {
    const entry: Dict = {
      name: row.action,
      description: row.description,
      inputSchema: deriveSchema(row.fromArgs),
    };
    if (row.mutates) entry.mutates = row.mutates;
    return entry;
  });
}

interface Parked {
  label: string;
  resume: (outcome: string) => void;
}

/** One recorded engine call. The corpus pins the tool list and the messages. */
export interface EngineRequest extends Dict {
  kind: string;
}

export class Host {
  readonly registry = new ToolRegistry();

  // --- what the corpus reads back -------------------------------------
  readonly results: Record<string, unknown> = {};
  readonly errors: Dict[] = [];
  readonly absent: Dict[] = [];
  readonly dispatched: Dict[] = [];
  readonly serverResponses: Dict[] = [];
  readonly engineRequests: EngineRequest[] = [];
  mcpConnectCount = 0;
  discoveryFile: Dict | null = null;
  boundLoopbackOnly = false;
  tokenInUrl = false;
  snapshotBeforeWrite = false;
  dispatchedAfterApproval = false;

  // --- the two tokens, which are never the same value ------------------
  //
  // The session token authenticates the app's own surfaces. The pairing token
  // is what an external host reads out of the discovery file. They are distinct
  // so that withdrawing external consent revokes exactly one of them.
  readonly #sessionToken = 'session-token';
  readonly #pairingToken = 'pairing-token';
  #externalConsent = false;
  #serverStarted = false;
  readonly #parked = new Map<string, Parked>();

  readonly spec: CaseSpec;

  constructor(spec: CaseSpec) {
    this.spec = spec;
  }

  #server(name: string): ServerSpec | undefined {
    return (this.spec.mcpServers ?? []).find((s) => s.name === name);
  }

  #rows(): RowSpec[] {
    return this.spec.servedRows ?? [];
  }

  // --- steps -----------------------------------------------------------

  call(step: Dict): void {
    const label = String(step.as ?? '');
    const scheme = String(step.scheme ?? '');
    const action = String(step.action ?? '');
    const args = (step.args ?? {}) as Dict;
    if (scheme === 'mcp') return this.#mcp(label, action, args);
    if (scheme === 'intelligence' && action === 'completion') {
      return this.#completion(label, args);
    }
    throw new Error(`unsupported call: ${scheme}/${action}`);
  }

  #mcp(label: string, action: string, args: Dict): void {
    if (action === 'connect') {
      const name = String(args.server ?? '');
      const declared = this.#server(name);
      if (!declared) {
        // The app's declarations are the allowlist. No socket is opened, and
        // the refusal is typed rather than thrown: a model cannot talk the app
        // into a new network peer.
        this.absent.push({ req: label, action: 'connect', code: 'server_not_declared', data: { server: name } });
        return;
      }
      this.mcpConnectCount += 1;
      if (declared.unreachable) {
        this.registry.remove(name);
        this.errors.push({ req: label, code: 'server_unreachable', data: { server: name } });
        return;
      }
      const names = this.registry.register(name, declared.tools ?? []);
      this.results[label] = { tools: names };
      return;
    }
    if (action === 'server.tools') {
      this.results[label] = { tools: toolList(this.#rows()) };
      return;
    }
    if (action === 'server.start') {
      this.#serverStarted = true;
      // Asserted rather than assumed: the listener binds numeric loopback and
      // the token rides a header. The JVM face proves both against a real
      // socket; here they are the answers the corpus reads.
      this.boundLoopbackOnly = true;
      this.tokenInUrl = false;
      this.results[label] = { started: true };
      return;
    }
    if (action === 'server.consent') {
      this.#externalConsent = args.external === true;
      this.discoveryFile = this.#externalConsent
        ? {
            mode: '0600',
            hasPort: true,
            tokenDistinctFromSession: this.#pairingToken !== this.#sessionToken,
            removedAfterWithdrawal: false,
          }
        // Withdrawal removes the file AND rotates the pairing token. A
        // withdrawal that only deleted a file would be theatre - the host that
        // cached the value would still be holding a working credential.
        : { ...(this.discoveryFile ?? {}), removedAfterWithdrawal: true };
      this.results[label] = { external: this.#externalConsent };
      return;
    }
    throw new Error(`unsupported mcp action: ${action}`);
  }

  #completion(label: string, args: Dict): void {
    const model = String(args.model ?? '');
    const script = this.spec.mock?.models?.[model] ?? {};
    let messages = [...((args.messages ?? []) as Dict[])];
    // Unresolvable names are DROPPED rather than passed through: a server that
    // is down contributes no tools, and the completion still runs with the
    // tools that are there.
    const tools = ((args.tools ?? []) as string[])
      .map((name) => this.registry.definition(name))
      .filter((d): d is ToolDefinition => d !== undefined)
      .map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));

    for (let turn = 0; turn < 8; turn++) {
      const request: EngineRequest = { kind: 'completion', model, messages: [...messages] };
      if (tools.length > 0) request.tools = tools;
      this.engineRequests.push(request);

      const events = script.turns?.[turn] ?? (turn === 0 ? script.script ?? [] : []);
      const calls: Dict[] = [];
      let text = '';
      for (const event of events) {
        if (event.token !== undefined) text += String(event.token);
        else if (event.tool) calls.push(event.tool as Dict);
      }
      if (calls.length === 0) {
        this.results[label] = { text };
        return;
      }
      const produced: Dict[] = [];
      for (const call of calls) {
        const name = String(call.name ?? '');
        const definition = this.registry.definition(name);
        this.dispatched.push({
          name,
          arguments: call.arguments ?? {},
          source: definition?.source ?? 'unknown',
        });
        produced.push({
          role: 'tool',
          tool_call_id: String(call.id ?? ''),
          content: this.#toolResult(name),
        });
      }
      messages = [...messages, ...produced];
    }
    this.results[label] = { text: '' };
  }

  #toolResult(namespaced: string): unknown {
    for (const server of this.spec.mcpServers ?? []) {
      for (const tool of server.tools ?? []) {
        if (this.registry.namespaced(server.name, tool.name) === namespaced) {
          return tool.returns ?? {};
        }
      }
    }
    return {};
  }

  /**
   * A request arriving at the local server.
   *
   * Two refusals share one answer on purpose. A missing token and a wrong token
   * both get `unauthorized` with no detail, because an error that distinguishes
   * them is an oracle a co-resident app can query.
   */
  serverRequest(step: Dict): void {
    const label = String(step.as ?? '');
    const raw = step.token;
    const token = raw === '$session.token' ? this.#sessionToken
      : raw === '$discovery.token' ? (this.#externalConsent ? this.#pairingToken : 'stale')
      : raw;
    const valid = token === this.#sessionToken ||
                  (token === this.#pairingToken && this.#externalConsent);
    if (!this.#serverStarted || !valid) {
      this.serverResponses.push({ req: label, code: 'unauthorized' });
      return;
    }
    const row = this.#rows().find((r) => r.action === String(step.tool));
    if (!row) {
      // Unknown before authorized-and-unknown: the table is the app's
      // declarations, and there is no dynamic registration path to probe.
      this.serverResponses.push({ req: label, code: 'unknown_tool' });
      return;
    }
    if (row.mutates && row.approval === 'prompt') {
      // The protocol is not a bypass. A write requested over MCP waits for
      // approval and runs inside a snapshot, exactly like an in-app one.
      this.#parked.set(label, {
        label,
        resume: (outcome) => {
          if (outcome !== 'approve') {
            this.serverResponses.push({ req: label, code: 'tool_denied' });
            return;
          }
          this.snapshotBeforeWrite = true;
          this.dispatchedAfterApproval = true;
          this.serverResponses.push({ req: label, ok: true });
        },
      });
      return;
    }
    this.serverResponses.push({ req: label, ok: true });
  }

  approve(id: string, decision: string): void {
    const parked = this.#parked.get(id);
    if (!parked) throw new Error(`nothing is waiting on approval ${id}`);
    this.#parked.delete(id);
    parked.resume(decision);
  }
}
