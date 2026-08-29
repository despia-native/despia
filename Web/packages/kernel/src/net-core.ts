//
//  net-core.ts — the shared Core/Net core: the classification fold, the online split, the
//  radio-family map, the probe verdict and the transition debounce. The law is the corpus,
//  OpenSource/Conformance/net/{status,transitions}.json (parity/F05-net.md); the Kotlin twin is
//  :core NetCore.kt and the Swift twin is Engine/iOS/NetCore.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. NWPathMonitor (iOS),
//  ConnectivityManager.registerDefaultNetworkCallback (Android) and navigator.connection (web)
//  each read their own platform and hand the neutral snapshot in; the module publishes the
//  context vars and fires the `change` broadcast on the way out. Keeping the DECISION separate
//  from the PLUMBING is what lets one corpus judge three renderers.
//

/** The reported link vocabulary. `unknown` is the pre-first-update value only. */
export const NET_TYPES: readonly string[] = [
  "wifi", "cellular", "ethernet", "vpn", "other", "none", "unknown",
];

/** Interface-name prefixes that mean "this is a tunnel". A VPN rides ON TOP of wifi or
 *  cellular, so reporting the transport underneath would hide the thing the app asked about. */
export const NET_TUNNEL_PREFIXES: readonly string[] = ["utun", "ipsec", "ppp", "tap", "tun"];

/**
 * The five facts a settled path carries.
 *
 * `validated` is Android's own captive-portal verdict (NET_CAPABILITY_VALIDATED). It is true on
 * every other renderer, where only an explicit `probe()` can learn the same thing, so the field
 * costs nothing there and keeps `online` one expression everywhere.
 */
export interface NetSnapshot {
  readonly reachable: boolean;
  readonly type: string;
  readonly expensive: boolean;
  readonly constrained: boolean;
  readonly validated: boolean;
}

/** What the module publishes before the first path update lands: optimistic, so a page never
 *  flashes an offline banner on the way to learning the truth. */
export const NET_UNKNOWN: NetSnapshot = {
  reachable: true, type: "unknown", expensive: false, constrained: false, validated: true,
};

/** One raw platform path snapshot, in the neutral shape all three renderers can produce. */
export interface NetPathInput {
  readonly satisfied: boolean;
  readonly interfaces?: readonly string[];
  readonly transports?: readonly string[];
  readonly metered?: boolean;
  readonly dataSaver?: boolean;
}

function isTunnel(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return NET_TUNNEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The classification fold: a raw path snapshot in, the reported link facts out.
 *
 *   1. VPN wins over the transport underneath (a tunnel rides on top of wifi or cellular).
 *   2. An unsatisfied path is `none` and nothing else is inspected — a metered flag on a link
 *      that is down is not a fact about anything.
 *   3. `expensive` is the METERED flag, never `type === "cellular"`: a personal hotspot over
 *      wifi is metered, and cellular on an unlimited plan is not.
 *   4. `constrained` is the user's data-saving setting and is independent of everything else.
 */
export function classifyPath(input: NetPathInput): NetSnapshot {
  if (!input.satisfied) {
    return { reachable: false, type: "none", expensive: false, constrained: false, validated: false };
  }
  const interfaces = input.interfaces ?? [];
  const transports = (input.transports ?? []).map((entry) => String(entry ?? "").trim().toLowerCase());
  let type: string;
  if (interfaces.some(isTunnel) || transports.includes("vpn")) type = "vpn";
  else if (transports.includes("wifi")) type = "wifi";
  else if (transports.includes("cellular")) type = "cellular";
  else if (transports.includes("ethernet")) type = "ethernet";
  else type = "other";
  return {
    reachable: true,
    type,
    expensive: input.metered === true,
    constrained: input.dataSaver === true,
    validated: true,
  };
}

/** `online` is `reachable` AND the last probe verdict — the entire reason the two fields exist
 *  separately. An interface can be up while a captive portal eats every request. */
export function isOnline(snapshot: NetSnapshot, probeFailed: boolean): boolean {
  return snapshot.reachable && snapshot.validated && !probeFailed;
}

/** Radio family token -> reported generation. The module normalises its own platform constant
 *  (CTRadioAccessTechnologyLTE, TelephonyManager.NETWORK_TYPE_LTE, connection.effectiveType)
 *  down to one of these tokens; anything unrecognised reports empty rather than a guess. */
const RADIO_FAMILIES: { readonly [token: string]: string } = {
  gprs: "2g", edge: "2g", cdma: "2g", cdma1x: "2g", "1xrtt": "2g", iden: "2g", gsm: "2g",
  wcdma: "3g", umts: "3g", hsdpa: "3g", hsupa: "3g", hspa: "3g", hspap: "3g",
  evdo0: "3g", evdoa: "3g", evdob: "3g", cdmaevdorev0: "3g", cdmaevdoreva: "3g",
  cdmaevdorevb: "3g", ehrpd: "3g", tdscdma: "3g",
  lte: "4g", iwlan: "4g",
  nr: "5g", nrnsa: "5g",
};

/** Empty unless the link is cellular AND the platform volunteered the family without a
 *  permission prompt. A withheld family is empty, never a guess. */
export function radioGeneration(type: string, radio: string | null | undefined): string {
  if (type !== "cellular") return "";
  const token = String(radio ?? "").trim().toLowerCase();
  if (token === "") return "";
  return RADIO_FAMILIES[token] ?? "";
}

/** The host a redirect points at, or null when the Location names none (which includes a
 *  relative Location, whose host is by definition the requested one). */
function redirectHost(location: string): string | null {
  const marker = location.indexOf("://");
  if (marker < 0) return null;
  let rest = location.slice(marker + 3);
  const slash = rest.search(/[/?#]/);
  if (slash >= 0) rest = rest.slice(0, slash);
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1);
  // One colon is a port; several is an IPv6 literal, which keeps its colons.
  if ((rest.match(/:/g) ?? []).length === 1) {
    const colon = rest.lastIndexOf(":");
    const port = rest.slice(colon + 1);
    if (port !== "" && /^[0-9]+$/.test(port)) rest = rest.slice(0, colon);
  }
  return rest.toLowerCase();
}

/**
 * The reachability verdict from ONE completed request.
 *
 * Redirects are never followed, so the response IS the 3xx and its Location is readable: a
 * redirect to another host is the captive-portal signature, while a same-host redirect (an http
 * to https upgrade) is a normal, reachable answer. 4xx and 5xx mean a server answered but the
 * app is not served, and status 0 is a dead transport — an ANSWER, never a throw.
 */
export function probeReachable(
  status: number,
  requestHost: string,
  location?: string | null,
): boolean {
  if (status < 200 || status >= 400) return false;
  if (status < 300) return true;
  const target = String(location ?? "").trim();
  if (target === "") return false;
  const host = redirectHost(target);
  if (host === null) return true;
  return host === String(requestHost ?? "").trim().toLowerCase();
}

/** One settled transition, as the debounce reports it. */
export interface NetChange {
  readonly at: number;
  readonly previous: string;
  readonly snapshot: NetSnapshot;
  readonly online: boolean;
}

export function netSnapshotsEqual(a: NetSnapshot, b: NetSnapshot): boolean {
  return a.reachable === b.reachable && a.type === b.type && a.expensive === b.expensive
    && a.constrained === b.constrained && a.validated === b.validated;
}

/**
 * The transition debounce.
 *
 * Interfaces flap: a wifi to cellular handoff drops through `none` for a few hundred
 * milliseconds, and an undebounced stream turns that into three events and two banner flashes.
 *
 *   1. The FIRST update after launch is applied immediately and announces nothing — there was
 *      no earlier state to change from, and waiting half a second to learn the truth at launch
 *      would be its own bug.
 *   2. After that a candidate must hold for `debounceMs` before it is published.
 *   3. A candidate that returns to the settled value inside the window cancels it outright, so
 *      a flap produces no event at all.
 *   4. A settled transition emits exactly ONE change, carrying the new facts plus `previous`.
 *   5. A settled transition clears the probe verdict: a new link deserves a fresh one.
 *
 * The clock is the CALLER'S. The module drives it from a real timer, the corpus runner drives
 * it from a timeline, and the machine cannot tell the difference.
 */
export class NetDebounce {
  readonly debounceMs: number;
  #settled: NetSnapshot;
  #hasSettled = false;
  #probeFailed = false;
  #pending: { candidate: NetSnapshot; deadline: number } | null = null;
  #events: NetChange[] = [];

  constructor(debounceMs: number, initial: NetSnapshot = NET_UNKNOWN) {
    this.debounceMs = Math.max(0, debounceMs);
    this.#settled = initial;
  }

  get settled(): NetSnapshot { return this.#settled; }
  get probeFailed(): boolean { return this.#probeFailed; }
  get online(): boolean { return isOnline(this.#settled, this.#probeFailed); }
  /** When the pending candidate is due, or null when nothing is pending. The module arms one
   *  timer on this; nothing else needs to know the window exists. */
  get pendingDeadline(): number | null { return this.#pending === null ? null : this.#pending.deadline; }

  /** Commit a pending candidate whose window has closed. Idempotent. */
  advance(now: number): void {
    const pending = this.#pending;
    if (pending === null || pending.deadline > now) return;
    this.#pending = null;
    if (netSnapshotsEqual(pending.candidate, this.#settled)) return;
    const previous = this.#settled.type;
    this.#settled = pending.candidate;
    this.#probeFailed = false;
    this.#events.push({
      at: pending.deadline,
      previous,
      snapshot: pending.candidate,
      online: isOnline(pending.candidate, false),
    });
  }

  /** A path update from the platform. */
  path(now: number, candidate: NetSnapshot): void {
    this.advance(now);
    if (!this.#hasSettled) {
      this.#hasSettled = true;
      this.#settled = candidate;
      this.#pending = null;
      return;
    }
    this.#pending = null;
    if (netSnapshotsEqual(candidate, this.#settled)) return;
    this.#pending = { candidate, deadline: now + this.debounceMs };
    if (this.debounceMs === 0) this.advance(now);
  }

  /** A completed probe's verdict. It moves `online` without touching the link facts, and
   *  without announcing a transition: the link did not change, only what it is worth. */
  probe(now: number, failed: boolean): void {
    this.advance(now);
    this.#probeFailed = failed;
  }

  /** Take the transitions recorded since the last drain. */
  drain(): NetChange[] {
    const out = this.#events;
    this.#events = [];
    return out;
  }
}
