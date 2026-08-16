//
//  logs.ts - the DSX log system's kernel core: the structured LOG RING behind `dsx.log`
//  (OpenSource/Conformance/logs/logs.json — the unified console primitive), plus the
//  JSERedact twin (the credential-masking contract shared with Stack.swift / Globals.kt).
//  TS twin of Engine/iOS/Logs.swift and Engine/Android core Logs.kt.
//
//  `dsx.log` is `console.log` with a home: one formatted line per call, attributed to its
//  source scheme, recorded here (ring, cap 500, always on — appending is nanoseconds and
//  programs, not just testers, read it via `dsx.logs`), and mirrored to the platform
//  console. Logs are NOT errors: nothing here touches the error ledger, the hooks, or the
//  reactive `global.dsx.*` keys. Near-leaf module by design — imports only jse/values.ts,
//  so the console builtin (jse/core.ts), the runner, and the bus can all feed it without
//  cycles.
//

import { isDict } from "./jse/values.ts";

/** One recorded log line — source scheme + console level + the formatted message. */
export type DSXLogEntry = {
  /** the SOURCE: a package scheme, "app" (unscoped markup), "console" (the console.*
   *  builtin), or "page" (the DSXWebView page / the kernel `dsx.log` bus verb) */
  scheme: string;
  /** "log" for dsx.log; the console.* builtin records its own level */
  level: string;
  message: string;
  at: number;
};

class DSXLogBufferImpl {
  static readonly cap = 500;
  private entries: DSXLogEntry[] = [];
  private total = 0;

  append(e: DSXLogEntry): void {
    this.entries.push(e);
    this.total += 1;
    if (this.entries.length > DSXLogBufferImpl.cap) {
      this.entries.splice(0, this.entries.length - DSXLogBufferImpl.cap);
    }
  }
  /** the retained tail, oldest → newest (snapshot) */
  recent(): DSXLogEntry[] { return [...this.entries]; }
  /** monotonic count of every line ever recorded (survives ring eviction) */
  count(): number { return this.total; }
  /** dev tooling only — drops the retained tail (the monotonic count stays) */
  clear(): void { this.entries = []; }
}

export const DSXLogs = new DSXLogBufferImpl();

/** Record one log line: the ring + one browser-console mirror line (the web's
 *  Xcode/logcat analogue). Never throws; message arrives pre-formatted (the house
 *  coercions — see formatLogArgs in jse/core.ts). */
export function reportLog(scheme: string, level: string, message: string): void {
  DSXLogs.append({ scheme, level, message, at: Date.now() });
  const line = `[dsx.log] ${scheme}: ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Log redaction — any value whose KEY looks like a credential masks to "•••" before it
 *  reaches console/log output. Applied recursively to dicts/arrays at serialization time —
 *  the live values in the store are untouched. The key list is part of the cross-platform
 *  contract (identical in Stack.swift / Globals.kt; pinned by the logs corpus). */
export const JSERedact = {
  sensitive: ["token", "secret", "password", "passwd", "authorization",
              "cookie", "apikey", "api_key", "api-key", "bearer",
              "credential", "session_id", "sessionid", "private_key", "privatekey"],
  isSensitive(key: string): boolean {
    const k = key.toLowerCase();
    return this.sensitive.some((s) => k === s || k.endsWith("_" + s) || (k.endsWith(s) && s.length > 5));
  },
  mask(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((e) => this.mask(e));
    if (isDict(v)) {
      const out: { [k: string]: unknown } = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = this.isSensitive(k) ? "•••" : this.mask(val);
      }
      return out;
    }
    return v;
  },
};
