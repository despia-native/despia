//
//  screenlayout.ts - where every node sits on the canvas.
//
//  THE ONLY REQUIREMENT THAT MATTERS: the same project produces the same map, on every
//  machine, on every build. A layout that drifts between runs makes screenshots useless,
//  diffs meaningless, and "the node moved" an unanswerable question. So there is no
//  randomness, no iteration-until-pretty, no Map insertion order relied on for anything a
//  human sees - every tie is broken alphabetically, which is arbitrary but STABLE.
//
//  Layered, in the five passes v4-launch/platform/02-canvas.md specifies. This is the
//  Sugiyama shape without the crossing-minimisation research: two barycentre passes buy most
//  of the readability, and a third stops paying on graphs the size of an app.
//

import type { ScreenGraph, ScreenNode, SurfaceKind } from "./screengraph.ts";

/** Placement pitch. A node is 160 wide and 320 tall (02-canvas.md), so these leave a
 *  column gutter of 80 and a row gutter of 120: enough for an edge to curve without
 *  crossing a neighbour, tight enough that a ten-screen app fits one viewport. */
export const COLUMN_PITCH = 240;
export const ROW_PITCH = 440;

/** Server and CLI surfaces have nothing to render, so they are short. */
export const NODE_SIZE: { [kind in SurfaceKind]: { width: number; height: number } } = {
  route: { width: 160, height: 320 },
  pushed: { width: 160, height: 320 },
  sheet: { width: 160, height: 320 },
  part: { width: 160, height: 320 },
  server: { width: 160, height: 96 },
  cli: { width: 160, height: 96 },
};

export type PlacedNode = ScreenNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  /** distance from a root, and the row it lands in */
  rank: number;
  /** which horizontal band: the screen graph, then server, then cli */
  band: "screen" | "server" | "cli";
};

export type ScreenLayout = {
  nodes: PlacedNode[];
  width: number;
  height: number;
};

/** Which band a surface belongs to. Server and CLI never interleave with screens, so the
 *  phone map stays a phone map and every `call` edge crosses one visible boundary. */
function bandOf(kind: SurfaceKind): "screen" | "server" | "cli" {
  return kind === "server" ? "server" : kind === "cli" ? "cli" : "screen";
}

/**
 * Place the graph. Pure and total: an empty graph lays out to nothing, a graph that is all
 * cycles still terminates, and reordering the input changes no coordinate.
 */
export function layoutScreenGraph(graph: ScreenGraph): ScreenLayout {
  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (nodes.length === 0) return { nodes: [], width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    // A `back` edge is a return along the stack, not a step forward: counting it would rank
    // every screen behind its own parent and fold the map flat.
    if (edge.to === null || edge.kind === "back" || edge.to === edge.from) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge.to);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  for (const list of outgoing.values()) list.sort();
  for (const list of incoming.values()) list.sort();

  // -- pass 1: roots -------------------------------------------------------------------
  // Anything nothing navigates to. A routed surface is a root even when something does
  // point at it, because an addressable screen is somewhere a person can start.
  //
  // REACHABLE ONLY. An orphan also has no incoming edge, so the obvious predicate makes it
  // a root and ranks it 0, sitting it in the top row beside the real entry points - which
  // is the opposite of what the map is for. The extractor already knows what is reachable
  // (it accounts for composition), so ask it rather than re-deriving a worse answer here.
  const roots = nodes
    .filter((n) => n.reachable && ((incoming.get(n.id) ?? []).length === 0 || n.kind === "route"))
    .map((n) => n.id);
  // THE ENTRY GOES FIRST. Every routed screen is a root, so on a cyclic app the order the
  // roots are visited in decides which edges get cut and therefore what ends up at the top.
  // Sorted order picks whatever begins with "A"; the root plan names the real answer.
  if (graph.entry !== null) {
    const at = roots.indexOf(graph.entry);
    if (at > 0) { roots.splice(at, 1); roots.unshift(graph.entry); }
  }
  // A graph that is entirely a cycle, or one with nothing reachable at all, has no root;
  // seed it with its first node by id rather than laying out nothing.
  if (roots.length === 0) roots.push(nodes[0]!.id);

  // -- pass 2a: break the cycles ---------------------------------------------------------
  //
  //  A real app's navigation is CYCLIC almost by definition: checkout returns to orders,
  //  orders link home, home links back into the funnel. Relaxing longest paths over a cycle
  //  raises every node one rank per lap until each has a rank of its own, and the map comes out
  //  as a single column N screens tall - fit-to-content then zooms to nothing and the surface
  //  is useless. Measured on an eight-screen storefront, which drew one 3500px column.
  //
  //  So rank over a DAG. A depth-first walk from the roots in sorted order marks every edge
  //  pointing back at a node still on the stack, and those are excluded from RANKING only:
  //  still drawn, still counted for reachability, still real. Sorted order is what makes the
  //  choice of which edge to cut deterministic.
  const cycleEdges = new Set<string>();
  {
    const state = new Map<string, "open" | "done">();
    const walk = (id: string): void => {
      state.set(id, "open");
      for (const next of outgoing.get(id) ?? []) {
        const seen = state.get(next);
        if (seen === "open") { cycleEdges.add(`${id}\u0000${next}`); continue; }
        if (seen === undefined) walk(next);
      }
      state.set(id, "done");
    };
    for (const id of roots) if (!state.has(id)) walk(id);
    for (const node of nodes) if (!state.has(node.id)) walk(node.id);
  }
  const forward = new Map<string, string[]>();
  for (const [from, list] of outgoing) {
    forward.set(from, list.filter((to) => !cycleEdges.has(`${from}\u0000${to}`)));
  }

  // -- pass 2b: rank = longest path from any root ----------------------------------------
  // Longest, not shortest: a screen reachable both early and late belongs at its deepest
  // position, so edges point mostly downward instead of doubling back over the map.
  const rank = new Map<string, number>();
  for (const id of roots) rank.set(id, 0);
  // The graph is acyclic now, so |V| relaxations is a bound rather than a hope.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const node of nodes) {
      const here = rank.get(node.id);
      if (here === undefined) continue;
      for (const next of forward.get(node.id) ?? []) {
        const candidate = here + 1;
        if ((rank.get(next) ?? -1) < candidate) { rank.set(next, candidate); moved = true; }
      }
    }
    if (!moved) break;
  }
  // Anything the walk never touched is unreachable; it goes in a band of its own at the
  // bottom rather than being silently dropped or piled onto rank 0.
  const maxReached = [...rank.values()].reduce((a, b) => Math.max(a, b), 0);
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, maxReached + 1);

  // -- pass 3: order within a rank -----------------------------------------------------
  const ranksByBand = new Map<string, Map<number, string[]>>();
  for (const node of nodes) {
    const band = bandOf(node.kind);
    const byRank = ranksByBand.get(band) ?? ranksByBand.set(band, new Map()).get(band)!;
    const r = band === "screen" ? rank.get(node.id)! : 0;   // a band with no edges is one row
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(node.id);
  }
  for (const byRank of ranksByBand.values()) for (const list of byRank.values()) list.sort();

  const screenRanks = ranksByBand.get("screen") ?? new Map<number, string[]>();
  const orderedRanks = [...screenRanks.keys()].sort((a, b) => a - b);
  // Barycentre: put a node above the average position of its parents. Two passes down the
  // ranks, then the positions stop moving enough to matter.
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const r of orderedRanks) {
      const previous = screenRanks.get(r - 1);
      if (previous === undefined) continue;
      const indexOf = new Map(previous.map((id, i) => [id, i]));
      const row = screenRanks.get(r)!;
      const centre = new Map<string, number>();
      for (const id of row) {
        const parents = (incoming.get(id) ?? []).map((p) => indexOf.get(p)).filter((v): v is number => v !== undefined);
        // No parent in the row above: hold position rather than jumping to zero.
        centre.set(id, parents.length === 0 ? row.indexOf(id) : parents.reduce((a, b) => a + b, 0) / parents.length);
      }
      // Alphabetical tiebreak, so an equal barycentre never depends on array order.
      row.sort((a, b) => (centre.get(a)! - centre.get(b)!) || (a < b ? -1 : a > b ? 1 : 0));
    }
  }

  // -- pass 4 and 5: placement, band by band -------------------------------------------
  const placed: PlacedNode[] = [];
  let cursorY = 0;
  for (const band of ["screen", "server", "cli"] as const) {
    const byRank = ranksByBand.get(band);
    if (byRank === undefined) continue;
    for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
      const row = byRank.get(r)!;
      let tallest = 0;
      for (const [column, id] of row.entries()) {
        const node = byId.get(id)!;
        const size = NODE_SIZE[node.kind];
        placed.push({
          ...node,
          x: column * COLUMN_PITCH,
          y: cursorY,
          width: size.width,
          height: size.height,
          rank: rank.get(id)!,
          band,
        });
        tallest = Math.max(tallest, size.height);
      }
      cursorY += tallest + (ROW_PITCH - NODE_SIZE.route.height);
    }
  }

  placed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const width = placed.reduce((m, n) => Math.max(m, n.x + n.width), 0);
  const height = placed.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  return { nodes: placed, width, height };
}

/** The eight numbers of one edge's cubic: `[x1, y1, c1x, c1y, c2x, c2y, x2, y2]`.
 *
 *  NUMBERS, not a path string. A renderer that has to parse `d` to draw is a renderer that
 *  reimplements a parser, and two of the three would get it subtly wrong; every surface takes
 *  the same eight numbers and the only thing that differs is the drawing call. */
export type EdgeGeometry = [number, number, number, number, number, number, number, number];

/** Out of the source's bottom anchor, into the target's top anchor, with vertical control
 *  points so edges leave and arrive perpendicular and the map reads as a flow, not a web. */
export function edgeGeometry(from: PlacedNode, to: PlacedNode): EdgeGeometry {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  // A back edge (target above source) needs a wider bow or it hides behind the nodes.
  const span = Math.max(Math.abs(y2 - y1) / 2, 40);
  return [x1, y1, x1, y1 + span, x2, y2 - span, x2, y2];
}

/** The same curve as an SVG path, for a surface that draws with one (SSR, an export). */
export function edgePath(from: PlacedNode, to: PlacedNode): string {
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = edgeGeometry(from, to);
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

/** The point at t = 0.5, where a gesture pill sits. One implementation, so the pill and the
 *  curve cannot disagree about where the middle of the curve is. */
export function edgeMidpoint(g: EdgeGeometry): { x: number; y: number } {
  return {
    x: (g[0] + 3 * g[2] + 3 * g[4] + g[6]) / 8,
    y: (g[1] + 3 * g[3] + 3 * g[5] + g[7]) / 8,
  };
}
