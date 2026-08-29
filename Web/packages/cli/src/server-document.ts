//
//  server-document.ts — the `<server>` document compile step of `despia build`
//  (backend-authoring.md, the STANDALONE twin of ClosedSource/scripts/server_document.rb +
//  the prepare_server.rb emitters).
//
//  A backend surface is a .dsx document: the head declares entities, secrets, egress and
//  actions; the body declares routes, workers and tools. In the monorepo those compile to
//  facet rows prepare_server.rb aggregates; a standalone project has no facet aggregate, so
//  this step compiles `server/*.dsx` straight into the shapes `@despia-native/server/host` consumes —
//  `server/generated/index.ts` (entities · routes · handlers · migrationSql) plus
//  `server/generated/migration.sql` — and the project's worker imports the barrel instead of
//  hand-carrying the compiled form. One source of truth; the drift class dies at the root.
//
//  THE READER IS A TWIN, NOT A COUSIN. Scanner, closed vocabulary, key derivation and every
//  validation mirror server_document.rb — an `<action>` body is JSE (it contains `<`, `&&`,
//  `"`), so action content is read as RAW TEXT to its closing tag, and an unknown tag or
//  attribute ABORTS naming the line (the attribute in question is usually `auth`).
//
//  Deterministic and idempotent: sorted iteration, no timestamps, write-only-on-change —
//  the second run is a no-diff, which is the same law every monorepo emitter obeys.
//

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { systemTables } from "@despia-native/server/postgres";

export class ServerDocumentError extends Error {}

// tag → the attributes it accepts. Anything else is a build abort naming the line.
const HEAD_TAGS: Record<string, readonly string[]> = {
  entity: ["as", "ownership"],
  field: ["as", "type"],
  index: ["on"],
  secret: ["as", "env"],
  egress: ["host", "self"],
  action: ["as", "inputs"],
  budget: ["of", "per", "max", "depth"],
};
const BODY_TAGS: Record<string, readonly string[]> = {
  route: ["as", "method", "path", "action", "entity", "op", "auth", "rate", "schedule", "body", "reach"],
  worker: ["as", "queue", "action", "path", "schedule", "idempotencyKey", "rate"],
  tool: ["as", "action", "description", "auth", "mutates"],
};

// Read as raw text to the closing tag: the content is code, not markup.
const RAW_TAGS = new Set(["action"]);

const IDENT = /^[a-z][a-z0-9_]*$/;
const ACTION_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const KEY = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// The spend plane's closed seam list (cost-guardrails.md) — server_document.rb BUDGET_OF,
// verbatim: a typo must not read as a guard.
const BUDGET_OF = /^(requests|data:reads|data:writes|egress:[a-z0-9]([a-z0-9.-]*[a-z0-9])?|queue:[a-z][a-z0-9_]*)$/;
const BUDGET_PER = ["hour", "day", "month"] as const;

// The guarded defaults (prepare_server.rb SPEND_DEFAULTS): units, never currency.
const SPEND_DEFAULTS: readonly [string, number][] = [
  ["requests", 250_000],
  ["data:writes", 500_000],
  ["data:reads", 2_500_000],
];
const SPEND_DEFAULT_EGRESS_MAX = 25_000;
const SPEND_DEFAULT_QUEUE_MAX = 50_000;
const SPEND_DEFAULT_QUEUE_DEPTH = 10_000;

// The one closed schema vocabulary (backend-authoring.md §2) — restated from the reference
// emitter, which owns it; a vendor type is vendor-named, never here.
const SCHEMA_TYPES = ["text", "integer", "real", "boolean", "timestamptz", "jsonb", "uuid"] as const;
const SCHEMA_OWNERSHIP = ["owner", "public-read", "service"] as const;
/** Columns the emitter writes itself; a declared field colliding is a build abort. */
const SCHEMA_RESERVED_FIELDS = ["id", "owner_id", "created_at"] as const;
const PG_TYPE: Record<string, string> = {
  text: "text", integer: "bigint", real: "double precision",
  boolean: "boolean", timestamptz: "timestamptz", jsonb: "jsonb", uuid: "uuid",
};
const CRUD_OPS = ["create", "get", "list", "update", "delete"] as const;

type Node = { tag: string; attrs: Record<string, string>; text: string | null; line: number; children: Node[] };

// ── scanning (one pass, no backtracking — server_document.rb `scan`, verbatim) ──────────

function scan(source: string, rel: string): Node {
  let pos = 0;
  const stack: Node[] = [];
  let root: Node | null = null;
  const lineOf = (offset: number): number => source.substring(0, offset).split("\n").length;

  for (;;) {
    const openAt = source.indexOf("<", pos);
    if (openAt < 0) break;
    if (source.substring(openAt, openAt + 4) === "<!--") {
      const close = source.indexOf("-->", openAt);
      if (close < 0) throw new ServerDocumentError(`${rel}: unterminated comment at line ${lineOf(openAt)}`);
      pos = close + 3;
      continue;
    }
    const closeAt = source.indexOf(">", openAt);
    if (closeAt < 0) throw new ServerDocumentError(`${rel}: unterminated tag at line ${lineOf(openAt)}`);
    const raw = source.substring(openAt + 1, closeAt);
    pos = closeAt + 1;

    if (raw.startsWith("/")) {
      const name = raw.substring(1).trim();
      const top = stack.pop();
      if (top === undefined) throw new ServerDocumentError(`${rel}: </${name}> with no matching open tag (line ${lineOf(openAt)})`);
      if (top.tag !== name) throw new ServerDocumentError(`${rel}: </${name}> closes <${top.tag}> (line ${lineOf(openAt)})`);
      if (stack.length === 0) root = top;
      continue;
    }

    let selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.substring(0, raw.length - 1) : raw;
    const nameMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(body);
    if (nameMatch === null) throw new ServerDocumentError(`${rel}: malformed tag at line ${lineOf(openAt)}`);
    const name = nameMatch[0];

    const node: Node = {
      tag: name,
      attrs: parseAttrs(body.substring(name.length), rel, lineOf(openAt)),
      text: null,
      line: lineOf(openAt),
      children: [],
    };

    if (RAW_TAGS.has(name) && !selfClosing) {
      // Raw content: scan for the literal closing tag. `</action` cannot appear inside a JSE
      // body (`<` is only ever a comparison, and `/action` after it is not an expression).
      const terminator = `</${name}>`;
      const endAt = source.indexOf(terminator, pos);
      if (endAt < 0) throw new ServerDocumentError(`${rel}: <${name}> at line ${node.line} is never closed`);
      node.text = source.substring(pos, endAt);
      pos = endAt + terminator.length;
      selfClosing = true;
    }

    if (stack.length === 0) {
      if (name !== "server") {
        throw new ServerDocumentError(`${rel}: the root element must be <server>, found <${name}> (line ${node.line})`);
      }
      if (selfClosing) throw new ServerDocumentError(`${rel}: <server> may not be self-closing`);
      stack.push(node);
      continue;
    }

    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 0) throw new ServerDocumentError(`${rel}: <${stack[stack.length - 1]!.tag}> is never closed`);
  if (root === null) throw new ServerDocumentError(`${rel}: no <server> root element`);
  return root;
}

const ATTR = /^\s*([A-Za-z][A-Za-z0-9_:-]*)\s*=\s*"([^"]*)"/;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

// ATTRIBUTES are decoded; an <action> BODY is not — a body is code, so `<` is a comparison an
// author types directly, while an attribute is markup text where `&lt;` is the only spelling.
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]!);
}

function parseAttrs(text: string, rel: string, line: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let rest = text;
  while (rest.trim().length > 0) {
    const m = ATTR.exec(rest);
    if (m === null) {
      throw new ServerDocumentError(`${rel}: line ${line}: attributes must be name="value" (at ${JSON.stringify(rest.trim().substring(0, 40))})`);
    }
    if (Object.hasOwn(attrs, m[1]!)) throw new ServerDocumentError(`${rel}: line ${line}: duplicate attribute ${JSON.stringify(m[1])}`);
    attrs[m[1]!] = decodeEntities(m[2]!);
    rest = rest.substring(m[0].length);
  }
  return attrs;
}

// ── the document → rows (server_document.rb `read`, TS-shaped) ──────────────────────────

export type EntityRow = { fields: Record<string, string>; ownership: string; indexes: string[] };
export type RouteRow = {
  method: string; path: string;
  auth?: string; rate?: string; schedule?: string; body?: string;
  op?: string; entity?: string;
  action?: string; worker?: string; idempotencyKey?: string;
};
/** One declared `<budget>` row (cost-guardrails.md). `line` is where it sits in the file —
 *  the Studio's server view points a reader at the declaration that pins a ceiling. */
export type BudgetRow = {
  of: string;
  per: "hour" | "day" | "month";
  max: number | "unbounded";
  depth?: number;
  line: number;
};

export type ServerDoc = {
  /** the document's chain — its basename ("notes.dsx" → "notes"); the handler-table key */
  chain: string;
  schema: Record<string, EntityRow>;
  api: Record<string, RouteRow>;
  mcp: Record<string, { action: string; description: string; auth?: string; mutates?: string }>;
  actions: Record<string, { body: string; inputs: Record<string, string> }>;
  secrets: string[];
  egress: string[];
  /** hosts acknowledged `self="allow"` — the deploy-time self-call refusal looks for these */
  egressSelf: string[];
  budgets: BudgetRow[];
  reach: Record<string, string[]>;
};

/** `POST /orders/:id` → `post-orders-id` — the stable default key (server_document.rb). */
export function deriveKey(method: string, path: string): string {
  let slug = path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  if (slug.length === 0) slug = "root";
  return `${method.toLowerCase()}-${slug}`;
}

function checkAttrs(node: Node, allowed: readonly string[], rel: string): void {
  for (const k of Object.keys(node.attrs)) {
    if (!allowed.includes(k)) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: <${node.tag}> has no attribute ${JSON.stringify(k)} (accepted: ${allowed.join(" · ")})`);
    }
  }
}

function requireAttr(node: Node, name: string, rel: string): string {
  const value = node.attrs[name] ?? "";
  if (value.length === 0) throw new ServerDocumentError(`${rel}: line ${node.line}: <${node.tag}> needs ${name}="…"`);
  return value;
}

/** Read one `<server>` document into its contribution rows.
 *
 *  `reachedByEvents` widens the emptiness gate, not the grammar: a PROJECT document whose
 *  only content is actions is an authoring mistake (nothing can reach them), but an app
 *  AUTOMATION document (studio-apps.md §7.2) is reached by event bindings the MANIFEST
 *  declares — outside this file's sight — so its caller states that reachability. */
export function readServerDocument(
  source: string, rel: string, chain: string, opts: { reachedByEvents?: boolean } = {},
): ServerDoc {
  const root = scan(source, rel);
  checkAttrs(root, [], rel);

  const heads = root.children.filter((c) => c.tag === "head");
  if (heads.length !== 1) throw new ServerDocumentError(`${rel}: a <server> document needs exactly one <head>`);

  const out: ServerDoc = { chain, schema: {}, api: {}, mcp: {}, actions: {}, secrets: [], egress: [], egressSelf: [], budgets: [], reach: {} };

  for (const node of heads[0]!.children) {
    const allowed = HEAD_TAGS[node.tag];
    if (allowed === undefined) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: <${node.tag}> is not a <head> element (accepted: ${Object.keys(HEAD_TAGS).join(" · ")})`);
    }
    checkAttrs(node, allowed, rel);
    if (node.tag === "entity") readEntity(node, out, rel);
    else if (node.tag === "secret") readSecret(node, out, rel);
    else if (node.tag === "egress") readEgress(node, out, rel);
    else if (node.tag === "action") readAction(node, out, rel);
    else if (node.tag === "budget") readBudget(node, out, rel);
    else throw new ServerDocumentError(`${rel}: line ${node.line}: <${node.tag}> belongs inside <entity>, not directly in <head>`);
  }

  for (const node of root.children.filter((c) => c.tag !== "head")) {
    const allowed = BODY_TAGS[node.tag];
    if (allowed === undefined) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: <${node.tag}> is not a <server> body element (accepted: ${Object.keys(BODY_TAGS).join(" · ")})`);
    }
    checkAttrs(node, allowed, rel);
    if (node.tag === "route") readRoute(node, out, rel);
    else if (node.tag === "worker") readWorker(node, out, rel);
    else readTool(node, out, rel);
  }

  if (Object.keys(out.api).length === 0 && Object.keys(out.mcp).length === 0 && opts.reachedByEvents !== true) {
    throw new ServerDocumentError(`${rel}: a <server> document declares no routes and no tools — it would emit nothing.`);
  }
  if (opts.reachedByEvents === true && Object.keys(out.actions).length === 0) {
    throw new ServerDocumentError(`${rel}: an automation document declares no actions — nothing for its event bindings to run.`);
  }
  return out;
}

function readEntity(node: Node, out: ServerDoc, rel: string): void {
  const name = requireAttr(node, "as", rel);
  if (!IDENT.test(name)) throw new ServerDocumentError(`${rel}: line ${node.line}: entity ${JSON.stringify(name)} must be snake_case.`);
  if (Object.hasOwn(out.schema, name)) throw new ServerDocumentError(`${rel}: line ${node.line}: entity ${JSON.stringify(name)} is declared twice.`);

  const fields: Record<string, string> = {};
  const indexes: string[] = [];
  for (const child of node.children) {
    if (child.tag !== "field" && child.tag !== "index") {
      throw new ServerDocumentError(`${rel}: line ${child.line}: <${child.tag}> is not an <entity> element (accepted: field · index)`);
    }
    checkAttrs(child, HEAD_TAGS[child.tag]!, rel);
    if (child.tag === "field") {
      const fname = requireAttr(child, "as", rel);
      const ftype = requireAttr(child, "type", rel);
      if (!IDENT.test(fname)) throw new ServerDocumentError(`${rel}: line ${child.line}: entity ${JSON.stringify(name)}: field ${JSON.stringify(fname)} must be snake_case.`);
      if (!(SCHEMA_TYPES as readonly string[]).includes(ftype)) {
        throw new ServerDocumentError(`${rel}: line ${child.line}: entity ${JSON.stringify(name)}: field ${JSON.stringify(fname)} type ${JSON.stringify(ftype)} is not one of ${SCHEMA_TYPES.join(" · ")}.`);
      }
      if ((SCHEMA_RESERVED_FIELDS as readonly string[]).includes(fname)) {
        throw new ServerDocumentError(`${rel}: line ${child.line}: entity ${JSON.stringify(name)}: field ${JSON.stringify(fname)} is RESERVED (${SCHEMA_RESERVED_FIELDS.join(" · ")} are emitted automatically).`);
      }
      fields[fname] = ftype;
    } else {
      indexes.push(...requireAttr(child, "on", rel).split(/\s+/).filter((s) => s.length > 0));
    }
  }
  if (Object.keys(fields).length === 0) throw new ServerDocumentError(`${rel}: line ${node.line}: entity ${JSON.stringify(name)} declares no <field>.`);
  for (const ix of indexes) {
    if (!Object.hasOwn(fields, ix)) throw new ServerDocumentError(`${rel}: line ${node.line}: entity ${JSON.stringify(name)}: index ${JSON.stringify(ix)} names no declared field.`);
  }
  const ownership = requireAttr(node, "ownership", rel);
  if (!(SCHEMA_OWNERSHIP as readonly string[]).includes(ownership)) {
    throw new ServerDocumentError(`${rel}: line ${node.line}: entity ${JSON.stringify(name)}: ownership ${JSON.stringify(ownership)} must be one of ${SCHEMA_OWNERSHIP.join(" · ")}.`);
  }
  out.schema[name] = { fields, ownership, indexes };
}

// Optional `self="allow"` is the acknowledgement the deploy-time self-call refusal looks for:
// a host that admits the deployment's own hostname is the recursion-bill class the spend plane
// exists to stop, and only a written word on the row may open that door.
function readEgress(node: Node, out: ServerDoc, rel: string): void {
  const host = requireAttr(node, "host", rel);
  const ack = node.attrs["self"];
  if (ack !== undefined && ack !== "allow") {
    throw new ServerDocumentError(`${rel}: line ${node.line}: egress ${JSON.stringify(host)}: self=${JSON.stringify(ack)} — the only value is "allow" (the acknowledgement that this host is the deployment itself).`);
  }
  out.egress.push(host);
  if (ack !== undefined) out.egressSelf.push(host);
}

// The spend plane's head row (cost-guardrails.md) — server_document.rb read_budget, verbatim:
// closed seam list, per ∈ hour · day · month (default day), max a positive whole number or the
// loud word "unbounded", depth on queue rows only.
function readBudget(node: Node, out: ServerDoc, rel: string): void {
  const of = requireAttr(node, "of", rel);
  if (!BUDGET_OF.test(of)) {
    throw new ServerDocumentError(`${rel}: line ${node.line}: budget of=${JSON.stringify(of)} is not a metered seam (requests · data:reads · data:writes · egress:<host> · queue:<name>).`);
  }
  if (out.budgets.some((b) => b.of === of)) {
    throw new ServerDocumentError(`${rel}: line ${node.line}: budget ${JSON.stringify(of)} is declared twice.`);
  }
  const per = node.attrs["per"] ?? "day";
  if (!(BUDGET_PER as readonly string[]).includes(per)) {
    throw new ServerDocumentError(`${rel}: line ${node.line}: budget ${JSON.stringify(of)}: per=${JSON.stringify(per)} must be one of ${BUDGET_PER.join(" · ")}.`);
  }
  const maxRaw = requireAttr(node, "max", rel);
  let max: number | "unbounded";
  if (maxRaw === "unbounded") {
    max = "unbounded";
  } else {
    if (!/^[1-9]\d{0,11}$/.test(maxRaw)) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: budget ${JSON.stringify(of)}: max=${JSON.stringify(maxRaw)} must be a positive whole number of units, or the word "unbounded" (the loud opt-out).`);
    }
    max = Number(maxRaw);
  }
  const row: BudgetRow = { of, per: per as BudgetRow["per"], max, line: node.line };
  if (Object.hasOwn(node.attrs, "depth")) {
    if (!of.startsWith("queue:")) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: budget ${JSON.stringify(of)}: \`depth\` (the outstanding-message ceiling) belongs on a queue budget only.`);
    }
    const depthRaw = node.attrs["depth"]!;
    if (!/^[1-9]\d{0,8}$/.test(depthRaw)) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: budget ${JSON.stringify(of)}: depth=${JSON.stringify(depthRaw)} must be a positive whole number of messages.`);
    }
    row.depth = Number(depthRaw);
  }
  out.budgets.push(row);
}

function readSecret(node: Node, out: ServerDoc, rel: string): void {
  const name = requireAttr(node, "as", rel);
  const env = requireAttr(node, "env", rel);
  if (!ACTION_NAME.test(name)) throw new ServerDocumentError(`${rel}: line ${node.line}: secret ${JSON.stringify(name)} must be snake_case or camelCase.`);
  if (!ENV_NAME.test(env)) throw new ServerDocumentError(`${rel}: line ${node.line}: secret ${JSON.stringify(name)}: env ${JSON.stringify(env)} must be SCREAMING_SNAKE_CASE.`);
  if (out.secrets.includes(name)) throw new ServerDocumentError(`${rel}: line ${node.line}: secret ${JSON.stringify(name)} is declared twice.`);
  // The seam reads by the DECLARED name and the runtime resolves it through `ctx.env`,
  // so the two must be the same word (server_document.rb, the B4 silent class).
  if (name !== env) {
    throw new ServerDocumentError(`${rel}: line ${node.line}: secret ${JSON.stringify(name)} must be declared as its env name (${JSON.stringify(env)}) — a body reads the secret by the name the deploy sets.`);
  }
  out.secrets.push(name);
}

function readAction(node: Node, out: ServerDoc, rel: string): void {
  const name = requireAttr(node, "as", rel);
  if (!ACTION_NAME.test(name)) throw new ServerDocumentError(`${rel}: line ${node.line}: action ${JSON.stringify(name)} must be a plain identifier.`);
  if (Object.hasOwn(out.actions, name)) throw new ServerDocumentError(`${rel}: line ${node.line}: action ${JSON.stringify(name)} is declared twice.`);
  const body = node.text ?? "";
  if (body.trim().length === 0) throw new ServerDocumentError(`${rel}: line ${node.line}: action ${JSON.stringify(name)} has an empty body.`);

  const inputs: Record<string, string> = {};
  for (const decl of (node.attrs["inputs"] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    // `inputs="order"` declares the name; `inputs="id: item.id"` declares name and expression.
    const colon = decl.indexOf(":");
    const key = (colon < 0 ? decl : decl.substring(0, colon)).trim();
    const expr = colon < 0 ? "" : decl.substring(colon + 1).trim();
    if (!ACTION_NAME.test(key)) throw new ServerDocumentError(`${rel}: line ${node.line}: action ${JSON.stringify(name)}: input ${JSON.stringify(key)} must be a plain identifier.`);
    inputs[key] = expr.length === 0 ? key : expr;
  }
  out.actions[name] = { body, inputs };
}

function readRoute(node: Node, out: ServerDoc, rel: string): void {
  const method = requireAttr(node, "method", rel).toUpperCase();
  const path = requireAttr(node, "path", rel);
  let key = node.attrs["as"] ?? "";
  if (key.length === 0) key = deriveKey(method, path);
  if (!KEY.test(key)) throw new ServerDocumentError(`${rel}: line ${node.line}: route key ${JSON.stringify(key)} must be lower-kebab-case.`);
  if (Object.hasOwn(out.api, key)) throw new ServerDocumentError(`${rel}: line ${node.line}: route key ${JSON.stringify(key)} is declared twice.`);

  const row: RouteRow = { method, path };
  for (const a of ["auth", "rate", "schedule", "body", "op", "entity"] as const) {
    if (Object.hasOwn(node.attrs, a)) row[a] = node.attrs[a]!;
  }

  const action = node.attrs["action"] ?? "";
  if (action.length === 0) {
    if ((row.entity ?? "").length === 0) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: route ${JSON.stringify(key)} needs either action="…" or entity="…" + op="…".`);
    }
  } else {
    if ((row.entity ?? "").length > 0) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: route ${JSON.stringify(key)} names BOTH action and entity — a row has one handler.`);
    }
    if (!Object.hasOwn(out.actions, action)) {
      throw new ServerDocumentError(`${rel}: line ${node.line}: route ${JSON.stringify(key)} names action ${JSON.stringify(action)}, which this document does not declare.`);
    }
    row.action = action;
    if (Object.hasOwn(node.attrs, "reach")) {
      out.reach[action] = node.attrs["reach"]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }
  out.api[key] = row;
}

// A `<tool>` row is to MCP what a `<route>` row is to HTTP: the SAME declared action, served
// over the /mcp streamable-HTTP face; the input shape is the action's declared inputs.
function readTool(node: Node, out: ServerDoc, rel: string): void {
  const action = requireAttr(node, "action", rel);
  if (!Object.hasOwn(out.actions, action)) throw new ServerDocumentError(`${rel}: line ${node.line}: tool action ${JSON.stringify(action)} is not declared by this document.`);
  let name = node.attrs["as"] ?? "";
  if (name.length === 0) name = action;
  if (!ACTION_NAME.test(name)) throw new ServerDocumentError(`${rel}: line ${node.line}: tool name ${JSON.stringify(name)} must be a plain identifier.`);
  if (Object.hasOwn(out.mcp, name)) throw new ServerDocumentError(`${rel}: line ${node.line}: tool ${JSON.stringify(name)} is declared twice.`);
  const description = requireAttr(node, "description", rel);
  const row: ServerDoc["mcp"][string] = { action, description };
  if (Object.hasOwn(node.attrs, "auth")) row.auth = node.attrs["auth"]!;
  if (Object.hasOwn(node.attrs, "mutates")) row.mutates = node.attrs["mutates"]!;
  out.mcp[name] = row;
}

function readWorker(node: Node, out: ServerDoc, rel: string): void {
  const queue = requireAttr(node, "queue", rel);
  const action = requireAttr(node, "action", rel);
  if (!Object.hasOwn(out.actions, action)) throw new ServerDocumentError(`${rel}: line ${node.line}: worker action ${JSON.stringify(action)} is not declared by this document.`);
  let path = node.attrs["path"] ?? "";
  if (path.length === 0) path = `/internal/${queue.replace(/_/g, "-")}/drain`;
  let key = node.attrs["as"] ?? "";
  if (key.length === 0) key = deriveKey("POST", path);
  if (Object.hasOwn(out.api, key)) throw new ServerDocumentError(`${rel}: line ${node.line}: worker key ${JSON.stringify(key)} is declared twice.`);

  // A worker row is an api row with `worker` set — POST + auth required + reach [] forced,
  // because the shape of a drain endpoint is not a decision.
  const row: RouteRow = { method: "POST", path, action, auth: "required", worker: queue };
  for (const a of ["schedule", "idempotencyKey", "rate"] as const) {
    if (Object.hasOwn(node.attrs, a)) row[a] = node.attrs[a]!;
  }
  out.reach[action] = [];
  out.api[key] = row;
}

// ── the spend plane (cost-guardrails.md — prepare_server.rb's merge, standalone-shaped) ──
//
//  Guarded defaults with ZERO declarations: every deployment carries per-day ceilings on the
//  five metered seams, derived from what the documents already declare (each egress host, each
//  drained queue), and a `<budget>` row is the author's per-attribute override. `declared`
//  carries the provenance the Studio shows — a default IS a budget, just one nobody had to
//  write — and `line`/`chain` point a reader at the declaration that pins a declared row.

export type SpendPlaneRow = {
  of: string;
  per: BudgetRow["per"];
  max: number | "unbounded";
  depth?: number;
  declared: boolean;
  line?: number;
  chain?: string;
};

export function spendPlane(docs: readonly ServerDoc[]): SpendPlaneRow[] {
  const egressHosts = [...new Set(docs.flatMap((d) => d.egress))].sort();
  const drained = [...new Set(docs.flatMap((d) => Object.values(d.api).filter((r) => r.worker !== undefined).map((r) => r.worker!)))].sort();

  for (const doc of docs) {
    for (const b of doc.budgets) {
      if (b.of.startsWith("egress:")) {
        const host = b.of.slice("egress:".length);
        // A budget host that is a SUFFIX-PARENT of declared hosts is the aggregate-vendor
        // ceiling the runtime's own resolution defines (spend.ts stateFor); only a host that
        // matches NOTHING is the typo this refusal exists for.
        if (!egressHosts.some((declared) => declared === host || declared.endsWith(`.${host}`))) {
          throw new ServerDocumentError(`server/${doc.chain}.dsx: line ${b.line}: budget ${q(b.of)} names a host no <egress> declares (declared: ${egressHosts.length === 0 ? "none" : egressHosts.join(" · ")}) — a ceiling on a host nothing can call is a typo, and a typo here must not read as a guard.`);
        }
      } else if (b.of.startsWith("queue:")) {
        const queue = b.of.slice("queue:".length);
        if (!drained.includes(queue)) {
          throw new ServerDocumentError(`server/${doc.chain}.dsx: line ${b.line}: budget ${q(b.of)} names a queue no <worker> drains (drained: ${drained.length === 0 ? "none" : drained.join(" · ")}).`);
        }
      }
    }
  }

  const rows: SpendPlaneRow[] = [];
  for (const [of, max] of SPEND_DEFAULTS) rows.push({ of, per: "day", max, declared: false });
  for (const host of egressHosts) rows.push({ of: `egress:${host}`, per: "day", max: SPEND_DEFAULT_EGRESS_MAX, declared: false });
  for (const queue of drained) rows.push({ of: `queue:${queue}`, per: "day", max: SPEND_DEFAULT_QUEUE_MAX, depth: SPEND_DEFAULT_QUEUE_DEPTH, declared: false });
  for (const doc of docs) {
    for (const b of doc.budgets) {
      const declared: SpendPlaneRow = { of: b.of, per: b.per, max: b.max, ...(b.depth !== undefined ? { depth: b.depth } : {}), declared: true, line: b.line, chain: doc.chain };
      const index = rows.findIndex((r) => r.of === b.of);
      // Per-attribute override: a queue budget that only tunes `max` keeps the default
      // `depth` — what the author did not touch stays guarded.
      if (index < 0) rows.push(declared);
      else rows[index] = { ...rows[index]!, ...declared };
    }
  }
  rows.sort((a, b) => (a.of < b.of ? -1 : a.of > b.of ? 1 : 0));
  return rows;
}

// ── the emitter (`server/*.dsx` → `server/generated/`) ──────────────────────────────────

export type ServerEmitResult = {
  /** compiled documents, by chain (sorted) */
  documents: string[];
  routes: number;
  entities: number;
  /** spend ceilings emitted (defaults + declared), and the seams loudly opted out */
  spend: { ceilings: number; unbounded: string[] };
  /** files written or refreshed under server/generated/, project-relative */
  written: string[];
  /** scheduled triggers the deploy target must declare: a queue drain plus every route schedule */
  crons: string[];
  /** declared `<tool>` rows — the barrel exports `mcpTools` only when there are some */
  tools: number;
  /** granted app automations folded in — the barrel exports `automations` only when > 0 */
  automations: number;
};

const GENERATED_HEADER = "//  GENERATED by `despia build` (the <server> document compile step) — never hand-edit.";

/** `list-notes` → `listNotes` — the shared handler-export namespace (prepare_server.rb). */
export function crudExportName(key: string): string {
  const [head, ...rest] = key.split(/[-_]/);
  return `${head}${rest.map((s) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.substring(1))).join("")}`;
}

function q(value: string): string { return JSON.stringify(value); }

/** Compile every `server/*.dsx` under the project root, or clean up when none remain.
 *  Returns null when the project has no server documents. */
export function emitServerArtifacts(
  projectRoot: string,
  opts: {
    /** the granted app-automation fold (studio-apps.md §7.2): namespaced `app_<scheme>`
     *  documents carrying actions/secrets/egress only, plus the event→action bindings */
    apps?: {
      docs: readonly ServerDoc[];
      automations: ReadonlyArray<{ app: string; contribution: string; on: string; chain: string; action: string; mode: string }>;
    };
  } = {},
): ServerEmitResult | null {
  const serverDir = join(projectRoot, "server");
  const generatedDir = join(serverDir, "generated");
  const sources = existsSync(serverDir)
    ? readdirSync(serverDir).filter((n) => n.endsWith(".dsx")).sort()
    : [];
  const appDocs = opts.apps?.docs ?? [];
  const automations = opts.apps?.automations ?? [];

  if (sources.length === 0 && appDocs.length === 0) {
    // Stale artifacts from documents that no longer exist: remove ONLY what this emitter
    // recognizably wrote — never a hand-managed folder.
    const barrel = join(generatedDir, "index.ts");
    if (existsSync(barrel) && readFileSync(barrel, "utf8").includes(GENERATED_HEADER)) {
      rmSync(generatedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    return null;
  }

  const docs: ServerDoc[] = [];
  for (const name of sources) {
    const chain = basename(name, ".dsx");
    if (!IDENT.test(chain)) {
      throw new ServerDocumentError(`server/${name}: the document's name becomes its chain — it must be snake_case.`);
    }
    docs.push(readServerDocument(readFileSync(join(serverDir, name), "utf8"), `server/${name}`, chain));
  }
  // App-automation documents join the same universe AFTER the project's own, so every merge
  // gate below (entities, routes, spend) judges them too. Their chain namespace (`app_…`) is
  // reserved: a project document of the same name is a collision, said here rather than as
  // a duplicate handler far away.
  for (const doc of appDocs) {
    if (docs.some((d) => d.chain === doc.chain)) {
      throw new ServerDocumentError(`server/${doc.chain}.dsx collides with the installed app chain ${q(doc.chain)} — the app_ prefix is reserved for granted automations.`);
    }
    docs.push(doc);
  }

  // ── merge gates over the whole set (one universe, like prepare_server.rb) ──
  const entityOwner = new Map<string, string>();
  for (const doc of docs) {
    for (const entity of Object.keys(doc.schema)) {
      const prior = entityOwner.get(entity);
      if (prior !== undefined) {
        throw new ServerDocumentError(`entity ${q(entity)} is declared by BOTH server/${prior}.dsx and server/${doc.chain}.dsx — declare it once.`);
      }
      entityOwner.set(entity, doc.chain);
    }
  }
  const byMethodPath = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const doc of docs) {
    for (const [key, row] of Object.entries(doc.api)) {
      const mp = `${row.method} ${row.path}`;
      const priorMp = byMethodPath.get(mp);
      if (priorMp !== undefined) {
        throw new ServerDocumentError(`route ${q(mp)} is declared twice (${priorMp} and ${doc.chain}/${key}) — one method+path, one row.`);
      }
      byMethodPath.set(mp, `${doc.chain}/${key}`);
      const priorKey = byKey.get(key);
      if (priorKey !== undefined) {
        throw new ServerDocumentError(`route key ${q(key)} is declared in both server/${priorKey}.dsx and server/${doc.chain}.dsx — rename one.`);
      }
      byKey.set(key, doc.chain);
      // The ownership/route cross-checks (prepare_server.rb): a service entity is admin-only,
      // and an owner entity without auth admits callers who have none.
      if (row.entity !== undefined) {
        const spec = docs.find((d) => Object.hasOwn(d.schema, row.entity!))?.schema[row.entity!];
        if (spec === undefined) {
          throw new ServerDocumentError(`route ${q(key)}: entity ${q(row.entity)} is not declared by any server document.`);
        }
        const op = row.op ?? "";
        if (!(CRUD_OPS as readonly string[]).includes(op)) {
          throw new ServerDocumentError(`route ${q(key)}: op ${q(op)} must be one of ${CRUD_OPS.join(" · ")}.`);
        }
        if (spec.ownership === "service" && row.worker === undefined) {
          throw new ServerDocumentError(`route ${q(key)}: entity ${q(row.entity)} declares ownership "service" (admin-only) — it cannot be exposed as client CRUD.`);
        }
        if (spec.ownership === "owner" && row.auth !== "required" && row.worker === undefined) {
          throw new ServerDocumentError(`route ${q(key)}: entity ${q(row.entity)} declares ownership "owner" but the route does not declare auth="required".`);
        }
      }
    }
    // The handler-export namespace is shared per chain: two CRUD keys may collide only by
    // spelling (`list-notes`/`list_notes` → `listNotes`), and a CRUD export must not shadow
    // a declared action — both are the prepare_server.rb gates, verbatim.
    const crudExports = new Map<string, string>();
    for (const [key, row] of Object.entries(doc.api)) {
      if (row.entity === undefined) continue;
      const exportName = crudExportName(key);
      const prior = crudExports.get(exportName);
      if (prior !== undefined) {
        throw new ServerDocumentError(`server/${doc.chain}.dsx: routes ${q(prior)} and ${q(key)} both generate the handler export \`${exportName}\` — rename one key.`);
      }
      if (Object.hasOwn(doc.actions, exportName)) {
        throw new ServerDocumentError(`server/${doc.chain}.dsx: the declared-CRUD row ${q(key)} generates \`${exportName}\`, which collides with the declared action of the same name — rename one.`);
      }
      crudExports.set(exportName, key);
    }
  }

  // ── emission ──
  const entities = docs.flatMap((doc) =>
    Object.entries(doc.schema).map(([entity, row]) => ({
      entity,
      fields: row.fields,
      ownership: row.ownership,
      ...(row.indexes.length > 0 ? { indexes: row.indexes } : {}),
    })),
  ).sort((a, b) => a.entity.localeCompare(b.entity));

  type EmittedRoute = Record<string, unknown>;
  const routeRows: EmittedRoute[] = [];
  const queues = new Set<string>();
  for (const doc of docs) {
    for (const [key, row] of Object.entries(doc.api)) {
      const emitted: EmittedRoute = {
        key,
        chain: doc.chain,
        action: row.entity !== undefined ? crudExportName(key) : row.action!,
        method: row.method,
        path: row.path,
      };
      for (const a of ["auth", "rate", "schedule", "worker", "idempotencyKey"] as const) {
        if (row[a] !== undefined) emitted[a] = row[a];
      }
      if (row.body === "raw") emitted["rawBody"] = true;
      if (row.worker !== undefined) {
        emitted["reach"] = [];
        queues.add(row.worker);
      } else if (row.action !== undefined && doc.reach[row.action] !== undefined) {
        emitted["reach"] = doc.reach[row.action];
      }
      routeRows.push(emitted);
    }
  }
  routeRows.sort((a, b) => String(a["key"]).localeCompare(String(b["key"])));

  const migrationSql = buildMigration(entities, [...queues].sort());

  // The spend plane, merged and validated over the whole set (the deployment has ONE plane).
  // The barrel carries budget rows only — provenance and lines are Studio-projection detail.
  const plane = spendPlane(docs);
  const spendRows = plane.map((r) => ({ of: r.of, per: r.per, max: r.max, ...(r.depth !== undefined ? { depth: r.depth } : {}) }));
  const spendUnbounded = plane.filter((r) => r.max === "unbounded").map((r) => r.of);

  const anyActions = docs.some((doc) =>
    Object.values(doc.api).some((row) => row.action !== undefined && Object.hasOwn(doc.actions, row.action)));
  const lines: string[] = ["//", GENERATED_HEADER];
  lines.push(`//  Source: ${[
    ...sources.map((s) => `server/${s}`),
    ...appDocs.map((d) => `${d.chain} (installed app automation)`),
  ].join(" · ")} (backend-authoring.md).`);
  lines.push("//  The worker imports THIS barrel — the document is the source of truth, this file");
  lines.push("//  is its compiled form, and hand-carrying the rows next to it is the drift class");
  lines.push("//  this step exists to kill.");
  lines.push("//", "");
  lines.push(`import { crudHandler, type EntitySpec, type ServerRoute, type SpendBudget } from "@despia-native/server/host";`);
  if (anyActions) lines.push(`import { declaredHandler } from "@despia-native/server/actions";`);
  lines.push("");
  lines.push(`export const entities: EntitySpec[] = ${JSON.stringify(entities, null, 2)};`);
  lines.push("");
  lines.push(`export const routes: ServerRoute[] = ${JSON.stringify(routeRows, null, 2)};`);
  lines.push("");
  lines.push("/** The spend plane (cost-guardrails.md): the guarded defaults merged with the documents'");
  lines.push(" *  <budget> rows. Hand it to createHost as `spend` — the ceilings ARE the deployment's. */");
  lines.push(`export const spendBudgets: SpendBudget[] = ${JSON.stringify(spendRows, null, 2)};`);
  lines.push("");
  lines.push("export const handlers = {");
  for (const doc of docs) {
    lines.push(`  ${q(doc.chain)}: {`);
    const rows = Object.entries(doc.api).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, row] of rows) {
      if (row.entity !== undefined) {
        lines.push(`    ${crudExportName(key)}: crudHandler(${q(row.entity)}, ${q(row.op!)}),`);
      }
    }
    const routed = new Set(rows.filter(([, r]) => r.action !== undefined).map(([, r]) => r.action!));
    // an automation-bound action is reached by an EVENT, not a route — same handler shape
    for (const a of automations) if (a.chain === doc.chain) routed.add(a.action);
    for (const name of [...routed].sort()) {
      lines.push(`    ${name}: declaredHandler({`);
      lines.push(`      chain: ${q(doc.chain)},`);
      lines.push(`      name: ${q(name)},`);
      lines.push(`      body: ${q(doc.actions[name]!.body)},`);
      lines.push(`      inputs: ${JSON.stringify(doc.actions[name]!.inputs)},`);
      lines.push(`      siblings: ${JSON.stringify(doc.actions)},`);
      lines.push(`      secrets: ${JSON.stringify(doc.secrets)},`);
      lines.push(`      egress: ${JSON.stringify(doc.egress)},`);
      lines.push(`    }),`);
    }
    lines.push(`  },`);
  }
  lines.push("};");
  lines.push("");
  const tools = docs.flatMap((doc) => Object.entries(doc.mcp).map(([name, row]) => ({ name, chain: doc.chain, ...row })));
  if (tools.length > 0) {
    lines.push("/** Declared MCP tools — consumed by an /mcp face when the host mounts one. */");
    lines.push(`export const mcpTools = ${JSON.stringify(tools.sort((a, b) => a.name.localeCompare(b.name)), null, 2)};`);
    lines.push("");
  }
  if (automations.length > 0) {
    lines.push("/** Granted app automations (studio-apps.md §7.2): event kind → handler binding,");
    lines.push(" *  compiled into THIS deployment because its owner consented — the custody law.");
    lines.push(" *  mode \"draft\" prepares and notifies, never publishes; every run is a ledger row. */");
    lines.push(`export const automations = ${JSON.stringify(automations, null, 2)};`);
    lines.push("");
  }
  lines.push("/** The convergent schema migration — also written beside this barrel as migration.sql. */");
  lines.push(`export const migrationSql = ${q(migrationSql)};`);
  lines.push("");

  mkdirSync(generatedDir, { recursive: true });
  const written: string[] = [];
  const emit = (rel: string, content: string): void => {
    const full = join(generatedDir, rel);
    if (!existsSync(full) || readFileSync(full, "utf8") !== content) writeFileSync(full, content);
    written.push(`server/generated/${rel}`);
  };
  emit("index.ts", `${lines.join("\n")}\n`.replace(/\n\n\n+/g, "\n\n"));
  emit("migration.sql", migrationSql);
  // Anything else in the folder is stale (a renamed document's old emission) — remove it.
  for (const name of readdirSync(generatedDir).sort()) {
    if (name !== "index.ts" && name !== "migration.sql") {
      rmSync(join(generatedDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  //  What a deploy target needs to declare, derived HERE because this is where the rows are:
  //  a queue drain every minute when any worker row exists (the pg_cron twin), then every
  //  declared route schedule verbatim. Sorted and de-duplicated so the emitted manifest is
  //  stable across runs.
  const crons = [
    ...(queues.size > 0 ? ["* * * * *"] : []),
    ...routeRows.map((r) => r["schedule"]).filter((s): s is string => typeof s === "string"),
  ];

  return {
    documents: docs.map((d) => d.chain),
    routes: routeRows.length,
    entities: entities.length,
    spend: { ceilings: spendRows.length, unbounded: spendUnbounded },
    written,
    crons: [...new Set(crons)].sort(),
    tools: tools.length,
    automations: automations.length,
  };
}

/** The convergent migration (the prepare_server.rb entity emitter, standalone-shaped):
 *  a re-runnable preamble, then per entity create + additive column convergence + RLS.
 *  `force row level security` on owner tables and the narrowed grants are measured
 *  decisions inherited from the reference emitter — see its comments for the evidence. */
function buildMigration(
  entities: { entity: string; fields: Record<string, string>; ownership: string; indexes?: string[] }[],
  queues: string[],
): string {
  const sql: string[] = [];
  sql.push("-- GENERATED by `despia build` (the <server> document compile step) — never hand-edit.");
  sql.push("-- Re-runnable by construction: create-if-not-exists + additive column convergence,");
  sql.push("-- so applying it to a live database is how a schema change reaches it.");
  sql.push("");
  sql.push("-- The platform preamble: every policy calls auth.uid() and runs as anon/authenticated.");
  sql.push("-- A hosted Supabase project already provides all three; a bare Postgres does not.");
  sql.push("create schema if not exists auth;");
  sql.push("do $$ begin");
  sql.push("  if not exists (");
  sql.push("    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace");
  sql.push("    where n.nspname = 'auth' and p.proname = 'uid'");
  sql.push("  ) then");
  sql.push("    create function auth.uid() returns uuid language sql stable as $fn$");
  sql.push("      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid");
  sql.push("    $fn$;");
  sql.push("  end if;");
  sql.push("end $$;");
  sql.push("do $$ begin");
  sql.push("  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;");
  sql.push("  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;");
  sql.push("  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;");
  sql.push("end $$;");
  sql.push("grant usage on schema auth to anon, authenticated;");
  sql.push("grant usage on schema public to anon, authenticated;");
  sql.push("");
  for (const e of entities) {
    const t = `dsx_${e.entity}`;
    sql.push(`create table if not exists ${t} (`);
    sql.push("  id uuid primary key default gen_random_uuid(),");
    sql.push(`  owner_id uuid${e.ownership === "owner" ? " not null default auth.uid()" : ""},`);
    for (const [fname, ftype] of Object.entries(e.fields).sort(([a], [b]) => a.localeCompare(b))) {
      sql.push(`  ${fname} ${PG_TYPE[ftype]},`);
    }
    sql.push("  created_at timestamptz not null default now()");
    sql.push(");");
    // Converge, don't just create: `create table if not exists` is a no-op on an existing
    // table, so every declared column is also asserted additively.
    for (const [fname, ftype] of Object.entries(e.fields).sort(([a], [b]) => a.localeCompare(b))) {
      sql.push(`alter table ${t} add column if not exists ${fname} ${PG_TYPE[ftype]};`);
    }
    for (const ix of e.indexes ?? []) sql.push(`create index if not exists ${t}_${ix}_idx on ${t} (${ix});`);
    sql.push(`alter table ${t} enable row level security;`);
    if (e.ownership === "owner") {
      sql.push(`alter table ${t} force row level security;`);
      sql.push(`drop policy if exists ${t}_owner_all on ${t};`);
      sql.push(`create policy ${t}_owner_all on ${t} for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());`);
      sql.push(`revoke all on ${t} from anon;`);
      sql.push(`grant select, insert, update, delete on ${t} to authenticated;`);
    } else if (e.ownership === "public-read") {
      sql.push(`drop policy if exists ${t}_public_read on ${t};`);
      sql.push(`create policy ${t}_public_read on ${t} for select using (true);`);
      sql.push("-- writes: service role only (no write policy — RLS denies by default)");
      sql.push(`grant select, insert, update, delete on ${t} to anon, authenticated;`);
    } else {
      sql.push("-- service-only: RLS enabled; the ONLY policy names service_role, so no client role sees a row");
      sql.push(`drop policy if exists ${t}_service on ${t};`);
      sql.push(`create policy ${t}_service on ${t} for all to service_role using (true) with check (true);`);
      sql.push("-- NO client grant: a service entity has no client route, and a grant would publish");
      sql.push("-- this table's shape into an auto-generated GraphQL/PostgREST schema.");
      sql.push(`revoke all on ${t} from anon, authenticated;`);
      sql.push(`grant select, insert, update, delete on ${t} to service_role;`);
    }
    sql.push("");
  }
  // THE RESERVED NAMESPACE — the tables Despia owns inside the customer's database, read from
  // the ONE registry the runtime and the provisioning step also read (postgres.ts
  // systemTables). Every declared queue's table is in there, and so are the counter and event
  // tables this emitter used to omit: the monorepo pipeline wrote them, this one did not, and a
  // deployment that believed it was metered had nowhere to count. Nobody writes this SQL.
  for (const spec of systemTables(queues)) {
    sql.push(`-- ${spec.table}: ${spec.purpose}`);
    sql.push(spec.sql.trimEnd());
    sql.push("");
  }
  return `${sql.join("\n")}\n`;
}
