export type AdaptiveShellWidths = { min: number; ideal: number; max: number };

export type AdaptiveShellPlan = {
  layout: "custom" | "stack" | "content" | "split2" | "split3" | "native2" | "native3";
  mode: "automatic" | "native" | "custom";
  collapse: "platform" | "stack" | "content" | "none";
  compact: boolean;
  compactAt: number;
  sidebar: AdaptiveShellWidths;
  inspector: AdaptiveShellWidths;
};

export type AdaptiveShellPanes = { sidebar: boolean; content: boolean; inspector: boolean };

const allowedModes = new Set(["automatic", "native", "custom"]);
const allowedCollapse = new Set(["platform", "stack", "content", "none"]);
const decimalNumber = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function word<T extends string>(raw: string | undefined, allowed: Set<string>, fallback: T): T {
  const value = raw?.trim().toLowerCase() ?? "";
  return (allowed.has(value) ? value : fallback) as T;
}

function finite(raw: string | undefined, fallback: number): number {
  const text = raw?.trim() ?? "";
  if (!decimalNumber.test(text)) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

function widths(
  attrs: Readonly<Record<string, string>>,
  prefix: "sidebar" | "inspector",
  defaults: AdaptiveShellWidths,
): AdaptiveShellWidths {
  const min = Math.min(1024, Math.max(120, finite(attrs[`${prefix}Min`], defaults.min)));
  const ideal = Math.min(1600, Math.max(min, finite(attrs[`${prefix}Ideal`], defaults.ideal)));
  const authoredMax = Math.min(1600, Math.max(120, finite(attrs[`${prefix}Max`], defaults.max)));
  const max = Math.max(ideal, authoredMax);
  return { min, ideal, max };
}

/** Shared adaptive-scaffold resolver. Its fixture is
 * OpenSource/Conformance/layout/adaptive-shell.json; Apple is the only current
 * renderer that passes nativeAvailable=true. */
export function resolveAdaptiveShell(
  attrs: Readonly<Record<string, string>>,
  width: number,
  nativeAvailable: boolean,
  panes: AdaptiveShellPanes,
): AdaptiveShellPlan {
  const mode = word<AdaptiveShellPlan["mode"]>(attrs["shell"], allowedModes, "custom");
  const collapse = word<AdaptiveShellPlan["collapse"]>(
    attrs["collapse"], allowedCollapse, "platform",
  );
  const compactAt = Math.min(4096, Math.max(320, finite(attrs["compactAt"], 760)));
  const boundedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const compact = boundedWidth < compactAt;
  const sidebar = widths(attrs, "sidebar", { min: 220, ideal: 280, max: 360 });
  const inspector = widths(attrs, "inspector", { min: 240, ideal: 320, max: 420 });
  const eligible = mode !== "custom" && panes.sidebar && panes.content;

  let layout: AdaptiveShellPlan["layout"];
  if (!eligible) layout = "custom";
  else if (compact && collapse === "content") layout = "content";
  else if (compact && collapse === "stack") layout = "stack";
  else if (compact && collapse === "none") layout = panes.inspector ? "split3" : "split2";
  else if (compact && collapse === "platform" && !nativeAvailable) layout = "stack";
  else if (nativeAvailable) layout = panes.inspector ? "native3" : "native2";
  else layout = panes.inspector ? "split3" : "split2";

  return { layout, mode, collapse, compact, compactAt, sidebar, inspector };
}
