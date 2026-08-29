//
//  screengraph.ts - the project's screen graph, DERIVED from its own source.
//
//  THE PROBLEM. A folder of .dsx files is a list of names. It does not tell you how many
//  screens there are, which are reachable, what gets you from one to the next, or which ones
//  nothing points at. Every one of those facts is already in the files, and nobody can see
//  them. That is the whole reason the canvas exists (v4-launch/platform/02-canvas.md), and
//  this module is the half that has to be TRUE - the picture is downstream of it.
//
//  WHAT MAKES IT HONEST. Nothing here is authored, stored or positioned by hand. The graph is
//  a pure function of the documents plus the route table, so there is no canvas file to go
//  stale, nothing to merge, and a wrong map is a bug in this file rather than an old drawing
//  somebody forgot to update. That is M4 (the code is the single source of truth) applied to a
//  diagram: a canvas that could disagree with the code is worse than no canvas.
//
//  WHAT IT DELIBERATELY DOES NOT DO. It does not execute anything. A navigation target built
//  at runtime out of data this scanner cannot see is reported as DYNAMIC rather than guessed,
//  because a map that invents an edge is worse than one that admits an unknown.
//

import { parseDsx, type XmlNode } from "./xml.ts";

export type SurfaceKind = "route" | "pushed" | "sheet" | "part" | "server" | "cli";

/** How one surface reaches another. `call` is a request, not a navigation. */
export type EdgeKind = "push" | "replace" | "reset" | "present" | "back" | "call";

export type ScreenNode = {
  /** stable address: the document's project-relative path without the extension */
  id: string;
  /** the document's own name, humanised - never a generated one (M3) */
  name: string;
  kind: SurfaceKind;
  /** the route pattern this surface answers, when it is routed */
  path?: string;
  file: string;
  /** no incoming edge and not routed: dead code with a picture, and the point of the map */
  reachable: boolean;
  /**
   * Every surface a person could be on before arriving here, transitively, sorted.
   *
   * DERIVED HERE rather than in whatever draws the map, because "how does anyone GET to this
   * screen" is a graph fact, not a rendering one - and the one place it is computed is the
   * one place it can be tested. It is also the only shape a `<variable computed>` can consume:
   * a computed body is branch-only by law (no `for`, no `while`, so it always terminates), and
   * a transitive walk expressed in markup would be a loop that silently does not run.
   *
   * NAVIGATION ONLY: composition counts for `reachable` above, but a component embedded in a
   * screen is not somewhere you navigate FROM, and listing it here would make the trace claim
   * a route that does not exist.
   */
  ancestors: string[];
};

export type ScreenEdge = {
  from: string;
  /** a node id, or null when the target could not be resolved statically */
  to: string | null;
  kind: EdgeKind;
  /** the target as written, kept verbatim for a dangling or dynamic edge */
  target: string;
  /** TAP, SUBMIT, CHANGE, ON APPEAR, or "2 WAYS" - the thing a person does */
  gesture: string;
  /** distinct call sites that collapse to this same edge */
  count: number;
  /** true when the target interpolates something this scanner cannot resolve */
  dynamic: boolean;
};

export type ScreenGraph = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  /**
   * Where the app STARTS, when it says so. The root plan names one entry surface, and a map
   * that does not know it ranks a cyclic app from whichever screen sorts first - so a
   * storefront opens with `Cart` at the top and `Home` three rows down. Null when the project
   * declares no entry, and then the layout falls back to sorted order as before.
   */
  entry: string | null;
  /** targets that matched no route and no document - a link to a screen that does not exist */
  dangling: string[];
};

export type GraphDocument = {
  /** project-relative path, e.g. "Components/Home.dsx" */
  file: string;
  source: string;
};

export type GraphRoute = { path: string; component?: string };

/**
 * Is this document's ROOT ELEMENT `<server>`?
 *
 * Not a substring test. A component that so much as MENTIONS `<server>` in a comment would be
 * drawn on the map as a backend, which is a wrong node kind on the one surface whose whole
 * claim is that it never invents anything. Found on the Studio's own source, which explains in
 * a comment why the inspector is hidden for a server document and was therefore drawn as one.
 */
function isServerRoot(source: string): boolean {
  return /^\s*(?:<\?[^>]*\?>\s*)?<server[\s>]/.test(source.replace(/<!--[\s\S]*?-->/g, ""));
}

/** `Components/Delivery/RestaurantMenu.dsx` becomes `Delivery.RestaurantMenu` */
function idFor(file: string): string {
  return file
    .replace(/\.(cli|server)?\.?dsx$/i, "")
    .replace(/^Components\//, "")
    .split("/")
    .join(".");
}

/** `RestaurantMenu` becomes `Restaurant Menu`; `restaurant-menu` becomes `Restaurant Menu`.
 *  The name a person gets is the one they typed, spaced out - never `screen-14`. */
export function humanise(base: string): string {
  const words = base
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words.map((w) => (w.length <= 1 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

/** `on:tap` gives `TAP`; `on:appear` gives `ON APPEAR`. The gesture IS the handler it sits in. */
function gestureFor(attr: string): string {
  const name = attr.startsWith("on:") ? attr.slice(3) : attr;
  const bare = name.split(".")[0]!;                    // strip .debounce / .throttle
  return bare === "appear" || bare === "disappear"
    ? `ON ${bare.toUpperCase()}`
    : bare.toUpperCase();
}

/** A route pattern matches a written target when their segments line up, with `:param`
 *  matching any one segment. `/orders/{{ item.id }}` resolves to the pattern `/orders/:id`,
 *  because the pattern is the screen and the id is data. */
export function matchRoute(target: string, routes: readonly GraphRoute[]): GraphRoute | null {
  const clean = target.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "") || "/";
  const parts = clean.split("/").filter((p) => p.length > 0);
  let best: GraphRoute | null = null;
  let bestScore = -1;
  for (const route of routes) {
    const rp = route.path.replace(/\/+$/, "") || "/";
    const rparts = rp.split("/").filter((p) => p.length > 0);
    if (rparts.length !== parts.length) continue;
    let score = 0;
    let ok = true;
    for (const [i, rpart] of rparts.entries()) {
      const part = parts[i]!;
      if (rpart.startsWith(":")) { score += 1; continue; }   // a param eats anything
      // A written segment that still carries an interpolation cannot be compared literally;
      // treat it as a wildcard rather than refusing the whole route.
      if (part.includes("{{")) { score += 1; continue; }
      if (rpart === part) { score += 2; continue; }
      ok = false;
      break;
    }
    if (ok && score > bestScore) { best = route; bestScore = score; }
  }
  return best;
}

/** One navigation found in a body or an attribute, before targets are resolved to nodes. */
type RawEdge = { kind: EdgeKind; target: string; gesture: string };

const ROUTE_VERBS: { [verb: string]: EdgeKind } = {
  push: "push", replace: "replace", reset: "reset", popTo: "back",
};

/** Find every navigation inside one JSE body. Static scanning by design: this runs over a
 *  project that may not build, and it must never execute author code. */
function scanBody(body: string, gesture: string): RawEdge[] {
  const found: RawEdge[] = [];
  // route.<verb>({ path: '...' }) - the history verbs
  for (const m of body.matchAll(/\broute\s*\.\s*(push|replace|reset|popTo)\s*\(\s*\{[^}]*?\bpath\s*:\s*(['"])([^'"]*)\2/g)) {
    found.push({ kind: ROUTE_VERBS[m[1]!]!, target: m[3]!, gesture });
  }
  // pop() / popToRoot() - a return along the stack, with no literal target
  for (const m of body.matchAll(/\broute\s*\.\s*(pop|popToRoot)\s*\(/g)) {
    found.push({ kind: "back", target: m[1] === "popToRoot" ? "/" : "", gesture });
  }
  // route.path = '...' - navigation is a state write, and it is a REPLACE
  for (const m of body.matchAll(/\broute\s*\.\s*path\s*=\s*(['"])([^'"]*)\1(?!\s*\+)/g)) {
    found.push({ kind: "replace", target: m[2]!, gesture });
  }
  // route.path = '/apps/' + id - a built target. The literal prefix is the screen; what is
  // concatenated is data, so it becomes a one-segment wildcard rather than a guess.
  for (const m of body.matchAll(/\broute\s*\.\s*path\s*=\s*(['"])([^'"]*)\1\s*\+/g)) {
    found.push({ kind: "replace", target: `${m[2]!}{{ }}`, gesture });
  }
  for (const m of body.matchAll(/\broute\s*\.\s*(push|replace|reset)\s*\(\s*\{[^}]*?\bpath\s*:\s*(['"])([^'"]*)\2\s*\+/g)) {
    found.push({ kind: ROUTE_VERBS[m[1]!]!, target: `${m[3]!}{{ }}`, gesture });
  }
  return found;
}

/** Walk a document: every `on:*` attribute is a gesture whose body may navigate, every
 *  `href=` is a declarative one, and every `<sheet>` is a presented child surface. */
function scanDocument(root: XmlNode, actions: Map<string, string>, composes: Set<string>): RawEdge[] {
  const out: RawEdge[] = [];
  const walk = (node: XmlNode): void => {
    // COMPOSITION, not navigation. A capitalised tag is a component invocation, and it never
    // becomes an edge on the map - a screen that merely CONTAINS a card is not a screen that
    // navigates to one, and drawing that would bury the navigation under structure. It is
    // collected anyway, because reachability needs it: a component composed into a live screen
    // is not dead code, and reporting it as such would make the one finding people rely on
    // cry wolf. Measured on this repo: without it, all four of the Studio's own documents
    // were flagged dead.
    if (/^[A-Z]/.test(node.tag)) composes.add(node.tag);
    for (const [attr, value] of Object.entries(node.attrs)) {
      if (attr === "href" && value.trim().length > 0) {
        // The anchor attribute: a tap runs on:tap first, then navigates. A static attribute,
        // so this is the most reliable edge in the language.
        out.push({ kind: "push", target: value.trim(), gesture: "TAP" });
        continue;
      }
      if (!attr.startsWith("on:")) continue;
      const gesture = gestureFor(attr);
      out.push(...scanBody(value, gesture));
      // A handler that calls a named action inherits that action's navigations, so the
      // gesture reported is the one a person actually performs.
      for (const call of value.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
        const body = actions.get(call[1]!);
        if (body !== undefined) out.push(...scanBody(body, gesture));
      }
    }
    if (node.tag === "sheet") {
      const present = node.attrs["present"];
      if (present !== undefined) out.push({ kind: "present", target: `sheet:${present}`, gesture: "OPEN" });
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Collect the head's named actions, so a handler that calls one can inherit its navigation. */
function headActions(root: XmlNode): Map<string, string> {
  const actions = new Map<string, string>();
  const head = root.children.find((c) => c.tag === "head");
  if (head === undefined) return actions;
  for (const decl of head.children) {
    if (decl.tag !== "action") continue;
    const as = decl.attrs["as"];
    if (as !== undefined) actions.set(as, decl.text ?? "");
  }
  return actions;
}

/**
 * Build the graph. Pure: the same documents plus the same routes give the same nodes, the same
 * edges in the same order, and the same reachability - which is what lets the layout downstream
 * be deterministic and a screenshot of the map be worth diffing.
 */
export function buildScreenGraph(
  documents: readonly GraphDocument[],
  routes: readonly GraphRoute[] = [],
  entry: string | null = null,
): ScreenGraph {
  const byId = new Map<string, ScreenNode>();
  const files = [...documents].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // -- nodes --------------------------------------------------------------------------
  const routeByComponent = new Map<string, GraphRoute>();
  for (const route of routes) {
    if (route.component !== undefined) routeByComponent.set(route.component, route);
  }
  for (const doc of files) {
    const id = idFor(doc.file);
    const base = doc.file.split("/").pop()!.replace(/\.(cli|server)?\.?dsx$/i, "");
    const kind: SurfaceKind = /\.cli\.dsx$/i.test(doc.file) ? "cli"
      : /\.server\.dsx$/i.test(doc.file) || isServerRoot(doc.source) ? "server"
      : routeByComponent.has(id) || routeByComponent.has(base) ? "route"
      : "part";
    const route = routeByComponent.get(id) ?? routeByComponent.get(base);
    byId.set(id, {
      id,
      name: humanise(base),
      kind,
      ...(route !== undefined ? { path: route.path } : {}),
      file: doc.file,
      reachable: kind === "route" || kind === "server" || kind === "cli",
      ancestors: [],
    });
  }

  // -- edges --------------------------------------------------------------------------
  // Collapsed on (from, to, kind, target): two buttons that both go to checkout is one edge
  // that says 2x, not two lines on top of each other. That collapse is what keeps a real
  // app's map readable.
  const collapsed = new Map<string, ScreenEdge>();
  const dangling = new Set<string>();
  // Routes the TOOLCHAIN itself serves alongside the project (the Studio door). They are
  // real navigation targets in the serving loop but never project routes, so they are
  // neither a node nor a dangling report - an app may link its own editor without the map
  // calling that a broken screen.
  const toolchainRoutes = new Set(["/edit"]);
  /** who composes whom - structural, never drawn, but reachability depends on it */
  const composition = new Map<string, Set<string>>();

  for (const doc of files) {
    const from = idFor(doc.file);
    let root: XmlNode;
    try {
      root = parseDsx(doc.source);
    } catch {
      continue;   // an unparseable document contributes no edges; it is still a node
    }
    const composes = new Set<string>();
    composition.set(from, composes);
    for (const raw of scanDocument(root, headActions(root), composes)) {
      let to: string | null = null;
      let dynamic = false;
      if (raw.target.startsWith("sheet:")) {
        to = from;                       // a sheet is a child surface of this same document
      } else if (raw.kind === "back" && raw.target === "") {
        to = null;                       // pop has no literal target
      } else {
        const match = matchRoute(raw.target, routes);
        const component = match?.component;
        if (component !== undefined) {
          to = byId.has(component)
            ? component
            : [...byId.values()].find((n) => n.file.endsWith(`/${component}.dsx`) || n.file === `${component}.dsx`)?.id ?? null;
        }
        dynamic = raw.target.includes("{{");
        if (to === null && !dynamic && !toolchainRoutes.has(raw.target)) dangling.add(raw.target);
      }
      const key = `${from} ${to ?? ""} ${raw.kind} ${raw.target}`;
      const existing = collapsed.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        // Two different gestures reaching the same screen is worth saying out loud.
        if (existing.gesture !== raw.gesture) existing.gesture = "2 WAYS";
        continue;
      }
      collapsed.set(key, { from, to, kind: raw.kind, target: raw.target, gesture: raw.gesture, count: 1, dynamic });
    }
  }

  const edges = [...collapsed.values()].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1
      : (a.to ?? "") < (b.to ?? "") ? -1 : (a.to ?? "") > (b.to ?? "") ? 1
      : a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.target < b.target ? -1 : a.target > b.target ? 1 : 0);

  // -- reachability -------------------------------------------------------------------
  // Breadth-first from every routed surface. A node nothing enters and no route names is
  // dead code with a picture, and seeing that instantly is most of the map's value.
  const outgoing = new Map<string, string[]>();
  const reach = (from: string, to: string): void => {
    if (to === from) return;
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  };
  for (const edge of edges) {
    if (edge.to === null) continue;
    reach(edge.from, edge.to);
  }
  // Composition counts for REACHING, never for drawing. A tag resolves to a node whose last
  // path segment is that name - the same last-segment resolution the registry uses.
  const byLastSegment = new Map<string, string>();
  for (const node of byId.values()) byLastSegment.set(node.id.split(".").pop()!, node.id);
  for (const [from, tags] of composition) {
    for (const tag of tags) {
      const target = byLastSegment.get(tag);
      if (target !== undefined) reach(from, target);
    }
  }
  const queue = [...byId.values()].filter((n) => n.reachable).map((n) => n.id);
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const next of outgoing.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  for (const node of byId.values()) {
    if (seen.has(node.id)) node.reachable = true;
  }

  // -- ancestors ----------------------------------------------------------------------
  // Walk the navigation edges backwards from each surface until nothing new joins. Bounded
  // by the node count, so a cycle (A pushes B, B pops to A - normal in an app) terminates
  // with both surfaces listing each other, which is the truth.
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.to === null || edge.to === edge.from) continue;
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  for (const node of byId.values()) {
    const found = new Set<string>();
    const pending = [...(incoming.get(node.id) ?? [])];
    while (pending.length > 0) {
      const from = pending.shift()!;
      if (from === node.id || found.has(from)) continue;
      found.add(from);
      pending.push(...(incoming.get(from) ?? []));
    }
    node.ancestors = [...found].sort();
  }

  // The entry is only an entry if it is a surface we actually found.
  const entryId = entry !== null && byId.has(entry) ? entry
    : entry !== null ? [...byId.values()].find((n) => n.file.endsWith(`/${entry}.dsx`) || n.file === `${entry}.dsx`)?.id ?? null
    : null;

  return { nodes: [...byId.values()], edges, dangling: [...dangling].sort(), entry: entryId };
}
