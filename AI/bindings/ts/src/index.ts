// index.ts - the TypeScript face of Despia AI.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// v1 ships TYPES and the MockEngine port, not browser inference. That is a
// deliberate non-goal: wasm and WebGPU inference is a real project and shipping
// a shell under the Despia name before it works would be the kind of overclaim
// this package is built to avoid. The package stays `private: true` until a
// real consumer exists, so the face is disciplined the day it does.
//
// What it IS good for today: running the conformance corpus per-PR on a lane
// with no native toolchain, and typing a host that talks to the real engine.

export * from './types.ts';
export { Engine } from './engine.ts';
export type { EngineOptions, MockModel, ScriptStep } from './engine.ts';
export { fit, meetsFloor, memoryLimitMb } from './fit.ts';
export type { DeviceProfile, FitPolicy } from './fit.ts';
export { route } from './router.ts';
export type { Decision, RouterTable } from './router.ts';
export { Host, TOOL_DEPTH_CAP } from './host.ts';
export type { CaseSpec, ProviderRow, ToolSpec } from './host.ts';
