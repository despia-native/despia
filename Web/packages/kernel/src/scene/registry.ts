//
//  registry.ts — the SceneRegistry seam (dsx-game.md §2 G5): the kernel-side door
//  between mounted `<scene>` ELEMENTS and the `scene` bus MODULE (Core/Scene).
//
//  THE SEAM CONTRACT (the JsTier.engine / SceneAR.provider shape, web-spelled): each
//  mounted scene element registers a SceneBusHandle here (keyed by its `id` attr, or
//  the auto key `scene#N`) and unregisters on unmount; the module's actions resolve a
//  target scene by that key (absent = the FIRST mounted scene) and drive the element
//  through the handle — never the other way around. The kernel names no module: the
//  registry is plain data, and a build with no Core/Scene web facet simply has no
//  reader (dsx.has("scene") === false, never a crash).
//
//  The store lives on `globalThis` under `Symbol.for("dsx.scene-surfaces.v1")` — the
//  Dom facet's `dsx.web-surfaces.v1` precedent — because the module's web facet is
//  bundled INDEPENDENTLY (build-demo esbuild) and must not import (and duplicate)
//  @despia/kernel. Both sides speak the one Symbol.for name; this file is the typed owner.
//
//  Events ride the seam too: the element emits `ready` / `collide` through
//  sceneBusEmit, and whoever subscribed (the Core/Scene facet, in boot) re-fires them
//  on the standard bus planes as `scene.ready` / `scene.collide` — the element itself
//  never touches the bus (modules provide, surfaces consume).
//

/** one frame of capture evidence — `image` is a data URL (web) or base64 (JVM) */
export type SceneBusCapture = { image: string; width: number; height: number };

/** one resolved node of the bus-facing tree (props are the RESOLVED strings —
 *  overrides applied, the same plane the renderer draws from) */
export type SceneBusNode = {
  kind: string;
  id: string;
  props: { [name: string]: string };
  /** world position [x, y, z] (the corpus world matrix's translation), when the node
   *  carries a world entry (renderable kinds + groups) */
  world: number[] | null;
  children: SceneBusNode[];
};

/** what a mounted `<scene>` element binds into the registry */
export type SceneBusHandle = {
  /** the element's authored `id` attr, or null */
  readonly id: string | null;
  nodes(): SceneBusNode[];
  /** "ok" | "node_not_found" | "bad_attr" — writes ride the resolved-attribute BASE
   *  plane, so an authored `transition=` glides the change (the P5 override plane) */
  set(id: string, attr: string, value: string): string;
  camera(): { position: string; lookAt: string; fov: number; authored: boolean };
  /** "ok" | "no_camera" | "bad_value"; flyTo rides the P5 transition path (EASE-OUT) */
  cameraSet(spec: { position?: string; lookAt?: string; flyTo?: string; durationMs?: number }): string;
  /** null = no live framebuffer (WebGL unavailable, zero-sized) → capture_failed */
  capture(): SceneBusCapture | null;
  /** normalized (x, y) ∈ [0,1] — the pick math of on:tap, WITHOUT firing handlers */
  pick(x: number, y: number): { id: string; kind: string } | null;
  /** the currently overlapping collider pairs (authored ids, "" when none) */
  contacts(): Array<{ a: string; b: string; depth: number }>;
  stats(): { nodes: number; animations: number; lastFrameDt: number; boundRows: number };
};

export type SceneBusListener = (scene: string, kind: string, payload: unknown) => void;

/** the seam's shared shape — both the kernel (this file) and the independently
 *  bundled module facet read exactly this */
export type SceneSurfaceSeam = {
  order: string[];
  surfaces: Map<string, SceneBusHandle>;
  listeners: Set<SceneBusListener>;
  serial: number;
};

const SCENE_SURFACES_KEY = Symbol.for("dsx.scene-surfaces.v1");

export function sceneSurfaceSeam(): SceneSurfaceSeam {
  const scope = globalThis as typeof globalThis & { [SCENE_SURFACES_KEY]?: SceneSurfaceSeam };
  if (scope[SCENE_SURFACES_KEY] === undefined) {
    scope[SCENE_SURFACES_KEY] = { order: [], surfaces: new Map(), listeners: new Set(), serial: 0 };
  }
  return scope[SCENE_SURFACES_KEY];
}

/** register a mounted scene; returns its key (the id attr, or `scene#N`). A duplicate
 *  id keeps BOTH scenes addressable — the later one gets the auto key, loudly. */
export function sceneBusRegister(handle: SceneBusHandle): string {
  const seam = sceneSurfaceSeam();
  seam.serial += 1;
  let key = handle.id !== null && handle.id.length > 0 ? handle.id : `scene#${seam.serial}`;
  if (seam.surfaces.has(key)) {
    console.warn(`[dsx scene] duplicate scene id "${key}" — registering as scene#${seam.serial}`);
    key = `scene#${seam.serial}`;
  }
  seam.surfaces.set(key, handle);
  seam.order.push(key);
  return key;
}

export function sceneBusUnregister(key: string): void {
  const seam = sceneSurfaceSeam();
  seam.surfaces.delete(key);
  const i = seam.order.indexOf(key);
  if (i >= 0) seam.order.splice(i, 1);
}

/** resolve a target scene: an explicit key, or the FIRST mounted scene (document /
 *  mount order) when none is named. null = scene_not_found. */
export function sceneBusResolve(scene?: string | null): SceneBusHandle | null {
  const seam = sceneSurfaceSeam();
  if (scene !== undefined && scene !== null && scene.length > 0) {
    return seam.surfaces.get(scene) ?? null;
  }
  const first = seam.order[0];
  return first === undefined ? null : seam.surfaces.get(first) ?? null;
}

/** the element-side event door: ready / collide flow through here to whoever listens
 *  (the Core/Scene facet re-fires them on the bus). A listener that throws is skipped —
 *  one bad observer never breaks the element (the delegate-fold stance). */
export function sceneBusEmit(scene: string, kind: string, payload: unknown): void {
  for (const listener of sceneSurfaceSeam().listeners) {
    try { listener(scene, kind, payload); } catch (e) { console.warn(`[dsx scene] bus listener (${kind}):`, e); }
  }
}
