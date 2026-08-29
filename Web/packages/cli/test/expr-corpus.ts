// The JSE expression grammar, one line per form. Every reader of an expression in this
// repo - the span parser, the projection, the layout - is measured against this list, so a
// form that only one of them handles is a visible failure rather than a silent divergence.
//
// The order is the precedence ladder, low to high, then the shapes that are not operators.
//
// TWO LISTS, AND THEY ANSWER TWO DIFFERENT QUESTIONS. `GRAMMAR` covers every FORM, which is
// what a parser and a projection have to be total over; it is chosen by the grammar, so it is
// full of `a?.b?.c` and `(x => x * 2)(4)` and one in seven of its lines is a higher-order
// pipeline. `WORKLOAD` is what people in this repo actually write, and the difference between
// the two was a measurement problem rather than a taste one: over the 6294 expressions the
// repo's own `.dsx` files contain - every `{{ }}` interpolation, every condition attribute,
// every argument row of every statement body - 61% are a SINGLE ATOM, 77% are three atoms or
// fewer, and 2.3% contain a higher-order call. Tuning a drawing against the grammar list
// therefore tunes it against a workload nobody has, and the drawing that came out of that
// spent 4.11 visual objects per atom to say `dsx.attribute.icon`.
//
// `FORMS` is both, because every existing law is measured over every shape. A law about COST
// should be measured over `WORKLOAD`.
export const GRAMMAR: string[] = [
  // literals
  "42", "0", "-1", "3.14", "1.5e-3", "0xFF", "0b1011", "0o17", "1_000", ".5",
  "'text'", '"text"', "''", "'it\\'s'", "true", "false", "null", "undefined",
  "/^a\\/b$/gi", "/[/]/",
  // names. $ is NOT one: the evaluator lexes it as an operator, so the parser must too.
  "total", "user.name", "a.b.c.d", "_private", "item0",
  // unary
  "!done", "!!value", "-price", "+count", "~mask", "typeof v", "typeof user.name",
  "- -x", "!(a && b)",
  // multiplicative and additive
  "a + b", "a - b", "a * b", "a / b", "a % b", "a + b * c", "(a + b) * c",
  "1 + 2 + 3 + 4", "a - b - c", "price * qty * 1.2",
  // exponent, right associative, and the unary trap
  "2 ** 3", "2 ** 3 ** 2", "-2 ** 2", "(-2) ** 2",
  // shifts and bitwise
  "a << 2", "a >> 2", "a >>> 1", "a & b", "a | b", "a ^ b", "a | b ^ c & d",
  // comparison
  "a < b", "a > b", "a <= b", "a >= b", "'k' in obj", "n in list",
  // equality, all four spellings
  "a == b", "a != b", "a === b", "a !== b", "x == null", "x != null",
  // logical and coalesce
  "a && b", "a || b", "a ?? b", "a && b || c", "a ?? b ?? c",
  "a < b && c !== d || !e", "ok && ready && live",
  // ternary
  "a ? b : c", "a ? b : c ? d : e", "n > 0 ? 'yes' : 'no'",
  "a ? (b ? 1 : 2) : 3",
  // member, index, optional
  "rows[0]", "rows[i + 1]", "obj['key']", "obj[key]", "a?.b", "a?.b?.c", "a?.[i]",
  "rows[0].items", "matrix[i][j]", "list.length", "list?.length",
  // calls
  "f()", "f(1)", "f(a, b)", "f(a, b, c)", "f(g(h(x)))", "Math.round(n)",
  "Math.max(a, b)", "a?.()", "f(...args)", "obj.method()", "obj.a.b.method(1)",
  "'x'.repeat(3)", "text.trim().toLowerCase()", "list.join(', ')",
  "arr[0].items.join(', ')", "n.toFixed(2)", "JSON.parse(text)",
  // higher order, both spellings
  "rows.map(r => r.n)", "map(rows, r => r.n)",
  "rows.filter(r => r.on)", "rows.reject(r => r.off)",
  "rows.find(r => r.id == id)", "rows.findLast(r => r.ok)",
  "rows.findIndex(r => r.id == id)", "rows.findLastIndex(r => r.ok)",
  "rows.some(r => r.bad)", "rows.every(r => r.ok)",
  "rows.sortBy(r => r.name)", "rows.sort((a, b) => a - b)", "rows.toSorted((a, b) => a - b)",
  "rows.sumBy(r => r.price)", "rows.reduce((t, r) => t + r.n, 0)",
  "rows.reduceRight((t, r) => t + r.n, 0)", "rows.forEach(r => r.go())",
  "rows.flatMap(r => r.tags)", "rows.groupBy(r => r.kind)", "rows.keyBy(r => r.id)",
  "rows.map(r => ({ id: r.id, total: r.price * r.qty }))",
  "rows.filter(r => r.on).map(r => r.n).join(', ')",
  "rows.map(r => r.items.filter(i => i.ok).length)",
  "rows.reduce((acc, r) => acc + r.items.reduce((s, i) => s + i.n, 0), 0)",
  // arrays and objects
  "[]", "[1, 2, 3]", "[a, b]", "[...a, ...b, 4]", "[[1, 2], [3, 4]]",
  "{}", "{ id: 1 }", "{ id: 1, name: 'x' }", "{ id }", "{ ...base, id: 2 }",
  "{ [key]: value }", "{ a: { b: { c: 1 } } }", "{ list: [1, 2], on: true }",
  // templates
  "`plain`", "`total ${a + b} done`", "`${x}${y}`", "`${a}`", "`a ${`b ${c}`} d`",
  // lambdas
  "x => x + 1", "(x) => x + 1", "(a, b) => a + b", "(a, b = 2) => a + b",
  "(...rest) => rest", "({ a, b }) => a + b", "() => 1", "x => ({ v: x })",
  // the rest
  "(x => x * 2)(4)", "new Date()", "new Error('bad')",
  "(a + b)", "((a))",
  // shapes an author actually writes
  "user.profile?.displayName ?? user.email",
  "items.filter(i => i.status == 'open').length > 0",
  "`${user.firstName} ${user.lastName}`.trim()",
  "order.lines.reduce((sum, l) => sum + l.price * l.qty, 0).toFixed(2)",
  "cart.items.length == 0 ? 'Empty' : `${cart.items.length} items`",
  "Math.round(order.total * 100) / 100",
  "products.filter(p => p.price >= min && p.price <= max).sortBy(p => p.price)",
  // the shapes the row NAMES are measured on: a run long enough to number, two operands of
  // one kind feeding one node, a comparison whose sides are roles, a hole with a word in
  // front of it, a literal with no ink in it, and the methods whose arguments have names
  "a + b + c + d + e + f + g + h", "(a + b) + (c + d)", "a.trim() + b.trim()",
  "lib.parse(a) + other.parse(b)", "f(x) + f(x)",
  "n >= min", "n <= max", "n > low", "n < high", "total ?? fallback",
  "{ note: '', tag: ' ' }", "list.join('')", "text.split('')",
  "`Total: ${n} items`", "`${a}${b}`", "`line\\n${x}`",
  "s.charAt(0)", "rows.with(0, v)", "chars.fill('x', 0, 3)", "rows.toSpliced(1, 2, x)",
  "d.toLocaleDateString('en-GB')", "n.toString(2)", "re.test(text)", "text.match(re)",
  "items.flat(2)", "mystery(a, b)",
];

/** WHAT PEOPLE IN THIS REPO ACTUALLY WRITE, sampled from the 6294 expressions its `.dsx`
 *  files contain and weighted to the measured distribution: 61% one atom, 16% two or three,
 *  14% four to six, 7% seven to twelve, 2% thirteen and up, and 2.5% higher-order. The
 *  spellings are real - `dsx.attribute.icon`, `item.name`, `'error: ' + r.error` - because a
 *  synthetic `a.b.c` is the same shape and a different length, and length is what a well and
 *  a nameplate are measured against.
 *
 *  This list exists so a cost number quoted on "the corpus" is a cost number about the work.
 *  The grammar list above is not that and was never meant to be. */
export const WORKLOAD: string[] = [
  // one atom - the median expression in the repo, at eighteen characters
  "false", "true", "null", "0", "1", "''", "'project'", "'select'", "'close'", "'change'",
  "item.name", "item.id", "item.label", "item.title", "item.key", "item.value", "item.text",
  "item.icon", "item.badge", "item.subtitle", "item.x", "item.y", "item.w", "item.h",
  "dsx.variable.fxTrack", "dsx.variable.progress", "dsx.variable.status", "dsx.variable.accent",
  "dsx.variable.aiBusy", "dsx.variable.percent", "dsx.variable.selTrack", "dsx.variable.line",
  "dsx.attribute.document", "dsx.attribute.title", "dsx.attribute.selected",
  "dsx.attribute.label", "dsx.attribute.subtitle", "dsx.attribute.message",
  "dsx.attribute.icon", "dsx.attribute.tone", "dsx.attribute.value", "dsx.attribute.placeholder",
  "dsx.const.studioApi", "dsx.this.value", "dsx.env.channel",
  "id", "name", "value", "next", "logicBody", "rows", "total", "count", "index", "selected",
  "r.ok", "s.status", "s.progress", "s.vars", "found.id", "node.kind", "edge.row", "flow.width",
  "row.span", "step.title", "user.email", "order.total", "cart.items", "form.errors",
  "'Save'", "'Cancel'", "'  '", "-1", "24", "0.5",
  // two and three atoms
  "!found.ok", "!done", "!dsx.variable.aiBusy", "-price",
  "row.name == g", "s.status == 'ok'", "dsx.variable.fxAutotunePro == 'Pro'",
  "'error: ' + r.error", "'Total: ' + total", "n + 1", "i - 1", "price * qty",
  "count > 0", "rows.length", "text.trim()", "n.toFixed(2)", "list.join(', ')",
  "rows[0]", "raw[i]", "user.name ?? ''",
  // four to six
  "cart.items.length == 0", "price * qty * 1.2", "a.trim().toLowerCase()",
  "user.profile?.displayName ?? user.email", "Math.round(order.total * 100) / 100",
  "`${user.firstName} ${user.lastName}`", "n > 0 ? 'yes' : 'no'",
  "{ id: 1, name: 'x' }", "[a, b, c]", "rows.length > 0 && ready",
  "step.title == null ? '' : step.title", "'#' + row.css + ' { }'",
  "dsx.variable.zoom * 100 + '%'", "left + width / 2", "err.code == 404 ? 'gone' : 'error'",
  "flow.width * zoom + 56", "String(dsx.attribute.delta || '').trim()",
  // seven to twelve
  "items.filter(i => i.status == 'open').length > 0",
  "cart.items.length == 0 ? 'Empty' : `${cart.items.length} items`",
  "{ id: order.id, when: order.createdAt, total: order.total }",
  "(subtotal + shipping) * (1 + taxRate) - discount",
  "order.total >= 100 && customer.tier != 'free'",
  "a1 + a2 * a3 - a4 / a5 + f(a6, a7)",
  "user.profile?.displayName ?? user.email ?? 'Someone'",
  "node.title == null ? node.kind : node.title + ' (' + node.kind + ')'",
  // thirteen and up
  "order.lines.reduce((sum, l) => sum + l.price * l.qty, 0).toFixed(2)",
  "products.filter(p => p.price >= min && p.inStock).sortBy(p => p.price)",
  "teams.map(t => ({ name: t.name, open: t.tickets.filter(i => i.state == 'open').length }))",
];

/** Every law in `exprflow.test.ts` is measured over both: a projection has to be total and
 *  lossless over the grammar, and cheap over the work. */
export const FORMS: string[] = [...GRAMMAR, ...WORKLOAD];
