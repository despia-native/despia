package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for JSE — behavior pinned to Engine/JSE.swift (js-core-parity.md:
/// both runtimes must pass every fixture before the evaluator counts as ported).
///
/// The bulk is DATA: {scope, expression, expected} triples driving one runner — the seed
/// of the cross-platform corpus (OpenSource/Conformance/jse/). Rows assert only values the
/// evaluator CONTRACTS (never raw dict descriptions, key order, or platform float quirks).
class JseTest {

    // ── the triple runner (the conformance-corpus seed shape) ──────────────────────────

    private class Case(
        val scope: Map<String, Any?>?,
        val expr: String,
        val expected: Any?,
        val vars: Map<String, Any?> = emptyMap(),
    )

    private fun t(expr: String, expected: Any?, scope: Map<String, Any?>? = null, vars: Map<String, Any?> = emptyMap()) =
        Case(scope, expr, expected, vars)

    private fun eval(expr: String, scope: Map<String, Any?>? = null, vars: Map<String, Any?> = emptyMap()): Any? {
        val st = StackStore()
        st.vars.putAll(vars)
        return JSE.eval(expr, st, scope)
    }

    @AfterTest fun resetSeams() {
        JSE.stateVars = { emptyMap() }
        JSE.cookieJar = { emptyMap() }
        JSE.appEnvironment = { "appstore" }
        JSE.moduleAvailable = { false }
    }

    private fun corpus(): List<Case> = listOf(
        // ── arithmetic + precedence + parens ──
        t("1 + 2 * 3", 7.0),
        t("(1 + 2) * 3", 9.0),
        t("10 / 4", 2.5),
        t("7 / 0", 0.0),                        // JSE law: division by zero yields 0, not Infinity
        t("5 - 2 - 1", 2.0),                    // left-assoc
        t("2 * 3 + 4 * 5", 26.0),
        t("-3 + 1", -2.0),
        t("10 / 2 / 5", 1.0),                   // `/` after a value is division, never regex
        t("10 % 3", 1.0),                       // JS % — truncating remainder, sign of the dividend
        t("7.5 % 2", 1.5),
        t("-7 % 3", -1.0),                      // truncating, sign of the dividend (JS), not floored (-2)
        t("7 % 0", 0.0),                        // %0 → 0, the /0 law
        t("1 + 6 % 4", 3.0),                    // precedence: % is multiplicative
        t("1 + '2'", 3.0),                      // numeric strings coerce in +
        t("'a' + 1", "a1"),                     // non-numeric string → concat
        t("'x' + null", "x"),
        t("null + null", ""),
        t("true + 1", 2.0),
        t("'1.5' * 2", 3.0),
        t("a / b", 5.0, vars = mapOf("a" to 10.0, "b" to 2.0)),
        // ── comparisons (string×string lexicographic — JS; everything else number-coerced ?? 0) ──
        t("2 > 1", true),
        t("2 >= 2", true),
        t("1 <= 0", false),
        t("'10' < '9'", true),                  // BOTH strings → lexicographic (the JS quirk, now agrees with sort/sortBy)
        t("'a' < 'b'", true),
        t("'apple' <= 'apple'", true),
        t("'b' > 'a'", true),
        t("'5' < 10", true),                    // MIXED string-number stays numeric
        t("null < 1", true),
        t("1 < 2 < 3", true),                   // chains through the Bool: (true=1) < 3
        t("3 > 2 > 1", false),                  // (true=1) > 1 → false
        // ── equality (== and === share the same coercion table) ──
        t("1 == '1'", true),
        t("1 === '1'", true),                   // pinned: strict shares equals() — no coercion gap
        t("1 != 2", true),
        t("1 !== 1", false),
        t("'abc' == 'abc'", true),
        t("true == 1", true),
        t("'0' == 0", true),
        t("null == ''", false),                 // null equals only null (core-002 law)
        t("null == 0", false),
        t("NaN == NaN", false),
        // ── structural equality: plain dicts/arrays compare deep + key-order-insensitive ──
        t("a == b", true, vars = mapOf("a" to mapOf("x" to 1.0, "y" to 2.0), "b" to mapOf("y" to 2.0, "x" to 1.0))),
        t("a == b", false, vars = mapOf("a" to mapOf("x" to 1.0), "b" to mapOf("x" to 2.0))),
        t("[1, 2] == [1, 2]", true),
        t("[1, 2] == [2, 1]", false),
        t("{ a: [1, { b: 2 }] } == { a: [1, { b: 2 }] }", true),   // nested
        t("[1] == 1", false),                   // collection vs scalar is structural, never coerced
        // ── typeof (unary; null/undefined both report 'undefined' — JSE's one deliberate JS divergence) ──
        t("typeof 1", "number"),
        t("typeof 'a'", "string"),
        t("typeof true", "boolean"),
        t("typeof missing", "undefined"),
        t("typeof [1]", "object"),
        t("typeof { a: 1 }", "object"),
        t("typeof(3)", "number"),               // operator + paren expr parses too
        t("typeof 1 == 'number' ? 'y' : 'n'", "y"),
        // ── range — the bounded repeat-N ladder ──
        t("range(3).join(',')", "0,1,2"),
        t("range(1, 4).join(',')", "1,2,3"),
        t("range(6, 0, 0 - 2).join(',')", "6,4,2"),
        t("range(0).length", 0.0),
        t("range(2, 2).length", 0.0),
        t("Array.isArray([1])", true),
        t("Array.isArray('a')", false),
        // ── logical (value-returning, like JS) + truthiness ──
        t("0 || 'x'", "x"),
        t("'a' || 'b'", "a"),
        t("1 && 2", 2.0),
        t("0 && 2", 0.0),
        t("'' || 'fallback'", "fallback"),
        t("!0", true),
        t("!''", true),
        t("!'a'", false),
        t("!null", true),
        t("!!'x'", true),
        // ── ternary ──
        t("1 ? 'y' : 'n'", "y"),
        t("'' ? 'y' : 'n'", "n"),
        t("0 ? 'a' : 1 ? 'b' : 'c'", "b"),
        t("2 == 2 ? 'y' : 'n'", "y"),
        // ── member access + indexing + walk ──
        t("user.name", "Ada", scope = mapOf("user" to mapOf("name" to "Ada", "tags" to listOf("x", "y")))),
        t("user.tags[1]", "y", scope = mapOf("user" to mapOf("tags" to listOf("x", "y")))),
        t("user.tags.length", 2.0, scope = mapOf("user" to mapOf("tags" to listOf("x", "y")))),
        t("user.tags[5]", null, scope = mapOf("user" to mapOf("tags" to listOf("x", "y")))),
        t("user.missing", null, scope = mapOf("user" to mapOf<String, Any?>())),
        t("'hello'.length", 5.0),
        t("a.b.c", 42.0, vars = mapOf("a" to mapOf("b" to mapOf("c" to 42.0)))),
        t("rows.0.id", "r0", vars = mapOf("rows" to listOf(mapOf("id" to "r0")))),   // numeric path segment
        t("rows.length", 1.0, vars = mapOf("rows" to listOf(mapOf("id" to "r0")))),
        t("list[0].name", "n0", vars = mapOf("list" to listOf(mapOf("name" to "n0")))),
        t("obj['1']", null, vars = mapOf("obj" to mapOf("1" to "x"))),   // pinned: numeric-string [key] indexes arrays only
        // ── literals ──
        t("[1, 2, 3].length", 3.0),
        t("[1,2,3][0]", 1.0),
        t("{ a: 1, b: 'x' }.b", "x"),
        t("{ 'k': 2 }['k']", 2.0),
        t("{ id }.id", 7.0, scope = mapOf("id" to 7.0)),   // JS shorthand
        t("await (1 + 1)", 2.0),                // `await v` on a non-promise is v
        t("new Foo()", null),                   // unknown constructor → null (total)
        // ── lambdas + higher-order ──
        t("[1,2,3].map((x) => x * 2).join(',')", "2,4,6"),
        t("[1,2,3].map(x => x * 2).join(',')", "2,4,6"),   // bare-ident arrow (the un-pinned quirk: `=>` is consumed like the paren path)
        t("[1,2].map(x => [10,20].map(y => x + y).join('-')).join(',')", "11-21,12-22"),   // lexical capture: inner arrow reads the enclosing param
        t("map([1,2], (x) => x + 1)[1]", 3.0),  // call form
        t("[1,2,3,4].filter((x) => x > 2).length", 2.0),
        t("[1,2,3].reject((x) => x > 1).length", 1.0),
        t("[1,2,3].find((x) => x > 1)", 2.0),
        t("[1,2].some((x) => x == 2)", true),
        t("[1,2].every((x) => x > 0)", true),
        t("[1,2,3].findIndex((x) => x == 3)", 2.0),
        t("[1,2].findIndex((x) => x == 9)", -1.0),
        t("[3,1,2].sortBy((x) => x).join('')", "123"),
        t("['b','a'].sortBy((x) => x).join('')", "ab"),    // non-numeric keys → string compare
        t("[2,3,1].sortBy((x) => x, 'desc').join('')", "321"),   // optional 3rd arg flips the comparator
        t("groupBy([{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}], (x) => x.t)['a'].length", 2.0),
        t("keyBy([{t:'a',v:1},{t:'b',v:2}], (x) => x.t)['b'].v", 2.0),
        // the 1:1 JS spellings of the same shapes:
        t("Object.groupBy([{t:'a'},{t:'b'},{t:'a'}], x => x.t)['a'].length", 2.0),   // ES2024
        t("Object.fromEntries([{t:'a',v:1},{t:'b',v:2}].map(x => [x.t, x]))['b'].v", 2.0),   // keyBy, the JS way
        t("Array.from({ length: 3 }, (_, i) => i).join(',')", "0,1,2"),   // the JS repeat-N idiom
        t("Array.from({ length: 2 }).length", 2.0),                       // no mapFn → [null × n]
        t("Array.from([1, 2], x => x * 2).join(',')", "2,4"),             // array source + mapFn
        t("sumBy([2,3], (x) => x * 2)", 10.0),
        t("[[1,2],[3]].flatMap((x) => x).length", 3.0),
        t("['a','b'].map((x, i) => i).join(',')", "0,1"),  // index arg
        t("[{a:1,b:2}].map(({a, b}) => a + b)[0]", 3.0),   // destructured param
        t("[1,2].forEach((x) => x)", null),
        t("reduce([1,2,3], (a, b) => a + b)", 6.0),        // no init → acc = first
        t("[].reduce((a, b) => a + b)", null),             // empty, no init → null (JS throws; JSE is total)
        t("cart.lines.reduce((acc, l) => acc + l.qty, 0)", 5.0,
          vars = mapOf("cart" to mapOf("lines" to listOf(mapOf("qty" to 2.0), mapOf("qty" to 3.0))))),
        // ── sort (A1/A2 fixtures: default is LEXICOGRAPHIC — the JS quirk both must copy) ──
        t("[3,1,2].sort().join('')", "123"),
        t("[3,1,10].sort().join(',')", "1,10,3"),
        t("[3,1,10].sort((a,b) => a - b).join(',')", "1,3,10"),
        t("[2,10,1].sort((a, b) => b - a).join(',')", "10,2,1"),
        // ── array/string methods ──
        t("[1,2].includes(2)", true),
        t("[1,2].includes(5)", false),
        t("'hello'.includes('ell')", true),
        t("'abc'.includes('')", false),         // pinned: Swift contains("") is false
        t("[1,2,3].indexOf(2)", 1.0),
        t("[1,2].indexOf(9)", -1.0),
        t("'abc'.indexOf('b')", 1.0),           // JS String.indexOf (grapheme offset)
        t("'abc'.indexOf('z')", -1.0),
        t("'abc'.indexOf('')", 0.0),            // JS: empty needle matches at 0
        t("'despia'.startsWith('des')", true),
        t("'despia'.endsWith('ia')", true),
        t("'despia'.startsWith('ia')", false),
        t("[1,2].join('-')", "1-2"),
        t("[1,2].join()", "1,2"),               // method default separator ","
        t("[1,2,3].reverse().join('')", "321"),
        t("[1,2,3,4].slice(2).join('')", "34"),
        t("[1,2,3].slice(0 - 1).join('')", "3"),   // JS end-relative negative start
        t("[1,2,3,4].slice(1, 3).join('')", "23"), // slice(start, end)
        t("'despia'.slice(1)", "espia"),           // strings slice too
        t("'despia'.slice(0 - 3)", "pia"),
        t("'despia'.slice(0, 0 - 3)", "des"),
        t("[1,2].slice(5).length", 0.0),           // out-of-range start → empty
        t("'ab'.toUpperCase()", "AB"),
        t("'AB'.toLowerCase()", "ab"),
        t("' x '.trim()", "x"),
        t("[[1,[2]],[3]].flat().length", 3.0),
        t("[[1,[2]],[3]].flat(2).join('|')", "1|2|3"),
        t("[1].concat([2,3], 4).join('')", "1234"),
        t("[[1,2],[3]].flat().concat(4).at(-1)", 4.0),     // A3 fixture
        t("'abc'.at(0)", "a"),
        t("'abc'.at(0 - 1)", "c"),
        t("'abc'.at(5)", null),
        t("[1,2].at(0 - 1)", 2.0),
        t("(255).toString(16)", "ff"),
        t("(255).toString(10)", "255"),         // radix 10 falls back to string()
        t("(255).toString(16).padStart(4, '0')", "00ff"),  // N2 fixture
        t("(1.5).toString()", "1.5"),
        t("(3).toString()", "3"),               // integral prints without ".0"
        t("'5'.padStart(3, '0')", "005"),
        t("'5'.padEnd(3, '0')", "500"),
        t("'5'.padStart(3)", "  5"),
        t("'abcd'.padStart(2, '0')", "abcd"),
        t("'5'.padStart(3, 'ab')", "ab5"),
        t("'hi'.toHex()", "6869"),
        t("[255, 16].toHex()", "ff10"),
        t("[0, 255, 16].toBase64()", "AP8Q"),   // C5 fixture (byte plumbing half)
        t("'x'.encode('y')", null),             // encode/decode claim only TextEncoder/TextDecoder shapes
        t("'x'.decode('y')", null),
        // ── regex (R fixtures) ──
        t("/^a.c$/.test('abc')", true),
        t("/^a.c$/.test('nope')", false),
        t("/ABC/i.test('abc')", true),
        t("""'a1b2c3'.replace(/\d/g, '#')""", "a#b#c#"),                        // R2
        t("""'Slug Title! 9'.toLowerCase().replace(/[^a-z0-9]+/g, '-')""", "slug-title-9"),   // R3
        t("""'a, b,c'.split(/\s*,\s*/).join('|')""", "a|b|c"),                  // R4
        t("""'/show/42'.match(/^\/show\/(\d+)$/)[1]""", "42"),                  // R5
        t("""'ab'.replace(/(a)/, '[$1]')""", "[a]b"),                           // $1 template
        t("""'a1b2'.match(/\d/g).length""", 2.0),
        t("""'ab'.match(/\d/)""", null),
        t("""'a1'.match(/(\d)/)[1]""", "1"),
        t("""'xya'.search(/a/)""", 2.0),
        t("""'xy'.search(/a/)""", -1.0),
        t("'aaa'.replace('a', 'b')", "baa"),    // string pattern → literal, first only
        t("'a.a'.replaceAll('.', '-')", "a-a"), // literal, every occurrence (not regex)
        t("'a-b-c'.split('-').length", 3.0),
        t("'abc'.split('').join('.')", "a.b.c"),
        t("'aXbXc'.split('X', 2).join('|')", "a|b"),
        t("/(/.test('x')", false),              // invalid pattern → logs + false (total)
        // ── builtins: string/number ──
        t("upper('abc')", "ABC"),
        t("lower('AbC')", "abc"),
        t("cap('hello world')", "Hello World"),
        t("capitalize('WORLD')", "World"),
        t("trim('  x  ')", "x"),
        t("len('hello')", 5.0),
        t("count([1,2])", 2.0),
        t("abs(-4.5)", 4.5),
        t("round(2.5)", 3.0),                   // Swift .rounded(): half AWAY from zero…
        t("round(-2.5)", -3.0),
        t("Math.round(2.5)", 3.0),              // …while Math.round is JS half-UP —
        t("Math.round(-2.5)", -2.0),            // the two must differ on negative halves
        t("floor(2.9)", 2.0),
        t("ceil(2.1)", 3.0),
        t("min(3, 5)", 3.0),
        t("max(2, 9)", 9.0),
        t("int(3.9)", 3.0),
        t("int(-3.9)", -3.0),
        t("pad(7, 3)", "007"),
        t("mmss(83)", "1:23"),
        t("clock(3671)", "1:01:11"),
        t("mmss(0 - 201)", "-3:21"),            // negatives keep the sign
        t("if(1, 'a', 'b')", "a"),
        t("if(0, 'a', 'b')", "b"),
        t("if(0, 'a')", null),
        t("matches('/users/42', '/users/{id}')", true),
        t("matches('/a', '/b')", false),
        // ── builtins: collections ──
        t("first([4,5])", 4.0),
        t("last([4,5])", 5.0),
        t("first([])", null),
        t("reverse([1,2])[0]", 2.0),
        t("sum([1,2,3])", 6.0),
        t("join([1,2], '-')", "1-2"),
        t("join([1,2])", "1, 2"),               // builtin default separator ", " (method default is ",")
        t("contains([1,2], '2')", true),
        t("contains([1,2], '9')", false),
        t("keys({a: 1})[0]", "a"),
        t("values({a: 'v'})[0]", "v"),
        t("keys('nope')", null),
        // ── builtins: validators ──
        t("required('x')", true),
        t("required('')", false),
        t("required(' ')", false),
        t("required([1])", true),
        t("required([])", false),
        t("required(0)", false),
        t("required(1)", true),
        t("minLength('abc', 2)", true),
        t("minLength('a', 2)", false),
        t("minLength([1,2,3], 2)", true),
        t("maxLength('ab', 2)", true),
        t("maxLength('abc', 2)", false),
        t("regex('abc123', '[0-9]+')", true),
        t("regex('abc', '[0-9]+')", false),
        t("email('x@y.com')", true),
        t("email('nope')", false),
        t("phone('+1 (555) 123-4567')", true),
        t("phone('abc')", false),
        t("url('https://x.com/y')", true),
        t("url('not a url')", false),
        t("url('mailto:x')", false),            // no host
        // ── JSECore: Math + constants (the already-1:1 slice of the core seam) ──
        t("Math.floor(2.7)", 2.0),
        t("Math.max(1, 5, 3)", 5.0),
        t("Math.min(4, 2, 8)", 2.0),
        t("Math.trunc(0 - 2.7)", -2.0),
        t("Math.sign(0 - 5)", -1.0),
        t("Math.pow(2, 10)", 1024.0),
        t("Math.sqrt(9)", 3.0),
        t("Math.abs(0 - 3)", 3.0),
        t("Math.PI > 3", true),
        t("Number.MAX_SAFE_INTEGER", 9007199254740991.0),
        t("Infinity > 1000000", true),
        // ── malformed / total-ness (never throws, never hangs) ──
        t("1 +", "1"),                          // missing RHS → nil operand → concat coercion
        t(")(", null),
        t("((1)", 1.0),
        t("'unterminated", "unterminated"),
    )

    @Test fun conformanceCorpus() {
        var count = 0
        for (c in corpus()) {
            val st = StackStore()
            st.vars.putAll(c.vars)
            val got = JSE.eval(c.expr, st, c.scope)
            assertEquals(c.expected, got, "JSE: ${c.expr}")
            count += 1
        }
        assertTrue(count >= 150, "corpus shrank? $count rows")
    }

    // ── bare-ident arrows + lexical capture (the former pinned quirk, fixed on BOTH runtimes) ──

    @Test fun identArrowAndClosureCapture() {
        // `x => …` now consumes the `=>` exactly like tryArrow's paren path (fixed iOS-first,
        // mirrored here, corpus regenerated — the order the old pin prescribed), and every
        // arrow snapshots its creation scope, so nested arrows read enclosing params/locals.
        assertEquals(listOf<Any?>(2.0, 4.0), eval("[1,2].map((x) => x * 2)"))
        assertEquals(listOf<Any?>(2.0, 4.0), eval("[1,2].map(x => x * 2)"))
        assertEquals("1,2", eval("[1,2].map(x => x).join(',')"))
        assertEquals("11-21,12-22", eval("[1,2].map(x => [10,20].map(y => x + y).join('-')).join(',')"))
        // a row-scoped arrow sees the row (`item`) it was created in:
        assertEquals(6.0, eval("prices.reduce((s, p) => s + p * qty, 0)",
            scope = mapOf("qty" to 2.0), vars = mapOf("prices" to listOf(1.0, 2.0))))
    }

    // ── eval entry: empty / whitespace / interpolation ───────────────────────────────────

    @Test fun evalEmptyAndWhitespaceIsNull() {
        assertNull(eval(""))
        assertNull(eval("   "))
    }

    @Test fun interpolateReplacesExpressions() {
        val st = StackStore()
        st.vars["name"] = "Ada"
        assertEquals("Hi Ada!", JSE.interpolate("Hi {{ name }}!", st, null))
        assertEquals("x=2, t=1", JSE.interpolate("x={{ 1 + 1 }}, t={{ true }}", st, null))   // Bool prints "1"
        assertEquals("no braces", JSE.interpolate("no braces", st, null))
        assertEquals("a{{b", JSE.interpolate("a{{b", st, null))       // unterminated → literal passthrough
        assertEquals("-", JSE.interpolate("{{ missing }}-", st, null))
    }

    // ── evalBlock: the bounded-JS statement interpreter ──────────────────────────────────

    @Test fun evalBlockRunsStatements() {
        val st = StackStore()
        assertEquals(2.0, JSE.evalBlock("1 + 1", st, null))                       // fast path
        assertEquals(2.0, JSE.evalBlock("return 1 + 1", st, null))
        assertEquals(6.0, JSE.evalBlock("const x = 2; const y = 3; return x * y", st, null))
        assertEquals(6.0, JSE.evalBlock("const a = 2; a * 3", st, null))          // implicit last expression
        assertEquals(6.0, JSE.evalBlock("x = 5; x + 1", st, null))                // local assignment (never the store)
        assertNull(st.vars["x"])                                                  // PURE: throwaway scope
        assertEquals(1.0, JSE.evalBlock("if (true) { return 1 } return 2", st, null))
        assertEquals("small", JSE.evalBlock("if (n > 2) return 'big'; return 'small'", st, mapOf("n" to 1.0)))
        assertEquals("big", JSE.evalBlock("if (n > 2) return 'big'; return 'small'", st, mapOf("n" to 5.0)))
        assertNull(JSE.evalBlock("return", st, null))
        assertNull(JSE.evalBlock("", st, null))
        assertEquals(5.0, JSE.evalBlock("function h(x) { return 1 } return 5", st, null))   // nested decls skipped
    }

    @Test fun evalBlockElseIfChain() {
        val st = StackStore()
        val body = "if (n == 1) { return 'one' } else if (n == 2) { return 'two' } else { return 'many' }"
        assertEquals("one", JSE.evalBlock(body, st, mapOf("n" to 1.0)))
        assertEquals("two", JSE.evalBlock(body, st, mapOf("n" to 2.0)))
        assertEquals("many", JSE.evalBlock(body, st, mapOf("n" to 5.0)))
    }

    // ── user functions + the fnDepth bound ───────────────────────────────────────────────

    @Test fun registerFunctionsAndCall() {
        val st = StackStore()
        JSE.registerFunctions("function add(a, b) { return a + b } function twice(n) { return add(n, n) }", st)
        assertEquals(5.0, JSE.eval("add(2, 3)", st, null))
        assertEquals(8.0, JSE.eval("twice(4)", st, null))
        JSE.registerFunctions("no functions here", st)                 // guard: no-op
        assertEquals(2, st.functions.size)
    }

    @Test fun fnDepthBoundContainsRecursion() {
        val st = StackStore()
        JSE.registerFunctions("function loop(n) { return loop(n + 1) }", st)
        assertNull(JSE.eval("loop(0)", st, null))                      // depth 32 breached → null, terminates
        assertEquals(0, st.fnDepth)                                    // balanced on the way out
    }

    // ── NSNull: the present-but-null scope sentinel (observable — see Jse.kt NULL MODEL) ──

    @Test fun nsNullScopeSentinelSemantics() {
        val st = StackStore()
        JSE.registerFunctions("function f(x) { return x ? 'y' : 'n' } function g(x) { return x == null ? 'eq' : 'ne' }", st)
        assertEquals("y", JSE.eval("f()", st, null))                   // unbound param = NSNull → truthy (Swift .some)
        assertEquals("eq", JSE.eval("g()", st, null))                  // the sentinel reads as null in equals (core-002 law)
        assertTrue(JSE.truthy(NSNull))
        assertEquals("<null>", JSE.string(NSNull))
        assertNull(JSE.number(NSNull))
    }

    // ── bounds: evalDepth (64) + computedDepth (32) ──────────────────────────────────────

    @Test fun evalDepthBudget() {
        val st = StackStore()
        st.evalDepth = 64
        assertNull(JSE.eval("1 + 1", st, null))                        // at the budget → null + log
        st.evalDepth = 63
        assertEquals(2.0, JSE.eval("1 + 1", st, null))                 // under it → evaluates
        assertEquals(63, st.evalDepth)                                 // restored on exit
    }

    @Test fun computedCycleIsBounded() {
        // a self-referential computed: 32 bodies evaluate (computedDepth gate), the 33rd
        // lookup skips → null → "" + "1" → then 31 numeric +1s — deterministically 32.
        val st = StackStore()
        st.computed["a"] = "a + 1"
        assertEquals(32.0, JSE.eval("a", st, null))
        assertEquals(0, st.computedDepth)
    }

    // ── scope resolution: shadowing, explicit namespace, computed/formula/initials ───────

    @Test fun bareNameShadowsStoreExplicitDoesNot() {
        val st = StackStore()
        st.vars["title"] = "store"
        assertEquals("row", JSE.eval("title", st, mapOf("title" to "row")))          // props rule
        assertEquals("store", JSE.eval("dsx.variable.title", st, mapOf("title" to "row")))   // explicit namespace
        assertEquals("store", JSE.eval("title", st, null))                           // no local → store
        assertEquals("row", JSE.eval("item.title", st, mapOf("title" to "row")))     // explicit local
    }

    @Test fun computedFormulaAndInitials() {
        val st = StackStore()
        st.vars["count"] = 4.0
        st.computed["double"] = "count * 2"
        assertEquals(8.0, JSE.eval("double", st, null))                // reactive formula
        st.vars["double"] = 1.0
        assertEquals(1.0, JSE.eval("double", st, null))                // a real store var wins

        st.formulas["plus"] = StackFormula(mapOf("n" to "count"), "return n + 1")
        assertEquals(5.0, JSE.eval("plus", st, null))                  // parameterized formula

        st.initials["greeting"] = "hi"
        assertEquals("hi", JSE.eval("greeting", st, null))             // declared default
        st.vars["greeting"] = "live"
        assertEquals("live", JSE.eval("greeting", st, null))           // superseded by the live var
    }

    @Test fun attributeScopeWithDefaultsAndRuntimeValues() {
        val st = StackStore()
        st.attrDefaults["color"] = "'blue'"
        assertEquals("blue", JSE.eval("attribute.color", st, null))    // declared default (re-evaluated)
        st.vars["dsx.attribute"] = mapOf("color" to "red")
        assertEquals("red", JSE.eval("attribute.color", st, null))     // runtime attribute wins over default
        assertEquals("green", JSE.eval("attribute.color", st, mapOf("color" to "green")))   // the row itself wins
        assertEquals("green", JSE.eval("dsx.attribute.color", st, mapOf("color" to "green")))
    }

    @Test fun reservedScopesThroughSeams() {
        assertEquals("android", eval("os"))                            // documented divergence: "ios" there, "android" here
        assertEquals("android", eval("platform"))
        assertEquals("appstore", eval("env"))                          // detector seam fails CLOSED

        JSE.stateVars = { mapOf("session" to mapOf("credits" to 42.0), "app" to mapOf("env" to "debug"),
                                "route" to mapOf("path" to "/home", "params" to mapOf("id" to "7"))) }
        assertEquals(42.0, eval("global.session.credits"))
        assertEquals(42.0, eval("dsx.global.session.credits"))
        assertEquals("debug", eval("env"))                             // boot-seeded global.app.env wins
        assertEquals("/home", eval("route.path"))
        assertEquals("/home", eval("dsx.path"))
        assertEquals("7", eval("dsx.params.id"))

        JSE.cookieJar = { mapOf("session" to "abc") }
        assertEquals("abc", eval("dsx.cookie.session"))
        assertEquals(mapOf("session" to "abc"), eval("dsx.cookie"))    // the whole jar

        JSE.moduleAvailable = { it == "player" }
        assertEquals(true, eval("has('player')"))
        assertEquals(false, eval("has('missing')"))
    }

    @Test fun normalizeScopeTable() {
        assertEquals("x", JSE.normalizeScope("dsx.variable.x"))
        assertEquals("x", JSE.normalizeScope("dsx.formula.x"))
        assertEquals("global.x", JSE.normalizeScope("dsx.global.x"))
        assertEquals("global.screen.width", JSE.normalizeScope("dsx.screen.width"))
        assertEquals("global.source.web.state", JSE.normalizeScope("dsx.source.web.state"))
        assertEquals("global.app.name", JSE.normalizeScope("dsx.app.name"))
        assertEquals("route.x", JSE.normalizeScope("dsx.route.x"))
        assertEquals("route.params.id", JSE.normalizeScope("dsx.params.id"))
        assertEquals("route.query.q", JSE.normalizeScope("dsx.query.q"))
        assertEquals("route.path", JSE.normalizeScope("dsx.path"))
        assertEquals("cookie.name", JSE.normalizeScope("dsx.cookie.name"))
        assertEquals("attribute.name", JSE.normalizeScope("dsx.attribute.name"))
        assertEquals("item.x", JSE.normalizeScope("dsx.item.x"))
        assertEquals("item.x", JSE.normalizeScope("dsx.this.x"))
        assertEquals("item.__element.width", JSE.normalizeScope("dsx.element.width"))
        assertEquals("event", JSE.normalizeScope("dsx.event"))         // unknown head → body, handled elsewhere
        assertEquals("plain.path", JSE.normalizeScope("plain.path"))   // no dsx. prefix → unchanged
    }

    // ── value ops: the coercion tables ───────────────────────────────────────────────────

    @Test fun stringCoercionTable() {
        assertEquals("2", JSE.string(2.0))                             // integral → no ".0"
        assertEquals("2.5", JSE.string(2.5))
        assertEquals("0", JSE.string(-0.0))
        assertEquals("1", JSE.string(true))                            // the NSNumber-bridging law
        assertEquals("0", JSE.string(false))
        assertEquals("", JSE.string(null))
        assertEquals("abc", JSE.string("abc"))
        assertEquals("3", JSE.string(3))                               // host Int
        assertEquals("<null>", JSE.string(NSNull))
    }

    @Test fun numberCoercionTable() {
        assertEquals(3.5, JSE.number("3.5"))
        assertEquals(1.0, JSE.number(true))
        assertEquals(0.0, JSE.number(false))
        assertEquals(2.0, JSE.number(2))
        assertEquals(31.0, JSE.number("0x1F"))                         // Swift Double(String) accepts bare hex
        assertNull(JSE.number("12px"))                                 // partial parse → null (unlike JS parseInt)
        assertNull(JSE.number(""))
        assertNull(JSE.number(" 1"))                                   // Swift: no whitespace tolerance
        assertNull(JSE.number("1f"))                                   // Java suffix Swift rejects
        assertNull(JSE.number(null))
        assertNull(JSE.number(listOf(1.0)))
        assertEquals(123.0, JSE.number(mapOf("__date" to 123.0)))      // Date dict coerces to its ms
        assertNull(JSE.number(mapOf("x" to 1.0)))
    }

    @Test fun truthinessTable() {
        assertTrue(JSE.truthy(true))
        assertFalse(JSE.truthy(false))
        assertTrue(JSE.truthy("0"))                                    // non-empty string — even "0"
        assertFalse(JSE.truthy(""))
        assertFalse(JSE.truthy(0.0))
        assertTrue(JSE.truthy(1.0))
        assertTrue(JSE.truthy(Double.NaN))                             // NaN != 0 → truthy (Swift semantics)
        assertFalse(JSE.truthy(null))
        assertTrue(JSE.truthy(emptyList<Any?>()))                      // .some → true, even empty
        assertTrue(JSE.truthy(emptyMap<String, Any?>()))
    }

    @Test fun equalsCoercionTable() {
        assertTrue(JSE.equals(1.0, "1"))
        assertTrue(JSE.equals(true, 1.0))
        assertFalse(JSE.equals(null, ""))                              // null equals only null (core-002 law)
        assertFalse(JSE.equals(null, 0.0))
        assertFalse(JSE.equals(Double.NaN, Double.NaN))                // primitive ==, not boxed equals
        assertTrue(JSE.equals(-0.0, 0.0))
        assertTrue(JSE.equals("a", "a"))
        assertTrue(JSE.equals(NSNull, null))                           // the sentinel reads as null (core-002 law)
    }

    @Test fun watchKeyIsStableAndDeep() {
        assertEquals("∅", JSE.watchKey(null))
        assertEquals("∅", JSE.watchKey(NSNull))
        assertEquals("sx", JSE.watchKey("x"))
        assertEquals("b1", JSE.watchKey(true))
        assertEquals("n2", JSE.watchKey(2.0))
        assertEquals("[n1sx]", JSE.watchKey(listOf(1.0, "x")))
        // dict keys sorted → insertion order never churns the key
        assertEquals(JSE.watchKey(mapOf("b" to 1.0, "a" to true)), JSE.watchKey(mapOf("a" to true, "b" to 1.0)))
        assertEquals("{a=b1b=n1}", JSE.watchKey(mapOf("b" to 1.0, "a" to true)))
    }

    @Test fun asArrayAndAsRows() {
        assertEquals(listOf<Any?>(1.0, 2.0), JSE.asArray(listOf(1.0, 2.0)))
        assertEquals(emptyList(), JSE.asArray("nope"))
        assertEquals(emptyList(), JSE.asArray(null))
        // asRows funnels element-wise: non-dict / NSNull rows drop, real rows survive
        val rows = JSE.asRows(listOf(mapOf("a" to 1.0), "junk", NSNull, mapOf("b" to 2.0)))
        assertEquals(listOf(mapOf("a" to 1.0), mapOf("b" to 2.0)), rows)
        assertEquals(emptyList(), JSE.asRows("nope"))
    }

    @Test fun emptyAttributeDefaultReadsAsTheEmptyString() {
        //  The twin of the TS hardening pin (kernel/test/hardening.test.ts) and of
        //  JSE.swift: `<attribute as="x" default=""/>` MEANS the empty string. An empty
        //  expression evaluated to null, so such an attribute read as ABSENT and the usual
        //  `!= ''` guard fired for one nobody set.
        val store = StackStore()
        store.attrDefaults["action"] = ""
        store.attrDefaults["title"] = "'Untitled'"
        store.vars["dsx.attribute"] = mapOf<String, Any?>()
        assertEquals("", JSE.eval("dsx.attribute.action", store, null))
        assertEquals("Untitled", JSE.eval("dsx.attribute.title", store, null))
        assertEquals(false, JSE.eval("dsx.attribute.action != ''", store, null))
        store.vars["dsx.attribute"] = mapOf<String, Any?>("action" to "Browse")
        assertEquals("Browse", JSE.eval("dsx.attribute.action", store, null))
    }

    @Test fun indexAndMemberHelpers() {
        assertEquals("b", JSE.index(listOf("a", "b"), 1.0))
        assertNull(JSE.index(listOf("a"), 5.0))
        assertNull(JSE.index(listOf("a"), -1.0))
        assertEquals("v", JSE.index(mapOf("k" to "v"), "k"))
        assertEquals(3.0, JSE.member("abc", "length"))
        assertEquals(2.0, JSE.member(listOf(1, 2), "length"))
        assertEquals(9.0, JSE.member(mapOf("length" to 9.0), "length"))   // a dict keeps its own "length" key
        assertNull(JSE.member(null, "length"))
    }
}
