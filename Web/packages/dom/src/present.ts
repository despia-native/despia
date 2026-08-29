//
//  present.ts — the web presentation machine's PURE half: the ledger behind
//  `dsx.component.present` / `dismiss` on this renderer, sharing the native runtimes' exact
//  normalization + dismissal topology, pinned by the SHARED corpus
//  OpenSource/Conformance/router/present.json (the Kotlin RouterTest drives the same file
//  through a real Router; Router.swift is the reference — the three-runtime law).
//
//  THE PLANES (the host contract, all three renderers): the content stack renders under
//  every overlay; overlays stack in presentation order; the CHAIN plane (sheet / cover)
//  renders above every overlay — a drawer always covers a menu-bar overlay, regardless of
//  presentation order. On this renderer: content frames z 10+, the overlay plane z 500,
//  chain frames z 1000+ (router.ts mounts them; theme.ts carries the plane CSS).
//
//  TOUCH MODES (overlay-only): "passthrough" (default) — only the overlay's INTERACTIVE
//  content takes pointer events (buttons, inputs, scrollers — the menu-bar-over-web shape:
//  everything beside the bar stays live); "block" — the FULL overlay: the whole layer takes
//  pointer events, nothing reaches the screen beneath (the lock-screen shape). DOM
//  hit-testing differs from the native renderers (an undrawn element still captures), so
//  passthrough is expressed in CSS as pointer-events: none with interactive selectors
//  re-enabled — the same observable contract, pinned as this renderer's mechanism.
//

export type PresentEntry = {
  id: number;
  as: "sheet" | "cover" | "overlay";
  component: string;
  /** overlay-only — "block" | "passthrough" */
  touch?: "passthrough" | "block";
  /** THE component input contract (the hard-coded-markup twin) — merged by updateAttrs */
  attrs?: Dict;
};

type Dict = { [k: string]: unknown };

export class PresentLedger {
  private entries: PresentEntry[] = [];
  private seq = 0;

  list(): readonly PresentEntry[] {
    return this.entries;
  }

  /** Normalize + append (present.json): unknown `as` fails open to sheet; `touch` rides only
   *  an overlay — "block" is pinned, anything else fails open to "passthrough"; `attrs` (the
   *  component input contract) ride verbatim. */
  add(component: string, as: string | undefined, touch: string | undefined, attrs?: Dict): PresentEntry {
    this.seq += 1;
    const kind: PresentEntry["as"] = as === "cover" || as === "overlay" ? as : "sheet";
    const e: PresentEntry = { id: this.seq, as: kind, component };
    if (kind === "overlay") e.touch = touch === "block" ? "block" : "passthrough";
    if (attrs !== undefined && Object.keys(attrs).length > 0) e.attrs = attrs;
    this.entries.push(e);
    return e;
  }

  /** The live half of the attribute contract at the LEDGER level: merge `attrs` into the
   *  deepest-last entry matching `target` (the dismiss rule; null/empty = the top). Returns
   *  the updated entry or null (unmatched / empty ledger = documented no-op). */
  /** The update MATCHING half alone (no merge) — no target = the top entry; else by
   *  component tag (exact or bare) or `as` mode, deepest-last. Shared by updateAttrs
   *  and the style plane's overrides re-seed, so the two planes can never target
   *  different entries. */
  find(target: string | null | undefined): PresentEntry | null {
    if (this.entries.length === 0) return null;
    let idx = this.entries.length - 1;
    if (target !== undefined && target !== null && target.length > 0) {
      idx = -1;
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const e = this.entries[i]!;
        const bare = e.component.includes(".") ? e.component.substring(e.component.indexOf(".") + 1) : e.component;
        if (e.component === target || bare === target || e.as === target) { idx = i; break; }
      }
      if (idx < 0) return null;
    }
    return this.entries[idx]!;
  }

  updateAttrs(target: string | null | undefined, attrs: Dict): PresentEntry | null {
    if (Object.keys(attrs).length === 0) return null;
    const e = this.find(target);
    if (e === null) return null;
    e.attrs = { ...(e.attrs ?? {}), ...attrs };
    return e;
  }

  /** The dismissal topology (present.json): no target = the top of the presentation stack; a
   *  target matches by component tag (exact, or the bare tag of a scheme-qualified name — the
   *  web qualifies caller-side names) or by `as` mode, deepest-last wins; an OVERLAY takes
   *  only itself; a CHAIN entry takes its later chain descendants and spares every overlay.
   *  Returns the removed entries in presentation order ([] = documented no-op). */
  remove(target?: string | null): PresentEntry[] {
    if (this.entries.length === 0) return [];
    let idx = this.entries.length - 1;
    if (target !== undefined && target !== null && target.length > 0) {
      idx = -1;
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const e = this.entries[i]!;
        const bare = e.component.includes(".") ? e.component.substring(e.component.indexOf(".") + 1) : e.component;
        if (e.component === target || bare === target || e.as === target) { idx = i; break; }
      }
      if (idx < 0) return [];
    }
    const seed = this.entries[idx]!;
    const gone: PresentEntry[] = [seed];
    if (seed.as !== "overlay") {
      for (let i = idx + 1; i < this.entries.length; i += 1) {
        const e = this.entries[i]!;
        if (e.as !== "overlay") gone.push(e); // later chain entries = presentation descendants
      }
    }
    const ids = new Set(gone.map((e) => e.id));
    this.entries = this.entries.filter((e) => !ids.has(e.id));
    return gone;
  }

  /** A chain entry's frame was popped by the stack itself (browser Back through a sheet) —
   *  drop the ledger row without re-running topology. */
  removeById(id: number): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }
}
