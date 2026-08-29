//
//  nodeflow.ts — the node projection the visual logic editor draws (05-node-editor.md).
//
//  ONE NODE PER LOGICAL STEP, titled in human language. The earlier containment projection
//  answered the area problem by rendering straight-line runs as text inside one box; the
//  product decision that superseded it is that logic editing IS node-based development:
//  every statement a person would name gets a block with a name ("Set Variable", "For Each
//  Loop", "Go To Page"), control flow is drawn as the familiar shapes (a branch is two
//  lanes that rejoin, a loop is a literal loop with a rounded back edge), and a statement
//  this file cannot classify degrades into a CUSTOM CODE node — never into a parse error,
//  never into a lost byte.
//
//  THE ROUND TRIP IS STILL THE LAW, inherited from cfg.ts: every node records a SPAN into
//  the author's own source and nothing is ever re-printed. A visual edit is a text splice
//  at a span boundary. `exact` (reconstruct == source) is computed per projection and the
//  write endpoint refuses to touch a body whose projection is not exact, so the flowchart
//  can never outrank the file.
//
//  EVERY CONNECTOR KNOWS WHERE IT SPLICES. An edge carries `insertAt`, the byte offset in
//  the body where "drop a node on this connector" inserts text. That is the whole insert
//  grammar: the picker chooses a template, the connector chooses the offset, the server
//  splices and re-verifies. No node is ever positioned by hand — the layout here is the
//  only geometry, recomputed per edit, which is what keeps the drawing compact and true.
//

import {
  projectCfg, reconstruct, skipSpace, endOfStatement, callbackBlock,
  type Region, type Span,
} from "./cfg.ts";
import { createHash } from "node:crypto";

// ── the node grammar ─────────────────────────────────────────────────────────────────

export type FlowField = {
  /** Human row label: "Api Key", "Condition", "Items", "Value". */
  name: string;
  /** The expression's text, entity-decoded and truncated for the row. */
  value: string;
  /** The full expression, entity-decoded - what the row's editor opens with. */
  text: string;
  /** Byte range of the expression in the body source - a row edit replaces exactly this. */
  span: Span;
  /** What KIND of value the author wrote here: a piece of text, a number, a switch, the name
   *  of something, or a computation. Derived from the text, never stored, so it cannot drift
   *  away from the source; the editor opens the matching control instead of a text box. */
  mode: ValueMode;
  /** The value with its literal wrapper off: `'Save'` edits as `Save`. */
  literal: string;
  /** True when this row DECLARES the name rather than reading one. The editor must not offer
   *  the in-scope list there: renaming a declaration to a name already in scope is a bug, not
   *  a completion. */
  binds?: boolean;
  /** The label column's width on THIS card, in px - the widest label the card carries, not a
   *  constant wide enough for the longest label in the vocabulary. Carried on the row rather
   *  than the node because the markup binds the rows as their own list, where the node is out
   *  of scope; every row of one card holds the same number. */
  labelW: number;
};

export type FlowNode = {
  id: string;
  kind: "start" | "end" | "merge" | "frame" | "port"
    | "set" | "call" | "action" | "event" | "api" | "log" | "error" | "navigate"
    | "return" | "throw" | "break" | "continue" | "code"
    | "if" | "loop" | "try" | "catch" | "finally" | "callback" | "note";
  /** Human language, first letters capitalised: "Set Variable", "For Each Loop". */
  title: string;
  /** The specific thing: the variable, the condition, the destination. Entity-decoded. */
  subtitle: string;
  /** Whether the card draws its subtitle. It is the step's IDENTITY - which action runs,
   *  which module, which event - and it used to be suppressed the moment the step had any
   *  argument rows, so every call with a parameter read as an anonymous "Run Action". It is
   *  suppressed only where an argument row already says the same thing. */
  showSubtitle: boolean;
  /** The raw statement lines, entity-decoded, for the code view and the Custom Code node. */
  lines: string[];
  /** Byte range in the body source (raw, entities intact). Absent on start/end/merge. */
  span?: Span;
  /** The block's argument rows - each one an in-place editable expression. */
  fields: FlowField[];
  /** The comment this statement owns, drawn as a strip inside the node's own reserved box. */
  note?: FlowNote;
  /** `stmt // why` - one quiet line at the foot of the card. */
  trailing?: string;
  /** Distance from `y` to the CARD's top: the note's height plus its gap, else zero. Every
   *  wire into this node lands here, not on the note. */
  headOffset?: number;
  /** On a `frame`: which construct's wall this is, so the client tints it in that
   *  construct's own hue. A loop and a one-armed `if` are the same SHAPE - a wall the reader
   *  is inside of - and the hue plus the head card above are what tell them apart. */
  frame?: "loop" | "if";
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FlowEdge = {
  from: string;
  to: string;
  label?: "Then" | "Else" | "Catch" | "Always";
  /** True where the insertion opens an EMPTY lane or loop: the client renders the
   *  labelled Add Node pill there instead of the small +. */
  prominent?: boolean;
  /** Polyline in flow coordinates; the client draws it with rounded corners. */
  points: [number, number][];
  /** Byte offset where an insertion on this connector splices. Absent on the exit edge
   *  into the End pill when the body ended with a terminator (nothing runs after it). */
  insertAt?: number;
  /** Where the + hotspot sits (midpoint of the connector's longest vertical run). */
  plusX?: number;
  plusY?: number;
  /** Where the Yes/No/Loop/Catch pill sits: just past the connector's first bend. */
  labelX?: number;
  labelY?: number;
};

export type InsertableNode = {
  kind: FlowNode["kind"];
  title: string;
  subtitle: string;
  /** The DSX/JSE text the picker splices in, before re-indentation. */
  template: string;
};

export type Flow = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
  /** reconstruct(project(src)) === src — the write gate. */
  exact: boolean;
  statements: number;
  /** sha256 of the body source; flowedit refuses a stale revision. */
  rev: string;
};

// ── classification: a statement's text → its block ──────────────────────────────────

const ENTITIES: [RegExp, string][] = [
  [/&lt;/g, "<"], [/&gt;/g, ">"], [/&quot;/g, '"'], [/&apos;/g, "'"], [/&amp;/g, "&"],
];

/** Entity-decoded text - what the drawing puts in front of a reader, where the file holds
 *  `&gt;`. Exported because `flowcost.ts` must price the same characters the
 *  canvas shows; two decoders would be two answers to what the reader is looking at. */
export function decode(text: string): string {
  let out = text;
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  return out;
}

/** camelCase / snake_case → Title Case with spaces: clearWebData → Clear Web Data. */
export function titleCase(word: string): string {
  return word
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((w) => w !== "")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

const ROUTE_TITLES: Record<string, string> = {
  push: "Go To Page", replace: "Replace Page", reset: "Reset Navigation",
  back: "Go Back", pop: "Go Back", popToRoot: "Go To Root",
};

/** First string literal inside the call, for subtitles like the fired event's name. */
function firstStringArg(text: string): string {
  const m = /\(\s*['"]([^'"]*)['"]/.exec(text);
  return m === null ? "" : m[1]!;
}

type Classified = { kind: FlowNode["kind"]; title: string; subtitle: string };

/* THE ASSIGNMENT HEAD, in one place because two readers need the same answer. The classifier
   peels it to find the operative expression and the field extractor peels it to find the Name
   row; when the two regexes drifted, a statement could classify as an assignment and then show
   no Name. It accepts a PATH, not just a bare word - `order.status = 'paid'`,
   `tokens[key] = row` and `count += 1` are assignments a reader recognises on sight, and every
   one of them used to fall through to Custom Code. */
const ASSIGN_HEAD =
  /^((?:dsx\.variable\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])*)\s*(?:\|\|=|&&=|\?\?=|\+=|-=|\*=|\/=|%=|=(?![=>]))\s*/;
const NOT_ASSIGNABLE = /^(return|throw|break|continue|if|for|while|try|else|do|switch)$/;
/** A list the author mutates in place, which is a step even though it looks like an expression. */
const LIST_VERBS: Record<string, string> = {
  push: "Add To List", unshift: "Add To List Front", pop: "Take From List",
  shift: "Take From List Front", splice: "Splice List", sort: "Sort List", reverse: "Reverse List",
};

/** Map one statement to its visual block. Everything unrecognised is Custom Code — the
 *  safe fallback that keeps the projection total over anything JSE accepts. */
export function classifyStatement(raw: string): Classified {
  const text = decode(raw).trim();
  // Peel `const x = `, `let x = `, `x = ` and `await ` to find the operative expression;
  // the peeled name is the step's result and becomes the subtitle's arrow.
  let rest = text;
  let assigned = "";
  const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(rest);
  if (decl !== null) { assigned = decl[1]!; rest = rest.slice(decl[0].length); }
  else {
    const plain = ASSIGN_HEAD.exec(rest);
    if (plain !== null && !NOT_ASSIGNABLE.test(plain[1]!.split(/[.[]/)[0]!)) {
      assigned = plain[1]!.replace(/^dsx\.variable\./, "");
      rest = rest.slice(plain[0].length);
    }
  }
  if (rest.startsWith("await ")) rest = rest.slice(6);
  const arrow = assigned === "" ? "" : ` → ${assigned}`;

  if (/^return\b/.test(text)) {
    return { kind: "return", title: "Return", subtitle: text.replace(/^return\s*/, "") };
  }
  if (/^throw\b/.test(text)) {
    return { kind: "throw", title: "Throw Error", subtitle: firstStringArg(text) || text.replace(/^throw\s*/, "") };
  }
  if (/^break\b/.test(text)) return { kind: "break", title: "Exit Loop", subtitle: "" };
  if (/^continue\b/.test(text)) return { kind: "continue", title: "Next Iteration", subtitle: "" };

  // the router reached as a value: `dsx.route.path = '/orders'` is navigation, not a variable
  if (/^dsx\.route\./.test(assigned)) {
    return { kind: "navigate", title: "Go To Page", subtitle: rest.replace(/^['"]|['"]$/g, "") };
  }
  if (/^dsx\.component\.(push|replace)\s*\(/.test(rest)) {
    const verb = /^dsx\.component\.(\w+)/.exec(rest)![1]!;
    return {
      kind: "navigate", title: verb === "push" ? "Open Component" : "Replace Component",
      subtitle: (firstStringArg(rest) || rest.replace(/^dsx\.component\.\w+\s*\(/, "").replace(/\)\s*;?$/, "")) + arrow,
    };
  }
  const route = /^(?:try\?\s*)?dsx\.module\.route\.(\w+)\s*\(/.exec(rest);
  if (route !== null && ROUTE_TITLES[route[1]!] !== undefined) {
    const m = /path\s*:\s*['"]([^'"]*)['"]/.exec(rest);
    return { kind: "navigate", title: ROUTE_TITLES[route[1]!]!, subtitle: (m?.[1] ?? firstStringArg(rest)) + arrow };
  }
  const call = /^(?:try\?\s*)?dsx\.module\.((?:\w+\.)*\w+)\.(\w+)\s*\(/.exec(rest);
  if (call !== null) {
    const chain = call[1]!.split(".").map(titleCase).join(" ");
    return { kind: "call", title: "Call Module", subtitle: `${chain} · ${titleCase(call[2]!)}${arrow}` };
  }
  if (/^dsx\.event\s*\(/.test(rest)) return { kind: "event", title: "Send Event", subtitle: firstStringArg(rest) };
  if (/^dsx\.broadcast\s*\(/.test(rest)) return { kind: "event", title: "Broadcast Event", subtitle: firstStringArg(rest) };
  if (/^dsx\.send\s*\(/.test(rest)) return { kind: "event", title: "Send To Parent", subtitle: firstStringArg(rest) };
  // the native module-bus spellings: real words on the Swift and Kotlin side, and not
  // statements the JSE runner implements, so they keep a node but never a picker template
  if (/^dsx\.fire\s*\(/.test(rest)) return { kind: "event", title: "Fire Event", subtitle: firstStringArg(rest) };
  if (/^dsx\.claim\s*\(/.test(rest)) return { kind: "event", title: "Claim Role", subtitle: firstStringArg(rest) };
  if (/^dsx\.log\s*\(/.test(rest)) return { kind: "log", title: "Log", subtitle: firstStringArg(rest) };
  if (/^dsx\.error\s*\(/.test(rest)) return { kind: "error", title: "Report Error", subtitle: firstStringArg(rest) };
  if (/^dsx\.action\.(\w+)\s*\(/.test(rest)) {
    return { kind: "action", title: "Run Action", subtitle: titleCase(/^dsx\.action\.(\w+)/.exec(rest)![1]!) + arrow };
  }
  const apiCall = /^([A-Za-z_$][\w$]*)\.(refresh|send|cancel)\s*\(/.exec(rest);
  if (apiCall !== null) {
    return { kind: "api", title: "API Request", subtitle: `${titleCase(apiCall[1]!)} · ${titleCase(apiCall[2]!)}${arrow}` };
  }
  if (/^queue\.\w+\s*\(/.test(rest)) {
    return { kind: "call", title: "Queue Work", subtitle: firstStringArg(rest) + arrow };
  }
  const dataOp = /^data\.(\w+)\.(\w+)\s*\(/.exec(rest);
  if (dataOp !== null) {
    return { kind: "call", title: `${titleCase(dataOp[2]!)} Data`, subtitle: `${titleCase(dataOp[1]!)}${arrow}` };
  }
  if (/^secret\.\w+/.test(rest)) {
    return { kind: "set", title: "Read Secret", subtitle: (/^secret\.(\w+)/.exec(rest)?.[1] ?? "") + arrow };
  }
  // a module reached with no action word: `dsx.module.rateapp()` runs the module itself
  const plainModule = /^(?:try\?\s*)?dsx\.module\.((?:\w+\.)*\w+)\s*\(/.exec(rest);
  if (plainModule !== null) {
    return { kind: "call", title: "Call Module", subtitle: plainModule[1]!.split(".").map(titleCase).join(" ") + arrow };
  }
  const listOp = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])*)\.(\w+)\s*\(/.exec(rest);
  if (listOp !== null && LIST_VERBS[listOp[2]!] !== undefined) {
    return { kind: "call", title: LIST_VERBS[listOp[2]!]!, subtitle: listOp[1]!.replace(/^dsx\.variable\./, "") + arrow };
  }
  const bare = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (bare !== null && !/^(if|for|while|switch|typeof|Number|String|Boolean|Array|Object|JSON|Math|Error)$/.test(bare[1]!)) {
    return { kind: "action", title: "Run Action", subtitle: titleCase(bare[1]!) + arrow };
  }
  if (assigned !== "") {
    // a path is a FIELD on something, a bare word is the variable itself - and a reader who
    // sees "Set Variable · order.status" reasonably asks which variable that is
    return { kind: "set", title: /[.[]/.test(assigned) ? "Set Value" : "Set Variable", subtitle: assigned };
  }
  // A LONE NAME IS A CALL. `on:tap="save"` runs the `save` action - the runner treats a bare
  // handler name as an invocation - and 120 of them in this repo drew as Custom Code because
  // the classifier only recognised a name with parentheses after it.
  const lone = /^([A-Za-z_$][\w$]*)\s*;?$/.exec(text);
  if (lone !== null && !NOT_ASSIGNABLE.test(lone[1]!)) {
    return { kind: "action", title: "Run Action", subtitle: titleCase(lone[1]!) };
  }
  return { kind: "code", title: "Custom Code", subtitle: "" };
}

/* The callback's own vocabulary. A reader does not care that `forEach` takes a function; they
   care that the steps below run once per row. The head is everything up to the `{`, so the
   receiver and the parameter are both in hand. Anything unrecognised falls back to the ordinary
   statement classifier, which already knows the module bus - `dsx.module.timer.after(500, () => {`
   reads as Call Module · Timer · After with its body drawn underneath. */
const ITERATORS: Record<string, string> = {
  forEach: "For Each Item", map: "Map Each Item", filter: "Keep Where", reduce: "Reduce",
  find: "Find Where", findIndex: "Find Index", some: "Any Match", every: "All Match",
  sort: "Sort By", flatMap: "Map And Flatten",
};
const TIMERS: Record<string, string> = {
  setTimeout: "After A Delay", setInterval: "Every Interval",
  requestAnimationFrame: "Next Frame", queueMicrotask: "Next Tick",
};

export function classifyCallback(rawHead: string, rawTail = ""): Classified {
  const head = decode(rawHead).trim().replace(/\{\s*$/, "").trim();
  const tail = decode(rawTail).trim().replace(/^\}/, "").trim();
  const param = /(?:\(\s*([^)]*?)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*$/.exec(head);
  const names = (param?.[1] ?? param?.[2] ?? "").split(",")[0]!.trim();

  // the receiver may itself be a call - `orders.refresh().then(res => {` - so the character
  // class has to admit parentheses or the chain reads as the refresh, not as its callback
  const iter = /([A-Za-z_$][\w$.[\]'"()]*)\.([A-Za-z_$][\w$]*)\s*\(\s*$/.exec(head.replace(/(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*$/, ""));
  if (iter !== null) {
    const verb = iter[2]!;
    if (ITERATORS[verb] !== undefined) {
      return { kind: "callback", title: ITERATORS[verb]!, subtitle: names === "" ? iter[1]! : `${names} in ${iter[1]!}` };
    }
    if (verb === "then") return { kind: "callback", title: "When It Resolves", subtitle: names };
    if (verb === "catch") return { kind: "callback", title: "When It Fails", subtitle: names };
    if (verb === "finally") return { kind: "callback", title: "Either Way", subtitle: "" };
  }
  const timer = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/.exec(head);
  if (timer !== null && TIMERS[timer[1]!] !== undefined) {
    // the delay is an argument AFTER the function, so it lives in the tail, not the head
    const ms = /^,\s*(\d+)/.exec(tail) ?? /,\s*(\d+)\s*\)?\s*$/.exec(head);
    return { kind: "callback", title: TIMERS[timer[1]!]!, subtitle: ms === null ? "" : `${ms[1]} ms` };
  }

  const fallback = classifyStatement(`${head})`);
  if (fallback.kind !== "code") return { kind: "callback", title: fallback.title, subtitle: fallback.subtitle };
  return { kind: "callback", title: "Run These Steps", subtitle: names };
}

/** A control head's block: `for (const line of lines)` → For Each Loop · line in lines. */
export function classifyHead(kind: Region["kind"], raw: string): Classified {
  const head = decode(raw).trim().replace(/\{\s*$/, "").trim();
  if (kind === "branch") {
    const cond = head.replace(/^if\s*\(/, "").replace(/\)\s*$/, "");
    return { kind: "if", title: "If", subtitle: cond };
  }
  if (kind === "guard") return { kind: "try", title: "Try", subtitle: "" };
  const forEach = /^for\s*\(\s*(?:const|let|var)?\s*([\w$]+)\s+of\s+(.+?)\)\s*$/.exec(head);
  if (forEach !== null) {
    return { kind: "loop", title: "For Each Loop", subtitle: `${forEach[1]} in ${forEach[2]}` };
  }
  if (/^while\b/.test(head)) {
    return { kind: "loop", title: "While Loop", subtitle: head.replace(/^while\s*\(/, "").replace(/\)$/, "") };
  }
  return { kind: "loop", title: "For Loop", subtitle: head.replace(/^for\s*\(/, "").replace(/\)$/, "") };
}

// ── field extraction: a block's arguments as in-place editable rows ─────────────────

/** What each verb calls its positional arguments. Anything unlisted falls back to Value. */
const ARG_NAMES: Partial<Record<FlowNode["kind"], string[]>> = {
  event: ["Event", "Payload"],
  log: ["Message"],
  error: ["Error"],
  navigate: ["Destination", "Options"],
};

/** Scan one bracketed range at top level, yielding comma-separated entry spans.
 *  Strings and comments are opaque; nested brackets are skipped whole. */
function topLevelEntries(src: string, from: number, to: number): Span[] {
  const out: Span[] = [];
  let start = from;
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === "(" || c === "{" || c === "[") {
      let depth = 0;
      const open = c;
      const close = open === "(" ? ")" : open === "{" ? "}" : "]";
      while (i < to) {
        const d = src[i]!;
        if (d === '"' || d === "'" || d === "`") {
          const q = d;
          i++;
          while (i < to) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
          continue;
        }
        if (d === open) depth++;
        else if (d === close) { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < to) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === ",") {
      out.push({ start, end: i });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  if (to > start) out.push({ start, end: to });
  return out.filter((e) => src.substring(e.start, e.end).trim() !== "");
}

/** One argument row. Every field is built here, so mode and literal cannot be forgotten. */
function field(name: string, src: string, span: Span, valueOverride?: string, textOverride?: string): FlowField {
  const text = textOverride ?? decode(src.substring(span.start, span.end));
  const mode = valueMode(text);
  return {
    name, value: valueOverride ?? fieldValue(src, span), text, span,
    mode, literal: modeValue(text, mode), labelW: LABEL_MIN,
  };
}

function trimSpan(src: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(src[start]!)) start++;
  while (end > start && /\s/.test(src[end - 1]!)) end--;
  return { start, end };
}

function fieldValue(src: string, span: Span): string {
  return decode(src.substring(span.start, span.end));
}

/** The argument rows of one statement, spans absolute into the body source.
 *  An object-literal argument becomes one row per top-level key; a plain argument one
 *  Value row; a Set Variable gets Name and Value; a head gets its clause. Total like the
 *  projection itself: a shape this misses simply contributes no rows. */
export function extractFields(src: string, span: Span, kind: FlowNode["kind"]): FlowField[] {
  const to = span.end;
  let at = skipSpace(src, span.start);

  if (kind === "if" || kind === "loop") {
    const open = src.indexOf("(", at);
    if (open < 0 || open >= to) return [];
    const close = findClose(src, open, to);
    if (close < 0) return [];
    const inner = trimSpan(src, { start: open + 1, end: close });
    if (kind === "if") return [field("Condition", src, inner)];
    const clause = src.substring(inner.start, inner.end);
    const of = /^(?:const|let|var)?\s*([\w$]+)\s+of\s+/.exec(decode(clause));
    if (of !== null) {
      const ofAt = clause.indexOf(" of ");
      const items = trimSpan(src, { start: inner.start + ofAt + 4, end: inner.end });
      // THE LOOP VARIABLE IS A BINDING, AND IT WAS THE ONE THE CARD WOULD NOT LET YOU EDIT.
      // The head drew `r in rows` as its subtitle and `Items rows` as its only row, so `rows`
      // was said twice and `r` - the name every step in the body reaches for - was said in
      // the one place on the card that is not editable. It is the same object as a Set
      // Variable's Name row, so it is drawn as one, and the subtitle that duplicated both
      // halves is suppressed by `subtitleShows`.
      const nameAt = clause.lastIndexOf(of[1]!, ofAt < 0 ? clause.length : ofAt);
      const bind = { start: inner.start + nameAt, end: inner.start + nameAt + of[1]!.length };
      return [
        { ...field("Item", src, bind, of[1]!, of[1]!), binds: true },
        field("Items", src, items),
      ];
    }
    return [field("Clause", src, inner)];
  }
  if (kind === "try" || kind === "catch" || kind === "code" || kind === "break" || kind === "continue") return [];

  if (kind === "return" || kind === "throw") {
    const word = kind === "return" ? "return" : "throw";
    const after = trimSpan(src, { start: at + word.length, end: statementContentEnd(src, at, to) });
    if (after.end <= after.start) return [];
    return [field(kind === "return" ? "Value" : "Error", src, after)];
  }

  // peel `const x = ` / `x = ` / `await ` exactly as classification does
  const raw = src.substring(at, to);
  let offset = 0;
  const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(raw);
  const plain = decl === null ? ASSIGN_HEAD.exec(raw) : null;
  const fields: FlowField[] = [];
  if (decl !== null) {
    const nameAt = at + raw.indexOf(decl[1]!);
    fields.push({ ...field("Name", src, { start: nameAt, end: nameAt + decl[1]!.length }, decl[1]!, decl[1]!), binds: true });
    offset = decl[0].length;
  } else if (plain !== null && !NOT_ASSIGNABLE.test(plain[1]!.split(/[.[]/)[0]!)) {
    const shown = plain[1]!.replace(/^dsx\.variable\./, "");
    const nameAt = at + raw.indexOf(shown);
    fields.push({ ...field("Name", src, { start: nameAt, end: nameAt + shown.length }, shown, shown), binds: true });
    offset = plain[0].length;
  }
  let exprAt = at + offset;
  if (src.startsWith("await ", exprAt)) exprAt += 6;

  const open = src.indexOf("(", exprAt);
  if (kind === "set" || open < 0 || open >= to) {
    // the whole right-hand side is the Value
    if (fields.length > 0) {
      const rhs = trimSpan(src, { start: at + offset, end: statementContentEnd(src, at, to) });
      if (rhs.end > rhs.start) fields.push(field("Value", src, rhs));
    }
    return fields;
  }
  const close = findClose(src, open, to);
  if (close < 0) return fields;
  // POSITIONAL ARGUMENTS ARE ARGUMENTS. `dsx.event('paid', { total: total })` used to collapse
  // into one `Value` row holding the whole parameter list, so the event's own name was not
  // separately editable and the card said "paid" twice. Each top-level argument gets its own
  // row, named from the verb's own vocabulary where there is one, and a trailing object
  // literal still expands into its keys - the shape most calls actually take.
  const args = topLevelEntries(src, open + 1, close).filter((e) => trimSpan(src, e).end > trimSpan(src, e).start);
  if (args.length === 0) return fields;
  const names = ARG_NAMES[kind] ?? [];
  args.forEach((entry, index) => {
    const span = trimSpan(src, entry);
    if (src[skipSpace(src, span.start)] === "{") {
      const objOpen = skipSpace(src, span.start);
      const objClose = findClose(src, objOpen, span.end);
      if (objClose > 0) {
        for (const e of topLevelEntries(src, objOpen + 1, objClose)) {
          const text = src.substring(e.start, e.end);
          const colon = topLevelColon(text);
          if (colon < 0) {
            const whole = trimSpan(src, e);
            fields.push(field(titleCase(decode(src.substring(whole.start, whole.end))), src, whole, ""));
            continue;
          }
          const key = decode(text.slice(0, colon)).trim();
          const value = trimSpan(src, { start: e.start + colon + 1, end: e.end });
          fields.push(field(titleCase(key), src, value));
        }
        return;
      }
    }
    fields.push(field(names[index] ?? (index === 0 ? "Value" : `Value ${index + 1}`), src, span));
  });
  return fields;
}

/** The matching close bracket for the opener at `open`, bounded by `to`; -1 if unbalanced. */
function findClose(src: string, open: number, to: number): number {
  const opener = src[open]!;
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < to; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < to) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) break; i++; }
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** First top-level `:` of one object entry (a URL inside a string does not count). */
function topLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < text.length) { if (text[i] === "\\") { i += 2; continue; } if (text[i] === q) break; i++; }
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

/** Where the statement's CONTENT ends: its span minus the trailing whitespace/newline the
 *  tiling made it own. */
function statementContentEnd(src: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/.test(src[end - 1]!)) end--;
  return end;
}

// ── layout: the auto-formatted tree, nobody positions anything ───────────────────────

/* ONE CARD WIDTH, AND IT IS THE WIDE ONE. A Custom Code card was 320 and every other card
   280, so a run of steps was a ragged column even before anything abutted; a stack whose
   members disagree about their width cannot read as one object. 320 is also the width the
   elision census asked for: the value column is what a card is FOR, and at 280 it cut a
   quarter of the rows it drew (1,316 of 5,560). At 320 that is 1,046 - 270 rows, 5% of the
   plane, stop being hidden - and the canvas leaves ~1000px of its width unused, so the room
   was never scarce. Past 340 the curve flattens and every lane pair grows with it. */
const STEP_W = 320;
const STEP_H = 46;       // the header-only card
const FIELD_H = 27;      // one argument row
/* A JUNCTION, NOT A NODE. At 12px in flat grey the merge read as a card that had lost its
   card - the one thing a reader should never have to wonder about. It is a bead on the wire:
   wire ink, wire weight, and small enough that the eye reads the line through it. */
const MERGE = 9;
const GAP = 44;          // a connector that forks or joins: one box to the next
/* EVERY BOUNDARY DRAWS ITS CONNECTOR (owner-directed 2026-08-27). An earlier wave abutted
   straight runs into one seamed stack, on the argument that adjacency already asserts
   sequence; the owner reversed it after using it: consecutive steps LINK, visibly, with the
   insert + riding every wire - the affordance is the point, and a chart whose steps carry
   their own wires reads as a chart everywhere someone has used one. The height that buys
   (GAP per statement) is accepted. */
/* AN ELBOW SPLITS ITS VERTICAL BETWEEN TWO LEGS, and a leg shorter than the hotspot sitting
   on it is a leg nobody can see. At GAP the two legs were 22px under a 28px disc, so the only
   visible part of a lane connector was its horizontal run - which is exactly the "orphan
   stub" the drawing was accused of. Elbows get their own, larger gap; straight runs keep the
   short one, because straight runs are where a thousand-line body spends its height. */
const ELBOW_GAP = 64;    // lane entry and exit: both legs clear of the hotspot
const STUB = 28;         // every edge leaves its anchor perpendicular this far before turning
const LANE_GAP = 56;     // between a branch's two lanes
const FRAME_PAD = 28;    // a loop container's inner margin
const LINE_H = 17;

/*
 *  COMMENTS ARE PART OF THE PROGRAM'S MEANING, and a projection that drops them tells the
 *  reader less than the file does. They are also the one thing in a body with no execution
 *  order, so they cannot be nodes in the chain without lying about the flow.
 *
 *  The rule that makes them safe: a comment is always OWNED by the statement it sits on, and
 *  it is drawn inside that statement's own reserved box - a tinted strip directly above the
 *  card, exactly the card's width. Two notes therefore cannot collide, a note cannot collide
 *  with a card, and a note cannot collide with a wire, because each one lives in vertical
 *  space the layout already paid for. Free-floating notes were rejected for the reason they
 *  are rejected in every text-backed editor: there is no byte in the file to store a position
 *  in, so the position would be lost on the next save.
 *
 *  Four shapes, and the shape is read from the text, not chosen by hand:
 *    note     a comment run directly above a statement           -> the post-it strip
 *    section  a run separated from its statement by a blank line -> a band with a rule
 *    ghost    a run whose content parses as code                 -> disabled-code styling
 *    trailing `stmt  // why`                                     -> a quiet line on the card
 *  A run that owns nothing - the end of a body, the whole content of an empty block - becomes
 *  a standalone note card, the only case where a comment gets a box of its own.
 *
 *  WRAPPING HAPPENS HERE, not in CSS. The layout must know the height before the browser
 *  does, so the projection greedy-wraps to the card's column count and ships one string per
 *  line; the client renders each line and wraps nothing. The reserved height is then correct
 *  by construction however long the comment is, and a very long one truncates at a fixed line
 *  budget with the full text still one tap away.
 */
export type FlowNote = {
  class: "note" | "section" | "ghost";
  /** Pre-wrapped display lines - the client renders one per row and wraps nothing. */
  lines: string[];
  /** The whole comment, markers stripped, for the editor panel. */
  text: string;
  /** The comment's own bytes, so it can be edited without touching the statement. */
  span: Span;
  h: number;
  /** True when the line budget cut it short. */
  more: boolean;
};

export type CommentPiece = { start: number; end: number; text: string };

/** A statement's byte range plus where its CODE begins - everything before that is its note. */
export type StatementSpan = Span & { code: number };

const NOTE_LINE = 15;
const NOTE_PAD = 14;
const NOTE_GAP = 6;
const NOTE_MAX = 8;
const SECTION_MAX = 3;
const TRAIL_H = 16;
/* WRAPPING NEEDS A WIDTH, AND AN AVERAGE IS NOT ONE. A flat advance wrapped prose correctly
   and clipped every line of a note full of digits or capitals, because in this face `@` is
   over three times the width of `i`. So the table is MEASURED, not guessed: it is the advance
   of every printable ASCII glyph in the note face at 11px, read out of the browser by
   dist/flow/calibrate.ts, and dist/flow/noteprobe.ts checks the resulting wrap against what
   the browser actually paints. Change the note's font and both scripts have to run again. */
const ADVANCE: Record<string, number> = {};
for (const [w, chars] of [
  [3.02, "'"], [3.06, "ijl"], [3.24, "IJ"], [3.50, " ,."], [3.71, "/:;\\|"], [3.79, "f"],
  [3.97, "-"], [4.29, "()[]"], [4.31, "t"], [4.33, "r"], [4.41, "!"], [5.06, '"'],
  [5.50, "*_`"], [5.73, "s"], [5.77, "z"], [5.84, "?"], [6.05, "c"], [6.13, "L"], [6.33, "F"],
  [6.37, "k"], [6.51, "vxy"], [6.53, "T"], [6.63, "P"], [6.72, "Y"], [6.73, "o"], [6.74, "a"],
  [6.77, "e"], [6.95, "E"], [6.97, "hnu"], [6.98, "Sbdgpq"], [7.00, "0123456789${}"],
  [7.21, "K"], [7.53, "V"], [7.54, "XZ"], [7.55, "B"], [7.64, "R"], [7.68, "C"], [7.83, "A"],
  [8.05, "U"], [8.23, "N"], [8.27, "H"], [8.47, "D"], [8.52, "G"], [8.58, "&"], [8.66, "OQ"],
  [9.00, "w"], [9.22, "#+<=>^~"], [9.49, "M"], [10.45, "%"], [10.72, "m"], [10.88, "W"],
  [11.00, "@"],
] as [number, string][]) for (const ch of chars) ADVANCE[ch] = w;
/** Anything off the table: an accented letter is ordinary width, CJK and emoji are full. */
const ADVANCE_OTHER = 7;
const ADVANCE_FULL = 11.5;
const MONO_ADVANCE = 6.02;   // the ghost skin, measured the same way at 10px

/* Three skins, three metrics. A section is SET IN CAPS by the sheet and tracked out, a ghost
   is monospace at the smaller size, and prose is the 11px face - so one measure would clip two
   of them. The measure reads the same numbers the sheet sets; if either moves, both move. */
type NoteMetric = { mono: boolean; scale: number; upper: boolean; track: number };
const METRICS: Record<FlowNote["class"], NoteMetric> = {
  note:    { mono: false, scale: 1,       upper: false, track: 0 },
  section: { mono: false, scale: 10 / 11, upper: true,  track: 0.6 },
  ghost:   { mono: true,  scale: 1,       upper: false, track: 0 },
};

/** One glyph's advance in the 11px Inter face the canvases are set in. Exported so the
 *  expression projection measures with the same table rather than a second guess. */
export function glyphWidth(ch: string): number {
  const known = ADVANCE[ch];
  if (known !== undefined) return known;
  return ch.codePointAt(0)! > 0x2e7f ? ADVANCE_FULL : ADVANCE_OTHER;
}

function textWidth(text: string, m: NoteMetric = METRICS.note): number {
  const cased = m.upper ? text.toUpperCase() : text;
  if (m.mono) return [...cased].length * (MONO_ADVANCE + m.track);
  let w = 0;
  for (const ch of cased) w += glyphWidth(ch) * m.scale + m.track;
  return w;
}

/*
 *  THE ARGUMENT ROW'S OWN GEOMETRY, and why the projection owns it rather than the sheet.
 *
 *  A row is `label | mark value` inside the card's 12px gutters. The label column used to be
 *  a flat 82px on every card, wide enough for the longest word in the whole vocabulary
 *  ("Destination"), which left a `Name` row with fifty pixels of nothing between the word and
 *  its value - and TWO measurable defects came out of that one number:
 *
 *    THE CARD READ AS TWO COLUMNS. Label to value was 90px inside a 27px row pitch, so the
 *    nearest thing to a label was the label below it, not the value beside it. Proximity is
 *    not a preference; at 3:1 the eye groups the wrong way and a card of rows reads as a
 *    column of names next to a column of values.
 *
 *    THE VALUE WAS CUT WHERE NOBODY COULD SEE IT. The projection handed out 60 characters and
 *    the row could show nineteen; the other forty-one went under a CSS ellipsis, so the
 *    drawing was hiding two thirds of an expression while reporting that it showed it. The
 *    note strip already refuses to work that way - "WRAPPING HAPPENS HERE, not in CSS" - and
 *    a value is the same problem: the projection must know what fits, because the projection
 *    is the thing that gets measured.
 *
 *  So the label column is measured PER CARD from the labels that card actually carries, and
 *  the value is elided to the pixels that are left. Both numbers come from the same advance
 *  table the note wrapper uses, at the row's own size.
 */
const LABEL_MIN = 40;    // "Name" and "Value" set the floor; below it rows stop lining up
const LABEL_MAX = 96;    // past this the label is the row, so a long one ellipsises instead
/** The 12px mono the value is set in (`--editor-t-meta`, `--editor-mono`): the note face's
 *  measured 10px advance, scaled. Fixed-advance, so characters are exact here. */
const ROW_MONO = MONO_ADVANCE * 1.2;
/** Everything in the row that is not the label or the value: the card's two 12px gutters, the
 *  8px gap, the value box's 8px padding each side, its 4px inner gap, and the mode mark's own
 *  column. */
const ROW_CHROME = 24 + 8 + 16 + 4 + 8;

/** The label column this card needs, and the value elided to what is left of the row. Called
 *  once per card, after its fields are extracted and before its height is reserved. */
function fitRows(fields: FlowField[], cardW: number): void {
  if (fields.length === 0) return;
  let labelW = LABEL_MIN;
  for (const f of fields) {
    labelW = Math.max(labelW, Math.ceil(textWidth(f.name, METRICS.note) * (12 / 11)) + 1);
  }
  labelW = Math.min(LABEL_MAX, labelW);
  const room = Math.max(ROW_MONO * 6, cardW - ROW_CHROME - labelW);
  for (const f of fields) {
    f.labelW = labelW;
    f.value = elideMono(f.value, room);
  }
}

/** A mono run cut to a pixel budget, with the ellipsis inside the budget. */
function elideMono(text: string, px: number): string {
  const chars = [...text];
  const max = Math.max(4, Math.floor(px / ROW_MONO));
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** Comment tokens in a range, plus where the last byte of actual code sits. String, template
 *  and comment aware, so a `//` inside a URL string is not a comment. Exported for the cost
 *  model, which has to split a statement's code from its prose exactly where `nodeFor` does. */
export function scanComments(src: string, from: number, to: number): { pieces: CommentPiece[]; codeEnd: number } {
  const pieces: CommentPiece[] = [];
  let codeEnd = from;
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < to) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      codeEnd = i;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < to && src[i] !== "\n") i++;
      pieces.push({ start, end: i, text: src.slice(start + 2, i).trim() });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      const close = src.indexOf("*/", i + 2);
      i = close < 0 || close + 2 > to ? to : close + 2;
      const inner = src.slice(start + 2, Math.max(start + 2, i - 2));
      pieces.push({
        start, end: i,
        text: inner.split("\n").map((l) => l.replace(/^\s*\*+ ?/, "").trim()).join("\n").trim(),
      });
      continue;
    }
    i++;
    codeEnd = i;
  }
  return { pieces, codeEnd };
}

/** Greedy wrap to a PIXEL budget. Returns the rendered lines and whether it was cut. */
function wrapNote(text: string, px: number, budget: number, m: NoteMetric): { lines: string[]; more: boolean } {
  const lines: string[] = [];
  const space = textWidth(" ", m);
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) { if (lines.length > 0) lines.push(""); continue; }
    let line = "";
    let width = 0;
    for (const word of words) {
      const ww = textWidth(word, m);
      if (line === "") { line = word; width = ww; continue; }
      if (width + space + ww <= px) { line = `${line} ${word}`; width += space + ww; continue; }
      lines.push(line);
      line = word;
      width = ww;
    }
    if (line !== "") lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= budget) return { lines, more: false };
  const cut = lines.slice(0, budget);
  let last = cut[budget - 1]!;
  while (last.length > 1 && textWidth(`${last}…`, m) > px) last = last.slice(0, -1);
  cut[budget - 1] = `${last}…`;
  return { lines: cut, more: true };
}

/* A HAND-DRAWN RULE IS A SECTION MARKER, not text. Authors write it three ways - a line of
   its own under the heading, a pair bracketing the heading, or a single leading run - and all
   three mean the same thing, so all three are stripped and all three promote the run to a
   section band. Box drawing counts: `// ── phase 2 ──` is the commonest spelling of it. */
const RULE = /^[-=~*_#─-╿]{3,}$/;
const RULE_EDGE = /^[-=~*_#─-╿]{2,}\s*|\s*[-=~*_#─-╿]{2,}$/g;

/** A comment run whose content is code someone switched off, rather than prose. */
function looksDisabled(text: string): boolean {
  const rows = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (rows.length === 0) return false;
  return rows.every((l) =>
    /^(const|let|var|return|throw|await|else|break|continue)\b/.test(l)
    || /^(if|for|while|switch|catch)\s*\(/.test(l)
    || /^[\w$.[\]'"]+\s*(=[^=]|\()/.test(l)
    || /^[)}\]];?$/.test(l));
}

/** The note a statement owns: the comment run between `from` and where its code starts. */
function noteBefore(src: string, from: number, codeAt: number, width: number): FlowNote | null {
  const { pieces, codeEnd } = scanComments(src, from, codeAt);
  const run = pieces.filter((piece) => piece.start >= codeEnd);
  if (run.length === 0) return null;
  const span: Span = { start: run[0]!.start, end: run[run.length - 1]!.end };
  // Consecutive `//` lines are ONE paragraph, not one line each: a hard newline per source
  // line re-wrapped into a ragged stack of half-empty rows. A blank `//` is a real break, and
  // a block comment keeps whatever line structure its author gave it.
  const literal = run.map((piece) => piece.text).filter((t) => t !== "").join("\n");
  const disabled = looksDisabled(literal);
  const paragraphs: string[] = [];
  // A LINE OF RULE ON ITS OWN underlines the heading above it, so the whole run is a heading.
  // A rule wrapped AROUND text makes that one line the heading, and anything else in the run
  // is prose about the step. The two spellings mean different things and are tracked apart.
  let underlined = false;
  let banner = false;
  let prose = false;
  // switched-off code keeps one line per line: re-flowing it would make it unreadable AS code
  if (disabled) paragraphs.push(...literal.split("\n"));
  else for (const piece of run) {
    const block = src[piece.start + 1] === "*";
    if (RULE.test(piece.text)) { underlined = true; continue; }
    const bare = piece.text.replace(RULE_EDGE, "");
    const ruled = bare !== piece.text;
    if (ruled) banner = true;
    if (bare === "") continue;
    if (piece.text === "") { paragraphs.push(""); continue; }
    if (!ruled) prose = true;
    // a heading is its own paragraph: prose written under `// ── phase 2 ──` is a note about
    // the step, not more of the heading, and running the two together loses both
    if (ruled || block || paragraphs.length === 0 || paragraphs[paragraphs.length - 1] === "") {
      paragraphs.push(bare);
      if (ruled) paragraphs.push("");
      continue;
    }
    paragraphs[paragraphs.length - 1] = `${paragraphs[paragraphs.length - 1]!} ${bare}`;
  }
  const text = decode(paragraphs.join("\n").trim());
  if (text === "") return null;
  const detached = /\n[ \t]*\r?\n/.test(src.slice(span.end, codeAt));
  // a banner with prose under it is a NOTE that opens with a heading, not a section band: the
  // band skin is a heading treatment and would set the whole paragraph in tracked caps
  const cls: FlowNote["class"] = disabled ? "ghost"
    : underlined || (banner && !prose) || (detached && !banner) ? "section" : "note";
  // the strip is `width` wide with 10px of padding each side and a 1px border each side
  const inner = Math.max(80, width - 22);
  const { lines, more } = wrapNote(text, inner, cls === "section" ? SECTION_MAX : NOTE_MAX, METRICS[cls]);
  return { class: cls, lines, text, span, h: lines.length * NOTE_LINE + NOTE_PAD, more };
}

/** `doThing()  // because the server rounds` - a comment sharing its statement's last line. */
function trailingComment(src: string, from: number, to: number): CommentPiece | null {
  const { pieces, codeEnd } = scanComments(src, from, to);
  const last = pieces[pieces.length - 1];
  if (last === undefined || last.start < codeEnd) return null;
  if (last.text === "") return null;
  return src.slice(codeEnd, last.start).includes("\n") ? null : last;
}

/** A step's identity line is drawn unless an argument row already carries it: "Set Variable ·
 *  total" over a `Name total` row says one thing twice, while "Call Module" over `Id`/`Amount`
 *  says nothing about which module. Compared with quotes and case stripped, so `'paid'` and
 *  `paid` count as the same word. */
function saysTheSame(a: string, b: string): boolean {
  const bare = (t: string): string => t.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return bare(a) === bare(b);
}

function subtitleShows(subtitle: string, fields: FlowField[], kind: FlowNode["kind"]): boolean {
  if (subtitle === "" || kind === "code" || kind === "start" || kind === "end") return false;
  if (fields.some((f) => saysTheSame(f.value, subtitle) || saysTheSame(f.text, subtitle))) return false;
  // `r in rows` is TWO facts, and a card carrying both of them as rows says each of them
  // twice if it draws the subtitle as well.
  const halves = subtitle.split(" in ");
  return !(halves.length === 2
    && halves.every((half) => fields.some((f) => saysTheSame(f.text, half))));
}

function cardHeight(fields: FlowField[], subtitle: string, showSub = subtitle !== ""): number {
  if (fields.length > 0) return STEP_H + fields.length * FIELD_H + 8 + (showSub ? 16 : 0);
  return showSub ? STEP_H + 16 : STEP_H;
}

type Ctx = { nodes: FlowNode[]; edges: FlowEdge[]; src: string; n: number };

function nodeFor(ctx: Ctx, span: StatementSpan): FlowNode {
  // A COMMENT USED TO DEMOTE ITS OWN STATEMENT. The span starts at the previous statement's
  // end, so `// pay the fee` + `charge(total)` classified as one blob and fell through every
  // pattern into Custom Code. Classification reads from `span.code`; the bytes before it are
  // the note. The span itself still covers both, so deleting an annotated step takes its
  // annotation with it rather than orphaning a comment about code that is gone.
  const note = noteBefore(ctx.src, span.start, span.code, STEP_W);
  const lift = note === null ? 0 : note.h + NOTE_GAP;

  if (span.code >= span.end) {
    // a comment that owns no statement: the note IS the node
    const only = noteBefore(ctx.src, span.start, span.end, STEP_W);
    const body = only ?? { class: "note" as const, lines: [], text: "", span, h: NOTE_PAD, more: false };
    return {
      id: `n${ctx.n++}`, kind: "note", title: "", subtitle: "", showSubtitle: false, lines: [], fields: [],
      note: body, headOffset: 0, span, x: 0, y: 0, w: STEP_W, h: body.h,
    };
  }

  const trail = trailingComment(ctx.src, span.code, span.end);
  const codeEnd = trail === null ? span.end : trail.start;
  const raw = ctx.src.substring(span.code, codeEnd);
  const c = classifyStatement(raw);
  const lines = decode(raw).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const fields = extractFields(ctx.src, { start: span.code, end: codeEnd }, c.kind);
  fitRows(fields, STEP_W);
  const showSub = subtitleShows(c.subtitle, fields, c.kind);
  const card = c.kind === "code"
    // 56, not 34: the card's own head is 44 plus 2 borders and a 10 bottom inset, so the
    // reserved box was 22px short of what the head alone needs and every code card
    // overflowed the height the layout engine had allotted it.
    // EVERY line, not the first ten: the markup binds `lines` whole, so a twelve-line
    // fallback drew twelve lines into a box reserved for ten and sat on the next card. The
    // budget belonged to a fold this card does not have - `lines` is also what the code
    // editor opens with, so shortening it would offer a Save that deletes the tail.
    ? Math.max(STEP_H, 56 + lines.length * LINE_H)
    : cardHeight(fields, c.subtitle, showSub);
  return {
    id: `n${ctx.n++}`, kind: c.kind, title: c.title, subtitle: c.subtitle, showSubtitle: showSub,
    lines, fields, span,
    ...(note === null ? {} : { note }),
    ...(trail === null ? {} : { trailing: decode(trail.text) }),
    headOffset: lift,
    x: 0, y: 0, w: STEP_W,
    h: lift + card + (trail === null ? 0 : TRAIL_H),
  };
}

/** Statement spans tiling one straight region: trailing whitespace rides with its statement
 *  (same trick the region parser uses), so splices at span ends land between lines. */
export function statementSpans(src: string, region: Span): StatementSpan[] {
  const out: StatementSpan[] = [];
  let cursor = region.start;
  while (cursor < region.end) {
    const at = skipSpace(src, cursor);
    // Nothing but whitespace and comments is left. Those bytes are a comment that owns no
    // statement - the end of a body, or the whole content of an empty block - and they used
    // to be tiled and then never drawn. They get a card of their own.
    if (at >= region.end) {
      if (scanComments(src, cursor, region.end).pieces.length > 0) {
        out.push({ start: cursor, end: region.end, code: region.end });
      }
      break;
    }
    let end = endOfStatement(src, at, region.end);
    if (end <= cursor) end = cursor + 1;
    // endOfStatement usually consumes the newline itself; when it stopped at a `;`,
    // pull the rest of the line in so the span ends at a line START, never mid-line.
    if (src[end - 1] !== "\n") {
      while (end < region.end && (src[end] === " " || src[end] === "\t" || src[end] === "\r")) end++;
      if (end < region.end && src[end] === "\n") end++;
    }
    out.push({ start: cursor, end, code: at });
    cursor = end;
  }
  return out;
}

/** Width one region list needs, lanes included. */
function measure(src: string, list: Region[]): number {
  let w = 0;
  for (const region of list) {
    if (region.kind === "straight") { w = Math.max(w, STEP_W); continue; }
    w = Math.max(w, STEP_W);
    if (region.kind === "branch" && region.alternate !== null) {
      // the SAME floors the layout uses, or a lane escapes its loop frame
      const yes = Math.max(STEP_W, measure(src, region.consequent));
      const no = Math.max(STEP_W, measure(src, region.alternate));
      w = Math.max(w, yes + LANE_GAP + no);
    } else if (region.kind === "branch") {
      w = Math.max(w, measure(src, region.consequent) + 2 * FRAME_PAD + 16);
    } else if (region.kind === "loop" || region.kind === "callback") {
      w = Math.max(w, measure(src, region.body) + 2 * FRAME_PAD + 16);
    } else {
      const body = Math.max(STEP_W, measure(src, region.body));
      const handler = region.handler === null ? 0 : Math.max(STEP_W, measure(src, region.handler));
      const fin = region.finalizer === null ? 0 : measure(src, region.finalizer);
      w = Math.max(w, body + (handler === 0 ? 0 : LANE_GAP + handler), fin);
    }
  }
  return Math.max(w, STEP_W);
}

function edge(ctx: Ctx, from: string, to: string, points: [number, number][], insertAt?: number, label?: FlowEdge["label"], prominent?: boolean): void {
  // the + sits at the midpoint of the longest vertical run
  let best: { y0: number; y1: number; x: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (x0 === x1 && Math.abs(y1 - y0) > (best === null ? 0 : Math.abs(best.y1 - best.y0))) {
      best = { y0, y1, x: x0 };
    }
  }
  const e: FlowEdge = { from, to, points, ...(label !== undefined ? { label } : {}), ...(prominent === true ? { prominent: true } : {}) };
  if (label !== undefined && points.length >= 2) {
    // Then/Else ride the bracket's HORIZONTAL run - the one stretch of a lane edge the +
    // hotspot never occupies - and fall back to the first segment on straight wires.
    let run: { x0: number; x1: number; y: number } | null = null;
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!;
      const [x1, y1] = points[i]!;
      if (y0 === y1 && Math.abs(x1 - x0) > (run === null ? 0 : Math.abs(run.x1 - run.x0))) {
        run = { x0, x1, y: y0 };
      }
    }
    if (run !== null) {
      e.labelX = (run.x0 + run.x1) / 2;
      e.labelY = run.y;
    } else {
      const a = points[0]!;
      const b = points[1]!;
      e.labelX = (a[0] + b[0]) / 2;
      e.labelY = (a[1] + b[1]) / 2;
    }
  }
  if (insertAt !== undefined) {
    e.insertAt = insertAt;
    const firstVertical = ((): { x: number; y: number } | null => {
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1]!;
        const [x1, y1] = points[i]!;
        if (x0 === x1 && y1 !== y0) return { x: x0, y: (y0 + y1) / 2 };
      }
      return null;
    })();
    const bestMid = best === null ? null : { x: best.x, y: (best.y0 + best.y1) / 2 };
    const spot = (bestMid ?? firstVertical)
      ?? (points.length >= 2
        ? { x: (points[0]![0] + points[points.length - 1]![0]) / 2, y: (points[0]![1] + points[points.length - 1]![1]) / 2 }
        : null);
    if (spot !== null) {
      e.plusX = spot.x;
      e.plusY = spot.y;
    }
  }
  ctx.edges.push(e);
}

/**
 * Lay one region list down an axis. Returns the exit: the node the next connector leaves
 * from, its bottom edge, and whether the sequence ended in a terminator (return/throw —
 * nothing runs after those, so no connector continues).
 */
/** Where a run continues from: the box the next connector hangs off. */
type Prev = { id: string; x: number; y: number };

function layoutSeq(
  ctx: Ctx, list: Region[], axis: number, top: number,
  from: Prev, entryInsert: number, exitInsert: number,
  firstLabel?: FlowEdge["label"],
): { id: string; x: number; y: number; bottom: number; terminated: boolean } {
  let prev: Prev = from;
  let y = top;
  let insert = entryInsert;
  let terminated = false;
  let pendingLabel = firstLabel;

  const connect = (to: FlowNode): void => {
    // The wire lands on the BOX, note included. Landing on the card instead ran the wire down
    // behind the note strip and put the + hotspot on top of it: the note is the head of this
    // block, not something floating over the connector.
    const points: [number, number][] = prev.x === axis
      ? [[prev.x, prev.y], [axis, to.y]]
      : [[prev.x, prev.y], [prev.x, prev.y + STUB], [axis, prev.y + STUB], [axis, to.y]];
    edge(ctx, prev.id, to.id, points, insert, pendingLabel);
    pendingLabel = undefined;
  };

  for (const region of list) {
    if (terminated) break;
    if (region.kind === "straight") {
      for (const span of statementSpans(ctx.src, region.span)) {
        if (ctx.src.substring(span.start, span.end).trim() === "") continue;
        const node = nodeFor(ctx, span);
        node.x = axis - node.w / 2;
        node.y = y;
        ctx.nodes.push(node);
        connect(node);
        prev = { id: node.id, x: axis, y: node.y + node.h };
        y = node.y + node.h + GAP;
        insert = span.end;
        // a terminator ends its RUN: `return`/`throw` leave the body, `break` leaves the
        // loop, `continue` goes back to the loop head. None of them reach the next statement,
        // and drawing an edge onward said the opposite - the chart claimed execution
        // continued past a break.
        if (node.kind === "return" || node.kind === "throw"
            || node.kind === "break" || node.kind === "continue") { terminated = true; break; }
      }
      continue;
    }

    const c = region.kind === "callback"
      ? classifyCallback(ctx.src.substring(region.headSpan.start, region.headSpan.end),
                         ctx.src.substring(region.tailSpan.start, region.tailSpan.end))
      : classifyHead(region.kind, ctx.src.substring(region.headSpan.start, region.headSpan.end));
    const headFields = extractFields(ctx.src, region.headSpan, c.kind);
    fitRows(headFields, STEP_W);
    // the region absorbed the comment run above the keyword; the head carries it
    const headNote = noteBefore(ctx.src, region.span.start, region.headSpan.start, STEP_W);
    const headLift = headNote === null ? 0 : headNote.h + NOTE_GAP;
    const headShowSub = subtitleShows(c.subtitle, headFields, c.kind);
    const head: FlowNode = {
      id: `n${ctx.n++}`, kind: c.kind, title: c.title, subtitle: c.subtitle, showSubtitle: headShowSub,
      lines: [], fields: headFields, span: region.headSpan,
      ...(headNote === null ? {} : { note: headNote }),
      headOffset: headLift,
      x: axis - STEP_W / 2, y, w: STEP_W, h: headLift + cardHeight(headFields, c.subtitle, headShowSub),
    };
    ctx.nodes.push(head);
    connect(head);
    const headBottom = head.y + head.h;

    if (region.kind === "branch" && region.alternate !== null) {
      const yesW = Math.max(STEP_W, measure(ctx.src, region.consequent));
      const noW = Math.max(STEP_W, measure(ctx.src, region.alternate));
      const total = yesW + LANE_GAP + noW;
      const yesAxis = axis - total / 2 + yesW / 2;
      const noAxis = axis + total / 2 - noW / 2;
      const laneTop = headBottom + ELBOW_GAP;
      const yes = layoutSeq(ctx, region.consequent, yesAxis, laneTop,
        { id: head.id, x: axis - STEP_W / 4, y: headBottom }, region.headSpan.end,
        endOfBody(ctx.src, region, "consequent"), "Then");
      const no = layoutSeq(ctx, region.alternate, noAxis, laneTop,
        { id: head.id, x: axis + STEP_W / 4, y: headBottom },
        region.alternateHeadSpan === null ? region.span.end : region.alternateHeadSpan.end,
        endOfBody(ctx.src, region, "alternate"), "Else");
      if (yes.terminated && no.terminated) {
        terminated = true;
        prev = { id: head.id, x: axis, y: Math.max(yes.bottom, no.bottom) };
        break;
      }
      const mergeY = Math.max(yes.bottom, no.bottom, headBottom) + ELBOW_GAP;
      const merge: FlowNode = {
        id: `n${ctx.n++}`, kind: "merge", title: "", subtitle: "", showSubtitle: false, lines: [], fields: [],
        x: axis - MERGE / 2, y: mergeY, w: MERGE, h: MERGE,
      };
      ctx.nodes.push(merge);
      if (!yes.terminated) {
        edge(ctx, yes.id, merge.id,
          yes.x === axis ? [[yes.x, yes.y], [axis, mergeY]] : [[yes.x, yes.y], [yes.x, mergeY - STUB], [axis, mergeY - STUB], [axis, mergeY]],
          endOfBody(ctx.src, region, "consequent"),
          yes.id === head.id ? "Then" : undefined,
          yes.id === head.id);
      }
      if (!no.terminated) {
        edge(ctx, no.id, merge.id,
          no.x === axis ? [[no.x, no.y], [axis, mergeY]]
            : [[no.x, no.y], [no.x, mergeY - STUB], [axis, mergeY - STUB], [axis, mergeY]],
          endOfBody(ctx.src, region, "alternate"),
          no.id === head.id ? "Else" : undefined,
          no.id === head.id);
      }
      prev = { id: merge.id, x: axis, y: mergeY + MERGE };
      y = mergeY + MERGE + GAP;
      insert = region.span.end;
      continue;
    }

    /*  A ONE-ARMED `IF` IS A CONTAINER, NOT A FORK. 336 of this repo's 418 branches (80%)
     *  have no `else`, and every one of them drew the full fork: a Then lane, a merge bead,
     *  a Then word, an Else word, and an else path that left the head, ran out to a channel
     *  of its own, down past the lane and back in - four corners to say "and if not, carry
     *  on". A fork is two paths the reader must hold at once; `if (x) { … }` is ONE path
     *  with a detour, which is the same object a loop is: a wall the reader is inside of.
     *  So it draws as one, and the spine stays a spine. A real `else` keeps the fork,
     *  because with two arms the fork is the information (and 82 branches have one). */
    if (region.kind === "loop" || region.kind === "callback" || region.kind === "branch") {
      const inner = region.kind === "branch" ? region.consequent : region.body;
      const innerPart = region.kind === "branch" ? "consequent" as const : "body" as const;
      const bodyW = Math.max(STEP_W, measure(ctx.src, inner));
      const frameW = bodyW + 2 * FRAME_PAD;
      const frameTop = headBottom + GAP;
      const laneTop = frameTop + FRAME_PAD;
      const frameId = `n${ctx.n++}`;
      const body = layoutSeq(ctx, inner, axis, laneTop,
        { id: head.id, x: axis, y: headBottom }, region.headSpan.end, endOfBody(ctx.src, region, innerPart));
      // the port sits ON the container's bottom border; the wire into it is the
      // append-inside connector, the wire out of it continues the flow after the container
      const portY = Math.max(body.bottom, laneTop) + GAP * 0.75;
      const port: FlowNode = {
        id: `n${ctx.n++}`, kind: "port", title: "", subtitle: "", showSubtitle: false, lines: [], fields: [],
        x: axis - MERGE / 2, y: portY, w: MERGE, h: MERGE,
      };
      ctx.nodes.push(port);
      // THE CONTAINER: emitted before its children in reading order but drawn underneath
      // by the client. Its whole meaning is the loop - there is no back edge to tangle.
      ctx.nodes.push({
        id: frameId, kind: "frame", title: "", subtitle: "", showSubtitle: false, lines: [], fields: [],
        frame: region.kind === "branch" ? "if" : "loop",
        x: axis - frameW / 2, y: frameTop, w: frameW, h: portY + MERGE / 2 - frameTop,
      });
      if (body.terminated) {
        // a body ending in return/throw never reaches the port; the flow still leaves the
        // container - a loop by exhausting it, a one-armed `if` by not entering it
        edge(ctx, head.id, port.id, [[axis, headBottom], [axis, portY]], region.headSpan.end, undefined, inner.length === 0);
      } else {
        edge(ctx, body.id, port.id,
          body.x === axis ? [[body.x, body.y], [axis, portY]] : [[body.x, body.y], [body.x, portY - STUB], [axis, portY - STUB], [axis, portY]],
          endOfBody(ctx.src, region, innerPart), undefined, inner.length === 0);
      }
      prev = { id: port.id, x: axis, y: portY + MERGE };
      y = portY + MERGE + GAP;
      insert = region.span.end;
      continue;
    }

    // guard: the try lane and the catch lane, centred as a PAIR around the axis - the same
    // arithmetic `branch` uses, because it is the same shape
    const bodyW = Math.max(STEP_W, measure(ctx.src, region.body));
    const handlerW = region.handler === null ? 0 : Math.max(STEP_W, measure(ctx.src, region.handler));
    const guardTotal = bodyW + (handlerW === 0 ? 0 : LANE_GAP + handlerW);
    const bodyAxis = axis - guardTotal / 2 + bodyW / 2;
    const catchAxis = axis + guardTotal / 2 - handlerW / 2;
    const laneTop = headBottom + ELBOW_GAP;
    const body = layoutSeq(ctx, region.body, bodyAxis, laneTop,
      { id: head.id, x: bodyAxis === axis ? axis : axis - STEP_W / 4, y: headBottom },
      region.headSpan.end, endOfBody(ctx.src, region, "body"));
    let handler: ReturnType<typeof layoutSeq> | null = null;
    if (region.handler !== null && region.handlerHeadSpan !== null) {
      const catchNode: FlowNode = {
        id: `n${ctx.n++}`, kind: "catch", title: "Catch", subtitle: "", showSubtitle: false, lines: [], fields: [],
        span: region.handlerHeadSpan, x: catchAxis - STEP_W / 2, y: laneTop, w: STEP_W, h: STEP_H,
      };
      ctx.nodes.push(catchNode);
      // out of the head's BOTTOM like every other edge, then across to the catch lane
      edge(ctx, head.id, catchNode.id,
        [[axis + STEP_W / 4, headBottom], [axis + STEP_W / 4, headBottom + STUB],
         [catchAxis, headBottom + STUB], [catchAxis, laneTop]],
        undefined, "Catch");
      handler = layoutSeq(ctx, region.handler, catchAxis, laneTop + STEP_H + GAP,
        { id: catchNode.id, x: catchAxis, y: laneTop + STEP_H }, region.handlerHeadSpan.end, endOfBody(ctx.src, region, "handler"));
    }
    const mergeY = Math.max(body.bottom, handler?.bottom ?? headBottom) + ELBOW_GAP;
    const merge: FlowNode = {
      id: `n${ctx.n++}`, kind: "merge", title: "", subtitle: "", showSubtitle: false, lines: [], fields: [],
      x: axis - MERGE / 2, y: mergeY, w: MERGE, h: MERGE,
    };
    ctx.nodes.push(merge);
    if (!body.terminated) {
      edge(ctx, body.id, merge.id,
        body.x === axis ? [[body.x, body.y], [axis, mergeY]]
          : [[body.x, body.y], [body.x, mergeY - STUB], [axis, mergeY - STUB], [axis, mergeY]],
        endOfBody(ctx.src, region, "body"));
    }
    if (handler !== null && !handler.terminated) {
      edge(ctx, handler.id, merge.id,
        [[handler.x, handler.y], [handler.x, mergeY - STUB], [axis, mergeY - STUB], [axis, mergeY]],
        endOfBody(ctx.src, region, "handler"));
    }
    prev = { id: merge.id, x: axis, y: mergeY + MERGE };
    y = mergeY + MERGE + GAP;

    // FINALLY IS A JOIN, NOT A HANDLER. Both lanes have already met at the merge, so the
    // finalizer hangs off it on the axis: one lane, entered from every path, which is exactly
    // what the keyword means. Sharing the handler slot had drawn it as the ERROR path and
    // labelled it Catch; splitting the region left its statements laid out nowhere at all.
    if (region.finalizer !== null && region.finallyHeadSpan !== null) {
      const finNode: FlowNode = {
        id: `n${ctx.n++}`, kind: "finally", title: "Finally", subtitle: "", showSubtitle: false, lines: [], fields: [],
        span: region.finallyHeadSpan, x: axis - STEP_W / 2, y, w: STEP_W, h: STEP_H,
      };
      ctx.nodes.push(finNode);
      edge(ctx, merge.id, finNode.id, [[axis, mergeY + MERGE], [axis, y]],
           region.finallyHeadSpan.end, "Always");
      const fin = layoutSeq(ctx, region.finalizer, axis, y + STEP_H + GAP,
        { id: finNode.id, x: axis, y: y + STEP_H }, region.finallyHeadSpan.end,
        endOfBody(ctx.src, region, "finalizer"));
      prev = { id: fin.id, x: fin.x, y: fin.y };
      y = fin.bottom + GAP;
      terminated = fin.terminated;
    }
    insert = region.span.end;
  }

  void exitInsert;
  return { id: prev.id, x: prev.x, y: prev.y, bottom: Math.max(prev.y, y - GAP), terminated };
}

/** The byte offset that appends INSIDE a construct's body/lane: just before its closing
 *  brace (found by walking back from the region end past the brace and whitespace). */
function endOfBody(src: string, region: Region, part: "consequent" | "alternate" | "body" | "handler" | "finalizer"): number {
  const inner: Region[] | null =
    part === "consequent" && region.kind === "branch" ? region.consequent
    : part === "alternate" && region.kind === "branch" ? region.alternate
    : part === "body" && (region.kind === "loop" || region.kind === "guard" || region.kind === "callback") ? region.body
    : part === "handler" && region.kind === "guard" ? region.handler
    : part === "finalizer" && region.kind === "guard" ? region.finalizer
    : null;
  if (inner !== null && inner.length > 0) return inner[inner.length - 1]!.span.end;
  // an empty callback body appends between its own braces, never after the statement
  if (part === "body" && region.kind === "callback") return region.headSpan.end;
  // empty lane: insert right after the head's opening brace
  if (part === "alternate" && region.kind === "branch" && region.alternateHeadSpan !== null) return region.alternateHeadSpan.end;
  if (part === "handler" && region.kind === "guard" && region.handlerHeadSpan !== null) return region.handlerHeadSpan.end;
  if (part === "finalizer" && region.kind === "guard" && region.finallyHeadSpan !== null) return region.finallyHeadSpan.end;
  return region.kind === "straight" ? region.span.end : region.headSpan.end;
}

// ── the projection ───────────────────────────────────────────────────────────────────

/** `trigger` names the start pill: "Action · Place", "On Tap". */
export function projectFlow(source: string, trigger: string): Flow {
  const cfg = projectCfg(source);
  const exact = reconstruct(cfg) === source;
  const width = measure(source, cfg.regions) + 2 * FRAME_PAD + 48;
  const axis = width / 2;
  const ctx: Ctx = { nodes: [], edges: [], src: source, n: 0 };

  const start: FlowNode = {
    id: "start", kind: "start", title: trigger, subtitle: "", showSubtitle: false, lines: [], fields: [],
    x: axis - STEP_W / 2, y: 0, w: STEP_W, h: 44,
  };
  ctx.nodes.push(start);

  const out = layoutSeq(ctx, cfg.regions, axis, 44 + GAP, { id: "start", x: axis, y: 44 }, 0, source.length);

  /*  A TERMINATED BODY HAS NO END PILL. `return`, `throw` and a branch whose every arm ends
   *  in one leave nothing that reaches the foot of the chart, so the flow already drew no
   *  connector there - and the pill stayed, floating in space, on a drawing whose whole job
   *  is to say what reaches what. 299 of the repo's 1,597 bodies (18.7%) drew that orphan.
   *  The terminator card IS the end: it carries its own mark and its own word, and nothing
   *  can be appended after it because nothing runs there.  */
  const endY = out.terminated ? out.bottom : out.bottom + GAP;
  if (!out.terminated) {
    const end: FlowNode = {
      id: "end", kind: "end", title: "End", subtitle: "", showSubtitle: false, lines: [], fields: [],
      x: axis - STEP_W / 2, y: endY, w: STEP_W, h: 44,
    };
    ctx.nodes.push(end);
    edge(ctx, out.id, end.id,
      out.x === axis ? [[out.x, out.y], [axis, endY]] : [[out.x, out.y], [out.x, endY - GAP / 2], [axis, endY - GAP / 2], [axis, endY]],
      source.length);
  }

  const statements = ctx.nodes.filter((n) => n.span !== undefined && n.kind !== "note").length;
  return {
    nodes: ctx.nodes, edges: ctx.edges,
    width, height: endY + (out.terminated ? 0 : 44) + 24,
    exact, statements,
    rev: createHash("sha256").update(source).digest("hex").slice(0, 16),
  };
}

// ── the scope plane: what an expression at this byte may name ────────────────────────
//
//  AN ARGUMENT ROW IS A FORMULA, and a formula is only writable if you know what is in
//  scope where it sits. The editor used to offer a bare text box, which is the same as
//  offering nothing: an author had to remember the loop variable's name, the action's input
//  names, and which document variables exist. Every one of those is derivable from the file.
//
//  Scope is computed by walking the region tree down to the byte and collecting, in order:
//  the binders each enclosing construct introduces (a `for … of` item, a callback parameter,
//  a `catch` binding), then every local declared EARLIER in the same run. Later declarations
//  are deliberately excluded - naming one is a temporal-dead-zone error, and an editor that
//  offers it is teaching the author a bug.

export type ScopeName = {
  name: string;
  /** Where it came from, so the picker can group and the reader can trust it. */
  origin: "input" | "binder" | "local" | "document" | "ambient";
  /** The construct or declaration that introduced it: "for row of rows", "<variable>". */
  from: string;
};

const DECLARE = /(?:^|[;{}\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;

/** Parameters of every arrow or function whose body encloses `at`, outermost first. */
function arrowBinders(src: string, span: Span, at: number, out: ScopeName[]): void {
  let from = span.start;
  for (let guard = 0; guard < 32; guard++) {
    const block = callbackBlock(src, from, span.end);
    if (block === null || block.close <= block.open) return;
    if (at <= block.open || at >= block.close) {
      // not this one: step past it and look for the next callback in the same statement
      from = block.close;
      continue;
    }
    const head = decode(src.slice(from, block.open + 1)).trim();
    const params = /(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{\s*$/.exec(head)
      ?? /function\s*[\w$]*\s*\(([^)]*)\)\s*\{\s*$/.exec(head);
    for (const raw of (params?.[1] ?? params?.[2] ?? "").split(",")) {
      const clean = raw.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) out.push({ name: clean, origin: "binder", from: head.replace(/\s*\{$/, "") });
    }
    from = block.open + 1;
  }
}

/** Names a region list declares before `at`, in source order. */
function localsBefore(src: string, list: Region[], at: number, out: ScopeName[]): void {
  for (const region of list) {
    if (region.span.start >= at) return;
    if (region.kind === "straight") {
      const slice = src.slice(region.span.start, Math.min(region.span.end, at));
      for (const m of slice.matchAll(DECLARE)) out.push({ name: m[1]!, origin: "local", from: "declared above" });
      // A ONE-LINE CALLBACK IS STILL A BINDING. `rows.forEach(line => dsx.log(line.id))` is
      // deliberately NOT promoted to a container - a frame around one statement says nothing -
      // but `line` is in scope inside it all the same, and an editor that will not offer the
      // one name the expression is about is worse than no editor.
      if (at > region.span.start && at < region.span.end) arrowBinders(src, region.span, at, out);
      continue;
    }
    // a construct that does not CONTAIN the byte still contributes nothing but its own
    // declarations, which live inside it and are therefore out of scope out here
    if (at < region.span.start || at > region.span.end) continue;
    const head = decode(src.slice(region.headSpan.start, region.headSpan.end));
    if (region.kind === "branch") {
      localsBefore(src, region.consequent, at, out);
      if (region.alternate !== null) localsBefore(src, region.alternate, at, out);
      continue;
    }
    if (region.kind === "loop") {
      const of = /^for\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\s/.exec(head.trim());
      const classic = /^for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(head.trim());
      const bound = of?.[1] ?? classic?.[1];
      if (bound !== undefined) out.push({ name: bound, origin: "binder", from: head.trim().replace(/\s*\{\s*$/, "") });
      localsBefore(src, region.body, at, out);
      continue;
    }
    if (region.kind === "callback") {
      const params = /(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{\s*$/.exec(head.trim().replace(/=&gt;/g, "=>"));
      for (const raw of (params?.[1] ?? params?.[2] ?? "").split(",")) {
        const clean = raw.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) {
          out.push({ name: clean, origin: "binder", from: head.trim().replace(/\s*\{\s*$/, "") });
        }
      }
      localsBefore(src, region.body, at, out);
      continue;
    }
    // guard: the catch binding is in scope only inside the handler
    if (region.handlerHeadSpan !== null && region.handler !== null
        && at >= region.handlerHeadSpan.start && at <= region.span.end) {
      const bound = /catch\s*\(\s*([A-Za-z_$][\w$]*)/.exec(decode(src.slice(region.handlerHeadSpan.start, region.handlerHeadSpan.end)));
      if (bound !== null) out.push({ name: bound[1]!, origin: "binder", from: "catch" });
      localsBefore(src, region.handler, at, out);
      continue;
    }
    localsBefore(src, region.body, at, out);
    if (region.finalizer !== null) localsBefore(src, region.finalizer, at, out);
  }
}

/** Everything an expression at `at` may name, nearest binding first, deduplicated. */
export function scopeAt(source: string, at: number, inputs: string[], document: ScopeName[]): ScopeName[] {
  const found: ScopeName[] = [];
  for (const name of inputs) found.push({ name, origin: "input", from: "this action" });
  localsBefore(source, projectCfg(source).regions, at, found);
  const seen = new Set<string>();
  const out: ScopeName[] = [];
  // nearest binding wins: a loop variable that shadows a document variable is what runs
  for (const row of [...found].reverse()) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.unshift(row);
  }
  for (const row of document) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

//
//  THE VALUE MODE. An argument is ultimately a formula, but most arguments are not: they are
//  a piece of text, a number, a switch, or the name of something. Reading which one the
//  author actually wrote lets the editor offer the right control instead of a text box for
//  everything - and lets the row show, at a glance and without being read, whether a value is
//  a literal or a computation. The mode is DERIVED, never stored: the source text is the only
//  record, so nothing can drift out of sync with it.
//
export type ValueMode = "text" | "number" | "boolean" | "reference" | "expression" | "empty";

export function valueMode(text: string): ValueMode {
  const t = decode(text).trim();
  if (t === "") return "empty";
  if (/^'[^'\\]*'$/.test(t) || /^"[^"\\]*"$/.test(t)) return "text";
  if (/^-?\d+(\.\d+)?$/.test(t)) return "number";
  if (t === "true" || t === "false") return "boolean";
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t) && t !== "null" && t !== "undefined") return "reference";
  return "expression";
}

/** The literal a mode carries, unwrapped: `'Save'` in text mode edits as `Save`. */
export function modeValue(text: string, mode: ValueMode): string {
  const t = decode(text).trim();
  if (mode === "text") return t.slice(1, -1);
  return t;
}

/** Turn what the author typed in one mode back into source text. */
export function modeSource(value: string, mode: ValueMode, quote = "'"): string {
  if (mode === "text") {
    // The author's own quote character, when there was one. Rewriting `"q"` as `'q'` is a
    // diff on a row nobody edited.
    const q = quote === '"' ? '"' : "'";
    const escaped = value.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`);
    return `${q}${escaped}${q}`;
  }
  if (mode === "boolean") return value === "true" ? "true" : "false";
  if (mode === "number") return /^-?\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : "0";
  if (mode === "empty") return "";
  return value;
}

// ── the insert catalog: what the + offers ────────────────────────────────────────────

const SHARED: InsertableNode[] = [
  { kind: "set", title: "Set Variable", subtitle: "Store a value under a name", template: "name = value" },
  { kind: "if", title: "If / Else", subtitle: "Branch on a condition", template: "if (condition) {\n} else {\n}" },
  { kind: "loop", title: "For Each Loop", subtitle: "Run the steps for every item", template: "for (const item of items) {\n}" },
  { kind: "loop", title: "While Loop", subtitle: "Repeat while a condition holds", template: "while (condition) {\n}" },
  { kind: "try", title: "Try / Catch", subtitle: "Recover when a step throws", template: "try {\n} catch (e) {\n}" },
  { kind: "log", title: "Log", subtitle: "Write to the log ring", template: "dsx.log('message')" },
  { kind: "return", title: "Return", subtitle: "Finish with a result", template: "return value" },
  { kind: "throw", title: "Throw Error", subtitle: "Fail this run", template: "throw new Error('message')" },
  { kind: "code", title: "Custom Code", subtitle: "Anything JSE runs", template: "// code" },
];

const FRONTEND: InsertableNode[] = [
  { kind: "call", title: "Call Module", subtitle: "A native capability on the bus", template: "dsx.module.scheme.action({ })" },
  { kind: "navigate", title: "Go To Page", subtitle: "Navigate to a route", template: "dsx.module.route.push({ path: '/page' })" },
  { kind: "event", title: "Send Event", subtitle: "Announce; the mounting side's on:<name> reacts", template: "dsx.event('name', {})" },
  { kind: "action", title: "Run Action", subtitle: "Another declared action", template: "actionName()" },
  { kind: "api", title: "API Request", subtitle: "Refresh or send a declared api", template: "apiName.refresh()" },
];

const BACKEND: InsertableNode[] = [
  { kind: "call", title: "Query Data", subtitle: "Read rows from an entity", template: "const rows = data.entity.list({ })" },
  { kind: "call", title: "Insert Data", subtitle: "Create a row", template: "data.entity.insert({ })" },
  { kind: "call", title: "Update Data", subtitle: "Change a row", template: "data.entity.update({ id: id })" },
  { kind: "call", title: "Delete Data", subtitle: "Remove a row", template: "data.entity.remove({ id: id })" },
  { kind: "call", title: "Queue Work", subtitle: "Hand a job to a worker", template: "queue.push({ })" },
  { kind: "set", title: "Read Secret", subtitle: "A declared secret, by name", template: "const key = secret.NAME" },
];

export function insertCatalog(surface: "frontend" | "backend"): InsertableNode[] {
  return surface === "backend" ? [...BACKEND, ...SHARED] : [...FRONTEND, ...SHARED];
}

// ── the splice: how a visual edit becomes bytes ──────────────────────────────────────

export type FlowEditOp =
  | { op: "insert"; at: number; text: string }
  | { op: "replace"; span: Span; text: string }
  | { op: "remove"; span: Span }
  | { op: "move"; span: Span; to: number };

/** The indentation of the line the offset sits on (or the previous line for an
 *  end-of-body offset), so inserted steps line up with their neighbours. */
function indentAt(src: string, at: number): string {
  let lineStart = src.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  let i = lineStart;
  let indent = "";
  while (i < src.length && (src[i] === " " || src[i] === "\t")) { indent += src[i]; i++; }
  if (indent === "" && lineStart > 0) {
    const prevStart = src.lastIndexOf("\n", lineStart - 2) + 1;
    i = prevStart;
    while (i < src.length && (src[i] === " " || src[i] === "\t")) { indent += src[i]; i++; }
  }
  return indent;
}

const XML_TEXT: [RegExp, string][] = [[/&/g, "&amp;"], [/</g, "&lt;"]];

/** New text entering a .dsx body must re-encode what the file's grammar reserves - and an
 *  `on:*` handler body is an ATTRIBUTE VALUE, where the delimiter is reserved too. Escaping
 *  only `&` and `<` meant every insert carrying a quote produced an unparseable document;
 *  the endpoint's reparse guard caught it and refused the edit, so the picker silently
 *  could not insert most of its own templates into a handler. */
export function encodeForBody(text: string, context: "text" | "attr" = "text"): string {
  let out = text;
  for (const [re, to] of XML_TEXT) out = out.replace(re, to);
  if (context === "attr") out = out.replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  return out;
}

/**
 * Apply one visual edit to a body's RAW source. Insert re-indents the template to the
 * insertion line; remove takes the statement's owned bytes (trailing whitespace included,
 * exactly the span the projection handed out — never more).
 */
export function applyFlowEdit(source: string, edit: FlowEditOp, context: "text" | "attr" = "text"): string {
  if (edit.op === "insert") {
    const at = Math.max(0, Math.min(edit.at, source.length));
    const indent = indentAt(source, at);
    // Spans own their trailing newline, so a connector's offset sits at a line start;
    // when it does not (an empty lane's brace, the very end), a newline opens the line.
    const atLineStart = at === 0 || source[at - 1] === "\n";
    const block = encodeForBody(edit.text, context).split("\n").map((line) => indent + line).join("\n") + "\n";
    return source.slice(0, at) + (atLineStart ? "" : "\n") + block + source.slice(at);
  }
  if (edit.op === "replace") {
    const held = source.slice(edit.span.start, edit.span.end);
    if (decode(held) === edit.text) return source;
    return source.slice(0, edit.span.start) + encodeForBody(edit.text, context) + source.slice(edit.span.end);
  }
  if (edit.op === "remove") {
    return source.slice(0, edit.span.start) + source.slice(edit.span.end);
  }
  // move: remove the span, then insert its text at the target (target measured in the
  // ORIGINAL source; shifted when the removal sits before it).
  const text = source.substring(edit.span.start, edit.span.end);
  const without = source.slice(0, edit.span.start) + source.slice(edit.span.end);
  const to = edit.to > edit.span.end ? edit.to - (edit.span.end - edit.span.start)
    : edit.to > edit.span.start ? edit.span.start
    : edit.to;
  const indent = indentAt(without, to);
  const trimmed = text.replace(/\s+$/, "");
  const body = trimmed.split("\n").map((line, i) => (i === 0 ? line.trimStart() : line)).join("\n");
  const needsLead = to > 0 && without[to - 1] !== "\n";
  return without.slice(0, to) + (needsLead ? "\n" + indent : indent) + body + "\n" + without.slice(to);
}
