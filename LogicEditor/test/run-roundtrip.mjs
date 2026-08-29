// THE GRAMMAR ROUND TRIP. `lift` turns JSE text into a graph and `compile` turns it back;
// this asserts the property the SDK actually promises, which is not that the text comes back
// byte for byte (it recompiles, so `(x) => x` comes back as `x => x`) but that the VALUE does.
//
// It also pins the CODE-FALLBACK CENSUS. A form the graph has no node for degrades to an
// opaque `code` node holding its own text: total, lossless, and coarser than the node
// vocabulary. That is a legitimate escape hatch and a real limit, so the count is written
// down here. A form that starts falling back is a regression; a form that stops is progress
// and moves the number WITH the node named in the diff.
//
//   node test/run-roundtrip.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SL = require("../src/logic-editor.js");

const CASES = [
  "1", "1.5e-3", "0xFF", "1_000", ".5", "'hi'", "true", "null", "undefined",
  "/^a\\/b$/gi", "total", "order.lines.length",
  "-x", "!ready", "typeof v", "~mask",
  "a + b * c", "(a + b) * c", "2 ** 3 ** 2", "a < b && c !== d || !e",
  "a ?? b", "cond ? x : y", "'k' in obj", "a | b ^ c & d", "a << 2 >>> 1",
  "rows[0]", "rows[i + 1]", "obj['key']", "a?.b", "a?.[i]",
  "upper(s)", "round(n, 2)", "dsx.module.share.text({ text: 'hi' })",
  "rows.filter(r => r.qty > 0)",
  "rows.map(r => ({ id: r.id, total: r.price * r.qty }))",
  "rows.reduce((sum, r) => sum + r.price, 0)",
  "map(rows, r => r.n)",
  "rows.sort((a, b) => a.n - b.n).slice(0, 10)",
  "arr[0].items.join(', ')",
  "[1, 2, 3]", "[...a, ...b, 4]", "[]",
  "{ id: 1, name: 'x' }", "{ id }", "{ ...base, id: 2 }", "{ [key]: value }", "{}",
  "`total ${a + b} done`", "`${x}${y}`",
  "(x) => x + 1", "(a, b) => a + b", "x => x", "(a, b = 2) => a + b", "(...rest) => rest",
  "({ a, b }) => a + b", "(x => x * 2)(4)",
  "new Date()", "Object.groupBy(rows, r => r.kind)", "Array.from(set)",
  "JSON.parse(text).items", "Math.max(1, 2)", "a.b.c.d.e", "f(g(h(x)))",
  "rows.map(r => r.tags.filter(t => t.on).map(t => t.name))",
];

/** The forms the node vocabulary has no shape for, so they lift to one `code` node. Each is
 *  here with the reason, because a list of exceptions with no reasons is a list of bugs. */
const FALLS_BACK = new Map([
  ["1.5e-3", "no numeric-format node: the literal keeps its own text"],
  ["0xFF", "no numeric-format node"],
  ["1_000", "no numeric-format node"],
  [".5", "no numeric-format node"],
  ["/^a\\/b$/gi", "no regex literal node"],
  ["typeof v", "no type-of node"],
  ["~mask", "no bitwise-not node"],
  ["2 ** 3 ** 2", "no exponent node"],
  ["a ?? b", "no coalesce node"],
  ["'k' in obj", "no membership node"],
  ["a | b ^ c & d", "no bitwise nodes"],
  ["a << 2 >>> 1", "no shift nodes"],
  ["rows[0]", "no index node"],
  ["rows[i + 1]", "no index node"],
  ["obj['key']", "no index node"],
  ["a?.b", "no optional-chain node"],
  ["a?.[i]", "no optional-chain node"],
  ["map(rows, r => r.n)", "the bare higher-order spelling is not lifted"],
  ["[...a, ...b, 4]", "no spread node"],
  ["{ id }", "no object-shorthand node"],
  ["{ ...base, id: 2 }", "no spread node"],
  ["{ [key]: value }", "no computed-key node"],
  ["`total ${a + b} done`", "no template node"],
  ["`${x}${y}`", "no template node"],
  ["(a, b = 2) => a + b", "no default-parameter node"],
  ["(...rest) => rest", "no rest-parameter node"],
  ["({ a, b }) => a + b", "no destructured-parameter node"],
  ["(x => x * 2)(4)", "no call-on-value node"],
  ["new Date()", "no constructor node"],
  ["f(g(h(x)))", "a plain call is not a nestable node"],
]);

const scope = {
  a: 3, b: 4, c: 5, d: 6, e: 0, x: 2, y: 7, n: 42, s: "hi", v: 1, i: 0, key: "k", cond: true,
  total: 10, mask: 5, ready: true, set: [1, 2], text: '{"items":[1,2]}',
  arr: [{ items: ["a", "b"] }], obj: { key: "v", k: 1 }, base: { id: 1 },
  order: { lines: [1, 2, 3] }, dsx: {},
  rows: [{ id: 1, qty: 2, price: 3, n: 1, kind: "a", tags: [{ on: true, name: "t" }] }],
};

let fell = 0, drift = 0, broke = 0, unexpected = [];
for (const src of CASES) {
  let graph, back;
  try {
    graph = SL.lift(src);
    back = SL.compile(graph);
  } catch (err) {
    console.error(`  THREW  ${JSON.stringify(src)}: ${err.message}`);
    broke += 1;
    continue;
  }
  const kinds = Object.values(graph.nodes || {}).map((n) => n.kind);
  const isCode = kinds.includes("code") || (graph.out && graph.out.code !== undefined);
  if (isCode) {
    fell += 1;
    if (!FALLS_BACK.has(src)) { unexpected.push(src); }
  } else if (FALLS_BACK.has(src)) {
    unexpected.push(`${src} (no longer falls back - remove it from FALLS_BACK and say which node landed)`);
  }
  if (back !== src) drift += 1;
  // THE PROPERTY THAT MATTERS: the recompiled text evaluates to what the original does.
  let want, got;
  try { want = SL.evaluate(src, scope); } catch { want = "__threw__"; }
  try { got = SL.evaluate(back, scope); } catch { got = "__threw__"; }
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    console.error(`  VALUE  ${JSON.stringify(src)} -> ${JSON.stringify(back)}`);
    console.error(`         was ${JSON.stringify(want)}, now ${JSON.stringify(got)}`);
    broke += 1;
  }
}

for (const u of unexpected) console.error(`  CENSUS ${u}`);
console.log(
  `[roundtrip] ${CASES.length} forms - ${fell} lift to code, ${drift} reformat, ` +
  `${broke} change value, ${unexpected.length} census drift`,
);
if (broke > 0 || unexpected.length > 0) process.exit(1);
