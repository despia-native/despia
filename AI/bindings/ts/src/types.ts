// types.ts - the shapes that cross the Despia AI seam.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// These mirror despia_ai.h and the conformance corpus. They are the TS face of
// one contract, not a second contract: when this file and the header disagree,
// the header is right and the fixtures are what catch it.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Dict = { [k: string]: any };

/** The schema version this build writes. Unknown fields are must-ignore in
 *  both directions, so a newer envelope is accepted for what we understand. */
export const SCHEMA_VERSION = 1;
export const ABI_VERSION = 1;

/** What a build reports about itself. Consumers ADAPT to this; they never
 *  hardcode it (local-ai-engine.md 4.2, rule 1). */
export type Capabilities = {
  schema_version: number;
  abi: number;
  version?: string;
  engines: string[];
  formats: string[];
  modalities: string[];
  dialects: string[];
  features: string[];
  limits: Dict;
};

/** A typed output block. The vocabulary is OPEN (4.14): `text`, `thinking`,
 *  `tool`, `json`, and the reference blocks `audio`, `image`, `file`,
 *  `embedding` - plus whatever a future backend emits, which an older runtime
 *  ignores with a notice rather than crashing on. Binary is ALWAYS a
 *  reference: a block carries a url, never bytes. */
export type Block = { type: string } & Dict;

/** The kernel envelope every stream event rides. */
export type Envelope = {
  schema_version: number;
  id: number;
  event: 'token' | 'sync' | 'tool' | 'routing' | 'complete' | 'error';
  final: boolean;
  data: Dict;
};

export type EngineRequest = {
  schema_version?: number;
  kind: string;
  model: string;
  priority?: 'interactive' | 'background';
  messages?: Dict[];
  tools?: Dict[];
  response_format?: Dict;
  options?: Dict;
} & Dict;

export type TypedError = { code: string; message?: string } & Dict;

/** A fit verdict. `measured` says whether the number came from this device or
 *  from a shipped prior - the difference between "should run" and "does". */
export type Verdict = {
  verdict: 'runs_well' | 'runs_slow' | 'too_big' | 'unsupported' | 'quarantined';
  reason?: string;
  decode_tps?: number;
  measured?: boolean;
  mapped_mb?: number;
  /** The footprint the memory check actually ran against, measured or
   *  estimated. It rides every verdict because "too big by how much" is the
   *  question a refusal raises. */
  footprint_mb?: number;
  /** `footprint_mb` came from a real load ON THIS DEVICE, not from the
   *  derivation. The footprint twin of `measured`. */
  footprint_measured?: boolean;
  /** A stored footprint measurement for this model on this device was DISCARDED
   *  as impossible, and the estimate was used instead. */
  footprint_rejected?: boolean;
  /** The requirements this verdict was computed against were DERIVED from a
   *  file size and a GGUF header rather than measured on a device.
   *
   *  Present on every runtime-added model and ABSENT on a shipped one, so the
   *  key answers two questions at once: `undefined` means the entry is curated,
   *  `true` means added and still estimated, `false` means added and MEASURED
   *  on this device. Only a real load turns it false - which is exactly what
   *  `footprint_measured` is, `footprint_mb` being the sole estimated number in
   *  `requirements`. Stated in both directions, like `measured`, because a
   *  fixture cannot assert a key that is not there. */
  predicted?: boolean;
};
