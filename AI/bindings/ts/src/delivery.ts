// delivery.ts - the four locks that make arbitrary-origin models a feature.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// An app may allow ANY model URL (local-ai-engine.md §4.4, D16). That is the
// feature and the attack surface in the same sentence, so four locks apply to
// every model regardless of where it came from:
//
//   1. An ORIGIN ALLOWLIST the app declares. https only, wildcard subdomains
//      supported, and EMPTY MEANS NOTHING - fail closed, or the lock is opt-out
//      and therefore not a lock.
//   2. DIGEST DISCIPLINE. A declared digest verifies as always; an undeclared
//      one is pinned on first download and verified forever after. Verification
//      happens before the engine sees the file, and a mismatch DELETES it -
//      keeping a failed file is how a mismatch becomes a load next launch.
//   3. The PRE-FLIGHT VALIDATOR (engine/src/preflight.hpp). A digest only says
//      the bytes are the bytes someone named; it says nothing about whether
//      they are a model.
//   4. FIT and QUARANTINE, unchanged (fit.ts).
//
// This file owns locks 1 and 2 and calls into 3. Nothing here is engine work:
// delivery is policy, and policy lives in the host.

import type { Dict } from './types.ts';

export type DeliveryPolicy = {
  /** Hosts this app trusts. https only. Empty allows nothing. */
  allowed_model_hosts?: string[];
};

/** What an origin serves, for cases and for the mock transport. A real
 *  implementation replaces this with the platform's background downloader; the
 *  DECISIONS around it are what the corpus pins. */
export type OriginResponse = {
  sha256?: string;
  gguf?: boolean;
  unreachable?: boolean;
  /** The GGUF metadata table a RANGED read of this file's first bytes returns.
   *  On device the engine's pre-flight walk produces it; here a fixture does,
   *  which is what lets "the file outranks the API" be proven with no network
   *  and no model. */
  header?: { [key: string]: number | string };
  /** A registry API URL answers with the repo document instead. UNTRUSTED. */
  repo?: Dict;
};

export type DownloadOutcome =
  | { ok: true; sha256: string; url: string; pinned?: boolean }
  | { ok: false; code: string; data?: Dict };

/** The DevSettings wildcard-host grammar, applied to model origins.
 *
 *  `*.example.com` matches a SUBDOMAIN and not the apex, and never matches a
 *  host that merely ends with the same letters - `notexample.com` is a
 *  different domain, and treating it as a match is the classic suffix bug. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === host) return true;
    if (!pattern.startsWith('*.')) return false;
    const suffix = pattern.slice(1);            // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}

/** Lock 1. Returns null when the URL is allowed, or the refusal reason. */
export function checkOrigin(url: string, policy: DeliveryPolicy): Dict | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { code: 'origin_not_allowed', data: { reason: 'malformed_url', url } };
  }
  if (parsed.protocol !== 'https:') {
    // Plaintext would let anyone on the path swap the bytes, and the digest is
    // checked after the transfer rather than during it.
    return { code: 'origin_not_allowed', data: { reason: 'insecure_scheme', host: parsed.hostname } };
  }
  const patterns = policy.allowed_model_hosts ?? [];
  if (!hostAllowed(parsed.hostname, patterns)) {
    return { code: 'origin_not_allowed', data: { host: parsed.hostname } };
  }
  return null;
}

export type DeliveryDeps = {
  policy: DeliveryPolicy;
  /** Digests already pinned on this device, by model id. */
  pinned: Map<string, string>;
  /** Fetches a URL. Returns undefined for an unreachable origin. */
  fetch: (url: string) => OriginResponse | undefined;
  /** Records that a downloaded file was deleted after failing a check. */
  onDelete: (model: string) => void;
  /** Every URL actually requested, in order. */
  onAttempt: (url: string) => void;
};

/**
 * Runs locks 1 to 3 for one catalog entry and reports what happened.
 *
 * The mirror list is tried in order: one host being down is not an outage, and
 * a mirror is not a trust shortcut - whichever URL answers, the same digest and
 * the same pre-flight parse apply.
 */
export function deliver(entry: Dict, deps: DeliveryDeps): DownloadOutcome {
  const file = (entry.files ?? [])[0] as Dict | undefined;
  if (!file) return { ok: false, code: 'no_files', data: { model: entry.id } };

  const urls: string[] = Array.isArray(file.urls) ? file.urls : [];
  if (urls.length === 0) return { ok: false, code: 'no_files', data: { model: entry.id } };

  // Lock 1 first, and BEFORE any request goes out. A refusal that has already
  // contacted the host has told it the app exists, which is most of what an
  // unwanted origin wanted.
  for (const url of urls) {
    const refusal = checkOrigin(url, deps.policy);
    if (refusal) return { ok: false, code: refusal.code, data: refusal.data };
  }

  const declared = typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : undefined;
  const pinned = deps.pinned.get(String(entry.id));
  const expected = declared ?? pinned;

  let lastFailure: DownloadOutcome = { ok: false, code: 'download_failed', data: { model: entry.id } };
  for (const url of urls) {
    deps.onAttempt(url);
    const response = deps.fetch(url);
    if (!response || response.unreachable) {
      lastFailure = { ok: false, code: 'download_failed', data: { model: entry.id, url } };
      continue;   // the next mirror
    }

    const actual = String(response.sha256 ?? '').toLowerCase();

    // Lock 2. Verified BEFORE the engine ever sees the file.
    if (expected && actual !== expected) {
      deps.onDelete(String(entry.id));
      return {
        ok: false,
        code: 'digest_mismatch',
        data: {
          model: entry.id,
          expected,
          actual,
          ...(declared ? {} : { reason: 'pinned_on_first_download' }),
        },
      };
    }

    // Lock 3. The digest says the bytes are the bytes someone named; it says
    // nothing about whether they are a model.
    if (response.gguf === false) {
      deps.onDelete(String(entry.id));
      return { ok: false, code: 'format_unrecognized', data: { model: entry.id } };
    }

    if (!expected) {
      // No declared digest: this is a bring-your-own model, so the first
      // download PINS one and every later fetch is verified against it.
      deps.pinned.set(String(entry.id), actual);
      return { ok: true, sha256: actual, url, pinned: true };
    }
    return { ok: true, sha256: actual, url };
  }
  return lastFailure;
}
