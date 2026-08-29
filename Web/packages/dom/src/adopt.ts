//
//  adopt.ts - adopt-hydration (W6 slice 1, /web/02): the client BINDS the server-
//  rendered DOM instead of throwing it away. The server emitter (@despia-native/server
//  renderPage) stamps every element with `data-dsx-n` — its IR node identity
//  (stampNodeIds, per-component preorder) — plus the existing `data-dsx-owner` on
//  component roots. This walk runs the SAME traversal the mount layer runs, claims
//  the stamped element each IR node expects, verifies identity (owner/nid/tag), and
//  attaches exactly the wiring mount.ts would have attached — listeners, reactive
//  bindings, gestures, measure — onto the EXISTING elements.
//
//  Three tiers, deliberate and explicit:
//    ADOPT    — the structural/content vocabulary (stack family, scroll, spacer,
//               divider, text/label, image, the button family, slots, component
//               roots, visible-if anchors): element identity is PRESERVED; the
//               per-tag reactive wiring below mirrors the elements.ts factories
//               line-for-line (adopt.test.ts pins the parity).
//    REBUILD  — control machinery (native/form/structural/overlay/data/application
//               controls, media surfaces, bound collections, universal globals,
//               unsupported): the claim still verifies the server put the SAME node
//               here, then the real factory rebuilds the subtree IN PLACE (initial
//               bytes are identical — the server is the static twin — so there is
//               no visual shift). Documented v1 tier, counted, never a mismatch.
//    INSERT   — nodes the server deliberately does not render (facet components,
//               module-gated `visible-if="has:x"` subtrees the render process had
//               no module for): mounted fresh at the cursor, never a mismatch.
//
//  Any DIVERGENCE — a missing/mis-stamped element, or leftover server elements a
//  parent's walk did not account for — increments the mismatch counter, logs ONE
//  diagnostic naming the owner/tag/nid, and falls back to a fresh mount for that
//  subtree (fail-open: the page is never blank, exactly the v0 replace behavior at
//  the smallest possible granularity). The gate: mismatches === 0 on the demo
//  corpus. Islands (skipping inert subtrees entirely) and streaming are LATER W6
//  slices — they ride these same stamps; nothing here precludes them.
//
//  App-bundle only: boot.ts/router.ts import this module; embeds never do, and
//  mount.ts reaches it only through AdoptSeam (registered at module load below).
//

import { truthy, string, isDict, JSESeams, DSXStrings, type Dict, type ApiSeed } from "@despia-native/kernel";
import { mapStyleValue } from "@despia-native/compiler/cssmap";
import { resolveComponent } from "@despia-native/compiler/resolve";
import type { XmlNode } from "@despia-native/compiler/xml";
import { stampNodeIds, type ComponentIR, type IRNode } from "@despia-native/compiler/component";
import { AdoptSeam, ApiSeedSeam, ElementMotionSeam, StreamSeedSeam, adoptInternals, mountNode, type MountCtx } from "./mount.ts";
import { applyLineClamp, iconSvg, type ElementApi } from "./elements.ts";

// ── the hydration report (exposed for tests + diagnostics) ───────────────────────────

export type HydrationReport = {
  /** "none" until a boot begins adoption; "adopted" once a server root is claimed */
  mode: "none" | "adopted";
  /** structural divergences (each logged once and replace-mounted, fail-open) */
  mismatches: number;
  /** elements whose identity was preserved (the ADOPT tier) */
  adopted: number;
  /** claimed-and-rebuilt machinery subtrees (the documented v1 REBUILD tier) */
  rebuilt: number;
  /** client-only mounts the server deliberately omitted (facets, has:-gated) */
  inserted: number;
  /** leftover server elements removed during mismatch/finish cleanup */
  discarded: number;
  /** inert (reactive===false) presentational subtrees the walk SKIPPED — their
   *  server DOM is reused verbatim and NO reactive graph is built (the automatic
   *  islands result, doc 02). Each counts the SUBTREE ROOT, not every node under it. */
  islandsSkipped: number;
};

const report: HydrationReport = { mode: "none", mismatches: 0, adopted: 0, rebuilt: 0, inserted: 0, discarded: 0, islandsSkipped: 0 };
(globalThis as { __DSX_HYDRATION__?: HydrationReport }).__DSX_HYDRATION__ = report;

export function hydrationReport(): HydrationReport {
  return report;
}

export function resetHydrationReport(): void {
  report.mode = "none";
  report.mismatches = 0;
  report.adopted = 0;
  report.rebuilt = 0;
  report.inserted = 0;
  report.discarded = 0;
  report.islandsSkipped = 0;
}

function mismatch(ctx: MountCtx, node: XmlNode, reason: string): void {
  report.mismatches += 1;
  console.warn(
    `[dsx hydrate] mismatch in <${ctx.owner}> at <${node.tag}>#${String((node as IRNode).nid ?? "?")}: `
    + `${reason} — subtree replace-mounted (fail-open)`,
  );
}

// ── the claim cursor ─────────────────────────────────────────────────────────────────

/** A cursor over one adopted parent's server-rendered children. Claims consume in
 *  document order — the same order both the server walk emitted and this walk
 *  visits — so a successful claim run leaves the DOM order untouched (no moves). */
type Claim = { parent: ParentNode; next: ChildNode | null };

function claimFor(parent: ParentNode, from?: ChildNode | null): Claim {
  return { parent, next: from !== undefined ? from : parent.firstChild };
}

/** advance over inter-element noise (whitespace text, comments) without consuming
 *  meaningful content — the emitter writes none between elements, but a hand-edited
 *  or proxied document must not break alignment */
function nextElement(claim: Claim): Element | null {
  let cursor = claim.next;
  while (cursor !== null && cursor.nodeType !== 1) {
    if (cursor.nodeType === 3 && (cursor.textContent ?? "").trim().length > 0) return null;
    cursor = cursor.nextSibling;
  }
  claim.next = cursor;
  return cursor as Element | null;
}

/** does the next server element carry THIS node's identity? (the peek that decides
 *  server-rendered vs server-omitted for the optional tiers — never consumes) */
function peekOwn(claim: Claim, node: XmlNode): boolean {
  const el = nextElement(claim);
  return el !== null && el.getAttribute("data-dsx-n") === String((node as IRNode).nid);
}

/** claim the element for `node`: identity (nid) plus, when the caller knows it, the
 *  tag. Returns null WITHOUT consuming on any disagreement. */
function claimElement(claim: Claim, node: XmlNode, expectTag?: string): Element | null {
  const el = nextElement(claim);
  if (el === null) return null;
  if (el.getAttribute("data-dsx-n") !== String((node as IRNode).nid)) return null;
  if (expectTag !== undefined && el.tagName.toLowerCase() !== expectTag.toLowerCase()) return null;
  claim.next = el.nextSibling;
  return el;
}

function insertAt(claim: Claim, n: Node): void {
  claim.parent.insertBefore(n, claim.next);
}

/** after a parent's children are all walked, any remaining server ELEMENT is a
 *  divergence: count once, log once, remove them (fail-open — the client tree is
 *  the truth from here on) */
function finishClaim(claim: Claim, ctx: MountCtx, node: XmlNode): void {
  const leftovers: Element[] = [];
  let cursor = claim.next;
  while (cursor !== null) {
    if (cursor.nodeType === 1) leftovers.push(cursor as Element);
    cursor = cursor.nextSibling;
  }
  if (leftovers.length === 0) return;
  mismatch(ctx, node, `${leftovers.length} unmatched server element(s) removed`);
  report.discarded += leftovers.length;
  for (const el of leftovers) el.remove();
}

// ── tier tables ──────────────────────────────────────────────────────────────────────

const ADOPT_CONTAINER_TAGS = new Set(["stack", "vstack", "hstack", "zstack", "scroll"]);
const ADOPT_LEAF_TAGS = new Set(["spacer", "divider"]);
const TEXT_TAGS = new Set(["text", "label"]);
const BUTTON_TAGS = new Set(["button", "glassButton", "pressable", "transport", "row"]);

/** a node the ADOPT tier hands back to the factories anyway: `container` publishes
 *  element metrics through a scope the factory owns (mount.ts) */
function demoted(node: XmlNode): boolean {
  return node.attrs["container"] !== undefined;
}

/** the DOM tag the client factory would emit for an ADOPT-tier node — null when the
 *  node is not in the tier (image's icon form renders a client-only svg wrapper the
 *  server never emits, so only the plain <img> form adopts) */
function adoptableTag(node: XmlNode): string | null {
  if (ADOPT_CONTAINER_TAGS.has(node.tag) || ADOPT_LEAF_TAGS.has(node.tag)) return "div";
  // A REACTIVE `markdown=` text owns a whole inline subtree, not one text node — it is
  // machinery, so the factory rebuilds it. (An INERT markdown text is still an island:
  // the server already painted the same markup through the same parser.)
  if (TEXT_TAGS.has(node.tag)) {
    return node.attrs["markdown"] !== undefined ? null : node.tag === "label" ? "label" : "span";
  }
  if (BUTTON_TAGS.has(node.tag)) return node.attrs["href"] !== undefined ? "a" : "button";
  // `asset=`/`cache=` route the source through resolution/cache-busting the plain
  // adopt twin does not run, so those forms rebuild rather than half-bind.
  if (node.tag === "image"
    && node.attrs["icon"] === undefined && node.attrs["icon-web"] === undefined
    && node.attrs["systemImage"] === undefined
    && node.attrs["asset"] === undefined && node.attrs["cache"] === undefined) return "img";
  return null;
}

// ── automatic islands (doc 02: hydration granularity is automatic) ───────────────────
//  The compiler stamps every IR node with a reactive-DESCENDANT bit (component.ts
//  subtreeReactive): reactive===false means the WHOLE subtree is inert static HTML —
//  no {{ }}, no on:*, no visible-if/bind, no <api>, no component reference anywhere
//  under it. Such a subtree is exactly the bytes the server already emitted, so the
//  walk claims its root by identity (keeping the structural check honest) and REUSES
//  every DOM node verbatim — building no ElementApi, no binding, no child walk, no
//  reactive graph. This is the Astro-islands result off the per-node stamps W6-1 laid
//  down, with zero islands authoring tax.
//
//  ADOPT-WIRING PARITY (design-system.md Wave 4 — the named defect): the reactive bit
//  proves the subtree builds no reactive GRAPH; it proves nothing about the WIRING a
//  fresh mount attaches regardless of reactivity — tooltip= bubbles + aria-describedby
//  (wireTooltip), href= SPA link interception (wireGestures; shortcut= rides it),
//  measure=/container= observers, focusOrder= tab order, the client-only icon svg an
//  icon-form <image> renders, and every factory-owned tag (buttons keep their
//  link/disabled/doubleTap wiring, machinery keeps its rebuild). A skipped subtree
//  containing any of those adopts DEADER than a fresh mount of the same registry, so
//  the island gate verifies skip-safety ITSELF: only a subtree that is presentational
//  vocabulary throughout AND wiring-free throughout is reused verbatim. Anything else
//  walks the normal tiers, which attach exactly the fresh-mount wiring.
const ISLAND_TAGS = new Set([...ADOPT_CONTAINER_TAGS, ...ADOPT_LEAF_TAGS, ...TEXT_TAGS]);

/** attributes whose wiring the fresh mount attaches on ANY element, reactive or not */
const WIRING_ATTRS = ["tooltip", "href", "measure", "container", "focusOrder"];

/** the plain (server-rendered) image form — the icon/systemImage forms render a
 *  client-only svg the server never emits, so they are never skip-safe */
function plainImage(node: XmlNode): boolean {
  return node.tag === "image"
    && node.attrs["icon"] === undefined && node.attrs["icon-web"] === undefined
    && node.attrs["systemImage"] === undefined;
}

/** The localization exception to skip-islands (P12): an app that SHIPS string tables
 *  has declared its static display text LIVE — a locale write must re-resolve it, so a
 *  text node carrying display copy needs its bindDisplay effect and cannot be reused
 *  verbatim. Data-driven: an app with no tables (loader null) keeps every island, and
 *  the embed fold removes the check entirely. (A runtime-tier-only table — written into
 *  global.strings after boot with no build tier — reaches adopted islands on the next
 *  swap or navigation, not mid-island; the build tier is the shipped story.) */
function stringsLive(): boolean {
  return (globalThis as typeof globalThis & { __DSX_OPTIONAL_STRINGS__?: boolean })
    .__DSX_OPTIONAL_STRINGS__ !== false && DSXStrings.loader !== null;
}

/** true when EVERY node of the subtree is skip-safe: island vocabulary (anything
 *  else — the button family, machinery, unsupported — carries factory wiring) and
 *  free of wiring-bearing attributes (container= subsumes the demoted() check) */
function subtreeAdoptInert(node: XmlNode): boolean {
  for (const attr of WIRING_ATTRS) if (node.attrs[attr] !== undefined) return false;
  if (!ISLAND_TAGS.has(node.tag) && !plainImage(node)) return false;
  if (stringsLive() && TEXT_TAGS.has(node.tag)
    && (node.attrs["value"] !== undefined || node.text.trim().length > 0)) return false;
  for (const child of node.children) if (!subtreeAdoptInert(child)) return false;
  return true;
}

/** is this the root of an inert presentational subtree the walk may skip wholesale? */
function isIslandRoot(node: XmlNode): boolean {
  if ((node as IRNode).reactive !== false) return false; // undefined ⇒ not proven inert
  if (!ISLAND_TAGS.has(node.tag) && !plainImage(node)) return false;
  return subtreeAdoptInert(node);
}

// ── fresh mounting helpers (the fail-open + INSERT paths) ────────────────────────────

/** mount `node` fresh (the real mount layer) and splice the result at the cursor */
function freshAt(node: XmlNode, ctx: MountCtx, claim: Claim): ChildNode[] {
  const frag = document.createDocumentFragment();
  mountNode(node, ctx, frag);
  const nodes = [...frag.childNodes];
  for (const n of nodes) insertAt(claim, n);
  return nodes;
}

/** REBUILD tier: verify the server put this node here (the stamp), then swap the
 *  factory-built subtree into its place. The claim keeps the structural check
 *  honest; a failed claim IS a mismatch. */
function claimRebuild(node: XmlNode, ctx: MountCtx, claim: Claim): ChildNode[] {
  const claimed = claimElement(claim, node);
  if (claimed === null) {
    mismatch(ctx, node, "expected server element missing or mis-stamped");
    return freshAt(node, ctx, claim);
  }
  const frag = document.createDocumentFragment();
  mountNode(node, ctx, frag);
  const nodes = [...frag.childNodes];
  for (const n of nodes) claim.parent.insertBefore(n, claimed);
  claimed.remove();
  report.rebuilt += 1;
  return nodes;
}

// ── the walk ─────────────────────────────────────────────────────────────────────────

/** Adopt one IR node against the claim cursor. Returns the top-level DOM nodes that
 *  now represent it (claimed, rebuilt, or freshly inserted) so visible-if branches
 *  can dispose them on toggle-off exactly like mount.ts does. */
function adoptNode(node: XmlNode, ctx: MountCtx, claim: Claim): ChildNode[] {
  const vif = node.attrs["visible-if"];
  if (vif !== undefined && vif.startsWith("has:")) {
    // module-availability gate (mount.ts twin): decided once, no anchor, no effect.
    // The SERVER's answer may differ from ours (a render process registers no
    // modules) — the stamp is the evidence: rendered → adopt, omitted → insert.
    if (!JSESeams.moduleAvailable(vif.slice(4).trim())) return [];
    const inner: XmlNode = { ...node, attrs: { ...node.attrs } };
    delete inner.attrs["visible-if"];
    if (peekOwn(claim, node)) return adoptNode(inner, ctx, claim);
    const nodes = freshAt(inner, ctx, claim);
    report.inserted += 1;
    return nodes;
  }
  if (vif !== undefined) {
    // keep=/transition= vifs own animated flip machinery (the element-motion seam,
    // mount.ts). That machinery is factory-owned: swap the server subtree for a
    // fresh mount so the animated toggle wiring is exactly the fresh-boot one. The
    // server may have rendered the branch (claim + replace) or not (plain insert);
    // neither is a divergence.
    const motion = ElementMotionSeam.impl;
    if (motion !== null && (node.attrs["keep"] === "true" || node.attrs["transition"] !== undefined)) {
      if (peekOwn(claim, node)) {
        const el = nextElement(claim)!;
        claim.next = el.nextSibling;
        const nodes = freshAt(node, ctx, claim);
        el.remove();
        report.rebuilt += 1;
        return nodes;
      }
      return freshAt(node, ctx, claim);
    }
    return adoptVisibleIf(node, ctx, claim, vif);
  }

  if (node.tag === "head") return []; // stripped by the compiler; ignore strays
  if (node.tag === "slot") return adoptSlot(node, ctx, claim);

  if (/^[A-Z]/.test(node.tag) || node.tag.includes(".")) {
    // WebView is the reserved capitalized platform primitive — machinery tier.
    if (node.tag !== "WebView") return adoptComponent(node, ctx, claim);
  }

  // AUTOMATIC ISLANDS: an inert presentational subtree is claimed by identity and
  // SKIPPED — its server DOM is reused, no reactive graph is built. A failed claim
  // (server omitted/mis-stamped it — never expected for inert content) does NOT
  // consume the cursor, so it falls through to the normal tier below which counts
  // the divergence and fail-opens.
  if (isIslandRoot(node)) {
    const claimed = claimElement(claim, node);
    if (claimed !== null) { report.islandsSkipped += 1; return [claimed]; }
  }

  if (!demoted(node)) {
    const expect = adoptableTag(node);
    if (expect !== null) return adoptElement(node, ctx, claim, expect);
  }

  // everything else — native/form/structural/overlay/data/application controls,
  // media surfaces, bound collections, globals, unsupported — is machinery: claim
  // (structure verified), rebuild in place.
  return claimRebuild(node, ctx, claim);
}

/** visible-if on an adopted node: same anchor + presence-effect contract as
 *  mount.ts, except an initially-true branch BINDS the already-rendered server
 *  subtree instead of building one. (keep=/transition= nodes never reach here —
 *  adoptNode swaps them fresh so the motion seam owns their flip machinery.) */
function adoptVisibleIf(node: XmlNode, ctx: MountCtx, claim: Claim, vif: string): ChildNode[] {
  const inner: XmlNode = { ...node, attrs: { ...node.attrs } };
  delete inner.attrs["visible-if"];
  const anchor = document.createComment("dsx:if");
  insertAt(claim, anchor);
  let mounted: { nodes: ChildNode[]; ctx: MountCtx } | null = null;

  const on = truthy(ctx.store.eval(vif, ctx.item));
  if (on) {
    const branch = adoptInternals.subCtx(ctx);
    if (peekOwn(claim, node)) {
      mounted = { nodes: adoptNode(inner, branch, claim), ctx: branch };
    } else {
      // the server said false where we say true — a real divergence
      mismatch(ctx, node, "visible-if diverged (client true, server rendered nothing)");
      mounted = { nodes: freshAt(inner, branch, claim), ctx: branch };
    }
  }
  // server-true/client-false needs no action here: the stamped element stays
  // unconsumed and the parent's finishClaim counts and removes it.

  const dispose = adoptInternals.contextEffect(ctx,
    () => truthy(ctx.store.eval(vif, ctx.item)),
    (want) => {
      if (want && mounted === null) {
        const branch = adoptInternals.subCtx(ctx);
        const frag = document.createDocumentFragment();
        mountNode(inner, branch, frag);
        const nodes = [...frag.childNodes];
        anchor.after(...nodes);
        mounted = { nodes, ctx: branch };
      } else if (!want && mounted !== null) {
        mounted.ctx.disposers.forEach((d) => d());
        mounted.nodes.forEach((n) => n.remove());
        mounted = null;
      }
    },
  );
  ctx.disposers.push(dispose, () => {
    mounted?.ctx.disposers.forEach((d) => d());
    mounted = null;
  });
  return mounted === null ? [anchor] : [anchor, ...mounted.nodes];
}

/** slots keep caller scope (mount.ts mountSlot twin); the server rendered the
 *  caller's content inline, so the SAME claim cursor continues through it */
function adoptSlot(node: XmlNode, ctx: MountCtx, claim: Claim): ChildNode[] {
  const slots = ctx.slots;
  if (slots === null) return []; // no DSX caller; embed slot projection never adopts (v1)
  const name = node.attrs["name"];
  const content = name !== undefined && name.length > 0 ? slots.named.get(name) ?? [] : slots.defaults;
  const out: ChildNode[] = [];
  for (const child of content) {
    out.push(...adoptNode(child, {
      ...slots.ctx,
      formNamespace: ctx.formNamespace ?? slots.ctx.formNamespace,
    }, claim));
  }
  return out;
}

/** a component reference: claim the child instance's root by OWNER (data-dsx-owner,
 *  stamped by every renderInstance/instantiate pair), then hand the element to the
 *  real mountComponent — instantiate() routes it back through AdoptSeam so the
 *  child's own tree adopts recursively with its own nid numbering */
function adoptComponent(node: XmlNode, ctx: MountCtx, claim: Claim): ChildNode[] {
  const ir = resolveComponent(ctx.registry, ctx.scheme, node.tag);
  if (ir === null) {
    // facet components + universal globals + unresolved tags: the server renders
    // globals/unsupported (stamped — rebuild) but leaves facets EMPTY (render.ts:
    // facets are DOM-owned). The stamp decides which case this is.
    if (peekOwn(claim, node)) return claimRebuild(node, ctx, claim);
    const nodes = freshAt(node, ctx, claim);
    report.inserted += 1;
    return nodes;
  }
  const el = nextElement(claim);
  if (el === null || el.getAttribute("data-dsx-owner") !== ir.name) {
    mismatch(ctx, node, `component root <${ir.name}> missing or mis-owned`);
    return freshAt(node, ctx, claim);
  }
  claim.next = el.nextSibling;
  // on an inner root mismatch the walk swaps a fresh root into el's slot (the
  // cursor is unaffected — replaceWith preserves the sibling chain); either way
  // mountComponent hands back the element now representing the component.
  const placed = adoptInternals.mountComponent(node, ctx, claim.parent, el);
  report.adopted += 1;
  return placed === null ? [el] : [placed];
}

// ── the ADOPT tier: per-tag wiring, mirroring elements.ts factories ─────────────────

/** strip attributes the wiring below re-derives, so re-attachment cannot double up:
 *  data-dsx handles (wireRootStyleContract CONCATENATES), and the initial value of a
 *  class FORMULA (its authored-token tracking must start from the base set) */
function normalizeAdopted(el: Element, node: XmlNode, ctx: MountCtx): void {
  el.removeAttribute("data-dsx");
  const cls = node.attrs["class"];
  if (cls !== undefined && cls.includes("{{")) {
    for (const token of ctx.store.interpolate(cls, ctx.item).split(/\s+/)) {
      if (token.length > 0) el.classList.remove(token);
    }
  }
}

function adoptElement(node: XmlNode, ctx: MountCtx, claim: Claim, expectTag: string): ChildNode[] {
  const claimed = claimElement(claim, node, expectTag) as HTMLElement | null;
  if (claimed === null) {
    mismatch(ctx, node, `expected <${expectTag}> missing or mis-stamped`);
    return freshAt(node, ctx, claim);
  }
  report.adopted += 1;
  normalizeAdopted(claimed, node, ctx);
  const api = adoptInternals.makeApi(node, ctx);
  // where this node's IR children continue in the server DOM; null = no child walk
  // (text/img/spacer/divider carry none, and a canonical labeled/icon button mounts
  // none — the factory's slot rule)
  let childPlan: { from: ChildNode | null } | null = null;

  if (ADOPT_CONTAINER_TAGS.has(node.tag)) {
    // elements.ts `stack` / `scroll` factories
    if (node.tag === "scroll") {
      api.bindText(node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical", (value) => {
        claimed.classList.toggle("dsx-scroll-x", value === "horizontal");
      });
    } else {
      if (node.attrs["flexDirection"] !== undefined) {
        api.bindText(node.attrs["flexDirection"], (value) => {
          if (node.tag === "stack") claimed.classList.toggle("dsx-hstack", value === "row");
        });
      }
      if (node.attrs["display"] !== undefined) {
        api.bindText(node.attrs["display"], (value) => {
          if (value === "grid") claimed.setAttribute("data-dsx-grid", "true");
          else claimed.removeAttribute("data-dsx-grid");
        });
      }
    }
    childPlan = { from: claimed.firstChild };
  } else if (node.tag === "divider") {
    bindColorProperty(node, api, claimed, "--dsx-divider-color");
  } else if (TEXT_TAGS.has(node.tag)) {
    // elements.ts `textEl` — value writes are guarded so an in-sync adopt keeps
    // even the server TEXT node (assignment would replace it)
    const setText = (v: string): void => { if (claimed.textContent !== v) claimed.textContent = v; };
    // bindDisplay, not bindText: adopt parity includes the LOCALIZATION seam (P12) - an
    // SSR-adopted page's static strings must re-resolve on a locale write exactly like a
    // fresh mount's, or the served first screen is the one surface a language switch skips
    if (node.attrs["bind"] !== undefined) api.bindValue(node.attrs["bind"], (v) => setText(string(v)));
    else if (node.attrs["value"] !== undefined) api.bindDisplay(node.attrs["value"], setText);
    else if (node.text.trim().length > 0) api.bindDisplay(node.text.trim(), setText);
    if (node.attrs["lineLimit"] !== undefined) {
      api.bindText(node.attrs["lineLimit"], (v) => applyLineClamp(claimed as HTMLElement, v));
    }
  } else if (node.tag === "image") {
    // elements.ts `imageEl`, plain form
    const img = claimed as HTMLImageElement;
    img.alt = node.attrs["alt"] ?? "";
    if (node.attrs["a11yLabel"] !== undefined) {
      api.bindText(node.attrs["a11yLabel"], (v) => { if (img.alt !== v) img.alt = v; });
    }
    api.bindText(node.attrs["src"], (v) => { if (v.length > 0 && img.src !== v) img.src = v; });
  } else if (BUTTON_TAGS.has(node.tag)) {
    childPlan = adoptButton(node, claimed, api);
  }

  adoptInternals.wireCommon(claimed, node, ctx, api);

  if (childPlan !== null) {
    const child = claimFor(claimed, childPlan.from);
    for (const c of node.children) adoptNode(c, ctx, child);
    finishClaim(child, ctx, node);
  }
  return [claimed];
}

/** elements.ts `bindSemanticColor` twin */
function bindColorProperty(node: XmlNode, api: ElementApi, el: HTMLElement, property: string): void {
  const expression = node.attrs["color"];
  if (expression === undefined) return;
  api.bindText(expression, (value) => {
    const color = mapStyleValue("color", value);
    if (color.length === 0) el.style.removeProperty(property);
    else el.style.setProperty(property, color);
  });
}

/** the button family (elements.ts `buttonEl`): semantics, variant/role words, the
 *  disabled pair, icon (client-side, additive), the label span (claimed from the
 *  server's inner markup), doubleTap. Returns where the CHILDREN cursor starts —
 *  after any machinery — or null when the factory contract mounts no children for
 *  this shape (canonical button with label/icon). */
function adoptButton(node: XmlNode, e: HTMLElement, api: ElementApi): { from: ChildNode | null } | null {
  const hasHref = node.attrs["href"] !== undefined;
  const isPressable = node.tag === "pressable" || node.tag === "row";
  e.setAttribute("data-dsx-component", isPressable ? "pressable" : "button");
  if (!hasHref) (e as HTMLButtonElement).type = "button";
  if (node.attrs["variant"] !== undefined) {
    api.bindText(node.attrs["variant"], (v) => {
      const t = v.trim();
      if (t.length > 0) e.setAttribute("data-dsx-variant", t);
      else e.removeAttribute("data-dsx-variant");
    });
  }
  if (node.attrs["role"] !== undefined) {
    api.bindText(node.attrs["role"], (v) => {
      const t = v.trim();
      if (t === "destructive" || t === "cancel") e.setAttribute("data-dsx-role", t);
      else e.removeAttribute("data-dsx-role");
    });
  }
  if (node.attrs["disabled"] !== undefined || node.attrs["disabled-if"] !== undefined) {
    const focusOrder = Number(node.attrs["focusOrder"]);
    const hasFocusOrder = node.attrs["focusOrder"] !== undefined && Number.isFinite(focusOrder);
    let declaredDisabled = false;
    let conditionalDisabled = false;
    let disabled = false;
    const reflectDisabled = (): void => {
      disabled = declaredDisabled || conditionalDisabled;
      if (e.tagName === "BUTTON") {
        (e as HTMLButtonElement).disabled = disabled;
      } else if (disabled) {
        e.setAttribute("aria-disabled", "true");
        e.tabIndex = -1;
      } else {
        e.removeAttribute("aria-disabled");
        if (hasFocusOrder) e.tabIndex = focusOrder;
        else e.removeAttribute("tabindex");
      }
    };
    if (node.attrs["disabled"] !== undefined) {
      api.bindText(node.attrs["disabled"], (value) => {
        declaredDisabled = truthy(value);
        reflectDisabled();
      });
    }
    if (node.attrs["disabled-if"] !== undefined) {
      api.bindValue(node.attrs["disabled-if"], (value) => {
        conditionalDisabled = truthy(value);
        reflectDisabled();
      });
    }
    if (hasHref) {
      e.addEventListener("click", (event) => {
        if (!disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
    }
  }
  const iconName = node.attrs["icon-web"] ?? node.attrs["icon"];
  if (iconName !== undefined) {
    const defaultIconSize = node.attrs["label"] === undefined ? 20 : 17;
    const parsed = Number(node.attrs["iconSize"] ?? String(defaultIconSize));
    const size = Number.isFinite(parsed) ? parsed : defaultIconSize;
    api.bindText(iconName, (v) => {
      e.querySelector("svg")?.remove();
      if (v.length > 0) {
        const icon = iconSvg(v, size);
        icon.setAttribute("data-dsx-part", "icon");
        e.prepend(icon);
      }
    });
  }
  if (node.attrs["label"] !== undefined) {
    // the server's inner label span (render.ts BUTTON_FAMILY inner) — claim it as
    // the binding target; a missing one (label added since render) is created. The
    // icon svg above PREPENDS, so the span is located among the leading machinery,
    // never assumed to be the literal first child.
    let span: HTMLElement | null = null;
    for (let cursor = e.firstElementChild; cursor !== null; cursor = cursor.nextElementSibling) {
      if (cursor.getAttribute("data-dsx-n") !== null) break; // stamped = an IR child, not machinery
      if (cursor.tagName === "SPAN") { span = cursor as HTMLElement; break; }
    }
    if (span === null) {
      span = document.createElement("span");
      e.appendChild(span);
    }
    span.setAttribute("data-dsx-part", "label");
    const label = span;
    api.bindDisplay(node.attrs["label"], (v) => { if (label.textContent !== v) label.textContent = v; });
  }
  if (api.hasHandler("doubleTap")) e.addEventListener("dblclick", () => api.handler("doubleTap"));
  // the factory's slot rule: pressables/rows always own content; a canonical
  // button only when neither label nor icon is supplied
  if (!isPressable && (node.attrs["label"] !== undefined || iconName !== undefined)) return null;
  // children continue after the leading machinery (icon svg, label span — both
  // unstamped); the first stamped element or text is IR content
  let from: ChildNode | null = e.firstChild;
  while (from !== null && from.nodeType === 1) {
    const el = from as Element;
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute("data-dsx-n") !== null) break;
    if (tag !== "svg" && !(tag === "span" && el.getAttribute("data-dsx-part") === "label")) break;
    from = from.nextSibling;
  }
  return { from };
}

// ── instance adoption (the AdoptSeam impl instantiate() calls) ───────────────────────

function rebuildRoot(ir: ComponentIR, ctx: MountCtx, server: Element): HTMLElement {
  const frag = document.createDocumentFragment();
  mountNode(ir.root, ctx, frag);
  const root = (frag.firstElementChild ?? document.createElement("div")) as HTMLElement;
  server.replaceWith(root);
  return root;
}

/** Adopt a whole component instance: `server` IS the element ir.root rendered. */
function adoptInstance(ir: ComponentIR, ctx: MountCtx, server: Element): HTMLElement {
  stampNodeIds(ir.root as IRNode);
  report.mode = "adopted";
  const root = ir.root as IRNode;

  // a component-reference root recurses through the real mountComponent — the
  // nested instantiate() routes back through this seam with the child's own tree
  if ((/^[A-Z]/.test(root.tag) || root.tag.includes(".")) && root.tag !== "WebView") {
    const inner = resolveComponent(ctx.registry, ctx.scheme, root.tag);
    if (inner !== null && server.getAttribute("data-dsx-owner") === inner.name) {
      const placed = adoptInternals.mountComponent(
        root, ctx, server.parentNode ?? document.createDocumentFragment(), server,
      );
      report.adopted += 1;
      return placed ?? (server as HTMLElement);
    }
    mismatch(ctx, root, "instance root component missing or mis-owned");
    return rebuildRoot(ir, ctx, server);
  }

  const expectTag = adoptableTag(root);
  const adoptable = expectTag !== null && !demoted(root) && root.attrs["visible-if"] === undefined;
  if (!adoptable) {
    // machinery-rooted instance (scaffold, overlay, form, …): rebuild in place —
    // counted, never a mismatch (the documented v1 tier)
    if (server.getAttribute("data-dsx-n") === String(root.nid)) {
      report.rebuilt += 1;
      return rebuildRoot(ir, ctx, server);
    }
    mismatch(ctx, root, "instance root mis-stamped");
    return rebuildRoot(ir, ctx, server);
  }
  if (server.getAttribute("data-dsx-n") !== String(root.nid)
      || server.tagName.toLowerCase() !== expectTag.toLowerCase()) {
    mismatch(ctx, root, `instance root expected <${expectTag}>#${String(root.nid)}`);
    return rebuildRoot(ir, ctx, server);
  }
  // bind the root in place through the SAME per-tag path children take: a claim
  // cursor positioned exactly at the root element (pre-verified, so the claim
  // inside adoptElement cannot fail and never double-materializes the root)
  const holder = claimFor(server.parentNode ?? document.createDocumentFragment(), server);
  const nodes = adoptElement(root, ctx, holder, expectTag);
  return (nodes[0] ?? server) as HTMLElement;
}

AdoptSeam.impl = adoptInstance;

// ── SSR api-hydration seeds (doc 02: window.__DSX__.api) ─────────────────────────────
// boot.ts fills these from the payload at the start of an adopt session; a mounting
// <api> block claims its seed once (by `as`, through ApiSeedSeam) and skips its initial
// fetch. Cleared with the session — an api-free / non-SSR boot never allocates it.

let apiSeeds: Map<string, ApiSeed> | null = null;

/** boot.ts: register the SSR-executed api envelopes (window.__DSX__.api) for this boot. */
export function seedApiEnvelopes(payload: unknown): void {
  if (!isDict(payload)) { apiSeeds = null; return; }
  const map = new Map<string, ApiSeed>();
  for (const [as, envelope] of Object.entries(payload as Dict)) {
    if (isDict(envelope)) map.set(as, envelope as ApiSeed);
  }
  apiSeeds = map.size > 0 ? map : null;
}

function clearApiSeeds(): void { apiSeeds = null; }

ApiSeedSeam.claim = (as: string): ApiSeed | null => {
  if (apiSeeds === null) return null;
  const seed = apiSeeds.get(as);
  if (seed === undefined) return null;
  apiSeeds.delete(as); // consumed once — a remount/second instance fetches normally
  if (apiSeeds.size === 0) apiSeeds = null;
  return seed;
};

// ── out-of-order streaming (doc 02: window.__DSX_STREAM__) ──────────────────────────
// The server flushes one {as, seed} chunk per resolved `defer` block AFTER the initial
// document. Mounted blocks are offered here (first-wins by `as` — one route scope per
// document); a chunk seeds its live block in place (`seedLate` — the client's own
// settled data always wins), and a chunk landing BEFORE the block mounts stashes into
// the boot-seed map so the mount claims it like any SSR seed. Cleared with the session.

let streamTargets: Map<string, { seedLate(seed: ApiSeed): boolean }> | null = null;

StreamSeedSeam.offer = (as, block): void => {
  if (streamTargets === null) streamTargets = new Map();
  if (!streamTargets.has(as)) streamTargets.set(as, block);
};

/** boot.ts: apply one streamed chunk ({as, seed} — untrusted shape, validated here). */
export function applyStreamChunk(entry: unknown): void {
  if (!isDict(entry)) return;
  const as = string((entry as Dict)["as"] ?? "");
  const seed = (entry as Dict)["seed"];
  if (as.length === 0 || !isDict(seed)) return;
  const target = streamTargets?.get(as);
  if (target !== undefined) {
    target.seedLate(seed as ApiSeed);
    return;
  }
  // Not mounted yet — the mount's ApiSeedSeam claim path picks it up.
  if (apiSeeds === null) apiSeeds = new Map();
  if (!apiSeeds.has(as)) apiSeeds.set(as, seed as ApiSeed);
}

function clearStreamTargets(): void { streamTargets = null; }

// ── the boot session (SSR page → frame adoption; boot.ts + router.ts glue) ──────────

let session: { host: HTMLElement; roots: Map<string, Element> } | null = null;

/** Begin adoption over an SSR host (`data-dsx-hydrate` — renderPage stamps it):
 *  collect the server-rendered component roots by owner. The DOM stays in place —
 *  first paint is never disturbed. */
export function beginAdopt(host: HTMLElement): void {
  resetHydrationReport();
  clearApiSeeds(); // a fresh session; boot.ts seeds the payload immediately after
  clearStreamTargets();
  const roots = new Map<string, Element>();
  for (const el of [...host.children]) {
    const owner = el.getAttribute("data-dsx-owner");
    if (owner !== null && !roots.has(owner)) roots.set(owner, el);
  }
  session = { host, roots };
}

/** The frame mount asks for its component's server root (router.ts). One claim per
 *  owner; no session or no match = null = the ordinary fresh mount. */
export function claimAdoptRoot(owner: string): Element | null {
  if (session === null) return null;
  const el = session.roots.get(owner);
  if (el === undefined) return null;
  session.roots.delete(owner);
  return el.isConnected ? el : null;
}

/** Root-plan fallback / diagnostic path: drop the session silently — the candidate
 *  failed for its own reason and the fold already ledgers it (never a mismatch). */
export function abandonAdopt(): void {
  clearApiSeeds();
  clearStreamTargets();
  if (session === null) return;
  for (const el of session.roots.values()) el.remove();
  session = null;
}

/** Boot completed: any server root no frame claimed is a divergence — count it,
 *  say so once, remove it (fail-open). */
export function finishAdopt(): void {
  clearApiSeeds(); // the entry mount has consumed its seeds; drop any unconsumed residue
  if (session === null) return;
  const stale = [...session.roots.values()].filter((el) => el.isConnected);
  if (stale.length > 0) {
    report.mismatches += 1;
    report.discarded += stale.length;
    console.warn(`[dsx hydrate] ${stale.length} server-rendered root(s) never claimed by a frame — removed (fail-open)`);
    for (const el of stale) el.remove();
  }
  session = null;
}
