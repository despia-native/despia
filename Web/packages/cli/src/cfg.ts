//
//  cfg.ts — the projection the visual logic editor rests on (platform/00-vision.md section 3).
//
//  THE PROBLEM IT SOLVES. A node costs 20 to 50 times the screen area of the code it stands
//  for, so a node-per-statement graph becomes unreadable at around forty statements: three
//  lines of code become half a screen. Every mitigation trades away the visual (collapse
//  hides, zoom blurs). The area problem itself has not been solved.
//
//  THE MOVE. Control flow is two-dimensional; straight-line code is one-dimensional. So render
//  a node per BASIC BLOCK — a maximal straight-line run — and render its statements as text
//  inside it. The graph then carries only the branching topology, and its area grows with the
//  number of BRANCH POINTS rather than the number of statements. Five hundred statements with
//  twelve branches is twelve boxes.
//
//  WHY THE ROUND TRIP IS EXACT, and this is the load-bearing property: every region records a
//  SPAN into the original source and nothing is ever re-printed. Reconstruction is a slice and
//  rejoin, so `reconstruct(project(src)) === src` byte for byte, including comments, blank
//  lines and whatever formatting the author chose. A visual editor that reformats on save is a
//  second source of truth, and the moment there are two, the whole thesis is gone.
//
//  The tiling is what makes that unconditional: the regions of a run partition its bytes with
//  no gap and no overlap, so exactness does not depend on the parse being RIGHT. A construct
//  this file does not model (`switch`, `do`/`while`, a regex literal holding a quote) degrades
//  into verbatim straight-line text — the picture gets coarser, the bytes never move. That is
//  the correct failure mode for an editor: never lose an author's file to a parse bug.
//
//  Deliberately NOT an expression parser. Statement boundaries and control-flow keywords are
//  all the topology needs, and leaving expressions as verbatim text is exactly what buys the
//  exactness above.
//

export type Span = { start: number; end: number };

export type Region =
  /** A maximal straight-line run: one basic block, rendered as text. */
  | { kind: "straight"; span: Span }
  /** `if (…) { … }` with an optional else, which may itself be an `else if` chain. */
  | { kind: "branch"; span: Span; headSpan: Span; consequent: Region[]; alternate: Region[] | null; alternateHeadSpan: Span | null }
  /** `for`/`while` — one back edge. */
  | { kind: "loop"; span: Span; headSpan: Span; body: Region[] }
  /** `try`/`catch`/`finally`: the one construct with an edge that is not in the text. */
  | { kind: "guard"; span: Span; headSpan: Span; body: Region[]; handlerHeadSpan: Span | null; handler: Region[] | null;
      finallyHeadSpan: Span | null; finalizer: Region[] | null }
  /** A statement whose argument is a function body: `rows.forEach(r => { … })`, a timer, a
   *  `.then`. The body RUNS, so hiding it inside one text row hid a whole program. Head is
   *  everything up to and including the callback's `{`, tail is its `}` and whatever the
   *  statement has left after it, so the three still tile the statement exactly. */
  | { kind: "callback"; span: Span; headSpan: Span; body: Region[]; tailSpan: Span };

const CONTROL = /^(if|for|while|try)\b/;

const ID_PREFIX: Record<Region["kind"], string> = {
  straight: "b", branch: "c", loop: "l", guard: "g", callback: "k",
};

const CLOSER: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/** `word` occurs at `at` as a whole word, not as the head of a longer identifier. */
function startsWord(src: string, at: number, word: string): boolean {
  return src.startsWith(word, at) && !isWordChar(src[at + word.length]);
}

/** Advance past a balanced bracket starting at `open`. Strings and comments are skipped,
 *  because a bracket inside either is not structure. Only the opener's own kind is counted,
 *  which is exact for balanced input and merely coarse for anything else. */
/* A `/` is a COMMENT only where a value cannot begin. After a value - an identifier, a
   literal, a closing bracket - it is division; before one it opens a REGEX LITERAL, and a
   regex may contain `/` escaped or inside a character class. Reading `/\//g` as a comment
   made the rest of the line vanish into the previous statement, so a field span swallowed
   the NEXT statement and editing that field deleted it. Verified: `g = 'a/b'.replace(/\//g,
   '-')` then `y = 2` projected to one node whose Value span covered both, and one edit
   through that span erased `y = 2` while `exact` stayed true. */
function regexCanStartAt(src: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(src[i]!)) i--;
  if (i < 0) return true;
  const c = src[i]!;
  if (c === ")" || c === "]" || c === "}") return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    // a keyword can precede a regex (`return /x/`), an identifier cannot (`a / b`)
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j]!)) j--;
    return KEYWORD_BEFORE_REGEX.has(src.substring(j + 1, i + 1));
  }
  return true;
}

const KEYWORD_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

/** Past a regex literal that starts at `at` (src[at] === "/"). */
function skipRegex(src: string, at: number, to: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < to) {
    const c = src[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return i;            // an unterminated regex is not a regex
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { i++; while (i < to && /[a-z]/.test(src[i]!)) i++; return i; }
    i++;
  }
  return to;
}

/* An XML entity reference ends in `;`, and a body inside a .dsx document is full of them
   (`&amp;amp;&amp;amp;` is how `&&` is spelled). Treating that `;` as a statement terminator tore
   `x = a &amp;amp;&amp;amp; b` into three nodes whose spans cut the entity in half, and one field
   edit rewrote it to `x = 'X'&amp;amp; b`. Live in shipped files. */
function closesEntity(src: string, semi: number): boolean {
  let i = semi - 1;
  for (let n = 0; n < 10 && i >= 0; n++, i--) {
    const c = src[i]!;
    if (c === "&") return i < semi - 1;
    if (!/[A-Za-z0-9#]/.test(c)) return false;
  }
  return false;
}

function matchBalanced(src: string, open: number): number {
  const opener = src[open]!;
  const closer = CLOSER[opener];
  if (closer === undefined) return open + 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/" && !regexCanStartAt(src, i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*" && !regexCanStartAt(src, i)) { const e = src.indexOf("*/", i + 2); if (e < 0) return src.length; i = e + 1; continue; }
    if (c === "/" && regexCanStartAt(src, i)) { i = skipRegex(src, i, src.length) - 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

export function skipSpace(src: string, at: number): number {
  let i = at;
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    return i;
  }
}

/* THE RUNTIME ALREADY KNOWS WHERE A STATEMENT ENDS, AND THE PROJECTION DID NOT ASK.
   `tokens.ts` runs a continuation heuristic before ASI: a depth-zero newline ends the
   statement UNLESS the line is clearly unfinished (it ends in a binary operator, a dot or a
   comma) or the next line can only be a continuation (it starts with `.` `?` `:` `&&` `||`).
   `endOfStatement` broke at every newline instead, so a fluent chain

       return cart
         .filter(l => l.qty > 0)
         .reduce((a, l) => a + l.price, 0)

   tiled as `return cart` plus two orphan lines. `layoutSeq` then sees a `return`, marks the
   run terminated and STOPS - so the two lines were tiled and never drawn, `exact` stayed
   true because reconstruct still concatenated the partition, and deleting the one visible
   node left `.filter(…)` stranded in the file with the write accepted. Fifty-five statements
   across twenty-seven bodies in this repo. Same rule, one implementation, no drift. */
function lineContinues(src: string, lineEnd: number, to: number): boolean {
  let t = lineEnd - 1;
  while (t >= 0 && (src[t] === " " || src[t] === "\t" || src[t] === "\r")) t--;
  if (t >= 0) {
    const last = src[t]!;
    const incDec = (last === "+" || last === "-") && t >= 1 && src[t - 1] === last;
    if (!incDec && "+-*/%&|<>=!?:,.".includes(last)) return true;
  }
  let j = lineEnd + 1;
  while (j < to && /\s/.test(src[j]!)) j++;
  if (j >= to) return false;
  const ch = src[j]!;
  if (ch === "." && !(j + 1 < to && /[0-9]/.test(src[j + 1]!))) return true;
  if (ch === ":") return true;
  if (ch === "?" && !(j + 1 < to && src[j + 1] === "?")) return true;
  if ((ch === "&" || ch === "|") && j + 1 < to && src[j + 1] === ch) return true;
  return false;
}

/** End of a statement: the next `;` or newline at bracket depth zero, whichever terminates it. */
export function endOfStatement(src: string, at: number, to: number): number {
  let i = at;
  while (i < to) {
    const c = src[i]!;
    if (c === "(" || c === "{" || c === "[") { i = matchBalanced(src, i); continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < to) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/" && !regexCanStartAt(src, i)) { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*" && !regexCanStartAt(src, i)) { const e = src.indexOf("*/", i + 2); i = e < 0 || e + 2 > to ? to : e + 2; continue; }
    if (c === "/" && regexCanStartAt(src, i)) { i = skipRegex(src, i, to); continue; }
    if (c === ";" && !closesEntity(src, i)) return i + 1;
    if (c === ";") { i++; continue; }
    if (c === "\n") { if (!lineContinues(src, i, to)) return i + 1; i++; continue; }
    i++;
  }
  return to;
}

/* A CALLBACK IS A BODY, NOT AN ARGUMENT. `rows.forEach(row => { … })` is one statement to a
   scanner and a whole program to a reader, so projecting it as a single text row hid every
   branch, loop and call inside it from the drawing AND from editing. The block is promoted to
   its own region - drawn as a container, exactly like a loop - whenever it holds more than one
   statement or any control flow; a one-line lambda (`l => l.qty > 0`) stays inline, because
   turning `filter` into a container would cost a frame to say nothing.

   Only an argument position counts. A `const f = () => { … }` at depth zero is a definition,
   not a step in the flow, and drawing it as one would claim it runs here. */
export function callbackBlock(src: string, from: number, to: number): { open: number; close: number } | null {
  let depth = 0;
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < to) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/" && !regexCanStartAt(src, i)) { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*" && !regexCanStartAt(src, i)) { const e = src.indexOf("*/", i + 2); i = e < 0 ? to : e + 2; continue; }
    if (c === "/" && regexCanStartAt(src, i)) { i = skipRegex(src, i, to); continue; }
    if (c === "(" || c === "[") { depth++; i++; continue; }
    if (c === ")" || c === "]") { depth--; i++; continue; }
    if (c === "{") { i = matchBalanced(src, i); continue; }

    let bodyAt = -1;
    // `=>` and `=&gt;` are the SAME arrow. A .dsx body is XML text, so every arrow a real
    // document contains is the entity form; matching only the bare one meant callbacks were
    // detected in tests and never in a file.
    if (c === "=" && src[i + 1] === ">") bodyAt = skipSpace(src, i + 2);
    else if (c === "=" && src.startsWith("&gt;", i + 1)) bodyAt = skipSpace(src, i + 5);
    else if (startsWord(src, i, "function")) {
      const paren = src.indexOf("(", i);
      if (paren >= 0 && paren < to) bodyAt = skipSpace(src, matchBalanced(src, paren));
    }
    if (bodyAt >= 0 && depth > 0 && src[bodyAt] === "{") {
      const close = matchBalanced(src, bodyAt);
      if (close <= to) return { open: bodyAt, close };
      return null;
    }
    if (bodyAt >= 0) { i = bodyAt > i ? bodyAt : i + 1; continue; }
    i++;
  }
  return null;
}

/** Statements a region list carries, control heads included - the promotion threshold. */
function weight(list: Region[], src: string): number {
  let n = 0;
  for (const region of list) {
    if (region.kind !== "straight") return 2;
    let cursor = region.span.start;
    while (cursor < region.span.end) {
      const at = skipSpace(src, cursor);
      if (at >= region.span.end) break;
      const end = endOfStatement(src, at, region.span.end);
      n++;
      if (n > 1) return n;
      cursor = end > cursor ? end : cursor + 1;
    }
  }
  return n;
}

/* WHERE A COMMENT ABOVE AN `if` GOES. It cannot stay in the preceding straight run: that run
   is tiled by statements, and a trailing comment there owns no statement, so it was drawn
   nowhere. The control region absorbs it - `span.start` moves back over the run while
   `headSpan.start` stays on the keyword - which keeps the tiling exact and gives the head node
   a note to carry, the same one an ordinary statement carries. */
function commentRunStart(src: string, from: number, at: number): number {
  let i = at;
  for (;;) {
    let j = i;
    while (j > from && (src[j - 1] === " " || src[j - 1] === "\t" || src[j - 1] === "\r" || src[j - 1] === "\n")) j--;
    if (j >= 2 && src[j - 1] === "/" && src[j - 2] === "*") {
      const open = src.lastIndexOf("/*", j - 2);
      if (open < from) return i;
      i = open;
      continue;
    }
    let lineStart = j;
    while (lineStart > from && src[lineStart - 1] !== "\n") lineStart--;
    const head = skipSpace0(src, lineStart, j);
    if (head >= 0 && src[head] === "/" && src[head + 1] === "/" && head + 2 <= j) { i = head; continue; }
    return i;
  }
}

/** First non-space byte in [from,to), or -1. Line-local, so it never crosses a newline. */
function skipSpace0(src: string, from: number, to: number): number {
  let i = from;
  while (i < to && (src[i] === " " || src[i] === "\t")) i++;
  return i < to ? i : -1;
}

/** Parse a run of source into regions. `from`/`to` bound the slice; spans are absolute. */
function parseRegions(src: string, from: number, to: number): Region[] {
  const out: Region[] = [];
  let cursor = from;
  let straightStart = from;

  const flushStraight = (end: number): void => {
    // Whitespace between constructs belongs to the preceding straight run, so that the
    // regions TILE the input: no byte owned twice, no byte dropped.
    if (end > straightStart) out.push({ kind: "straight", span: { start: straightStart, end } });
  };

  while (cursor < to) {
    const at = skipSpace(src, cursor);
    if (at >= to) break;
    const keyword = CONTROL.exec(src.substring(at, to));
    if (keyword === null) {
      const next = endOfStatement(src, at, to);
      const block = callbackBlock(src, at, next);
      if (block !== null) {
        const inner = parseRegions(src, block.open + 1, block.close - 1);
        if (weight(inner, src) > 1) {
          const lead = commentRunStart(src, straightStart, at);
          flushStraight(lead);
          out.push({
            kind: "callback", span: { start: lead, end: next },
            headSpan: { start: at, end: block.open + 1 }, body: inner,
            tailSpan: { start: block.close - 1, end: next },
          });
          cursor = next > cursor ? next : cursor + 1;
          straightStart = cursor;
          continue;
        }
      }
      cursor = next > cursor ? next : cursor + 1;
      continue;
    }

    const word = keyword[1]!;
    let region: Region;

    if (word === "try") {
      const bodyOpen = src.indexOf("{", at);
      if (bodyOpen < 0 || bodyOpen >= to) { cursor = endOfStatement(src, at, to); continue; }
      const lead = commentRunStart(src, straightStart, at);
      flushStraight(lead);
      const bodyClose = matchBalanced(src, bodyOpen);
      let handlerHeadSpan: Span | null = null;
      let handler: Region[] | null = null;
      let finallyHeadSpan: Span | null = null;
      let finalizer: Region[] | null = null;
      let end = bodyClose;
      let after = skipSpace(src, bodyClose);
      if (startsWord(src, after, "catch")) {
        const hOpen = src.indexOf("{", after);
        if (hOpen >= 0) {
          const hClose = matchBalanced(src, hOpen);
          handlerHeadSpan = { start: after, end: hOpen + 1 };
          handler = parseRegions(src, hOpen + 1, hClose - 1);
          end = hClose;
          after = skipSpace(src, hClose);
        }
      }
      if (startsWord(src, after, "finally")) {
        const fOpen = src.indexOf("{", after);
        if (fOpen >= 0) {
          const fClose = matchBalanced(src, fOpen);
          finallyHeadSpan = { start: after, end: fOpen + 1 };
          finalizer = parseRegions(src, fOpen + 1, fClose - 1);
          end = fClose;
        }
      }
      region = {
        kind: "guard", span: { start: lead, end },
        headSpan: { start: at, end: bodyOpen + 1 },
        body: parseRegions(src, bodyOpen + 1, bodyClose - 1),
        handlerHeadSpan, handler, finallyHeadSpan, finalizer,
      };
    } else {
      const parenOpen = src.indexOf("(", at);
      if (parenOpen < 0 || parenOpen >= to) { cursor = endOfStatement(src, at, to); continue; }
      const lead = commentRunStart(src, straightStart, at);
      flushStraight(lead);
      const parenClose = matchBalanced(src, parenOpen);
      const bodyOpen = skipSpace(src, parenClose);
      // A braceless body (`if (x) return`) is a single statement, not a block.
      const braced = src[bodyOpen] === "{";
      const bodyClose = braced ? matchBalanced(src, bodyOpen) : endOfStatement(src, bodyOpen, to);
      const inner = braced
        ? parseRegions(src, bodyOpen + 1, bodyClose - 1)
        : parseRegions(src, bodyOpen, bodyClose);
      const headSpan: Span = { start: at, end: braced ? bodyOpen + 1 : bodyOpen };

      if (word === "if") {
        let alternate: Region[] | null = null;
        let alternateHeadSpan: Span | null = null;
        let end = bodyClose;
        const after = skipSpace(src, bodyClose);
        if (startsWord(src, after, "else")) {
          const elseBody = skipSpace(src, after + 4);
          const elseBraced = src[elseBody] === "{";
          // `else if` recurses as one nested branch, which is what keeps an if/else-if chain
          // a chain in the graph rather than a staircase of unrelated nodes.
          const elseClose = elseBraced ? matchBalanced(src, elseBody) : endOfStatement(src, elseBody, src.length);
          alternateHeadSpan = { start: after, end: elseBraced ? elseBody + 1 : elseBody };
          alternate = elseBraced
            ? parseRegions(src, elseBody + 1, elseClose - 1)
            : parseRegions(src, elseBody, elseClose);
          end = elseClose;
        }
        region = { kind: "branch", span: { start: lead, end }, headSpan, consequent: inner, alternate, alternateHeadSpan };
      } else {
        region = { kind: "loop", span: { start: lead, end: bodyClose }, headSpan, body: inner };
      }
    }
    out.push(region);
    cursor = region.span.end > cursor ? region.span.end : cursor + 1;
    straightStart = cursor;
  }
  flushStraight(to);
  return out;
}

export interface CfgNode {
  id: string;
  /** `block` renders its text; the others are the branching topology. */
  kind: "entry" | "block" | "branch" | "loop" | "guard" | "join" | "exit";
  /** The exact source this node stands for. Never re-printed, only sliced. */
  text: string;
  /** Statement lines, for rendering inside a block node. */
  lines: string[];
  /**
   * Where this node's text came from. The JOIN KEY between the flat graph and the region
   * tree: a layout that draws the tree needs each region's dataflow, and matching on a span
   * is exact, where re-deriving the id by re-walking in the same order is a coupling that
   * breaks silently the first time either walk changes. Absent on entry/exit/join, which
   * stand for no source at all.
   */
  span?: Span;
}

export interface CfgEdge { from: string; to: string; label?: "then" | "else" | "body" | "back" | "catch" }

export interface Cfg { nodes: CfgNode[]; edges: CfgEdge[]; regions: Region[]; source: string }

/** Project source into the graph the editor draws. */
export function projectCfg(source: string): Cfg {
  const regions = parseRegions(source, 0, source.length);
  const nodes: CfgNode[] = [{ id: "entry", kind: "entry", text: "", lines: [] }];
  const edges: CfgEdge[] = [];
  let n = 0;
  const id = (p: string): string => `${p}${n++}`;

  const walk = (list: Region[], from: string): string => {
    let previous = from;
    for (const region of list) {
      const text = source.substring(region.span.start, region.span.end);
      if (region.kind === "straight") {
        if (text.trim() === "") continue;
        const node: CfgNode = {
          id: id("b"), kind: "block", text,
          lines: text.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
          span: region.span,
        };
        nodes.push(node);
        edges.push({ from: previous, to: node.id });
        previous = node.id;
        continue;
      }
      const head = source.substring(region.headSpan.start, region.headSpan.end).trim();
      const node: CfgNode = {
        id: id(ID_PREFIX[region.kind]), kind: region.kind === "callback" ? "loop" : region.kind,
        text: head, lines: [head], span: region.headSpan,
      };
      nodes.push(node);
      edges.push({ from: previous, to: node.id });

      const join: CfgNode = { id: id("j"), kind: "join", text: "", lines: [] };
      if (region.kind === "branch") {
        edges.push({ from: walk(region.consequent, node.id), to: join.id, label: "then" });
        edges.push({ from: region.alternate === null ? node.id : walk(region.alternate, node.id), to: join.id, label: "else" });
      } else if (region.kind === "loop") {
        edges.push({ from: walk(region.body, node.id), to: node.id, label: "back" });
        edges.push({ from: node.id, to: join.id });
      } else if (region.kind === "callback") {
        edges.push({ from: walk(region.body, node.id), to: join.id, label: "body" });
      } else {
        edges.push({ from: walk(region.body, node.id), to: join.id });
        if (region.handler !== null) edges.push({ from: walk(region.handler, node.id), to: join.id, label: "catch" });
      }
      nodes.push(join);
      previous = join.id;
    }
    return previous;
  };

  const last = walk(regions, "entry");
  nodes.push({ id: "exit", kind: "exit", text: "", lines: [] });
  edges.push({ from: last, to: "exit" });
  return { nodes, edges, regions, source };
}

/**
 * Rebuild the source from the region tree. Byte-exact by construction: the top-level regions
 * partition the input, and reconstruction concatenates those slices in order.
 */
export function reconstruct(cfg: Cfg): string {
  let out = "";
  for (const region of cfg.regions) out += cfg.source.substring(region.span.start, region.span.end);
  return out;
}

/** How much smaller the graph is than a node-per-statement rendering would have been. */
export function compaction(cfg: Cfg): { statements: number; nodes: number; ratio: number } {
  const statements = cfg.nodes.filter((n) => n.kind === "block").reduce((sum, n) => sum + n.lines.length, 0);
  const drawn = cfg.nodes.filter((n) => n.kind !== "join" && n.kind !== "entry" && n.kind !== "exit").length;
  return { statements, nodes: drawn, ratio: drawn === 0 ? 1 : statements / drawn };
}

//
//  LIVE-VARIABLE ANALYSIS — the funnel, computed rather than declared.
//
//  The owner's requirement is that a block be a funnel with arguments in and results out,
//  instead of a node reaching into global state. Asking an author to DECLARE that funnel gets
//  a declaration that drifts from the code. Dataflow gives the funnel that is actually there:
//  a block's inputs are the variables it reads before defining (upward-exposed uses), and its
//  outputs are the ones it defines that some later block still reads (live-out ∩ def).
//

const DECLARATORS = new Set(["const", "let", "var"]);

/** Words that are syntax, plus the ambient names a body may always reach. Neither is a funnel
 *  edge: `dsx` is the bus handle every body has, so drawing a port for it is noise. */
const NOT_A_VARIABLE = new Set([
  "if", "else", "for", "while", "do", "try", "catch", "finally", "switch", "case", "default",
  "return", "break", "continue", "throw", "new", "delete", "typeof", "instanceof", "in", "of",
  "function", "class", "this", "await", "async", "yield", "void",
  "true", "false", "null", "undefined",
  "dsx", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Date", "console",
  "Promise", "parseInt", "parseFloat", "isNaN", "Error",
]);

const ASSIGN_OPS = ["=", "+=", "-=", "*=", "/=", "%=", "||=", "&&=", "??="];

export interface BlockFlow {
  id: string;
  /** Read before this node writes it: the node's argument list. */
  inputs: string[];
  /** Written here and still read downstream: the node's results. */
  outputs: string[];
  /** Everything read, and everything written, for tooling that wants the raw sets. */
  reads: string[];
  writes: string[];
}

/** Upward-exposed uses and definitions of one node's text. Strings, comments, property names
 *  after a dot, object-literal keys and callee names are not variables.
 *
 *  Definitions are held back until the statement ENDS, because `total = total + x` reads the
 *  old `total` before it writes the new one. Flushing eagerly would call that read a write and
 *  the loop below would lose its carried value. */
function scanFlow(text: string): { uses: Set<string>; defs: Set<string> } {
  const uses = new Set<string>();
  const defs = new Set<string>();
  let pending: string[] = [];
  let declaring = false;
  const endStatement = (): void => {
    for (const name of pending) defs.add(name);
    pending = [];
    declaring = false;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (!isWordChar(c) || /[0-9]/.test(c)) { if (c === ";" || c === "\n") endStatement(); i++; continue; }

    let j = i;
    while (j < text.length && isWordChar(text[j])) j++;
    const word = text.substring(i, j);
    let before = i - 1;
    while (before >= 0 && /[ \t]/.test(text[before]!)) before--;
    const property = text[before] === ".";
    let after = j;
    while (after < text.length && /[ \t]/.test(text[after]!)) after++;

    if (property) { i = j; continue; }
    if (DECLARATORS.has(word)) { declaring = true; i = j; continue; }
    if (NOT_A_VARIABLE.has(word)) { i = j; continue; }
    // A callee is a name in the action/builtin namespace, not a value flowing between blocks.
    // Drawing a port for `submit` on every node that calls it is noise, not information.
    if (text[after] === "(") { i = j; continue; }

    const op = ASSIGN_OPS.filter((o) => text.startsWith(o, after))
      .sort((a, b) => b.length - a.length)[0];
    const assigning = op !== undefined && !(op === "=" && (text[after + 1] === "=" || /[=!<>]/.test(text[before] ?? "")));
    const objectKey = text[after] === ":" && text[after + 1] !== ":";

    if (declaring) {
      pending.push(word);
      declaring = false;
    } else if (assigning) {
      if (op !== "=" && !defs.has(word)) uses.add(word);
      pending.push(word);
    } else if (!objectKey && !defs.has(word)) {
      uses.add(word);
    }
    i = j;
  }
  endStatement();
  return { uses, defs };
}

/**
 * Backward dataflow over the projected graph. Iterated to a fixpoint, so a loop's back edge
 * carries liveness around the loop rather than pretending the body runs once.
 */
export function liveness(cfg: Cfg): Map<string, BlockFlow> {
  const use = new Map<string, Set<string>>();
  const def = new Map<string, Set<string>>();
  for (const node of cfg.nodes) {
    const { uses, defs } = node.text === "" ? { uses: new Set<string>(), defs: new Set<string>() } : scanFlow(node.text);
    // A branch or guard head is a condition: it reads, it defines nothing. A loop head is
    // the one head that BINDS — `for (const x of xs)` is where `x` comes from.
    if (node.kind === "branch" || node.kind === "guard") { for (const d of defs) uses.add(d); defs.clear(); }
    use.set(node.id, uses);
    def.set(node.id, defs);
  }

  const successors = new Map<string, string[]>();
  for (const node of cfg.nodes) successors.set(node.id, []);
  for (const edge of cfg.edges) successors.get(edge.from)?.push(edge.to);

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  for (const node of cfg.nodes) { liveIn.set(node.id, new Set()); liveOut.set(node.id, new Set()); }

  const order = [...cfg.nodes].reverse();
  for (let pass = 0; pass < cfg.nodes.length + 2; pass++) {
    let changed = false;
    for (const node of order) {
      const out = new Set<string>();
      for (const s of successors.get(node.id) ?? []) for (const v of liveIn.get(s) ?? []) out.add(v);
      const inSet = new Set(use.get(node.id));
      for (const v of out) if (!def.get(node.id)!.has(v)) inSet.add(v);
      if (out.size !== liveOut.get(node.id)!.size || inSet.size !== liveIn.get(node.id)!.size) changed = true;
      liveOut.set(node.id, out);
      liveIn.set(node.id, inSet);
    }
    if (!changed) break;
  }

  const flows = new Map<string, BlockFlow>();
  for (const node of cfg.nodes) {
    if (node.kind === "entry" || node.kind === "exit" || node.kind === "join") continue;
    const defs = def.get(node.id)!;
    const out = liveOut.get(node.id)!;
    flows.set(node.id, {
      id: node.id,
      inputs: [...use.get(node.id)!].sort(),
      outputs: [...defs].filter((d) => out.has(d)).sort(),
      reads: [...use.get(node.id)!].sort(),
      writes: [...defs].sort(),
    });
  }
  return flows;
}
