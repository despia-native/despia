# Action contracts — the declaration IS the schema

> **Status: PROPOSED (corpus-first), 2026-08-27.** Nothing here is landed. This document is the
> language-design ruling and the execution plan; the first wave it authorises is a corpus, not a
> parser. Written in answer to a review finding on WebMCP (`webmcp.md` §3, the sentence *"when the
> declared-args table lands, types flow in here with zero grammar change"*) and to the
> owner-directed question behind it: **can the honest-but-empty tool schema create critical gaps?**
>
> **The one-sentence claim:** DSX already has a typed action-contract table — it has had one for
> 805 actions since before MCP existed here — and the gap is not that the language cannot describe
> an action, it is that the table lives in ONE of the four residences and is projected by FIVE
> hand-written derivations that do not agree. The fix is one canonical `ActionContract` IR, one
> projection per consumer, and the same table spelled for the residence that lacks it. Not a new
> schema plane. The retirement of four of the five that already exist.

---

## 0 · The question, answered first

**Is the WebMCP schema a critical gap?** Not today, and yes structurally. Precisely:

| Claim | Verdict | Evidence |
|---|---|---|
| An agent cannot tell a required string from an optional object | TRUE, and it is the whole finding | `mcp-face.ts:99` emits `{ type:"object", properties:{ <input>:{} } }`; `webmcp.ts` projects the same |
| Nothing is currently WRONG on the wire | TRUE — the schema is honest, not false | an empty property schema means "any JSON", which is exactly what an untyped input accepts |
| The app is at risk of a drifting second schema | FALSE, and it must stay false | no surface accepts a hand-written schema anywhere in the tree; that is already law in five places |
| Wiring the EXISTING module table into the derivation is safe today | **FALSE.** This is the critical part | 19 declared args carry a type word that is not a JSON Schema type; 16 `_note*` keys sit inside `resolves` blocks and would project as phantom output fields |

So the gap that matters is not the empty schema. It is that **the moment someone connects the table
that already exists to the derivation that already exists, they ship invalid JSON Schema and
sixteen imaginary return fields**, because the two halves were built years apart against different
type vocabularies and nothing gates the join. That join is a four-line change any engineer would
make on a Friday. This proposal exists to make it a corpus instead.

## 1 · What already exists, measured

Run `python3` over `ClosedSource/DSX/Modules/**/dsx.json` and `grep` over `**/*.dsx`:

| Fact | Count |
|---|---|
| module manifests | 185 |
| declared module actions | 805 |
| actions declaring `args` | 554 |
| declared arguments | 1428 (975 object form, 453 `"name": "string"` shorthand) |
| args carrying `enum` | 6 |
| args carrying `default` | 4 |
| args carrying `_note` (author comment, stripped) | 86 |
| actions declaring `resolves` (the OUTPUT plane) | 761 |
| actions declaring `errors` (declared outcomes) | 511 |
| actions declaring `tests` (executable examples) | 801 |
| `<action>` declarations in `.dsx` documents | 489 across 101 files |
| document actions using the `inputs="…"` spelling | 72 |

**The typed table the review asks for is 90% written.** It is `dsx.json`'s
`actions.<name>.{args,resolves,errors}`, it is validated at build by `verify_module_tests.rb`
(which type-checks every declared test fixture against it), its evolution is gated by
`contract_diff.rb` (remove an arg, retype one, or add a required one and CI fails), and it is
already published whole as `ClosedSource/CapabilityManifest.json` (805 actions with args,
resolves, errors and examples). `moat-assessment.md` §6 named this exact condition:
*"~80% BUILT AND UNASSEMBLED. This is the finding that matters most."*

What does NOT have it is the **document** residence: a `.dsx` `<action>` declares input NAMES and
nothing else. That is the honest shape the WebMCP derivation reports.

### 1.1 · Three residences, three spellings, already

| Residence | Spelling | Types today | Reader |
|---|---|---|---|
| module manifest | `"args": { "amount": { "type":"number", "optional":true } }` | YES | `dsx_graph.rb`, `verify_module_tests.rb`, `contract_diff.rb` |
| screen / component `.dsx` | every attribute on `<action>` that is not `as`/`computed`/`value` is an input; the VALUE is a default expression | no | `component.ts:231` |
| `<server>` / `<cli>` `.dsx` | one `inputs="a, b: expr"` attribute | no | `server-document.ts:300`, `document.ts:292` |

The fork is not hypothetical: `edit.ts` already reads both — `decl.attrs["inputs"].split(",")` at
line 750 for the server face, `Object.keys(decl.attrs)` minus `HEAD_INPUT_SKIP` at line 1126 for
the screen face. Two readers, one product surface. A third consumer will write a third reader.

### 1.2 · Five derivations, one law

The law "a tool never declares a second contract" is stated in five files and implemented five
times:

| Derivation | Emits | Reads the declared table? |
|---|---|---|
| `packages/server/src/mcp-face.ts` `inputSchema()` | `{type:object, properties:{name:{}}}` | no (document inputs are untyped) |
| `packages/kernel/src/mcp/webmcp.ts` `projectTools` | same | no |
| `Core/MCP` `MCP.kt` / `MCP.swift` `toolList()` | `{"type":"object"}`, no `properties` | **no — `McpMap` never fans `args` in** |
| `OpenSource/MCP` `ServedCatalog.deriveSchema` (kt/swift/ts) | `{type, properties, required}` | YES, when a caller supplies `ArgSpec`s — which the app path never does |
| `OpenSource/AI` `Host.deriveSchema` (kt/swift/ts) | same, behind `row.fromArgs` | same |

The declaration is the source of truth in principle and in five different pieces of code in
practice. **The proposal's real deliverable is that this table becomes one row.**

## 2 · The measured defects, so they are fixed rather than inherited

Each of these is a live condition in the tree today, found by reading it, and each one is a corpus
case in §7.

1. **Two type words are not JSON Schema types.** `int` (18 args) and `any` (1) are declared and
   `deriveSchema` passes `spec.type` through verbatim. A strict MCP client validating
   `{"type":"int"}` rejects the tool. `verify_module_tests.rb:94` also accepts `file` and `json`
   as arg types and silently passes ANY unknown word (`else true # unknown → don't over-constrain`),
   so the vocabulary is open by accident.
2. **`_note*` keys inside a `resolves` block would project as output fields.** 16 occurrences
   (15 `_note_status`, 1 `_note_type` — `Core/Audio`, `Core/Net`). `generate_capability_manifest.rb`
   already has `strip_notes` for exactly this; the kernel folds do not, because they never read the
   block. Any output derivation written without the rule inherits the bug.
3. **The device MCP face advertises an empty object with no properties.** `McpMap.generated.*`
   carries `chain · action · description · mutates` and no args, so `Core/MCP` hardcodes
   `"inputSchema" to mapOf("type" to "object")` while the open package it wraps has a working
   derivation sitting unused two files away.
4. **A `resolves` block can be a scalar or a field map, disambiguated by whether its `type` key is
   a string.** Two manifests carry a `_note` explaining the trap in prose, one of them ending
   *"The checker fix is filed with this workstream's handoff."* An IR that does not rule on this
   inherits a shape that needs a paragraph to read.
5. **A document action exposed as a tool has NO evolution gate.** `contract_diff.rb` reads
   `dsx.json` only. A `<tool>` row can publish an action to every agent on the internet, and
   renaming that action's input is not a gated change.
6. **Nothing validates arguments at runtime, on any renderer.** `required` is currently a
   documentation claim. The only enforcement is `verify_module_tests.rb` checking FIXTURES at build.

## 3 · The law

**ACTION CONTRACT = SOURCE OF TRUTH. Everything else is a projection.**

Three corollaries, all of which are restatements of rules already in force:

1. **No consumer accepts an authored schema.** Not `<tool>`, not `facets.mcp`, not `facets.tools`,
   not a Studio field, not a `<server>` row. (Already law; this proposal removes the last reason
   anyone would ask for one.)
2. **No consumer writes its own derivation.** One fold, three renderers, one corpus. A second
   `deriveSchema` in the tree is a gate failure, not a style preference.
3. **A projection may narrow, never invent.** A face that cannot express a declared word drops it
   and says so in its own docs. It never fabricates a constraint the author did not write, and it
   never reports a shape as complete when the declaration was untyped.

## 4 · The IR

One record, platform-neutral, in the kernel beside `mcp/result.ts`. Every field maps to something
an author already writes in at least one residence today.

```
ActionContract {
  name         : string
  residence    : "module" | "screen" | "server" | "cli"
  chain        : string?            // module residence only
  description  : string?            // model-facing, UNTRUSTED, never policy
  completeness : "untyped" | "typed"
  inputs       : Field[]            // declaration order
  output       : Output
  failures     : Failure[]
  effects      : { mutates?: string, broadcasts: string[], stream?: string }
}

Field {
  name        : string
  type        : TypeWord            // the closed vocabulary, §5
  required    : boolean             // DERIVED: !optional
  description : string?
  nullable    : boolean             // default false
  enum        : Json[]?
  default     : Json?
  of          : TypeWord?           // array element type
  fields      : Field[]?            // members when type is object, or the ELEMENT's members when
                                    // type is array and of is object
  constraints : { min?, max?, minLength?, maxLength?, pattern?, format? }?
  sample      : Json?               // the P3 editor sample plane, §6.4
}

Output  = { kind: "fields", fields: Field[] }
        | { kind: "scalar", type: TypeWord }
        | { kind: "void" }
        | { kind: "unknown" }       // nothing declared

Failure = { code: string, message?: string, recoverable: boolean, canonical?: string,
            data?: Field[] }
```

Four rulings inside that record, each of which the audit in §6 depends on:

- **`completeness` is a first-class value, not an inference.** It is what lets every projection be
  honest without guessing: `"untyped"` means the author declared names only, and a face may then
  emit exactly what it emits today. This is the entire backward-compatibility story (§8) and it is
  a data field rather than a code path, so all four renderers agree on it by construction.
- **`required` is derived, never authored.** The manifest spells `optional: true`; the document
  grammar spells `required="true"`. Both fold to the same boolean. Nothing in the IR carries both
  polarities, because a contract that can express "not optional and not required" has a third state
  nobody meant.
- **`Output.kind` closes the scalar/map ambiguity of defect 4** at the reader, once, instead of at
  every consumer. `unknown` and `void` are different answers and both are honest.
- **`Failure` is in v1 of the IR even though its v1 projections are few** (§6.15). The manifest
  residence already declares 511 of them against a canonical vocabulary (`error_vocabulary.rb`); an
  IR that omitted the plane would guarantee a second divergence the day the document residence
  grows one.

## 5 · The type vocabulary

One closed list. **The DSX spellings do not change**, because changing them is itself a breaking
contract change under `contract_diff.rb` (a retype fails CI), so `int` stays `int` and is *mapped*
at projection time.

| DSX word | JSON Schema | Swift | Kotlin | TS | note |
|---|---|---|---|---|---|
| `string` | `{"type":"string"}` | `String` | `String` | `string` | 853 uses |
| `number` | `{"type":"number"}` | `Double` | `Double` | `number` | 244 |
| `int` | `{"type":"integer"}` | `Int` | `Long` | `number` | 18 — **the mapping that does not exist today** |
| `boolean` | `{"type":"boolean"}` | `Bool` | `Boolean` | `boolean` | 133 |
| `array` | `{"type":"array"}` + `items` from `of`/`fields` | `[Any]` | `List<*>` | `unknown[]` | 97 |
| `object` | `{"type":"object"}` + `properties` from `fields` | `[String:Any]` | `Map<String,*>` | `object` | 82 |
| `json` | `{}` (any JSON) | `Any` | `Any?` | `unknown` | accepted by the test checker, unused in args |
| `file` | `{"type":"string","contentEncoding":"binary"}` | `String` | `String` | `string` | a path or URI by contract |
| `any` | `{}` | `Any` | `Any?` | `unknown` | 1 use; the explicit escape hatch |

**An unknown type word becomes a build error.** Today it silently passes. Closing the vocabulary is
a one-line change to `verify_module_tests.rb` and it is the cheapest defect in §2 to retire.

`nullable: true` projects as `{"type":["string","null"]}`, never as `anyOf` — one spelling, so
three renderers can produce byte-identical output.

## 6 · The grammar

### 6.1 · Module residence — additive, no new file

The manifest table gains the words it lacks. Every one is optional and every existing manifest
stays valid:

```json
"actions": {
  "charge": {
    "description": "Charge the saved card and return the receipt.",
    "args": {
      "amount":   { "type": "int", "description": "Minor units, never a float.", "min": 1 },
      "currency": { "type": "string", "optional": true, "default": "USD", "enum": ["USD","EUR"] },
      "customer": { "type": "object", "fields": {
        "id":    { "type": "string" },
        "email": { "type": "string", "optional": true, "format": "email" } } },
      "items":    { "type": "array", "of": "object", "fields": {
        "sku": { "type": "string" }, "qty": { "type": "int" } } }
    },
    "resolves": { "receipt": "string", "captured": "boolean" },
    "errors": { "card_declined": { "message": "…", "recoverable": true } }
  }
}
```

New words: `description` on the action and on each arg, `fields`, `of`, `min`/`max`/`minLength`/
`maxLength`/`pattern`/`format`, `nullable`. `enum` and `default` already exist and already parse.

**`description` is NOT `_note`.** `_note` is an author-to-author comment, stripped by every
projection, and 86 args carry one that talks about internals. `description` is model-facing text
that rides to an agent as untrusted data. Collapsing them would ship implementation notes to
language models as instructions.

### 6.2 · Document residence — a head row, because the grammar leaves no other door

The reviewer's conceptual shape is a typed child of `<action>`. **It is unimplementable, and the
reason is worth stating precisely, because it also rules out the two obvious alternatives:**

1. **`<action>` cannot take children.** `xml.ts:56` — `CODE_TAGS = {script, action, formula,
   variable, var, let, functions}` — reads the body as raw text to the matching close tag. That is
   not an optimisation; it is what lets a JSE body contain `if (a < b)` at all. Making `<action>` a
   container would break every action body containing a bare `<`, which is most of them.
2. **`<action>` cannot take a new attribute.** Every attribute that is not `as`/`computed`/`value`
   IS an input (`component.ts:235`). This is already enforced and already cost a feature:
   `lint_dsx.rb:752` errors on `sample=` on `<action>` with the sentence *"it becomes an input
   binding evaluated at call time"*. A `type=` or `contract=` attribute would silently declare an
   input named `type`.
3. **The `inputs="…"` string cannot grow a type syntax.** Its right-hand side after `:` is a
   default EXPRESSION (`inputs="limit: defaults.limit"`, `server-document.ts:314`). A second
   micro-syntax inside an attribute value is how you get a parser nobody can lint.

So the contract is a head declaration that NAMES its action — exactly the move `<tool>` already
made, for exactly the reason recorded in `webmcp.md` §3. The precedent is not merely similar; it
is the same sentence:

```xml
<screen>
  <head>
    <contract action="addTodo" description="Add an item to the user's todo list.">
      <in as="text" type="string" required="true" description="What to add."/>
      <in as="priority" type="string" enum="low normal high" default="normal"/>
      <in as="tags" type="array" of="string"/>
      <in as="author" type="object">
        <in as="name" type="string" required="true"/>
        <in as="email" type="string" format="email"/>
      </in>
      <out as="id" type="string"/>
      <out as="created" type="boolean"/>
      <fail code="list_full" message="The list is at its limit." recoverable="true"/>
    </contract>

    <tool action="addTodo" description="Add an item to the user's todo list."/>

    <action as="addTodo" text="" priority="'normal'">
      dsx.variable.todos.push({ text: text, done: false })
      return { id: dsx.variable.todos.length, created: true }
    </action>
  </head>
</screen>
```

Rules, and each one has a reason that is already law somewhere:

- **`action=` must name an action this document declares.** Stale target fails the build, validated
  at the END of the head pass like `<tool>`, because a contract is interface and reads before its
  action.
- **A `<contract>` is COMPLETE.** Declaring one means every input of the named action is described;
  an input with no `<in>` row is a build error, and an `<in>` naming an input the action does not
  declare is a build error. There is no half-typed state, because `completeness: "typed"` must mean
  something to the consumer that reads it. An author who wants types on one argument writes the
  other rows; there are usually two.
- **`<in>` recurses; `<field>` is deliberately NOT reused.** `<entity><field type="text"/>` on the
  `<server>` node carries a STORAGE vocabulary (`text · integer · real · timestamptz · jsonb ·
  uuid`), not the wire vocabulary of §5. Reusing the word would put two closed type vocabularies
  behind one attribute in one document family, which is the exact drift this proposal exists to
  prevent. A nested `<in>` reads as "a member of this input", which is what it is.
- **The shorthand keeps its job.** `<action as="addTodo" text="">` still declares the input and its
  DEFAULT EXPRESSION. The contract describes the SHAPE. They are different facts about the same
  name and neither is derivable from the other, so neither is redundant and there is no conflict
  rule to remember.
- **`<contract>` is independent of `<tool>`.** Contracts are for every caller: the runtime, Try It,
  the docs, tests. Exposure to an agent stays an explicit, separate row. An action is never
  agent-callable by accident, which was the founding rule of the `<tool>` row.
- **Head rank 2, beside `event`/`input`/`tool`** — the interface band. `headOrderHint` becomes
  `attribute → expects → event/input/tool/contract → api/variable → formula → action → …`.

### 6.3 · Progressive disclosure, stated as the three legal states

| State | Author writes | `completeness` | What an agent sees |
|---|---|---|---|
| SIMPLE | `<action as="add" text="">` | `untyped` | `{type:"object", properties:{text:{}}}` — byte-identical to today |
| STRICT | the above + a `<contract>` | `typed` | the full derived schema with `required` |
| MODULE | `dsx.json` `args`, as 554 actions already do | `typed` | the same derived schema, same code path |

### 6.4 · The bonus the row unlocks

`sample=` was deferred on `<action>` for the reason quoted in §6.2 — the attribute would become an
input binding. On an `<in>` row it cannot, so `<in as="text" sample='"Buy milk"'/>` closes the
master-plan P3 sample gap for actions without a new decision. Try It (§6.7) reads it as the
prefilled value.

## 7 · The adversarial audit, consumer by consumer

The fifteen the review named, plus the two it did not.

**1 · WebMCP JSON Schema derivation.** Today `projectTools` builds `properties[name] = {}`.
Becomes: `projectTools(rows, contracts)` where an `untyped` contract yields the identical object.
Risk: the `<tool>` row's `description` and the `<contract>`'s `description` can disagree. Ruling:
they describe different things (the TOOL's purpose to a model, the ACTION's purpose to a reader)
and both are untrusted text, so both are legal; the tool row wins for the descriptor. Second risk:
`annotations.readOnlyHint` is derived from `mutates` on the row today; a contract's `effects.mutates`
must not become a second source. Ruling: the ROW owns exposure policy, the CONTRACT owns shape;
`readOnlyHint` keeps reading the row.

**2 · Backend MCP (`/mcp` on the `<server>` node).** `mcp-face.ts` gains the contract lookup and
loses its private `inputSchema()`. Its `McpToolRow.inputs?: string[]` field becomes
`contract: ActionContract`, generated into `generated/mcp-tools.json` by `prepare_server.rb`.
Risk: the emitter is idempotence-gated (`prepare_server` twice = no diff), so field ORDER in the
emitted contract must be declaration order, deterministic. Ruling: the IR is an ordered array, not
a map, for exactly this reason — and it is the same reason `fallbackText` had to sort keys in W0.

**3 · Local/device AI tool registry.** `OpenSource/AI` `Host.deriveSchema` already does the right
thing behind `row.fromArgs`. The break is upstream: `McpMap`/`ToolsMap` never fan the args in.
Ruling: the fan-in emits a `contract` blob per row; `Core/MCP`'s hardcoded
`"inputSchema" to mapOf("type" to "object")` is DELETED, not fixed, and the module calls the open
package's derivation. Risk: `ToolsMap.generated.*` grows by the size of the contract table for
every enabled module, in a binary that ships. Measured mitigation: only rows that a `facets.tools`
/ `facets.mcp` declaration NAMES need their contract emitted, which is 8 rows in the tree
today (1 `facets.tools`, 7 `facets.mcp`), not 805. Page and MCP tool schemas keep passing through VERBATIM — never down-converted into this
vocabulary, which stays law (`ai/tools` §Schemas).

**4 · Actions and routes.** A `<route>` binds an HTTP request to an action; the payload is the
request body. A typed contract makes 400-vs-500 decidable at the boundary instead of inside the
body. Risk: turning that on retroactively changes the status code shipped apps return. Ruling:
validation enforcement is staged and opt-in-by-declaration (§8), because an action with NO contract
must behave exactly as it does now.

**5 · Studio Tools.** Already draws the derived schema and is explicitly forbidden from ever
growing a schema field (`webmcp.md` §4c decision 2). With contracts it draws types, required marks,
enums and descriptions — the same fold, more to show. Risk: the WE2 inspector edits `<tool>`
attributes through the surgery door; authors will expect to edit contract rows there too. Ruling:
YES, and it is the same mechanism (`insertNode`/`setAttribute` on a real element) — but the
inspector must edit the `<contract>` element, never synthesise one on the tool row, or the two
homes come back through the UI.

**6 · Studio Logic / workflow visualisation.** The entry node already retitles to `AGENT · <tool>`.
With a contract the node draws typed argument slots and the flow's terminal node draws the declared
output. Risk: 489 document actions have no contract and would draw an empty contract strip. Ruling:
`completeness: "untyped"` renders as a named absence ("this action declares no types" with the
one-click action that writes the `<contract>` skeleton), never as a blank panel. Typed absence is
already the house pattern.

**7 · Try It.** `/edit/api/try` makes a live entry call with argument slots. Contracts turn those
into typed controls, enum pickers, required marks and client-side validation before the call is
made — the same value proposition `stack-style-properties.json` gives the style panel. Risk: Try It
validating locally against a contract the RUNTIME does not enforce would be a second validator.
Ruling: Try It calls the same shared validation fold (§8) and reports its result; it never
implements its own check.

**8 · CLI / MCP developer tooling.** `dsx doctor`, `/edit/mcp` and the `<cli>` document node.
`<cli>` actions use the `inputs="…"` spelling and `document.ts:375` already treats `inputs=` as a
CHECKED CONTRACT (a body may only read declared names). Contracts give `dsx <command> --help`
real argument documentation and typed flag parsing. Risk: the `<cli>` head has its own closed seam
list (`out · env · fs · exec`); `<contract>` must be added to the `<cli>` head grammar explicitly
or it lands as an unknown tag. Named here so it is not discovered in W3.

**9 · Runtime input validation.** See §8. This is the one consumer where "derive it and turn it on"
is wrong.

**10 · TS / Kotlin / Swift conformance.** The reader, the folds and the projections are pure and
run on all three renderers against `OpenSource/Conformance/contract/`. Risk: Swift's `Any` bridging
already bit this plane once (W0 defect 2: an `NSNumber` holding 1 casts to `Bool`, so a COUNT
rendered as `true`). A contract carrying `int`, `number` and `boolean` in one action is therefore a
mandatory corpus case, not an optional one. Second risk: dictionary ordering has no portable
answer in Swift, which is why `Field[]` is an array.

**11 · Generated documentation.** `CapabilityManifest.json` already emits the module half with
`strip_notes`. It gains the document half and the new words. `llms.txt`, the registry site and the
docs site read it. Risk: the manifest is `--check` gated for staleness, so the contract emitter
must be deterministic or every unrelated PR goes red.

**12 · Backward compatibility with `inputs="…"`.** The law is stronger than "still valid": **for an
action with no contract, every projection must be BYTE-IDENTICAL to what it emits today**, pinned
by re-running the existing `webmcp/project.json`, `ai/mcp/*` and `mcp-apps/server.json`
expectations unchanged. If a landed expectation moves, the wave is wrong. (The one legitimate
exception is `Core/MCP`'s `{"type":"object"}` with no `properties`, which is a DIFFERENT claim from
the honest empty-properties schema and is defect 3, not a contract.)

**13 · Nested objects and arrays.** `fields` (members) and `of` (element type), recursive, with a
DEPTH CAP. Ruling: cap at 5, refused at build with the path that exceeded it. A schema plane with
no depth cap is a build-time hang waiting for a cyclic import to be invented, and every other
recursive plane here is capped (action depth 32, loop budget 10000).

**14 · Output and result contracts.** `resolves` already exists on 761 actions and
`check_resolve_shapes` gates it. `Output.kind` closes the scalar-vs-map ambiguity (defect 4) at the
reader. Projection: MCP's `outputSchema` and `structuredContent` (spec 2025-06-18) are the natural
targets — and this is where a real risk lives, because `structuredContent` must MATCH the declared
output or a conformant client rejects the result. Ruling: **declaring an output does not turn on
result enforcement in v1.** The face advertises `outputSchema` only for actions whose output is
`kind:"fields"` and whose declared shape has been proven against the action's own declared tests
(801 actions carry them) — the existing fixtures become the proof that the promise is kept.

**15 · Declared errors — v1 or later?** **In the IR in v1, projected narrowly in v1.** The manifest
half already ships 511 of them with a canonical vocabulary and a gate; leaving them out of the IR
would guarantee that the document residence invents a second error grammar. But MCP has no error
schema field and inventing a place to put one would violate §3 corollary 3. So v1 projections are:
documentation, Studio, the `expectError` test gate (extended to document actions), and the
`isError` result's structured payload which already carries `{code, message, recoverable}`. A face
that wants declared failures in its descriptor is a later, separate ruling.

**16 · The gate plane (not in the review's list, and it is the one that decides whether this
holds).** `contract_diff.rb` is stdlib-only Ruby reading `dsx.json`. It must gate document
contracts too (defect 5) without learning to parse `.dsx`. Ruling: **the build emits one canonical
artifact — `Contracts.generated.json`, every residence, normalised IR — and every Ruby gate diffs
the artifact rather than re-parsing a source.** One reader in TS, one artifact, N gates. This also
gives §6.11 its document half for free and gives `check_gate_coverage.rb` something to point a lane at.

**17 · Exclusion and platform facets (not in the list).** A contract belongs to a module that can
be excluded, and an action can be `platforms`-limited (338 actions declare it). A projection must
never advertise a tool whose owner is excluded — already true, via the fan-in — and a contract for
a platform-limited action must carry that fact rather than implying universal availability. The IR
does not add a field for it: `platforms` stays on the action, and the projection reads both.

## 8 · Runtime validation, staged — the ruling that protects shipped apps

Deriving a validator is trivial. Turning it on is a behaviour change for 1428 declared arguments in
185 modules and 489 document actions, and Article 7 says the runtime fails OPEN.

The existing code already draws the correct line. `runner.ts:497` splits `options.entry === true`
from an in-app call site, with a comment recording that collapsing the two *"cost a shipped bug"*:
an ENTRY has no caller scope and its payload arrives from outside; an in-app call site is the
author's own code.

| Caller | v1 behaviour |
|---|---|
| ENTRY: agent tool call, MCP, HTTP route, CLI command, queue message | validate against the contract; a violation settles `invalid_param` naming the field and the expectation, before the body runs |
| in-app: `dsx.action.x()`, `dsx.module.a.b()`, a markup handler | **no enforcement in v1.** Report through the error ledger (`dsx.errors`, already a ring of 128, already surfaced in the dev drawer on test installs) and continue |
| any caller, action with no contract | nothing changes, at all |

The reasoning is the trust boundary, not timidity: at an entry the caller is foreign and a typed
refusal is the correct answer; in-app, a hard failure would turn a documentation improvement into a
crash in shipped apps, which is precisely how a contract plane gets a reputation for being
dangerous to declare. Promoting in-app enforcement is a later decision with its own evidence (the
ledger will have counted the violations by then), and it belongs to the app through
config, never to the framework by fiat.

## 9 · The corpus, first

`OpenSource/Conformance/contract/` — four files plus the README naming every runner. Written and
run BEFORE any grammar lands, because `generate_conformance_index.rb` measures which runtimes
actually execute a corpus and `check_gate_coverage.rb` fails a gate no lane runs. A corpus without
a runner is indistinguishable from success in every other artifact.

**`read.json`** — the READER law, one shape from three spellings.
- manifest object form, manifest `"name": "string"` shorthand, and both forms in one action
- screen attribute form (`<action as="x" text="" limit="defaults.limit">`) folds to two untyped fields, defaults preserved
- server/CLI `inputs="a, b: expr"` folds to the same
- `_note` and every `_note*` key stripped from args, resolves and the action body
- `resolves` as a field map vs as a scalar type word → `kind:"fields"` vs `kind:"scalar"`
- no `resolves` → `kind:"unknown"`, which is not `kind:"void"`
- `optional:true` → `required:false`; `required="true"` → the same boolean
- an unknown type word is a build error, with the word in the message
- depth cap 5 exceeded → build error naming the path
- `completeness` is `untyped` for a nameless-types action and `typed` for a contract, on every residence

**`project.json`** — the PROJECTION law, one fold, every face.
- every type word of §5 → its JSON Schema, `int` → `integer`, `any` → `{}`
- `required` array present only when non-empty (matches the shipped `ServedCatalog` expectation exactly)
- `enum`, `default`, `description`, `nullable` → their JSON Schema spellings; `nullable` as a type array, never `anyOf`
- nested object and array-of-object, three levels
- **an untyped contract projects byte-identically to today's output** — the case that makes §7.12 a gate
- a `_note_status` key in a resolves block never appears in the output schema
- `mutates` → `readOnlyHint` derivation reads the ROW, not the contract
- declaration order preserved through every projection (determinism)

**`validate.json`** — the VALIDATION law.
- missing required → `invalid_param` naming the field; wrong type → the same, naming the expectation
- enum violation, min/max, minLength/maxLength, pattern, format
- `nullable` accepts an explicit null; a non-nullable optional absent is not a violation
- coercion rules: a numeric string at an HTTP entry is a `number`, and the same value in-app is not coerced twice
- an entry violation refuses before the body runs; an in-app violation records and continues
- an action with no contract validates nothing

**`evolve.json`** — the EVOLUTION law, extending `contract_diff.rb`'s existing rules to every
residence: add optional arg / widen / add output field = compatible; remove, retype, require, or
delete an output field = breaking; the document residence obeys the identical table.

Three runners each, the `webmcp` shape: TS per-PR, Kotlin `:core` per-PR, Swift through
`RecordMain.swift` in the record lane.

## 10 · Execution

| Wave | Deliverable | Gate |
|---|---|---|
| **W0** | The four corpus files + README + the pure reader/projector on all three renderers (`kernel/src/contract.ts`, `:core Contract.kt`, `Engine/iOS/Contract.swift`). No grammar, no consumer. | corpus green on TS + Kotlin; Swift in `RecordMain`; `generate_conformance_index.rb` shows three runtimes; `check_gate_coverage.rb` green |
| **W1** | Retire the defects with no new grammar: close the type vocabulary in `verify_module_tests.rb`, strip `_note*` from every projection, fan the module `args` into `McpMap`/`ToolsMap` and DELETE `Core/MCP`'s hardcoded `{"type":"object"}`, collapse `mcp-face.ts`'s private `inputSchema()` into the shared fold | every landed expectation unchanged (`webmcp`, `ai/mcp`, `mcp-apps`); `gradle :core:test`; `contract_diff.rb`; `check_swift_parse.rb --changed` |
| **W2** | Manifest grammar: `description`, `fields`, `of`, constraints, `nullable`; `Contracts.generated.json`; `CapabilityManifest` carries them | `verify_module_tests.rb`; manifest `--check` gates; `prepare_modules` ×2 no diff |
| **W3** | Document grammar: `<contract>` in `lint/facts.json` (`builtinTags`, `declTags`, `headRank` 2, `headOrderHint`), all three linters, `component.ts`, `server-document.ts`, `cli` head, Kotlin `StackNodeView`, Swift `StackHead` | `lint_dsx.rb --strict` 0/0; `lint_conformance.rb` 0 drift; `npm test`; `:core:test` |
| **W4** | Projections: WebMCP, `/mcp`, the device faces, the AI registry — all reading the one fold | the corpus, plus `packages/dom/oracle/webmcp-browser.ts` through a real `document.modelContext` |
| **W5** | Validation at entries (§8) + the error ledger path for in-app | `validate.json` live on three runners; `actions` corpus unchanged |
| **W6** | Studio: typed Tools panel, typed Try It controls, the contract skeleton one-click, contract rows through the surgery door | `edit.test.ts`; `studio-surfaces-browser.ts`; `studio-tryit-browser.ts` |
| **W7** | Evolution: `contract_diff.rb` reads `Contracts.generated.json`, so document contracts are gated like manifest ones | `evolve.json`; `contract_diff.rb --self-test` |

W0 and W1 are independently valuable and W1 ships the review's actual complaint for module-declared
tools without one new word of grammar.

## 11 · What does NOT change

- **No authored schema anywhere.** Not on `<tool>`, not in Studio, not in a manifest facet row.
- **Foreign schemas still pass through verbatim.** A page tool's or an MCP server's arbitrary JSON
  Schema is never down-converted into the §5 vocabulary. That law predates this proposal.
- **The shorthand stays forever.** `<action as="x" text="">` and `inputs="a, b"` are not deprecated,
  not warned about, and not scheduled for removal. `untyped` is a legal end state.
- **Descriptions stay untrusted.** A contract's description is data a model reads and never policy.
- **`mutates` stays on the exposure row.** Shape and policy are different planes.

## 12 · Decisions for the owner

1. **The element word.** `<contract>` (recommended — it is the word `contract_diff.rb` and
   `facet-contracts.md` already use) vs `<signature>` vs `<schema>` (rejected on connotation:
   the whole law is that there is no second schema).
2. **`<in>` recursion vs reusing `<field>`.** Recommended: `<in>`, because `<entity><field>` carries
   the storage vocabulary and one attribute must not front two closed type lists.
3. **Contract completeness.** Recommended: a `<contract>` is COMPLETE (every input described, or
   build error). The alternative — allow partial rows — makes `completeness` unreadable to a
   consumer and reintroduces the "is this the whole shape?" question the plane exists to answer.
4. **In-app validation enforcement.** Recommended: report-only in v1 (§8), promoted later on the
   ledger's evidence and through app config, never by framework fiat.
5. **`outputSchema` on the MCP faces.** Recommended: advertise only for `kind:"fields"` outputs
   whose declared tests already prove the shape — a promise a conformant client will check must be
   one the build has checked first.
6. **Declared failures in a face descriptor.** Recommended: not in v1 (§7.15). The IR carries them;
   no protocol gets an invented field.
