// index.ts - the TypeScript face of Despia Local.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Backed by the SQLite that ships inside Node, which makes it a real
// implementation rather than a mock - useful for the conformance lane, for
// server-side tooling, and for anyone who wants the same semantics off-device.
// It stays `private: true` until there is a real consumer to publish for.

export { Local, LocalError } from './store.ts';
export type { Dict, Embedding, TypedError } from './store.ts';
