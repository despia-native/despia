//
//  licence.ts — the export gate and the shelf model, CLI side.
//
//  THE RULE (00-plan.md D5): an open-only project exports freely, forever, with no licence and
//  no watermark. A project that bundles PREMIUM modules needs an entitlement for that app id,
//  because the export would otherwise carry premium source onto a machine that has not paid for
//  it. Nothing else about `despia export` changes.
//
//  THE REFUSAL ALWAYS OFFERS A FREE PATH. Two real options, one of which costs nothing: licence
//  the app, or remove the premium modules and export immediately. A gate with only a "pay us"
//  branch is where a tool stops being a tool, and the owner's constraint is explicit that we
//  cannot look worse than the alternative.
//
//  Verification here is DELIBERATELY SHALLOW: the CLI checks that an entitlement exists and
//  names this app. The cryptographic check is the runtime's job (Ed25519, offline, in the
//  licence module) because that is the copy an attacker cannot edit without infringing. A CLI
//  is on the user's machine; treating it as the enforcement point would be theatre.
//

export class LicenceError extends Error {}

import { coversApp, VARIANT_SUFFIXES } from "./entitlement.ts";

export const ENTITLEMENT_FILENAME = "despia-entitlement.json";
export const PRICING_URL = "https://despia.com/license";

/** The documented child-suffix set, mirroring sign_entitlement.rb. TestFlight and internal
 *  Play tracks ship as RELEASE builds under a child id. */
// One home, in entitlement.ts, beside the canonical-bytes contract the ruby signer and both
// native verifiers are corpus-bound to. Re-exported here so the public name does not move.
export { VARIANT_SUFFIXES };

export interface Entitlement {
  appId: string;
  platform: string;
  majorVersion: number;
  licenseId?: string;
  variants?: string[];
  signature?: string;
}

/** Does a signed appId cover the identifier this project builds under? */
// Re-exported, not reimplemented: the suffix rule and the suffix LIST live in entitlement.ts
// next to the canonical-bytes contract that the ruby signer and both native verifiers are
// corpus-bound to. A second copy here is a second chance for the list to drift, and the drift
// direction that matters is the permissive one — an export that ships premium source to a build
// no device would licence.
export { coversApp };

export interface ShelfSplit {
  open: string[];
  premium: string[];
}

/**
 * Split modules by their manifest `shelf`. PREMIUM REQUIRES THE EXPLICIT MARKER; anything else
 * is open.
 *
 * This is the OPPOSITE default to `Config/tiers.json`, deliberately, because the two answer
 * different questions. In the framework tree an unclassified module means "we have not decided
 * yet", and giving it away would be the irreversible mistake, so that policy fails closed. Here
 * an unclassified module means "somebody else wrote this": a developer's own module in their
 * own `Modules/` folder, or a third-party registry package. Failing closed HERE would
 * export-block every developer who writes their own module, which is the exact opposite of the
 * deal (00-plan.md D5: DIY is always free).
 *
 * Every first-party premium module carries the marker, because classify_tiers.rb stamps every
 * manifest in the framework tree (181 at last census).
 * Stripping it is editing licensed code, and the CLI was never the enforcement point anyway —
 * the runtime Ed25519 check is.
 */
export function splitByShelf(
  modules: ReadonlyArray<{ id: string; manifest: { [k: string]: unknown } }>,
): ShelfSplit {
  const open: string[] = [];
  const premium: string[] = [];
  for (const m of modules) {
    (m.manifest["shelf"] === "premium" ? premium : open).push(m.id);
  }
  return { open: open.sort(), premium: premium.sort() };
}

export interface GateInput {
  platform: string;
  appId: string;
  majorVersion: number;
  premium: readonly string[];
  entitlement: Entitlement | null;
}

export interface GateResult {
  allowed: boolean;
  /** The full refusal text, ready to print. Empty when allowed. */
  message: string;
  /** Present when allowed and premium modules ship: what the export now contains. */
  note?: string;
}

/**
 * The export decision. Pure, so the refusal wording is a test rather than a hope.
 */
export function exportGate(input: GateInput): GateResult {
  if (input.premium.length === 0) {
    return { allowed: true, message: "" };
  }
  const listed = input.premium.join(", ");
  const buy = `${PRICING_URL}?app=${encodeURIComponent(input.appId)}&platform=${encodeURIComponent(input.platform)}`;
  const refuse = (why: string): GateResult => ({
    allowed: false,
    message: [
      `this project bundles premium modules, so export needs a licence for this app.`,
      ``,
      `  premium in build:  ${listed}`,
      `  app id:            ${input.appId} (${input.platform})`,
      `  ${why}`,
      ``,
      `  Two ways forward:`,
      `    1. Licence this app   $249 one time, perpetual, includes 200 build credits`,
      `       ${buy}`,
      `       Export then includes full source for those modules. Nothing withheld.`,
      ``,
      `    2. Remove them        despia remove ${input.premium.join(" ")}`,
      `       Export works immediately, free, no watermark, no licence.`,
    ].join("\n"),
  });

  if (input.entitlement === null) {
    return refuse(`no ${ENTITLEMENT_FILENAME} in the project root.`);
  }
  if (!coversApp(input.entitlement, input.appId)) {
    return refuse(`${ENTITLEMENT_FILENAME} is for ${JSON.stringify(input.entitlement.appId)}, not this app.`);
  }
  if (input.entitlement.platform !== input.platform) {
    return refuse(`${ENTITLEMENT_FILENAME} covers ${input.entitlement.platform}, and this is ${input.platform} (each platform is its own licence).`);
  }
  if (Number(input.entitlement.majorVersion) !== input.majorVersion) {
    return refuse(`${ENTITLEMENT_FILENAME} covers Despia ${input.entitlement.majorVersion}, and this is ${input.majorVersion} (a major version is a new licence).`);
  }
  return {
    allowed: true,
    message: "",
    note: `licensed (${input.entitlement.licenseId ?? "no id"}) — the export includes source for ${input.premium.length} premium module(s)`,
  };
}
