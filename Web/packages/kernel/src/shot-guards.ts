//
//  shot-guards.ts - THE SHOT GUARD SET (platform/10-screenshot-execution.md §4).
//
//  Ways to refuse an image, each with its own detector, because they are different
//  failures and only one of them is obvious:
//
//    G-unresolved  a binding with no value at any tier            (shot-scope.ts)
//    G-empty       the screen RENDERED FINE and says "No data"    (this file)
//    G-unsettled   a settle condition never held inside budget    (this file)
//    G-blank       the frame painted neither text nor an image    (this file)
//    G-cover       a decoration covers readable app UI silently   (this file)
//    G-safe        content crowds the card edge past the safe inset (this file)
//
//  G-empty is the one worth reading twice. `{{ user.name }}` rendering as literal text is a
//  bug anyone spots. A screen that renders perfectly, with correct chrome and real typography,
//  and shows an empty list under a "Recent orders" header is a DIFFERENT failure: everything
//  technically worked, nothing threw, and the resulting image is a store rejection for
//  placeholder content. Only a zero-row rule catches it.
//
//  This file is pure. It scores a FRAME REPORT that the browser driver collects; it never
//  touches the DOM itself, so the same law can be scored from a native capture later.
//

// ── what the driver collects ─────────────────────────────────────────────────────────

/** One `<api>` block's settled facts, read off the store's reserved paths (/web/05). */
export type FrameApi = {
  as: string;
  status: string;
  loading: boolean;
  refreshing: boolean;
  blockedBy: string[];
  error: unknown;
};

/** One bound collection in the rendered frame. `ref` is the author's handle for
 *  `allowEmpty`; `rows` is what actually rendered. */
export type FrameCollection = { ref: string; tag: string; rows: number };

/** Every settle condition, as observed at capture time. */
export type FrameSettle = {
  fontsReady: boolean;
  imagesDecoded: boolean;
  domStable: boolean;
  actionsIdle: boolean;
  transportIdle: boolean;
  /** elements the driver could not bring to rest, named rather than timed out anonymously */
  restless: string[];
};

/** A measured box in frame space (CSS px at capture). */
export type FrameRect = { x: number; y: number; w: number; h: number };

/** One decoration's measured box plus what its data row DECLARED. `over: "screen"` is the
 *  author saying "covering the app UI here is the composition" - without it, covering is an
 *  accident and the shot is refused (G-cover). `bleed: true` is the same shape for the safe
 *  inset: a sticker allowed to run off the card edge says so, or G-safe refuses it. */
export type FrameDecoration = { label: string; rect: FrameRect; over?: string; bleed?: boolean };

/** The measured scene: where the card canvas, the device, the app screen, the crop window
 *  and the dissolve veil landed, and where every decoration landed. Collected off the
 *  rendered frame's landmarks (`#shot-card`, `#shot-device`, `#shot-screen`, `#shot-crop`,
 *  `#shot-veil`, `#shot-decor-<id>`), absent for documents that are not composed slides. */
export type FrameScene = {
  screen: FrameRect | null;
  card?: FrameRect | null;
  device?: FrameRect | null;
  crop?: FrameRect | null;
  veil?: FrameRect | null;
  decor: FrameDecoration[];
};

export type FrameReport = {
  apis: FrameApi[];
  collections: FrameCollection[];
  settle: FrameSettle;
  /** requests the armed response plane did not recognise */
  seamMisses: string[];
  /** total rendered text length, and how many images actually painted. A slide with neither
   *  is BLANK - see G-blank. */
  ink?: { text: number; images: number };
  /** the measured scene geometry - see G-cover */
  scene?: FrameScene;
};

/** `allowEmpty` NAMES ITS ELEMENTS. A screen advertising a clean-inbox zero state has one
 *  legitimately empty list beside a nav that must still be full; a bare `true` would blind
 *  the guard to the second, which is exactly the image the guard exists to stop. */
export type AllowEmpty = true | ReadonlyArray<string>;

export type GuardFinding = {
  guard: "G-empty" | "G-unsettled" | "G-blank" | "G-cover" | "G-safe";
  subject: string;
  reason: string;
  fix: string;
};

/** The card canvas keeps a 1rem safe inset on its content - the same responsive discipline
 *  DSX enforces everywhere else. Enforced on the MEASURED frame, so a template edit that
 *  glues the phone to the card border is caught even when the template's own padding was
 *  supposed to prevent it. */
export const SAFE_INSET_PX = 16;

/** Rounding and hairline borders must not refuse a box that sits exactly on the inset. */
const SAFE_SLACK_PX = 4;

/** How far `rect` intrudes into the safe inset of `card`, per edge; all zeros is lawful.
 *  `edges` names which edges the law applies to (the device's bottom runs into the dissolve
 *  by design, so its bottom edge is exempt). */
function safeIntrusion(
  rect: FrameRect, card: FrameRect, inset: number,
  edges: { left: boolean; right: boolean; top: boolean; bottom: boolean },
): string[] {
  const out: string[] = [];
  const l = rect.x - (card.x + inset);
  const r = (card.x + card.w - inset) - (rect.x + rect.w);
  const t = rect.y - (card.y + inset);
  const b = (card.y + card.h - inset) - (rect.y + rect.h);
  if (edges.left && l < -SAFE_SLACK_PX) out.push(`${Math.round(-l)}px past the left inset`);
  if (edges.right && r < -SAFE_SLACK_PX) out.push(`${Math.round(-r)}px past the right inset`);
  if (edges.top && t < -SAFE_SLACK_PX) out.push(`${Math.round(-t)}px past the top inset`);
  if (edges.bottom && b < -SAFE_SLACK_PX) out.push(`${Math.round(-b)}px past the bottom inset`);
  return out;
}

// ── the containment arithmetic (pure, so a native capture can score the same law) ─────

function intersect(a: FrameRect, b: FrameRect): FrameRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  if (r - x <= 0 || btm - y <= 0) return null;
  return { x, y, w: r - x, h: btm - y };
}

/** A touch under this many px in either axis is a kiss, not a cover - rounding and border
 *  overlap must not refuse a legitimate composition. */
const COVER_SLACK_PX = 6;

/** Where the app UI stops being READABLE. The visible screen is the screen clipped by the
 *  crop window; under a dissolve veil the UI is design ground, not content, so the readable
 *  zone ends partway into the gradient (35% in ≈ where the card colour takes over). */
export function readableScreen(scene: FrameScene): FrameRect | null {
  if (scene.screen === null) return null;
  let zone = scene.screen;
  if (scene.crop !== undefined && scene.crop !== null) {
    const clipped = intersect(zone, scene.crop);
    if (clipped === null) return null;
    zone = clipped;
  }
  if (scene.veil !== undefined && scene.veil !== null) {
    const readableBottom = scene.veil.y + scene.veil.h * 0.35;
    const h = readableBottom - zone.y;
    if (h <= 0) return null;
    zone = { x: zone.x, y: zone.y, w: zone.w, h: Math.min(zone.h, h) };
  }
  return zone;
}

function allows(allow: AllowEmpty | undefined, ref: string): boolean {
  if (allow === undefined) return false;
  if (allow === true) return true;
  return allow.includes(ref);
}

/**
 * Score a collected frame. An empty result means the image may be published.
 */
export function evaluateShotGuards(
  report: FrameReport,
  opts: { allowEmpty?: AllowEmpty; safeInsetPx?: number } = {},
): GuardFinding[] {
  const findings: GuardFinding[] = [];

  // ── G-unsettled ──
  const settle = report.settle;
  const conditions: Array<[boolean, string, string]> = [
    [settle.fontsReady, "fonts", "document.fonts.ready never resolved - the capture would use the fallback face"],
    [settle.imagesDecoded, "images", "an <img> never decoded - it would be a blank box in the PNG"],
    [settle.domStable, "dom", "the DOM never held still for three consecutive snapshots"],
    [settle.actionsIdle, "actions", "the action queue never drained"],
    [settle.transportIdle, "transport", "a request was still in flight"],
  ];
  for (const [ok, subject, reason] of conditions) {
    if (!ok) {
      findings.push({
        guard: "G-unsettled",
        subject,
        reason,
        fix: "raise the settle budget for this shot, or fix what never rests",
      });
    }
  }
  for (const element of settle.restless) {
    findings.push({
      guard: "G-unsettled",
      subject: element,
      reason: "a continuous surface could not be frozen",
      fix: `give ${element} a poster/frame, or exclude it from this shot`,
    });
  }

  // ── G-blank ──
  //
  //  A slide with no text and no painted image is a rectangle of background colour. Nothing
  //  threw, no api failed, no collection was empty (there were none), and every settle
  //  condition held - so every other guard passes it, and it uploads to a store as a blank
  //  banner. This guard exists because that happened: a composition template whose layers
  //  silently collapsed to zero width rendered a flat 1024x500 rectangle and was reported ok.
  //
  //  Text OR an image is enough; a full-bleed screenshot with no caption is legitimate.
  const ink = report.ink;
  if (ink !== undefined && ink.text === 0 && ink.images === 0) {
    findings.push({
      guard: "G-blank",
      subject: "slide",
      reason: "the frame rendered no text and no image - it is a rectangle of background colour",
      fix: "check the template's layers: a layer that collapsed to zero size paints nothing",
    });
  }

  // ── G-cover ──
  //
  //  The containment law of the composed scene: a decoration may sit beside the phone, over
  //  the bezel, over the dissolve - anywhere - but the moment it covers READABLE app UI it
  //  must say so (`over: "screen"` on its data row). The app screen is the thing the store
  //  listing is selling and the thing review compares against the real build; a chip that
  //  drifts onto the greeting because a headline wrapped is not a design choice, it is the
  //  layout equivalent of an unresolved binding. This guard is what lets the freeform-feeling
  //  parts of a slide stay data-driven without freeform's failure mode.
  const scene = report.scene;
  if (scene !== undefined) {
    const readable = readableScreen(scene);
    if (readable !== null) {
      for (const d of scene.decor) {
        if (d.over === "screen") continue;
        const hit = intersect(d.rect, readable);
        if (hit === null || hit.w <= COVER_SLACK_PX || hit.h <= COVER_SLACK_PX) continue;
        findings.push({
          guard: "G-cover",
          subject: d.label,
          reason: `it covers ${Math.round(hit.w)}x${Math.round(hit.h)}px of readable app UI without declaring it`,
          fix: `move it off the screen, or declare over: "screen" on its row if covering the UI is the composition`,
        });
      }
    }
  }

  // ── G-safe ──
  //
  //  The safe-inset law: the card canvas is not a freeform poster. The device keeps the
  //  inset on its left and right (its top is flow, its bottom runs into the dissolve by
  //  design), and every decoration keeps it on all four edges unless its row declares
  //  `bleed: true`. The template's own padding is supposed to make a violation impossible;
  //  this guard is what notices when an edit makes it possible again.
  if (scene !== undefined && scene.card !== undefined && scene.card !== null) {
    const card = scene.card;
    if (scene.device !== undefined && scene.device !== null) {
      const hits = safeIntrusion(scene.device, card, opts.safeInsetPx ?? SAFE_INSET_PX,
        { left: true, right: true, top: false, bottom: false });
      for (const hit of hits) {
        findings.push({
          guard: "G-safe",
          subject: "device",
          reason: `the device sits ${hit} - it is glued to the card edge with no breathing room`,
          fix: "reduce deviceWidth: 100% is the largest lawful phone, sized against the safe width",
        });
      }
    }
    for (const d of scene.decor) {
      if (d.bleed === true) continue;
      const hits = safeIntrusion(d.rect, card, opts.safeInsetPx ?? SAFE_INSET_PX,
        { left: true, right: true, top: true, bottom: true });
      for (const hit of hits) {
        findings.push({
          guard: "G-safe",
          subject: d.label,
          reason: `it sits ${hit}`,
          fix: `move it inside the safe area, or declare bleed: true on its row if running off the card is the composition`,
        });
      }
    }
  }

  // ── G-empty ──
  for (const miss of report.seamMisses) {
    findings.push({
      guard: "G-empty",
      subject: miss,
      reason: "a request the armed response plane did not recognise",
      fix: "declare a sample= whose url template matches it, or record a cassette",
    });
  }
  for (const api of report.apis) {
    if (api.error !== null && api.error !== undefined) {
      findings.push({
        guard: "G-empty",
        subject: api.as,
        reason: `the api settled with an error (${JSON.stringify(api.error)})`,
        fix: `check the sample= or cassette entry for <api as="${api.as}"/>`,
      });
      continue;
    }
    if (api.blockedBy.length > 0 || api.status === "waiting") {
      findings.push({
        guard: "G-empty",
        subject: api.as,
        reason: `still gated on ${api.blockedBy.join(", ") || "an upstream block"}`,
        fix: "resolve the upstream block's inputs - its dependency never produced a value",
      });
      continue;
    }
    if (api.loading || api.refreshing) {
      findings.push({
        guard: "G-unsettled",
        subject: api.as,
        reason: "the block was still loading at capture",
        fix: "raise the settle budget for this shot",
      });
    }
  }
  for (const collection of report.collections) {
    if (collection.rows > 0) continue;
    if (allows(opts.allowEmpty, collection.ref)) continue;
    findings.push({
      guard: "G-empty",
      subject: collection.ref,
      reason: `a bound <${collection.tag}> rendered ZERO rows - this is the "No data found" screenshot`,
      fix: `give its bound data a sample=, or add allowEmpty="${collection.ref}" if the empty state IS the point`,
    });
  }

  return findings;
}

/** Did every settle condition hold? Kept separate so the driver can keep waiting rather
 *  than failing the moment one is false. */
export function settleHolds(settle: FrameSettle): boolean {
  return settle.fontsReady && settle.imagesDecoded && settle.domStable
    && settle.actionsIdle && settle.transportIdle && settle.restless.length === 0;
}
