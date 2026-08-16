//
//  scene/bind.ts - data-driven scene children (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/bind.json. `<group bind="dsx.variable.enemies"
//  key="id">` instantiates its template children once per array row; the row scope
//  binds `item.*` exactly like `<list>` (each surface reuses its own list-row resolve
//  mechanism); add/remove/reorder are KEYED (the list keying law verbatim, including
//  the `·n` duplicate suffix); removing a row removes its subtree and stops its
//  animations. This module is the platform-neutral half: row keying, the keyed diff,
//  and template instantiation — the renderer owns scopes, disposal and draw.
//

import type { SceneDiag, SceneNode } from "./ir.ts";

/** the row cap — a hostile array cannot mint an unbounded draw list (the
 *  BOUND_COLLECTION_LIMIT stance, scene-sized) */
export const SCENE_BIND_LIMIT = 256;

export type SceneBindRow = { key: string; index: number; item: unknown };

function isPlainDict(value: unknown): value is { [k: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** THE ROW LAW: a non-array binds zero rows; a dict row keys on
 *  String(row[keyField] ?? index), a scalar row on String(row); duplicate keys get the
 *  `·1`, `·2`… suffix in encounter order (the list keying law); rows past
 *  SCENE_BIND_LIMIT are dropped with one diagnostic. */
export function sceneBindRows(value: unknown, keyField: string, diag?: SceneDiag): SceneBindRow[] {
  if (!Array.isArray(value)) return [];
  if (value.length > SCENE_BIND_LIMIT) {
    diag?.({ code: "bind-overflow", message: `<group bind> has ${value.length} rows — instantiating the first ${SCENE_BIND_LIMIT}` });
  }
  const rows = value.length > SCENE_BIND_LIMIT ? value.slice(0, SCENE_BIND_LIMIT) : value;
  const counts = new Map<string, number>();
  return rows.map((item, index) => {
    const base = isPlainDict(item) ? String(item[keyField] ?? index) : String(item);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return { key: seen === 0 ? base : `${base}·${seen}`, index, item };
  });
}

export type SceneBindDiff = {
  /** keys mounting fresh subtrees, in row order */
  added: string[];
  /** keys whose subtrees unmount (dispose bindings, stop animations) */
  removed: string[];
  /** keys keeping their instantiated subtree (identity survives reorder) */
  retained: string[];
};

/** THE KEYED-IDENTITY LAW: a key present on both sides keeps its instantiated subtree
 *  across any reorder; a new key mounts; a vanished key unmounts. Pure — the corpus
 *  pins reorder scenarios as data. */
export function diffSceneBindRows(previous: readonly string[], next: readonly SceneBindRow[]): SceneBindDiff {
  const before = new Set(previous);
  const now = new Set(next.map((r) => r.key));
  const added: string[] = [], removed: string[] = [], retained: string[] = [];
  for (const row of next) (before.has(row.key) ? retained : added).push(row.key);
  for (const key of previous) if (!now.has(key)) removed.push(key);
  return { added, removed, retained };
}

/** deep-clone a template subtree with FRESH node identities (per-row caches, handler
 *  scopes and animation states key on the node object) while sharing the immutable
 *  `source` markup — the renderer's way back to its binding machinery. A prefab
 *  expansion root keeps its `prefab` stamp (G1): a spawned row instantiates the prefab
 *  with a fresh per-instance identity + the shared raw scope. */
export function instantiateSceneRow(template: readonly SceneNode[]): SceneNode[] {
  return template.map((node) => ({
    kind: node.kind,
    id: node.id,
    attrs: node.attrs,
    children: instantiateSceneRow(node.children),
    ...(node.source !== undefined ? { source: node.source } : {}),
    ...(node.prefab !== undefined ? { prefab: node.prefab } : {}),
    ...(node.mode2d !== undefined ? { mode2d: node.mode2d } : {}),
  }));
}
