// host.ts - the reference host: everything ABOVE the engine seam.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The engine streams typed blocks and knows nothing else. Policy lives here:
// the catalog, fit, the router, the tool registry, the agentic loop, approvals,
// the transcript, and typed absence. That split is the design
// (local-ai-engine.md 4.6 puts the loop in the module, 4.13 puts fit and
// routing in the catalog layer), and it is why swapping engines is cheap.
//
// This is the TS implementation of the host contracts stated in
// OpenSource/Conformance/ai/README.md. Core/LocalAI implements the same
// mapping in Swift and Kotlin; these fixtures are what say the three matched.

import { checkOrigin, deliver } from './delivery.ts';
import type { DeliveryPolicy, OriginResponse } from './delivery.ts';
import { Engine } from './engine.ts';
import type { EngineOptions, MockModel } from './engine.ts';
import { fit, meetsFloor, memoryLimitMb } from './fit.ts';
import type { DeviceProfile, FitPolicy } from './fit.ts';
import { CATEGORY_UNKNOWN, expand, parseSource, pickFile, synthesize } from './catalog.ts';
import type { GgufKV, RepoInfo, SourceRegistry } from './catalog.ts';
import { route } from './router.ts';
import type { RouterTable } from './router.ts';
import { SCHEMA_VERSION } from './types.ts';
import type { Capabilities, Dict, Verdict } from './types.ts';

export const TOOL_DEPTH_CAP = 32;

/** The catalog fields this build understands. Anything else is carried
 *  untouched and reported once as an ignored-unknown notice: must-ignore with
 *  a receipt, so a developer sees what a newer catalog brought. */
const KNOWN_ENTRY_FIELDS = new Set([
  'schema_version', 'id', 'name', 'family', 'category', 'engine', 'format', 'status', 'requires',
  'files', 'license', 'languages', 'inputs', 'outputs', 'context_length', 'context_length_max',
  'parameters', 'thinking', 'tool_dialect', 'template', 'sampling', 'requirements', 'perf_priors',
  'mock', 'origin',
]);

/** Verdicts that mean "do not spend the bytes". A download is the most
 *  expensive thing a user can be asked to wait for, so these are refused
 *  BEFORE the transfer rather than discovered at load time. */
const REFUSES_DOWNLOAD: { [verdict: string]: string } = {
  too_big: 'model_too_big',
  unsupported: 'unsupported',
  quarantined: 'model_quarantined',
};

export type ToolSpec = {
  source?: 'module' | 'page' | 'mcp';
  server?: string;
  name: string;
  description?: string;
  /** A foreign schema (page or MCP): passed to the model VERBATIM. */
  schema?: Dict;
  /** A module action's declared args: the schema is DERIVED from them. */
  fromArgs?: { [k: string]: { type: string; required?: boolean } };
  mutates?: string;
  approval?: 'auto' | 'prompt';
  approval_timeout_ms?: number;
  approval_default?: 'deny' | 'approve';
  deadline_ms?: number;
  hangs?: boolean;
  fails?: boolean;
  returns?: Dict;
};

export type ProviderRow = {
  chain: string;
  modality: string;
  serves: string;
  engine?: string;
  capabilities?: Dict;
};

export type CaseSpec = {
  engine?: EngineOptions & { present?: boolean };
  device?: DeviceProfile;
  catalog?: Dict;
  router?: RouterTable;
  tools?: ToolSpec[];
  providers?: ProviderRow[];
  excludedOverlay?: { [chain: string]: { reason: string; from?: string } };
  mcpServers?: Array<{ name: string; unreachable?: boolean; tools?: ToolSpec[] }>;
  servedRows?: Array<{ action: string; description?: string; mutates?: string; approval?: string; fromArgs?: ToolSpec['fromArgs'] }>;
  mock?: { models?: { [id: string]: MockModel } };
  remoteMock?: { script?: Dict[]; error?: { code?: string; message?: string } };
  /** The app's declared delivery policy (the origin allowlist). */
  delivery?: DeliveryPolicy;
  /** What each URL serves. A model file answers with a digest, a pre-flight
   *  verdict and optionally the GGUF header a ranged read would return; a
   *  registry API answers with a `repo` document. Same map, because "what does
   *  this URL serve" is one question. */
  origins?: { [url: string]: OriginResponse };
};

export type BusEvent = { req: string; event: string; final: boolean; data: Dict };
export type Absence = { action: string; code: string } & Dict;

type ParkedTool = {
  id: string;
  kind: 'approval' | 'deadline';
  dueAt: number;
  resume: (outcome: 'approve' | 'deny' | 'timeout') => void;
};

type Loop = {
  label: string;
  rid: number;
  model: string;
  entry: Dict;
  messages: Dict[];
  toolNames: string[];
  responseFormat?: Dict;
  depth: number;
  settle: ((result: Dict) => void) | null;
  reject: ((err: Dict) => void) | null;
};

/** Schema derivation: a module tool's parameters come from the action's
 *  declared args and are never restated in the row, so the schema cannot drift
 *  from the contract it describes. */
function deriveSchema(fromArgs: NonNullable<ToolSpec['fromArgs']>): Dict {
  const properties: Dict = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(fromArgs)) {
    properties[name] = { type: spec.type };
    if (spec.required) required.push(name);
  }
  const out: Dict = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

export class Host {
  spec: CaseSpec;
  engine: Engine;
  caps: Capabilities;
  device: DeviceProfile;
  policy: FitPolicy;
  table: RouterTable;

  entries = new Map<string, Dict>();
  entryOrder: string[] = [];
  /** The ids the USER added at runtime, in the order they were added. This is
   *  the overlay a real device persists beside the catalog rather than inside
   *  it: an OTA catalog replaces `entries` wholesale, and a model somebody
   *  chose must not disappear because the fleet's catalog was retuned. */
  addedIds: string[] = [];
  sources: SourceRegistry = {};
  installed: string[] = [];
  loadedModel: string | undefined;
  verdicts = new Map<string, Verdict>();
  quarantined = new Set<string>();

  // Observations the corpus asserts against.
  events: BusEvent[] = [];
  errors: Array<{ req?: string } & Dict> = [];
  absent: Absence[] = [];
  results: { [label: string]: Dict } = {};
  dispatched: Array<{ name: string; arguments?: Dict; source?: string }> = [];
  dispatchGroups: string[][] = [];
  remoteRequests: Dict[] = [];
  notices: Dict[] = [];
  catalogNotices: Dict[] = [];
  transcript: Dict[] = [];
  transcriptTransmitted = false;
  providers: Dict[] = [];
  buildAbort: Dict | null = null;
  rows: Dict[] = [];
  downloadCount = 0;
  mcpConnectCount = 0;
  downloadAttempts: Dict[] = [];
  /** Every URL contacted while RESOLVING a source, in order. Zero is the whole
   *  assertion for a registry the app never allowed: a refusal that has already
   *  contacted the host has told it the app exists. */
  resolveAttempts: Dict[] = [];
  downloaded: Dict[] = [];
  deletedOnMismatch: string[] = [];
  pinnedDigests: { [model: string]: string } = {};
  engineLoadCount = 0;
  serverResponses: Array<{ req: string } & Dict> = [];
  discoveryFile: Dict | null = null;
  boundLoopbackOnly = false;
  tokenInUrl = false;
  snapshotBeforeWrite = false;
  snapshotBeforeFirstWrite = false;
  dispatchedAfterApproval = false;
  ridOf: { [label: string]: number } = {};

  #pinned = new Map<string, string>();
  #tools = new Map<string, ToolSpec>();
  #connectedServers = new Set<string>();
  #parked: ParkedTool[] = [];
  #now = 0;
  #store = new Map<string, Dict>();
  #sessionToken = 'session-token';
  #discoveryToken = 'pairing-token';
  #externalConsent = false;
  #serverStarted = false;
  #writesSeen = 0;
  #approvalSeen = false;
  #loops = new Map<string, Loop>();

  constructor(spec: CaseSpec) {
    this.spec = spec;
    this.engine = new Engine(spec.engine ?? {});
    this.caps = this.engine.capabilities;
    this.device = spec.device ?? {};
    this.table = spec.router ?? {};
    const catalog = spec.catalog ?? {};
    this.policy = (catalog.fit_policy ?? {}) as FitPolicy;
    this.loadedModel = catalog.loaded ? String(catalog.loaded) : undefined;
    for (const id of this.device.quarantined ?? []) this.quarantined.add(id);

    for (const [model, digest] of Object.entries((catalog.pinned ?? {}) as Dict)) {
      this.#pinned.set(model, String(digest));
    }
    this.sources = (catalog.sources ?? {}) as SourceRegistry;
    this.#ingestCatalog(catalog);
    this.#registerTools(spec.tools ?? []);
    this.#deriveProviders(spec.providers ?? []);
    this.rows = this.#availableRows();
  }

  // --- catalog ---------------------------------------------------------

  #ingestCatalog(catalog: Dict): void {
    const entries: Dict[] = Array.isArray(catalog.entries) ? catalog.entries : [];
    for (const entry of entries) {
      // A malformed row is a ROW-level problem. One bad or too-new entry must
      // never blind an app to the rest of its models, so it is skipped with a
      // notice and the catalog keeps loading.
      if (typeof entry.id !== 'string' || typeof entry.engine !== 'string') {
        this.catalogNotices.push({ code: 'entry_skipped', reason: 'missing_required_field' });
        continue;
      }
      const unknown = Object.keys(entry).filter((k) => !KNOWN_ENTRY_FIELDS.has(k));
      if (unknown.length > 0) {
        this.catalogNotices.push({
          code: 'unknown_fields_ignored',
          entry: entry.id,
          fields: unknown,
        });
      }
      this.entries.set(entry.id, entry);
      this.entryOrder.push(entry.id);
    }
    // The RESTORED overlay: entries a previous launch added, read back before
    // anything else runs. A shipped row of the same id always wins - the
    // catalog is the fleet's document and a device-local addition may never
    // shadow it - and the collision is a notice rather than a silent drop.
    for (const entry of (Array.isArray(catalog.added) ? catalog.added : []) as Dict[]) {
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id) continue;
      if (this.entries.has(id)) {
        this.catalogNotices.push({ code: 'added_entry_skipped', reason: 'id_shadows_catalog', entry: id });
        continue;
      }
      this.entries.set(id, { ...entry, origin: { ...(entry.origin ?? {}), added: true } });
      this.entryOrder.push(id);
      this.addedIds.push(id);
    }

    this.installed = (Array.isArray(catalog.installed) ? catalog.installed : []).map(String);
    // Installed ids the catalog never described still exist on disk; the mock
    // gives them a bare entry so a case can install a model without spelling
    // out a whole row.
    for (const id of this.installed) {
      if (!this.entries.has(id)) {
        this.entries.set(id, { id, engine: 'mock', format: 'mock' });
        this.entryOrder.push(id);
      }
    }
    for (const [id, entry] of this.entries) {
      this.verdicts.set(id, fit(entry, this.device, this.caps, this.policy));
    }
  }

  #row(id: string): Dict {
    const entry = this.entries.get(id) ?? { id };
    const verdict = this.verdicts.get(id) ?? { verdict: 'unsupported' };
    const row: Dict = { id, ...verdict };
    if (entry.status) row.status = entry.status;
    // A user-added model is never presented as a shipped one. The flag is on
    // the ROW because the row is what a surface renders, and "where did this
    // come from" is a question a settings screen has to be able to answer.
    if (entry.origin?.added === true) row.added = true;
    return row;
  }

  #installedRows(): Dict[] {
    return this.entryOrder.filter((id) => this.installed.includes(id)).map((id) => this.#row(id));
  }

  #availableRows(): Dict[] {
    // Retirement stops NEW downloads only. An installed model keeps working
    // forever - there is no remote kill switch, which is what "you own your
    // OWN AI" has to mean to be worth saying.
    return this.entryOrder
      .filter((id) => (this.entries.get(id)?.status ?? 'active') !== 'retired')
      .map((id) => this.#row(id));
  }

  // --- tools -----------------------------------------------------------

  #registerTools(tools: ToolSpec[]): void {
    for (const t of tools) this.#tools.set(t.name, t);
  }

  #toolDefinition(name: string): Dict | null {
    const t = this.#tools.get(name);
    if (!t) return null;
    // A module tool DERIVES its schema; a page or MCP tool carries its own
    // arbitrary JSON Schema through verbatim, never down-converted - anything
    // else would silently narrow what the model can express.
    const parameters = t.fromArgs ? deriveSchema(t.fromArgs) : (t.schema ?? { type: 'object' });
    const def: Dict = { name: t.name, parameters };
    if (t.description !== undefined) def.description = t.description;
    if (t.source) def.source = t.source;
    // Descriptions are UNTRUSTED input. They ride to the model as data, tagged
    // with where they came from, and they change no policy.
    if (t.source === 'mcp') def.provenance = `mcp:${t.server ?? 'unknown'}`;
    else if (t.source === 'page') def.provenance = 'page';
    return def;
  }

  // --- providers -------------------------------------------------------

  #deriveProviders(rows: ProviderRow[]): void {
    const claimants = new Map<string, ProviderRow[]>();
    for (const row of rows) {
      if (this.#exclusionFor(row.chain)) continue;  // exclusion is the resolution
      const list = claimants.get(row.modality) ?? [];
      list.push(row);
      claimants.set(row.modality, list);
    }
    for (const [modality, list] of claimants) {
      if (list.length > 1) {
        // Two ENABLED claimants of one modality is a build abort, not a
        // runtime coin flip - the same enabled-claimant collision the facet
        // grammar already enforces at prepare time.
        this.buildAbort = {
          code: 'facet_key_collision',
          word: 'provider',
          key: modality,
          claimants: list.map((r) => r.chain),
        };
        return;
      }
    }
    for (const [modality, list] of claimants) {
      const row = list[0];
      const carried = !row.engine || this.caps.engines.includes(row.engine);
      this.providers.push({
        modality,
        chain: row.chain,
        available: carried,
        ...(carried ? {} : { reason: 'engine_not_carried' }),
      });
    }
  }

  #providerFor(chain: string): { row: Dict; spec: ProviderRow } | null {
    for (const p of this.providers) {
      if (p.chain === chain) {
        const spec = (this.spec.providers ?? []).find((r) => r.chain === chain);
        if (spec) return { row: p, spec };
      }
    }
    return null;
  }

  // --- exclusion / absence ---------------------------------------------

  #exclusionFor(chain: string): { reason: string; from?: string } | null {
    const overlay = this.spec.excludedOverlay ?? {};
    if (overlay[chain]) return overlay[chain];
    return null;
  }

  #absence(label: string | undefined, action: string, code: string, extra: Dict = {}): Dict {
    const record: Absence = { action, code, ...extra };
    this.absent.push(record);
    if (label) this.results[label] = { error: record };
    return record;
  }

  // --- the bus ---------------------------------------------------------

  call(step: Dict): void {
    const scheme = String(step.scheme ?? 'intelligence');
    const action = String(step.action ?? '');
    const args: Dict = (step.args ?? {}) as Dict;
    const label = step.as ? String(step.as) : undefined;
    const mode = String(step.mode ?? 'await');

    if (scheme === 'base') return this.#baseCall(label, action, args);
    if (scheme === 'mcp') return this.#mcpCall(label, action, args);

    // Exclusion answers first and by name: a UI can say "this app was built
    // without voice" rather than "something went wrong".
    const excluded = this.#exclusionFor(scheme);
    if (excluded) {
      const extra: Dict = { reason: excluded.reason };
      if (excluded.from) extra.from = excluded.from;
      else if (scheme.includes('.')) extra.chain = scheme;
      this.#absence(label, action, 'not_available', extra);
      return;
    }
    if (!this.engine.present) {
      this.#absence(label, action, 'not_available', { reason: 'engine_absent' });
      return;
    }

    if (scheme !== 'intelligence') {
      const provider = this.#providerFor(scheme);
      if (provider) return this.#providerCall(label, scheme, action, args, provider, mode);
      if (scheme.startsWith('intelligence.')) {
        // A child of the container with no declared row is still a chain of
        // this module: the residency law puts NEW actions on child chains, so
        // the call belongs here and answers like any other provider call.
        const implied = {
          row: { modality: scheme.slice('intelligence.'.length), chain: scheme, available: true },
          spec: { chain: scheme, modality: scheme.slice('intelligence.'.length), serves: action },
        };
        return this.#providerCall(label, scheme, action, args, implied as any, mode);
      }
      this.#absence(label, action, 'not_available', { reason: 'unknown_scheme' });
      return;
    }

    switch (action) {
      case 'capabilities':
        if (label) this.results[label] = { ...this.caps };
        return;
      case 'models':
      case 'models.installed':
        this.rows = this.#installedRows();
        if (label) this.results[label] = { rows: this.rows };
        return;
      case 'models.available':
        this.rows = this.#availableRows();
        if (label) this.results[label] = { rows: this.rows };
        return;
      case 'models.fit': {
        const id = String(args.model ?? '');
        const v = this.verdicts.get(id);
        if (!v) return void this.#absence(label, action, 'unknown_model', { data: { model: id } });
        if (label) this.results[label] = { ...v };
        return;
      }
      case 'models.add':
        return this.#modelsAdd(label, args);
      case 'models.added':
        if (label) this.results[label] = { rows: this.addedIds.map((id) => this.#row(id)) };
        return;
      case 'models.best':
        return this.#modelsBest(label, args);
      case 'models.clearQuarantine': {
        const id = String(args.model ?? '');
        this.quarantined.delete(id);
        this.device = { ...this.device, quarantined: [...this.quarantined] };
        const entry = this.entries.get(id);
        if (entry) this.verdicts.set(id, fit(entry, this.device, this.caps, this.policy));
        if (label) this.results[label] = { ok: true };
        return;
      }
      case 'download':
        return this.#download(label, args);
      case 'completion':
      case 'embed':
        return this.#completion(label, action, args, mode);
      default:
        this.#absence(label, action, 'unknown_action');
    }
  }

  // --- open catalog: adding a model at runtime -------------------------

  /**
   * `models.add({ source, prefer?, revision?, id? })`.
   *
   * Turns a registry reference into a catalog entry at RUNTIME, so a developer
   * who wants a model that is not in the shipped eleven writes one call instead
   * of editing a JSON file and rebuilding. What comes out is an ordinary entry:
   * download, the four locks, pre-flight, fit, the governor and load all apply
   * to it unchanged, because it IS the same shape.
   *
   * THE REGISTRY'S ANSWER IS UNTRUSTED INPUT, and the sequence below is what
   * that means concretely:
   *
   *   - the app's declared registry says where to ask; the ANSWER never does
   *   - the API leg is origin-checked too, so a registry on a host the app
   *     never allowed is refused with nothing contacted
   *   - the resolved file URL is origin-checked BEFORE its first byte is read,
   *     and a response can never widen `allowed_model_hosts`
   *   - a revision that is not an immutable commit is refused
   *   - the FILE's own header outranks the API on context length and family
   *   - the entry is marked `origin.added` forever, so nothing downstream can
   *     mistake it for a curated row
   */
  #modelsAdd(label: string | undefined, args: Dict): void {
    const refuse = (code: string, extra: Dict = {}): void =>
      void this.#absence(label, 'models.add', code, extra);

    const parsed = parseSource(String(args.source ?? ''));
    if (!parsed.ok) return refuse(parsed.code, { data: parsed.data, message: parsed.message });

    const ref = parsed.value;
    const registry = this.sources[ref.scheme];
    if (!registry) {
      // Fail closed, exactly like the origin allowlist: an app that has not
      // declared a registry has not opted into resolving against one.
      return refuse('source_unsupported', {
        reason: 'registry_not_declared',
        // `_`-prefixed keys are the documents' own annotations, never registries.
        data: { registry: ref.scheme, declared: Object.keys(this.sources).filter((k) => !k.startsWith('_')) },
        message: `This app does not resolve "${ref.scheme}:" sources.`,
      });
    }

    const apiUrl = expand(registry.api, {
      repo: ref.repo,
      revision: args.revision ? String(args.revision) : (registry.default_revision ?? 'main'),
    });
    // The allowlist covers the METADATA leg as well as the bytes. A registry
    // the app never named is not contacted at all.
    const apiRefusal = checkOrigin(apiUrl, this.spec.delivery ?? {});
    if (apiRefusal) {
      return refuse(String(apiRefusal.code), {
        data: { ...(apiRefusal.data as Dict), leg: 'registry' },
        message: 'This app is not allowed to talk to that model registry.',
      });
    }

    this.resolveAttempts.push({ url: apiUrl, leg: 'registry' });
    const answer = this.spec.origins?.[apiUrl];
    if (!answer || answer.unreachable || !answer.repo) {
      return refuse('resolve_failed', {
        data: { registry: ref.scheme, repo: ref.repo },
        message: 'That model registry did not answer.',
      });
    }
    const info = answer.repo as RepoInfo;

    const chosen = pickFile(info, { path: ref.path, prefer: args.prefer ? String(args.prefer) : undefined });
    if (!chosen.ok) return refuse(chosen.code, { data: chosen.data, message: chosen.message });

    // Phase one: synthesise WITHOUT the header, only to learn the URL the app's
    // own template resolves to. Nothing is stored from this pass.
    const first = synthesize({
      ref, registry, info, file: chosen.value,
      id: args.id ? String(args.id) : undefined,
      license: 'record',
    });
    if (!first.ok) return refuse(first.code, { data: first.data, message: first.message });

    const fileUrl = first.value.files[0].urls[0];
    const fileRefusal = checkOrigin(fileUrl, this.spec.delivery ?? {});
    if (fileRefusal) {
      // The response resolved to a host this app never allowed. Nothing in an
      // API document may widen the allowlist, so this is where it stops - and
      // the error names the host, because "add a host" is a decision the
      // developer makes deliberately or not at all.
      return refuse(String(fileRefusal.code), {
        data: { ...(fileRefusal.data as Dict), leg: 'file' },
        message: `That model is served from ${(fileRefusal.data as Dict)?.host ?? 'an origin'}, ` +
                 'which this app does not allow.',
      });
    }

    // Phase two: read the header off the file itself and synthesise for real.
    // The bytes outrank the registry on everything they can answer.
    this.resolveAttempts.push({ url: fileUrl, leg: 'file' });
    const header = this.spec.origins?.[fileUrl]?.header as GgufKV | undefined;
    const built = synthesize({
      ref, registry, info, file: chosen.value, header,
      id: args.id ? String(args.id) : undefined,
      license: 'record',
    });
    if (!built.ok) return refuse(built.code, { data: built.data, message: built.message });
    const entry = built.value;

    const existing = this.entries.get(entry.id);
    if (existing && existing.origin?.added !== true) {
      // A shipped row is the fleet's document. A device-local addition may
      // never take its id and quietly change what a task routes to.
      return refuse('id_conflict', {
        data: { model: entry.id, origin: 'catalog' },
        message: `This app already ships a model called ${entry.id}. Pass an id to add yours beside it.`,
      });
    }

    this.entries.set(entry.id, entry as unknown as Dict);
    if (!this.entryOrder.includes(entry.id)) this.entryOrder.push(entry.id);
    if (!this.addedIds.includes(entry.id)) this.addedIds.push(entry.id);
    const verdict = fit(entry as unknown as Dict, this.device, this.caps, this.policy);
    this.verdicts.set(entry.id, verdict);
    this.rows = this.#availableRows();

    if (entry.license.id === 'unknown') {
      // Engine is not weights. A licence the repository did not state is not a
      // licence anybody may invent, so the entry records the absence and the
      // surface decides whether it will serve it.
      this.notices.push({
        code: 'license_unknown',
        data: { model: entry.id, repo: ref.repo },
      });
    }

    if (label) this.results[label] = { entry, verdict, added: true };
  }

  /** The downloadable catalog: everything not retired. Retirement stops NEW
   *  downloads only, so it is exactly the right filter for a recommendation. */
  #downloadable(): string[] {
    return this.entryOrder.filter((id) => (this.entries.get(id)?.status ?? 'active') !== 'retired');
  }

  /**
   * The best model of a kind that this device can actually run.
   *
   * ONE ranking, used by both the refusal path (as a fallback) and by
   * `models.best` when the router has no opinion. It reuses `fit`'s own
   * ordering through `meetsFloor` rather than restating a rank table:
   * `runs_well` first, then `runs_slow`, and nothing else is a degree of
   * "works". Among equals the LARGEST wins, because the biggest model that
   * runs is the best quality this device can have.
   *
   * IT NEVER SUBSTITUTES ACROSS AN `unknown` CATEGORY, in either direction. The
   * whole offer means "another model of the same kind", so it is only sound
   * when the kind is known on both sides: a model this build could not classify
   * gets no replacement suggested for it, and it is never suggested as a
   * replacement for something else. Answering a refused speech model with a
   * chat model is worse than answering with nothing, because nothing is
   * obviously nothing and a chat model looks like an answer.
   */
  #bestAlternative(opts: { category?: string; exclude?: string; requireCaps?: string[] }): Dict {
    if (opts.category === CATEGORY_UNKNOWN) {
      return { none: true, reason: 'category_unknown', category: CATEGORY_UNKNOWN };
    }
    const candidates = this.#downloadable().filter((id) => {
      if (id === opts.exclude) return false;
      const entry = this.entries.get(id);
      if (!entry) return false;
      if (entry.category === CATEGORY_UNKNOWN) return false;
      if (opts.category !== undefined && (entry.category ?? undefined) !== opts.category) return false;
      const declared: string[] = (entry.requires?.engine_caps ?? []) as string[];
      if ((opts.requireCaps ?? []).some((c) => !this.caps.features.includes(c) || !declared.includes(c))) {
        return false;
      }
      const v = this.verdicts.get(id);
      return Boolean(v && meetsFloor(v.verdict, undefined));
    });

    if (candidates.length === 0) {
      return {
        none: true,
        reason: 'no_model_of_this_kind_runs_here',
        ...(opts.category !== undefined ? { category: opts.category } : {}),
      };
    }

    const score = (id: string): number[] => {
      const v = this.verdicts.get(id)!;
      const size = Number((this.entries.get(id)?.requirements ?? {}).disk_mb ?? 0);
      return [meetsFloor(v.verdict, 'runs_well') ? 1 : 0, size];
    };
    const best = candidates.reduce((a, b) => {
      const [ra, sa] = score(a);
      const [rb, sb] = score(b);
      if (rb > ra) return b;
      if (rb < ra) return a;
      return sb > sa ? b : a;      // ties keep catalog order
    });
    return this.#recommendation(best, 'best-that-runs');
  }

  #recommendation(id: string, reason: string): Dict {
    const entry = this.entries.get(id) ?? { id };
    const verdict = this.verdicts.get(id) ?? { verdict: 'unsupported' };
    return {
      model: id,
      ...(entry.name ? { name: entry.name } : {}),
      verdict,
      reason,
      installed: this.installed.includes(id),
      download_mb: Number((entry.requirements ?? {}).disk_mb ?? 0),
    };
  }

  /**
   * `models.best({ task?, category? })` - what should this device DOWNLOAD.
   *
   * The router already answers "which of my INSTALLED models serves this task",
   * which is the second question a developer has. This is the first one, and it
   * is the same function over the whole catalog: `route` with every
   * downloadable id in the candidate set and no stickiness, since a resident
   * model cannot be the answer to what to install. It returns the verdict with
   * the id, never a bare name, so a surface can say "Qwen3 1.7B, runs well,
   * 1.1 GB" instead of a word.
   */
  #modelsBest(label: string | undefined, args: Dict): void {
    const task = args.task ? String(args.task) : undefined;
    const category = args.category !== undefined ? String(args.category) : undefined;

    if (task && (this.table.remote?.policy ?? 'local') === 'remote-only') {
      return void this.#absence(label, 'models.best', 'no_model_available', {
        reason: 'policy-remote-only',
        message: 'This app is configured to run this task remotely, so there is nothing to download.',
      });
    }

    let requireCaps: string[] | undefined;
    if (task) {
      const spec = (this.table.tasks ?? {})[task] ?? (this.table.tasks ?? {})[this.table.default ?? ''] ?? {};
      requireCaps = spec.require_caps;
      // The router's declared preference order IS the app's ranking. Where it
      // has one, it wins over any size heuristic.
      const decision = route(task, { ...this.table, remote: undefined }, this.#downloadable(),
                             this.entries, this.verdicts, this.caps, undefined);
      if (decision.kind === 'local') {
        if (label) this.results[label] = this.#recommendation(decision.model, decision.reason);
        return;
      }
    }

    const best = this.#bestAlternative({ category, requireCaps });
    if (best.none) {
      return void this.#absence(label, 'models.best', 'no_model_available', {
        reason: best.reason,
        data: { ...(category !== undefined ? { category } : {}), ...(task ? { task } : {}) },
        message: 'No model in this catalog runs on this device.',
      });
    }
    if (label) this.results[label] = best;
  }

  /** A refusal a person reads. It says what is wrong and what to do about it,
   *  because a download refusal is user-facing in effect whatever the code
   *  says. */
  #refusalSentence(id: string, verdict: Verdict, fallback: Dict): string {
    const offer = fallback.reason === 'category_unknown'
      // Saying nothing runs here would be a different, false claim. What is
      // true is narrower: this build could not tell what kind of model it is,
      // so it has nothing it is entitled to offer in its place.
      ? ' This build could not tell what kind of model that is, so it is not suggesting a replacement.'
      : fallback.none
        ? ' No model in this catalog runs on this device.'
        : ` Try ${fallback.model} instead - it ${fallback.verdict?.verdict === 'runs_well'
            ? 'runs well' : 'runs, slowly'} on this device.`;
    if (verdict.verdict === 'too_big' && verdict.reason === 'memory') {
      return `${id} needs more memory than this device gives an app, so it would not run ` +
             `even once it downloaded.${offer}`;
    }
    if (verdict.verdict === 'too_big') {
      return `${id} is too big for this device.${offer}`;
    }
    if (verdict.verdict === 'quarantined') {
      return `${id} crashed this app the last time it loaded and is held back until you clear it.${offer}`;
    }
    return `This build cannot run ${id} (${verdict.reason ?? 'unsupported'}).${offer}`;
  }

  #download(label: string | undefined, args: Dict): void {
    const id = String(args.model ?? '');
    const entry = this.entries.get(id);
    if (!entry) return void this.#absence(label, 'download', 'unknown_model', { data: { model: id } });
    if ((entry.status ?? 'active') === 'retired') {
      return void this.#absence(label, 'download', 'model_retired', { data: { model: id } });
    }
    // Storage is accounted BEFORE the bytes move, so a model that cannot fit
    // is refused instead of filling the disk and then failing. This is the
    // LIVE free-space check and it stays ahead of the fit verdict below: it is
    // the more specific answer and it reads the device rather than the catalog.
    const needed = Number((entry.requirements ?? {}).disk_mb ?? 0);
    const free = Number(this.device.free_disk_mb ?? Infinity);
    if (needed > free) {
      return void this.#absence(label, 'download', 'insufficient_storage', {
        data: { needed_mb: needed, free_mb: free, fallback: this.#bestAlternative({
          category: entry.category ?? undefined, exclude: id,
        }) },
        message: `${id} needs ${needed} MB and this device has ${free} MB free. ` +
                 'Free up space, or install a smaller model.',
      });
    }

    // Lock 4, BEFORE the bytes move. It used to run only on the request path,
    // which meant a device with plenty of disk and no memory would download
    // gigabytes and discover at LOAD time that it could not run them - the user
    // paying the wait, the data and the battery for an error. The refusal
    // carries the verdict AND the reason, because "too big for memory" and "too
    // big for disk" send a person to two completely different remedies.
    const verdict = this.verdicts.get(id);
    const code = verdict ? REFUSES_DOWNLOAD[verdict.verdict] : undefined;
    if (verdict && code) {
      const fallback = this.#bestAlternative({ category: entry.category ?? undefined, exclude: id });
      return void this.#absence(label, 'download', code, {
        reason: verdict.reason,
        data: { model: id, verdict: verdict.verdict, reason: verdict.reason, fallback },
        message: this.#refusalSentence(id, verdict, fallback),
      });
    }

    // Locks 1 to 3.
    if (Array.isArray(entry.files) && entry.files.length > 0) {
      const outcome = deliver(entry, {
        policy: this.spec.delivery ?? {},
        pinned: this.#pinned,
        fetch: (url) => this.spec.origins?.[url],
        onDelete: (model) => this.deletedOnMismatch.push(model),
        onAttempt: (url) => this.downloadAttempts.push({ url }),
      });
      for (const [model, digest] of this.#pinned) this.pinnedDigests[model] = digest;
      if (!outcome.ok) {
        return void this.#absence(label, 'download', outcome.code, { data: outcome.data });
      }
      this.downloaded.push({ model: id, sha256: outcome.sha256, url: outcome.url, verified: true });
    }
    this.downloadCount++;
    this.installed = [...this.installed, id];
    if (label) this.results[label] = { ok: true };
  }

  // --- completion + the agentic loop -----------------------------------

  #completion(label: string | undefined, action: string, args: Dict, mode: string): void {
    const target = this.device.runs_inference;
    if (target === false) {
      // The reach-vs-run law: every target REACHES the surface; running is a
      // per-target declaration. Reach without run is a typed answer with the
      // target named, never silence.
      return void this.#absence(label, action, 'not_available', {
        reason: 'run_not_declared',
        data: { target: this.device.target },
      });
    }

    let model = args.model ? String(args.model) : undefined;
    const task = args.task ? String(args.task) : undefined;
    const rid = this.#nextRid();
    const key = label ?? `#${rid}`;
    this.ridOf[key] = rid;

    if (model) {
      const entry = this.entries.get(model);
      if (!entry) {
        return void this.#absence(label, action, 'unknown_model', { data: { model } });
      }
      this.#emit(key, 'routing', { model, reason: 'explicit' }, false);
    } else if (task) {
      if (this.installed.length === 0 && (this.table.remote?.policy ?? 'local') === 'local') {
        return void this.#absence(label, action, 'no_model_available', { reason: 'none_installed' });
      }
      const decision = route(task, this.table, this.installed, this.entries, this.verdicts,
                             this.caps, this.loadedModel);
      if (decision.kind === 'none') {
        return void this.#absence(label, action, 'no_model_available', { reason: decision.reason });
      }
      if (decision.kind === 'remote') {
        this.#emit(key, 'routing', { task, engine: 'remote', reason: decision.reason }, false);
        return this.#runRemote(label, key, args);
      }
      this.#emit(key, 'routing', { task, model: decision.model, reason: decision.reason }, false);
      model = decision.model;
    } else {
      return void this.#absence(label, action, 'no_model_available', { reason: 'none_installed' });
    }

    const entry = this.entries.get(model)!;
    if (!this.caps.engines.includes(String(entry.engine ?? 'mock'))) {
      return void this.#absence(label, action, 'unsupported', {
        reason: 'engine_not_carried',
        data: { engine: entry.engine },
      });
    }

    const verdict = this.verdicts.get(model)!;
    if (verdict.verdict === 'quarantined') {
      return void this.#absence(label, action, 'model_quarantined', { data: { model } });
    }
    if (verdict.verdict === 'too_big') {
      // Enforced, not advisory: the engine is never handed a model this device
      // cannot hold, so no request reaches the seam.
      return void this.#absence(label, action, 'model_too_big', {
        data: { verdict: verdict.verdict, reason: verdict.reason },
      });
    }
    if (verdict.verdict === 'unsupported') {
      return void this.#absence(label, action, 'unsupported', { reason: verdict.reason });
    }

    // A declared `inputs` list is a contract: sending an image to a text-only
    // model is answered above the seam, with no wasted load.
    const declaredInputs: string[] | undefined = Array.isArray(entry.inputs) ? entry.inputs : undefined;
    if (declaredInputs) {
      for (const message of (args.messages ?? []) as Dict[]) {
        for (const part of (message.parts ?? []) as Dict[]) {
          if (part.type && !declaredInputs.includes(String(part.type))) {
            return void this.#absence(label, action, 'unsupported_input', {
              data: { type: part.type, model },
            });
          }
        }
      }
    }

    this.#ensureLoaded(model);
    if (action === 'embed') {
      const messages = [{ role: 'user', parts: [{ type: 'text', text: String(args.text ?? '') }] }];
      return this.#runTurns(label, key, {
        label: key, rid, model, entry, messages, toolNames: [], depth: 0,
        settle: null, reject: null,
      }, 'embed', args);
    }
    this.#runTurns(label, key, {
      label: key,
      rid,
      model,
      entry,
      messages: [...((args.messages ?? []) as Dict[])],
      toolNames: (args.tools ?? []) as string[],
      responseFormat: args.response_format as Dict | undefined,
      depth: 0,
      settle: null,
      reject: null,
    }, 'completion', args);
  }

  #ensureLoaded(model: string): void {
    if (this.engine.isLoaded(model)) return;
    this.engineLoadCount++;
    const entry = this.entries.get(model) ?? { id: model };
    const mock = this.spec.mock?.models?.[model];
    this.engine.loadModel(entry, mock);
    this.loadedModel = model;
  }

  #runTurns(label: string | undefined, key: string, loop: Loop, kind: string, args: Dict): void {
    this.#loops.set(key, loop);
    this.#turn(label, key, loop, kind, args);
  }

  #turn(label: string | undefined, key: string, loop: Loop, kind: string, args: Dict): void {
    const request: Dict = {
      schema_version: SCHEMA_VERSION,
      kind,
      model: loop.model,
      messages: loop.messages,
    };
    const defs = loop.toolNames.map((n) => this.#toolDefinition(n)).filter(Boolean) as Dict[];
    if (defs.length > 0) request.tools = defs;
    if (loop.responseFormat) {
      request.response_format = loop.responseFormat;
      // Structured output is v1: the schema compiles to a grammar, so the JSON
      // is well formed by construction rather than by hope.
      if (this.caps.features.includes('gbnf')) request.grammar = 'gbnf';
    }
    if (args.priority) request.priority = args.priority;
    this.transcript.push({ kind: 'request', model: loop.model });

    const toolCalls: Dict[] = [];
    let settled = false;

    // Finishing is driven by the TERMINAL EVENT, not by the request call
    // returning. That is what lets a script pause mid-stream: the turn stays
    // genuinely in flight, a cancel or a resync lands on it, and the loop only
    // moves on once the engine says it is done.
    const finish = (terminal: Dict | null, failure: Dict | null): void => {
      if (settled) return;
      settled = true;

      if (failure) {
        this.errors.push({ req: key, code: String(failure.code), message: failure.message });
        if (label) this.results[label] = { error: failure };
        this.#loops.delete(key);
        return;
      }

      const cancelled = Boolean(terminal?.cancelled);
      if (!cancelled && toolCalls.length > 0) {
        if (loop.depth >= TOOL_DEPTH_CAP) {
          this.errors.push({ req: key, code: 'tool_depth_exceeded', data: { depth: TOOL_DEPTH_CAP } });
          this.#loops.delete(key);
          return;
        }
        loop.depth++;
        this.#dispatchTools(label, key, loop, kind, args, toolCalls);
        return;
      }

      const data: Dict = {
        snapshot: this.#finalSnapshot(loop, (terminal?.snapshot ?? []) as Dict[]),
        ...(cancelled ? { cancelled: true } : {}),
      };
      if (terminal?.usage) data.usage = terminal.usage;
      this.#emit(key, 'complete', data, true);
      this.transcript.push({ kind: 'complete' });
      this.#loops.delete(key);
      if (label) this.results[label] = data;
    };

    const rid = this.engine.request(request as any, (e) => {
      if (e.event === 'token') {
        const delta = e.data.delta as Dict;
        if (delta && delta.type === 'tool') {
          toolCalls.push(delta);
          return;  // tool blocks surface as `tool` events, not as text deltas
        }
        if (delta && !this.#knownBlock(delta.type)) {
          // Must-ignore with a receipt: an unknown block from a newer engine is
          // dropped, recorded, and the request still completes.
          this.notices.push({ code: 'unknown_block_ignored', data: { type: delta.type } });
          return;
        }
        this.#emit(key, 'token', e.data, false);
        return;
      }
      if (e.event === 'sync') return void this.#emit(key, 'sync', e.data, false);
      if (e.event === 'error') return void finish(null, { code: String(e.data.code), message: e.data.message });
      if (e.event === 'complete') finish(e.data, null);
    });
    // The engine owns request identity; the host's label is just a name for it.
    // Carrying the engine's id here is what makes cancel and resync target the
    // request a fixture means.
    this.ridOf[key] = rid;
    loop.rid = rid;
  }

  /** The snapshot a caller sees: blocks this build understands, with text and
   *  thinking coalesced, and embeddings stamped with the model that produced
   *  them. Dropping an unknown block from the events but leaving it in the
   *  snapshot would be must-ignore in name only. */
  #finalSnapshot(loop: Loop, raw: Dict[]): Dict[] {
    const out: Dict[] = [];
    for (const block of raw) {
      if (!this.#knownBlock(block.type)) continue;
      if (block.type === 'embedding' && block.model === undefined) {
        out.push({ ...block, model: loop.model });
        continue;
      }
      const last = out[out.length - 1];
      if ((block.type === 'text' || block.type === 'thinking') && last && last.type === block.type) {
        last.text = String(last.text ?? '') + String(block.text ?? '');
        continue;
      }
      out.push({ ...block });
    }
    return out;
  }

  #knownBlock(type: unknown): boolean {
    return ['text', 'thinking', 'tool', 'json', 'audio', 'image', 'file', 'embedding']
      .includes(String(type));
  }

  /** Groups tool calls for dispatch: consecutive read-only calls run together,
   *  a mutating call runs alone. The wire shape is an array of tool blocks
   *  precisely so this is possible. */
  #groups(calls: Dict[]): Dict[][] {
    const groups: Dict[][] = [];
    let current: Dict[] = [];
    for (const call of calls) {
      const spec = this.#tools.get(String(call.name));
      if (spec?.mutates) {
        if (current.length > 0) { groups.push(current); current = []; }
        groups.push([call]);
        continue;
      }
      current.push(call);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  #dispatchTools(label: string | undefined, key: string, loop: Loop, kind: string,
                 args: Dict, calls: Dict[]): void {
    const groups = this.#groups(calls);
    const results: Dict[] = [];

    const runGroup = (gi: number): void => {
      if (gi >= groups.length) {
        for (const r of results) loop.messages = [...loop.messages, r];
        return this.#turn(label, key, loop, kind, args);
      }
      const group = groups[gi];
      const names = group.map((c) => String(c.name));
      let pending = group.length;
      const done = (): void => {
        if (--pending === 0) {
          this.dispatchGroups.push(names);
          runGroup(gi + 1);
        }
      };
      for (const call of group) this.#runTool(key, loop, call, results, done);
    };
    runGroup(0);
  }

  #runTool(key: string, loop: Loop, call: Dict, results: Dict[], done: () => void): void {
    const id = String(call.id ?? 'call_0');
    const name = String(call.name ?? '');
    const argsIn = (call.arguments ?? {}) as Dict;
    this.transcript.push({ kind: 'tool_call', name, arguments: argsIn });

    const answer = (content: Dict, status: string): void => {
      this.#emit(key, 'tool', { id, name, status }, false);
      this.transcript.push({ kind: 'tool_result', id });
      results.push({ role: 'tool', tool_call_id: id, content });
      done();
    };

    // A tool may not call the model that is running it. Refused typed rather
    // than self-deadlocking under single-flight; governor-scheduled nesting is
    // a later relaxation, never a v1 accident.
    if (name === 'intelligence' || name.startsWith('intelligence.')) {
      return answer({ error: 'tool_self_call' }, 'refused');
    }
    const spec = this.#tools.get(name);
    if (!spec) return answer({ error: 'tool_unknown' }, 'unknown');

    const dispatch = (): void => {
      if (spec.hangs) {
        // A hung page callback or MCP server must not stall the loop: the
        // deadline turns it into a typed answer the model can react to.
        this.#emit(key, 'tool', { id, name, arguments: argsIn, status: 'ready' }, false);
        this.#park({
          id,
          kind: 'deadline',
          dueAt: this.#now + (spec.deadline_ms ?? 30000),
          resume: () => answer({ error: 'tool_timeout' }, 'timeout'),
        });
        return;
      }
      this.#emit(key, 'tool', { id, name, arguments: argsIn, status: 'ready' }, false);
      if (spec.mutates) {
        // Execution runs inside a savepoint with a pre-write snapshot, so a
        // failure unwinds atomically and there is always a backup from before
        // the agent touched anything.
        this.snapshotBeforeWrite = true;
        if (this.#writesSeen === 0) this.snapshotBeforeFirstWrite = true;
        this.#writesSeen++;
        if (this.#approvalSeen) this.dispatchedAfterApproval = true;
      }
      if (spec.fails) return answer({ error: 'tool_failed' }, 'failed');
      this.dispatched.push({ name, arguments: argsIn, ...(spec.source ? { source: spec.source } : {}) });
      answer(spec.returns ?? { ok: true }, 'done');
    };

    // A `mutates` tool is approval-gated regardless of which source offered it,
    // and a description that says otherwise changes nothing.
    if (spec.mutates && spec.approval === 'prompt') {
      this.#emit(key, 'tool', { id, name, arguments: argsIn, status: 'awaiting_approval' }, false);
      this.#park({
        id,
        kind: 'approval',
        dueAt: this.#now + (spec.approval_timeout_ms ?? Number.MAX_SAFE_INTEGER),
        resume: (outcome) => {
          this.transcript.push({ kind: 'approval', id, decision: outcome });
          if (outcome === 'approve') {
            this.#approvalSeen = true;
            this.#emit(key, 'tool', { id, name, status: 'approved' }, false);
            return dispatch();
          }
          if (outcome === 'deny') return answer({ error: 'tool_denied' }, 'denied');
          return answer({ error: 'approval_timeout' }, 'timeout');
        },
      });
      return;
    }
    dispatch();
  }

  #park(p: ParkedTool): void {
    // Nothing is held while a tool is parked: no engine request, no write lock.
    // An unrelated app write and an unrelated completion both proceed, which is
    // the difference between asking a human and wedging the app.
    this.#parked.push(p);
  }

  approve(id: string, decision: 'approve' | 'deny'): void {
    const i = this.#parked.findIndex((p) => p.id === id && p.kind === 'approval');
    if (i < 0) return;
    const [p] = this.#parked.splice(i, 1);
    p.resume(decision);
  }

  tick(ms: number): void {
    this.#now += ms;
    for (;;) {
      const i = this.#parked.findIndex((p) => p.dueAt <= this.#now);
      if (i < 0) return;
      const [p] = this.#parked.splice(i, 1);
      p.resume('timeout');
    }
  }

  cancel(labelOrTarget: string): void {
    const rid = this.ridOf[labelOrTarget];
    if (rid === undefined) return;
    this.engine.cancel(rid);
    const loop = this.#loops.get(labelOrTarget);
    if (loop) this.#loops.delete(labelOrTarget);
    if (this.engine.hasLive(rid)) this.engine.resume(rid);
    // A cancelled request still settles: no orphaned stream, no silent
    // truncation, and nothing dispatched afterwards.
    if (!this.events.some((e) => e.req === labelOrTarget && e.final)) {
      this.#emit(labelOrTarget, 'complete', { cancelled: true }, true);
    }
  }

  resync(target: string): void {
    const rid = this.ridOf[target];
    if (rid === undefined) return;
    this.engine.resync(rid);
    this.engine.resume(rid);
  }

  // --- providers, remote, base, mcp ------------------------------------

  #providerCall(label: string | undefined, chain: string, action: string, args: Dict,
                provider: { row: Dict; spec: ProviderRow }, mode: string): void {
    if (!provider.row.available) {
      return void this.#absence(label, action, 'not_available', {
        reason: 'engine_not_carried',
        data: { engine: provider.spec.engine },
      });
    }
    const model = args.model ? String(args.model) : this.installed[0];
    if (args.language) {
      // A request no installed voice serves is a missing asset, not a failure
      // of speech: the answer names the language and what WOULD serve it.
      const want = String(args.language);
      const serving = this.entryOrder.filter((id) => (this.entries.get(id)?.languages ?? []).includes(want));
      const installedServing = serving.filter((id) => this.installed.includes(id));
      if (installedServing.length === 0) {
        return void this.#absence(label, action, 'no_voice_for_language', {
          data: { language: want, available: serving },
        });
      }
    }
    if (!model) return void this.#absence(label, action, 'no_model_available', { reason: 'none_installed' });
    const rid = this.#nextRid();
    const key = label ?? `#${rid}`;
    this.ridOf[key] = rid;
    this.#ensureLoaded(model);
    const entry = this.entries.get(model) ?? { id: model };
    this.#runTurns(label, key, {
      label: key, rid, model, entry, messages: [], toolNames: [], depth: 0,
      settle: null, reject: null,
    }, action, args);
  }

  #runRemote(label: string | undefined, key: string, args: Dict): void {
    const remote = this.table.remote ?? {};
    // No credential ships in the app: the app's own backend holds the keys, and
    // there is no Despia endpoint for this to point at.
    this.remoteRequests.push({
      endpoint: remote.endpoint,
      dialect: remote.dialect,
      hasCredential: false,
    });
    const mock = this.spec.remoteMock ?? {};
    if (mock.error) {
      this.errors.push({ req: key, code: String(mock.error.code ?? 'remote_failed'), message: mock.error.message });
      if (label) this.results[label] = { error: mock.error };
      return;
    }
    const snapshot: Dict[] = [];
    let seq = 0;
    for (const step of mock.script ?? []) {
      if ('token' in step) {
        const delta = { type: 'text', text: String(step.token) };
        this.#emit(key, 'token', { seq: seq++, delta }, false);
        const last = snapshot[snapshot.length - 1];
        if (last && last.type === 'text') last.text += delta.text;
        else snapshot.push({ ...delta });
      }
    }
    const data = { snapshot };
    this.#emit(key, 'complete', data, true);
    if (label) this.results[label] = data;
  }

  /** The minimal store the ai corpus needs to prove that a pending approval
   *  holds no write lock. Despia Local proper is OpenSource/Local - this is not
   *  it, and W-BASE replaces it with the real binding. */
  #baseCall(label: string | undefined, action: string, args: Dict): void {
    if (action === 'put') {
      this.#store.set(`${args.store}/${args.key}`, args.value as Dict);
      if (label) this.results[label] = { ok: true };
      return;
    }
    if (action === 'get') {
      const v = this.#store.get(`${args.store}/${args.key}`) ?? null;
      if (label) this.results[label] = { value: v };
      return;
    }
    if (label) this.results[label] = { ok: true };
  }

  #mcpCall(label: string | undefined, action: string, args: Dict): void {
    const servers = this.spec.mcpServers ?? [];
    if (action === 'connect') {
      const name = String(args.server ?? '');
      const server = servers.find((s) => s.name === name);
      // The app's manifest and config are the allowlist: a model cannot talk
      // the app into a new network peer.
      if (!server) {
        return void this.#absence(label, action, 'server_not_declared', { data: { server: name } });
      }
      if (server.unreachable) {
        // Degradation is per-server: this one's tools are absent, everyone
        // else's keep working.
        this.errors.push({ req: label, code: 'server_unreachable', data: { server: name } });
        return;
      }
      this.#connectedServers.add(name);
      this.mcpConnectCount++;
      for (const t of server.tools ?? []) {
        // Namespaced by server, so two servers offering `search` never
        // collide and the model sees two distinct tools.
        const namespaced = `mcp.${name}.${t.name}`;
        this.#tools.set(namespaced, { ...t, name: namespaced, source: 'mcp', server: name });
      }
      if (label) this.results[label] = { ok: true };
      return;
    }
    if (action === 'server.tools') {
      const tools = (this.spec.servedRows ?? []).map((row) => ({
        name: row.action,
        description: row.description,
        inputSchema: row.fromArgs ? deriveSchema(row.fromArgs) : { type: 'object' },
        ...(row.mutates ? { mutates: row.mutates } : {}),
      }));
      if (label) this.results[label] = { tools };
      return;
    }
    if (action === 'server.start') {
      this.#serverStarted = true;
      // Loopback only, and the token is the boundary rather than the
      // interface: on-device loopback is reachable by co-resident apps, so it
      // never rides in a URL.
      this.boundLoopbackOnly = true;
      this.tokenInUrl = false;
      if (label) this.results[label] = { ok: true, port: 0 };
      return;
    }
    if (action === 'server.consent') {
      this.#externalConsent = Boolean(args.external);
      this.discoveryFile = this.#externalConsent
        ? {
            mode: '0600',
            hasPort: true,
            tokenDistinctFromSession: this.#discoveryToken !== this.#sessionToken,
            removedAfterWithdrawal: false,
          }
        : { ...(this.discoveryFile ?? {}), removedAfterWithdrawal: true };
      if (label) this.results[label] = { ok: true };
      return;
    }
    if (label) this.results[label] = { ok: true };
  }

  serverRequest(step: Dict): void {
    const label = String(step.as ?? '');
    const raw = step.token;
    const token = raw === '$session.token' ? this.#sessionToken
      : raw === '$discovery.token' ? (this.#externalConsent ? this.#discoveryToken : 'stale')
      : raw;
    const valid = token === this.#sessionToken ||
                  (token === this.#discoveryToken && this.#externalConsent);
    if (!this.#serverStarted || !valid) {
      this.serverResponses.push({ req: label, code: 'unauthorized' });
      return;
    }
    const row = (this.spec.servedRows ?? []).find((r) => r.action === String(step.tool));
    if (!row) {
      this.serverResponses.push({ req: label, code: 'unknown_tool' });
      return;
    }
    if (row.mutates && row.approval === 'prompt') {
      // The protocol is not a bypass: a write requested over MCP waits for
      // approval and runs inside a snapshot, exactly like an in-app one.
      this.#park({
        id: label,
        kind: 'approval',
        dueAt: Number.MAX_SAFE_INTEGER,
        resume: (outcome) => {
          if (outcome === 'approve') {
            this.snapshotBeforeWrite = true;
            this.#approvalSeen = true;
            this.dispatchedAfterApproval = true;
            this.serverResponses.push({ req: label, ok: true });
          } else {
            this.serverResponses.push({ req: label, code: 'tool_denied' });
          }
        },
      });
      return;
    }
    this.serverResponses.push({ req: label, ok: true });
  }

  // --- plumbing --------------------------------------------------------

  #ridSeq = 0;
  #nextRid(): number {
    return ++this.#ridSeq;
  }

  #emit(req: string, event: string, data: Dict, final: boolean): void {
    this.events.push({ req, event, final, data });
  }
}
