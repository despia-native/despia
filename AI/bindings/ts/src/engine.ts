// engine.ts - the TS engine facade and the MockEngine port.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is the SUBORDINATE port. The authority is the C++ mock behind the C ABI
// (OpenSource/AI/mock/mock_backend.cpp), which the Swift and Kotlin lanes load;
// this file exists so the web lane can run the same fixtures per-PR without a
// native toolchain. If the two ever disagree, the C++ one is right and this one
// is the bug - which is why both are gated by the same corpus.
//
// The split it implements is the one that matters architecturally: the ENGINE
// streams typed blocks and knows nothing about tools, routing, fit or
// approvals. Those are the HOST's, because they are policy (see host.ts).

import { ABI_VERSION, SCHEMA_VERSION } from './types.ts';
import type { Block, Capabilities, Dict, EngineRequest, Envelope } from './types.ts';

export type ScriptStep = Dict;

export type MockModel = {
  script?: ScriptStep[];
  turns?: ScriptStep[][];
  everyTurn?: ScriptStep[];
  load?: { error?: { code?: string } };
};

export type EngineOptions = {
  /** What this build reports. A case that narrows it is testing that
   *  consumers adapt rather than assume. */
  capabilities?: Partial<Capabilities>;
  /** false = no engine in this build at all (the typed-absence cases). */
  present?: boolean;
  abi?: number;
};

const DEFAULT_CAPABILITIES: Capabilities = {
  schema_version: SCHEMA_VERSION,
  abi: ABI_VERSION,
  engines: ['gguf', 'mock'],
  formats: ['gguf', 'mock'],
  modalities: ['text', 'embedding'],
  dialects: ['hermes-json'],
  features: ['gbnf', 'structured-output', 'tools'],
  limits: { max_parallel: 1 },
};

export type EngineEvent = Envelope;

type Live = {
  id: number;
  cancelled: boolean;
  paused: boolean;
  seq: number;
  snapshot: Block[];
  emit: (e: EngineEvent) => void;
  resume: (() => void) | null;
};

export class Engine {
  capabilities: Capabilities;
  present: boolean;
  /** Every request that reached the seam, in order. The corpus asserts on this
   *  because it is how routing, schema derivation and structured output are
   *  proven without reaching into the engine. */
  requests: EngineRequest[] = [];

  #models = new Map<string, { entry: Dict; mock: MockModel; turn: number }>();
  #live = new Map<number, Live>();
  #nextId = 1;

  constructor(options: EngineOptions = {}) {
    this.present = options.present !== false;
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(options.capabilities ?? {}),
      schema_version: SCHEMA_VERSION,
      abi: options.abi ?? options.capabilities?.abi ?? ABI_VERSION,
    };
  }

  loadModel(entry: Dict, mock: MockModel | undefined): { ok: boolean; error?: string } {
    if (mock?.load?.error) return { ok: false, error: mock.load.error.code ?? 'load_failed' };
    this.#models.set(String(entry.id), { entry, mock: mock ?? {}, turn: 0 });
    return { ok: true };
  }

  isLoaded(id: string): boolean {
    return this.#models.has(id);
  }

  unloadModel(id: string): void {
    this.#models.delete(id);
  }

  /** Submits a request. Returns its id; events arrive on `emit` synchronously,
   *  in production order, which is the deterministic analogue of the ABI's
   *  one-worker-per-context rule. */
  request(req: EngineRequest, emit: (e: EngineEvent) => void): number {
    const id = this.#nextId++;
    this.requests.push(req);
    const live: Live = {
      id,
      cancelled: false,
      paused: false,
      seq: 0,
      snapshot: [],
      emit,
      resume: null,
    };
    this.#live.set(id, live);
    this.#run(live, req);
    return id;
  }

  /** Legal at any time, including from inside an event handler - the ABI's
   *  reentrancy whitelist, honoured here so the fixtures exercise the same
   *  shape a native consumer will. */
  cancel(id: number): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    live.cancelled = true;
    if (live.paused) this.#settle(live, { cancelled: true });
    return true;
  }

  /** An on-demand full-snapshot resync for a paused (in-flight) request. */
  resync(id: number): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    this.#emit(live, 'sync', {
      seq: Math.max(0, live.seq - 1),
      snapshot: structuredClone(live.snapshot),
    }, false);
    return true;
  }

  /** Lets a paused script continue - how a case drives "something happened
   *  mid-stream" without a timer. */
  resume(id: number): void {
    const live = this.#live.get(id);
    if (!live || !live.resume) return;
    const go = live.resume;
    live.resume = null;
    live.paused = false;
    go();
  }

  hasLive(id: number): boolean {
    return this.#live.has(id);
  }

  #run(live: Live, req: EngineRequest): void {
    const model = this.#models.get(String(req.model));
    if (!model) {
      this.#emit(live, 'error', { code: 'unknown_model', message: `model '${req.model}' is not loaded` }, true);
      this.#live.delete(live.id);
      return;
    }

    const turns = model.mock.turns
      ? model.mock.turns
      : model.mock.everyTurn
        ? [model.mock.everyTurn]
        : model.mock.script
          ? [model.mock.script]
          : [[]];
    const repeat = Boolean(model.mock.everyTurn);
    const index = repeat ? 0 : Math.min(model.turn, turns.length - 1);
    if (!repeat) model.turn++;

    const steps = turns[index] ?? [];
    let i = 0;
    const step = (): void => {
      for (; i < steps.length; i++) {
        if (live.cancelled) {
          this.#settle(live, { cancelled: true });
          return;
        }
        const s = steps[i];
        if ('token' in s) {
          this.#block(live, { type: 'text', text: String(s.token) });
        } else if ('thinking' in s) {
          this.#block(live, { type: 'thinking', text: String(s.thinking) });
        } else if ('tool' in s) {
          this.#block(live, { type: 'tool', ...(s.tool as Dict) });
        } else if ('block' in s) {
          this.#block(live, s.block as Block);
        } else if ('sync' in s) {
          this.#emit(live, 'sync', {
            seq: Math.max(0, live.seq - 1),
            snapshot: structuredClone(live.snapshot),
          }, false);
        } else if ('pause' in s) {
          // Suspend here. The host's next step lands while this request is
          // genuinely in flight, with no sleeps and no scheduling races.
          i++;
          live.paused = true;
          live.resume = step;
          return;
        } else if ('error' in s) {
          const e = s.error as Dict;
          this.#emit(live, 'error', {
            code: String(e.code ?? 'engine_failed'),
            message: e.message,
            snapshot: structuredClone(live.snapshot),
          }, true);
          this.#live.delete(live.id);
          return;
        } else if ('complete' in s) {
          this.#settle(live, (s.complete as Dict) ?? {});
          return;
        }
      }
      this.#settle(live, {});
    };
    step();
  }

  #block(live: Live, block: Block): void {
    // Accumulate FIRST, then emit. A consumer may ask for a resync from inside
    // this callback, and a snapshot missing the token it was just handed would
    // silently lose it for a late joiner.
    const last = live.snapshot[live.snapshot.length - 1];
    if ((block.type === 'text' || block.type === 'thinking') && last && last.type === block.type) {
      last.text = String(last.text ?? '') + String(block.text ?? '');
    } else {
      live.snapshot.push(structuredClone(block));
    }
    live.seq++;
    // The delta goes out alone; the snapshot stays here. A token event never
    // carries what came before it, which is what keeps a long generation
    // linear over the bridge instead of quadratic.
    this.#emit(live, 'token', { seq: live.seq - 1, delta: block }, false);
  }

  #settle(live: Live, extra: Dict): void {
    if (!this.#live.has(live.id)) return;
    this.#live.delete(live.id);
    this.#emit(live, 'complete', {
      ...extra,
      snapshot: structuredClone(live.snapshot),
      ...(live.cancelled ? { cancelled: true } : {}),
    }, true);
  }

  #emit(live: Live, event: EngineEvent['event'], data: Dict, final: boolean): void {
    live.emit({ schema_version: SCHEMA_VERSION, id: live.id, event, final, data });
  }
}
