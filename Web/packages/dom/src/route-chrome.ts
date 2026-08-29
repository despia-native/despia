//
//  route-chrome.ts — the DOM-free ownership half of the web system navigation bar.
//  A screen's NavBar claim is keyed by its opaque router frame id, never delivery
//  order or "whatever is top now". This is the web twin of Router.swift/.kt's
//  `__frame` targeting contract.
//

export function frameId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function chromeBackVisibility(navigationDepth: number, split: boolean): "visible" | "hidden" {
  return navigationDepth > 1 && !split ? "visible" : "hidden";
}

export class FrameChromeClaims<T> {
  private readonly claims = new Map<number, T>();

  /** A stamped call targets its exact live frame. An unstamped public JS call keeps
   *  the legacy behavior and targets the current top navigation frame. */
  target(liveFrames: readonly number[], stamped: unknown): number | null {
    const id = frameId(stamped);
    if (id !== null) return liveFrames.includes(id) ? id : null;
    return liveFrames[liveFrames.length - 1] ?? null;
  }

  claim(liveFrames: readonly number[], stamped: unknown, value: T): number | null {
    const id = this.target(liveFrames, stamped);
    if (id !== null) this.claims.set(id, value);
    return id;
  }

  release(liveFrames: readonly number[], stamped: unknown): number | null {
    const id = this.target(liveFrames, stamped);
    if (id !== null) this.claims.delete(id);
    return id;
  }

  /** Prune popped frames and return the top frame's claim, if it owns one. */
  active(liveFrames: readonly number[]): T | undefined {
    const live = new Set(liveFrames);
    for (const id of this.claims.keys()) if (!live.has(id)) this.claims.delete(id);
    const top = liveFrames[liveFrames.length - 1];
    return top === undefined ? undefined : this.claims.get(top);
  }

  /** The claim of the frame directly beneath the top - the Back destination - so the
   *  chrome can label its back affordance with the previous screen's title. */
  covered(liveFrames: readonly number[]): T | undefined {
    const beneath = liveFrames[liveFrames.length - 2];
    return beneath === undefined ? undefined : this.claims.get(beneath);
  }
}
