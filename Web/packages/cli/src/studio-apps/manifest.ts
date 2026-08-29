//
//  studio-apps/manifest.ts — the APP MANIFEST reader (proposals/studio-apps.md §3).
//
//  A Despia app is an ordinary registry package whose dsx.json adds `"studioApi": <major>`
//  and `facets.apps` contribution rows. This file is the OPEN validator of that grammar —
//  the one the CLI, the editor host and the apps-shelf CI all run. Its ruby twin
//  (ClosedSource/scripts/check_studio_apps.rb) validates the in-tree first-party app
//  modules with the SAME rules; both are driven by OpenSource/Conformance/studio-apps/
//  manifest.json, so the two validators cannot drift (the lint_conformance pattern).
//
//  Every vocabulary here is CLOSED and pinned in OpenSource/Web/support/studio-api-v1.json
//  (the contract artifact; public-api-contract-style test). Additions are additive within a
//  studioApi major; a removal or rename forces the major — durability P5 applied to the
//  app surface.
//

export const STUDIO_API = 1;

/** The slot vocabulary v1 — six, closed (studio-apps.md §4). */
export const APP_SLOTS = [
  // THE SIDE PANEL IS THE DEFAULT PLACEMENT (studio-apps.md §4.1). A plugin that takes the
  // whole window every time it is opened is a plugin nobody keeps open: the work an app
  // does is BESIDE the work you are doing, so `studio.panel` docks a column next to the
  // live preview and the agent, and PROMOTES to the full work area on demand. `studio.rail`
  // stays for the app that genuinely IS a destination (a board, a canvas, a whole editor).
  "studio.panel",
  "studio.rail",
  "studio.inspector.section",
  "studio.style.section",
  "dashboard.card",
  "tool",
  "automation",
] as const;
export type AppSlot = (typeof APP_SLOTS)[number];

/** Editor-session events an app may subscribe to (studio-apps.md §7.1). */
export const EDITOR_EVENTS = [
  "document.saved",
  "document.opened",
  "selection.changed",
  "build.finished",
  "lint.finished",
  "deploy.requested",
  "deploy.finished",
  "app.installed",
  "app.enabled",
  "app.disabled",
] as const;

/** Platform events an automation row may bind (owner-gated to deliver; typed-absent locally). */
export const PLATFORM_EVENTS = [
  "platform.release.published",
  "platform.pr.opened",
  "platform.build.finished",
  "platform.order.created",
] as const;

/** The fixed grant words (studio-apps.md §6). Parameterized grants are validated by shape. */
export const FIXED_GRANTS = [
  "project:read",
  "project:write",
  "selection:read",
  "automation:deploy",
  "automation:auto",
] as const;

/** Parameterized grant shapes: prefix → the parameter rule. */
const NET_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENTITY_NAME = /^[a-z][a-z0-9_]*$/;

/** Which grants a slot may hold (studio-apps.md §3.3: grants⊆slot-legal, abort tier).
 *  UI slots reach the studio residence; automation rows reach the server residence;
 *  tool rows ride declared actions and hold no grants of their own. */
const UI_GRANTS = new Set<string>(["project:read", "project:write", "selection:read"]);
const AUTOMATION_GRANTS = new Set<string>(["automation:deploy", "automation:auto"]);

/** The per-entry execution ceilings an app may lower and never raise (§5). */
export const APP_BUDGETS = { loopCap: 200_000, deadlineMs: 30_000, calls: 128 } as const;

/** The closed issue vocabulary. A code here is a contract; the corpus pins each one. */
export const APP_MANIFEST_CODES = [
  "missing_studio_api",
  "unsupported_studio_api",
  "bad_contribution_id",
  "unknown_slot",
  "missing_component",
  "forbidden_component",
  "bad_component_path",
  "missing_title",
  "missing_icon",
  "unknown_grant",
  "grant_not_slot_legal",
  "unknown_event",
  "event_not_slot_legal",
  "missing_on",
  "unknown_automation_event",
  "missing_run",
  "bad_run",
  "bad_mode",
  "auto_needs_grant",
  "missing_action",
  "bad_order",
  "bad_row",
] as const;
export type AppManifestCode = (typeof APP_MANIFEST_CODES)[number];

export type AppContribution = {
  id: string;
  slot: AppSlot;
  component?: string;
  title?: string;
  icon?: string;
  order: number;
  grants: string[];
  events: string[];
  on?: string;
  run?: string;
  mode: "draft" | "auto";
  action?: string;
  description?: string;
};

export type AppManifestInfo = {
  name: string;
  scheme: string;
  version: string;
  summary: string;
  studioApi: number;
  contributions: AppContribution[];
};

export type AppManifestIssue = { code: AppManifestCode; path: string; message: string };

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;
const UI_SLOTS = new Set<string>(["studio.panel", "studio.rail", "studio.inspector.section", "studio.style.section", "dashboard.card"]);
/** The two slots that put a row in the Studio's rail, so both carry an identity mark. */
const RAIL_SLOTS = new Set<string>(["studio.panel", "studio.rail"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A grant is legal when it is a fixed word or matches a parameterized shape. */
export function grantLegal(grant: string): boolean {
  if ((FIXED_GRANTS as readonly string[]).includes(grant)) return true;
  if (grant.startsWith("net:")) return NET_HOST.test(grant.slice("net:".length));
  if (grant.startsWith("secret:")) return SECRET_NAME.test(grant.slice("secret:".length));
  if (grant.startsWith("data:")) return ENTITY_NAME.test(grant.slice("data:".length));
  return false;
}

/** Is this grant admissible on this slot? net:/secret: ride both residences (a panel may call
 *  its vendor; an automation may too); data: is automation-plane only; the fixed words split. */
function grantSlotLegal(grant: string, slot: AppSlot): boolean {
  if (grant.startsWith("net:")) return slot !== "tool";
  if (grant.startsWith("secret:")) return slot === "automation";
  if (grant.startsWith("data:")) return slot === "automation";
  if (UI_GRANTS.has(grant)) return UI_SLOTS.has(slot);
  if (AUTOMATION_GRANTS.has(grant)) return slot === "automation";
  return false;
}

/**
 * Read + validate one app manifest (a parsed dsx.json). Returns every issue rather than the
 * first, so a shelf CI comment can show the whole list; `info` is null when any issue exists —
 * fail-closed, a partially valid app never mounts.
 *
 * A manifest with NO `facets.apps` rows is not an app: `{ info: null, issues: [] }` — the
 * caller distinguishes "not an app" (both empty-ish) from "a broken app" (issues non-empty).
 */
export function readAppManifest(manifest: unknown): { info: AppManifestInfo | null; issues: AppManifestIssue[] } {
  if (!isRecord(manifest)) return { info: null, issues: [{ code: "bad_row", path: "", message: "the manifest is not an object" }] };
  const facets = isRecord(manifest["facets"]) ? (manifest["facets"] as Record<string, unknown>) : {};
  const rows = isRecord(facets["apps"]) ? (facets["apps"] as Record<string, unknown>) : null;
  if (rows === null || Object.keys(rows).filter((k) => !k.startsWith("_")).length === 0) {
    return { info: null, issues: [] };
  }

  const issues: AppManifestIssue[] = [];
  const push = (code: AppManifestCode, path: string, message: string): void => { issues.push({ code, path, message }); };

  const studioApiRaw = manifest["studioApi"];
  if (studioApiRaw === undefined) {
    push("missing_studio_api", "studioApi", 'an app manifest pins the Studio API it was built for — add `"studioApi": 1`');
  } else if (typeof studioApiRaw !== "number" || !Number.isInteger(studioApiRaw) || studioApiRaw < 1) {
    push("missing_studio_api", "studioApi", "studioApi must be a positive integer");
  } else if (studioApiRaw !== STUDIO_API) {
    push("unsupported_studio_api", "studioApi", `this toolchain speaks Studio API ${STUDIO_API}; the manifest pins ${studioApiRaw}`);
  }

  const contributions: AppContribution[] = [];
  for (const [id, raw] of Object.entries(rows)) {
    if (id.startsWith("_")) continue;
    const path = `facets.apps.${id}`;
    if (!CONTRIBUTION_ID.test(id)) {
      push("bad_contribution_id", path, `contribution ids are lowercase kebab-case (got ${JSON.stringify(id)})`);
      continue;
    }
    if (!isRecord(raw)) {
      push("bad_row", path, "a contribution row is an object");
      continue;
    }
    const slotRaw = str(raw["slot"]);
    if (slotRaw === undefined || !(APP_SLOTS as readonly string[]).includes(slotRaw)) {
      push("unknown_slot", `${path}.slot`, `slot must be one of ${APP_SLOTS.join(" · ")} (got ${JSON.stringify(raw["slot"] ?? null)})`);
      continue;
    }
    const slot = slotRaw as AppSlot;

    const component = str(raw["component"]);
    const title = str(raw["title"]);
    const icon = str(raw["icon"]);
    const on = str(raw["on"]);
    const run = str(raw["run"]);
    const action = str(raw["action"]);
    const modeRaw = str(raw["mode"]) ?? "draft";
    const orderRaw = raw["order"];

    // grants + events arrive as arrays (the generic facet grammar carries them as `object`)
    const grants: string[] = Array.isArray(raw["grants"]) ? (raw["grants"] as unknown[]).map((g) => String(g)) : [];
    const events: string[] = Array.isArray(raw["events"]) ? (raw["events"] as unknown[]).map((e) => String(e)) : [];

    if (UI_SLOTS.has(slot)) {
      if (component === undefined) push("missing_component", `${path}.component`, `a ${slot} contribution names the component it mounts`);
      if (title === undefined) push("missing_title", `${path}.title`, `a ${slot} contribution carries a title (the label a person sees)`);
      if (RAIL_SLOTS.has(slot) && icon === undefined) push("missing_icon", `${path}.icon`, `a ${slot} contribution carries an icon (its identity mark in the rail)`);
      if (on !== undefined || run !== undefined) push("bad_row", path, `\`on\`/\`run\` belong to automation rows, not ${slot}`);
    }
    if (slot === "automation") {
      if (component !== undefined) push("forbidden_component", `${path}.component`, "an automation has no UI — drop `component`");
      if (on === undefined) {
        push("missing_on", `${path}.on`, "an automation names the event it runs on");
      } else if (!(EDITOR_EVENTS as readonly string[]).includes(on) && !(PLATFORM_EVENTS as readonly string[]).includes(on)) {
        push("unknown_automation_event", `${path}.on`, `unknown event ${JSON.stringify(on)} — editor events: ${EDITOR_EVENTS.join(", ")}; platform events: ${PLATFORM_EVENTS.join(", ")}`);
      }
      if (run === undefined) {
        push("missing_run", `${path}.run`, 'an automation names its handler: `"run": "Server/Automations.dsx#actionName"`');
      } else if (!/^[A-Za-z0-9_/.-]+\.dsx#[A-Za-z_][A-Za-z0-9_]*$/.test(run) || run.includes("..") || run.startsWith("/")) {
        push("bad_run", `${path}.run`, "run is a package-relative document + action: `Path/Doc.dsx#action` (no `..`, no leading `/`)");
      }
      if (modeRaw !== "draft" && modeRaw !== "auto") push("bad_mode", `${path}.mode`, 'mode is "draft" (the default) or "auto"');
      if (modeRaw === "auto" && !grants.includes("automation:auto")) {
        push("auto_needs_grant", `${path}.mode`, 'mode "auto" requires the automation:auto grant, shown at install');
      }
      if (!grants.includes("automation:deploy")) {
        push("grant_not_slot_legal", `${path}.grants`, "an automation row carries automation:deploy — installing it changes the user's deployment, and the grant is how that is said");
      }
    }
    if (slot === "tool") {
      if (action === undefined) push("missing_action", `${path}.action`, "a tool contribution names the published tool (the name the CLI and MCP faces expose)");
      if (grants.length > 0) push("grant_not_slot_legal", `${path}.grants`, "a tool row holds no grants — it rides the app's consented grants at run time");
      if (component !== undefined) push("forbidden_component", `${path}.component`, "a tool row projects a descriptor, it mounts nothing — drop `component`");
      // An interface is ONE consumer of an app (studio-apps.md §9): every tool is
      // headless-runnable, so the row names its implementation the way an automation does.
      if (run === undefined) {
        push("missing_run", `${path}.run`, 'a tool names its implementation: `"run": "Server/Tools.dsx#actionName"` — the same narrowed document grammar automations use, runnable from the Studio, the CLI (`despia app run`) and the MCP face alike');
      } else if (!/^[A-Za-z0-9_/.-]+\.dsx#[A-Za-z_][A-Za-z0-9_]*$/.test(run) || run.includes("..") || run.startsWith("/")) {
        push("bad_run", `${path}.run`, "run is a package-relative document + action: `Path/Doc.dsx#action` (no `..`, no leading `/`)");
      }
      if (on !== undefined) push("bad_row", path, "`on` belongs to automation rows — a tool is invoked, never event-bound");
    }
    if (component !== undefined && (component.includes("..") || component.startsWith("/") || !component.endsWith(".dsx"))) {
      push("bad_component_path", `${path}.component`, "component is a package-relative .dsx path with no `..` and no leading `/`");
    }

    for (const g of grants) {
      if (!grantLegal(g)) {
        push("unknown_grant", `${path}.grants`, `unknown grant ${JSON.stringify(g)}`);
      } else if (!grantSlotLegal(g, slot)) {
        push("grant_not_slot_legal", `${path}.grants`, `${JSON.stringify(g)} is not admissible on a ${slot} contribution`);
      }
    }
    for (const e of events) {
      if (!(EDITOR_EVENTS as readonly string[]).includes(e)) {
        push("unknown_event", `${path}.events`, `unknown editor event ${JSON.stringify(e)}`);
      } else if (!UI_SLOTS.has(slot)) {
        push("event_not_slot_legal", `${path}.events`, "only UI contributions subscribe to editor events; an automation binds `on`");
      }
    }

    let order = 500;
    if (orderRaw !== undefined) {
      const n = typeof orderRaw === "number" ? orderRaw : typeof orderRaw === "string" ? Number(orderRaw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        push("bad_order", `${path}.order`, "order is an integer 0–999");
      } else order = n;
    }

    contributions.push({
      id,
      slot,
      ...(component !== undefined ? { component } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(icon !== undefined ? { icon } : {}),
      order,
      grants,
      events,
      ...(on !== undefined ? { on } : {}),
      ...(run !== undefined ? { run } : {}),
      mode: modeRaw === "auto" ? "auto" : "draft",
      ...(action !== undefined ? { action } : {}),
      ...(str(raw["description"]) !== undefined ? { description: str(raw["description"])! } : {}),
    });
  }

  if (issues.length > 0) return { info: null, issues };

  contributions.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return {
    info: {
      name: str(manifest["name"]) ?? "",
      scheme: str(manifest["scheme"]) ?? "",
      version: str(manifest["version"]) ?? "0.0.0",
      summary: str(manifest["summary"]) ?? "",
      studioApi: STUDIO_API,
      contributions,
    },
    issues: [],
  };
}

/** The union of every grant an app asks for, in first-seen order — what an install dialog shows. */
export function manifestGrants(info: AppManifestInfo): string[] {
  const out: string[] = [];
  for (const c of info.contributions) for (const g of c.grants) if (!out.includes(g)) out.push(g);
  return out;
}
