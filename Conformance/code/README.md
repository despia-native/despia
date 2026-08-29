# code/ - the `<code>` element's highlighter

One corpus, three scanners. `tokens.json` is the shared expectation for the token spans a
`<code>` element paints over JSE source.

## Why this is not the evaluator's tokenizer

`packages/kernel/src/jse/tokens.ts` (and its Swift and Kotlin twins) strips comments, runs
ASI, and returns values with no idea where they came from. That is exactly right for running
code and useless for drawing it: a highlighter needs every byte accounted for, in source
order, with offsets, comments and whitespace included. So the highlighter is its own scanner
on each renderer.

The one rule the two must never disagree about is whether a `/` opens a regex literal or
divides. Both use the same test: a slash is a regex when nothing valued precedes it, where a
keyword does not count as a value (`return /ab/` is a regex, `x / 2` is division).

## The mask

Every case is a MASK: one letter per code unit of `source`. The spans TILE the input - no
gap, no overlap, index 0 to length - so the whole expectation is one string a person can read
against the source by eye, and a wrong length fails before a wrong colour does.

| letter | kind | what it is |
|---|---|---|
| `.` | plain | whitespace, and anything the scanner has no opinion about |
| `c` | comment | `// ...` to the line end, `/* ... */` to its close or the file end |
| `s` | string | a quoted literal, and a template's backticks and literal chunks |
| `n` | number | decimal, radix (`0x` `0b` `0o`), exponent, `_` separators |
| `r` | regex | the literal and its flags |
| `k` | keyword | a control word |
| `l` | literal | `true` `false` `null` `undefined` - a value, not a control word |
| `f` | call | an identifier a `(` follows: what this line does |
| `p` | property | an identifier a single `.` precedes (so `?.b` yes, `...b` no) |
| `i` | ident | everything else nameable |
| `o` | operator | including `.`, `=>`, and a template hole's `${` and `}` |
| `x` | punct | `( ) [ ] { } , ;` |

Precedence where a word could be two things: keyword, then literal, then call, then property.
`if (` is not a call and `default:` is not a property.

## Recovery

Malformed input is drawn, never refused - a person is typing, so half a literal is the normal
state of the file. An unterminated quote ends at the line break; an unterminated block comment
runs to the end of the source; a `/` that opens nothing is division.

## Runners

| renderer | scanner | test |
|---|---|---|
| TypeScript | `packages/kernel/src/jse/highlight.ts` | `packages/kernel/test/highlight-conformance.test.ts` |
| Kotlin | `Engine/Android/core/.../Highlight.kt` | `:core HighlightConformanceTest` |
| Swift | `Engine/iOS/Highlight.swift` | `HighlightConformance` (record lane) |
