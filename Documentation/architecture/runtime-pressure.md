# Runtime pressure: what to do when the framework gets in your way

> **Owner-directed 2026-08-21.** Standing procedure, not a one-off. It exists because we are now
> building our own product on our own framework, so every limitation we hit, a customer hits too,
> and the temptation each time is to route around it locally and keep moving.

## The law

**When building on DSX blocks you, the bug is almost never that the kernel cannot do the thing.
The kernel is dynamic. The bug is that somewhere we decided too much on someone's behalf. Find
that decision and reopen it. Do not build a workaround around your own runtime.**

A workaround is not free and it is not local. It is a second, undocumented opinion about how the
runtime behaves, held by one caller, invisible to the next person, and untested. Ship three of
them and the runtime no longer has one behaviour; it has three, and nobody can say which is
correct.

## The procedure

Five questions, in order. Do not skip to the fifth.

**1 · What is the issue, in one sentence, as an observable?**
Not "the drain seam is awkward" but "a `<worker>` body cannot read the queue it was declared to
drain". If you cannot write it as something that is or is not true, you have not found it yet.

**2 · What is the issue behind the issue?**
The first statement is a symptom. Keep asking until you reach a DECISION someone made. Usually one
of these:
- a case that was never specified, silently absorbed by a rule written for a different case
- a closed vocabulary that should have been open, or an open one that grew a hardcoded member
- a capability that exists and is reachable by nothing (built, tested, never wired to a declaration)
- a shape fixed in a script or a host that belongs in a manifest, a document, or the kernel

**3 · Where did we limit too much?**
Name the file and the line. "The runtime is too strict" is not an answer. `callAction` applying one
input rule to two kinds of call is an answer.

**4 · What is the opening move, and is it still safe?**
Extend, do not special-case. Prefer, in this order: make the runtime model the real distinction →
add the declaration that was missing → add the seam that was missing → widen the vocabulary. A new
concept in the kernel is better than a new `if` in a host. **But less restrictive is not the same as
less safe:** the answer must keep every gate that was doing real work. If the opening also opens a
hole, it is the wrong opening.

**5 · Then implement it properly, everywhere.**
Corpus first, then all three renderers (the unified-codebase law is not suspended because you found
the problem while building something else). Then go back and DELETE the workarounds that existed
because of it, including the ones you wrote an hour ago. A fix that leaves the workarounds in place
has not fixed the category; it has added a fourth behaviour.

## What this is not

It is not licence to widen everything. A restriction that is doing real work — the JSE seam list,
the egress allowlist, the reserved-column check, the fail-closed release profile — is load-bearing,
and "it got in my way" is exactly what it is supposed to do. The test is whether the restriction is
**deciding something that is properly the author's**, or **preventing something that must not
happen**. Reopen the first. Never the second.

It is also not licence to skip the gates. The output of this procedure is corpus cases plus three
implementations plus deleted workarounds, not a quick kernel patch.

## What extending the kernel costs

"Extend the runtime" is the right instinct and it is not free: kernel bytes ship in every bundle,
including the self-contained embeds that live under a hard size law. R1 added ~40 bytes gzip and
moved four pinned censuses (`support/element-support.json` audio/video, the EmbedCard figure in
`OpenSource/Web/README.md`, and `support/public-api-v1.json`).

Those censuses are deliberately hardcoded so a landed feature cannot inflate a budget silently.
When one goes red:

1. **Confirm the law still holds.** A pin moving is routine; a BUDGET being exceeded is not, and it
   is not fixed by editing a number. After R1: EmbedCard 40,497 of 40,960 bytes, media 48,636 of
   50,176.
2. **Attribute the delta.** Name the change and check the magnitude is proportionate.
   `git diff --name-only` over the bundled packages is usually the whole proof.
3. **Measure on a clean build, with nothing else touching the tree.** Editing a source file while a
   measurement suite is building silently pins the wrong number — that happened during R1 and cost
   two rounds. Build, measure, pin, re-verify.
4. **Refresh the pin with the cause recorded**, never by pasting whatever the failure printed.

An API-surface pin (`public-api-v1.json`) is a separate question from a size pin: refresh it only
after proving the change is ADDITIVE. R1's was an optional parameter and a new exported interface,
so no existing caller could break; a removal or a narrowed signature would need a major release
instead.

**EmbedCard has 463 bytes of headroom.** The next kernel feature of R1's size takes most of it, so
the widget law is the first real constraint on kernel growth and should be treated as one.

## The ledger

Every application of this procedure gets a row. The point is the pattern, not the anecdotes.

### R1 · A declared input at an entry point bound null (2026-08-21)

**Symptom.** A `<server>` action declaring `inputs="title, total"` received `null` for both over
HTTP. Declaring the contract was strictly worse than omitting it.

**Behind it.** `ActionRunner.callAction` had ONE input-binding rule serving TWO different callers.
For a SURFACE call (another action, an `on:*` handler) a declared input is an expression evaluated
in the caller's scope, and `inputs="id: item.id"` is exactly right. For an ENTRY call (an HTTP
request, a CLI command, a queue message) there is no caller and no scope; the values come from
outside, and `inputs="message"` means "I accept a payload key by that name". Both readings are
correct. The entry case was never specified, so it fell through to the surface rule, evaluated
against an empty scope, and overwrote the host's payload with the absent sentinel.

**Where we limited too much.** `runner.ts callAction` — the unconditional
`scope[k] = evalBlock(expr, …) ?? NSNull`. Not a missing feature: a missing distinction.

**How we knew it was a category and not a bug.** Three hosts had already coped, each differently
and none of them documented as a workaround anywhere but in its own comment:
`cli/src/declared.ts` discarded declared inputs entirely (losing the contract, so a CLI command
could not have a declared default); the queue drain smuggled its message through the `callArgs`
plane (works only by argument precedence); `server/src/actions.ts` did neither and shipped the
nulls. The `<cli>` comment even claimed "the server does exactly this for the same reason" — it
did not, and that false claim is why the defect survived review.

**The opening.** `CallActionOptions.entry` — the runner now models the two kinds of call. At an
entry, a declared input the payload supplies binds the payload value; one the payload omits falls
back to its expression against the store, so a declared default still works; either way it is bound,
so a body never reads an unbound name. The entry reading applies to the entry frame only.

**Landed.** Corpus `Conformance/actions/actions.json` `entry-*` (6 cases, 5 of which fail against
the old rule) → TS `callAction(..., { entry: true })` → Kotlin `JSERunner.runAction` → Swift
`JSERunner.runAction`. All three workarounds deleted.

**What it cost to not have found it earlier.** Every backend and CLI author who declared their
inputs got nulls, and the framework's own documentation showed them doing it.

### R2 · A capability that nothing could declare (2026-08-21)

**Symptom.** The platform backend needed to receive a purchase webhook, so it grew a public POST
route with no signature verification.

**Behind it.** `server/src/webhook.ts` was already a complete, tested inbound boundary — HMAC over
raw bytes, clock window, replay defence through the queue's UNIQUE key. Nothing constructed a source
from a declaration and no route dispatched to one, so it was reachable by nothing. A plane nobody
can declare is a plane nobody uses, and the author writes the five silent failures themselves.

**Where we limited too much.** The `<server>` document grammar had no `<webhook>` tag, and
`prepare_server.rb` had no facet to read. The capability existed; the way to ASK for it did not.

**The opening.** `<webhook>` as a body tag, generating the receiver — the shape (POST, raw body, no
auth, a mandatory rate) is fixed because none of it is a decision an author should be able to get
wrong, and what the author decides (source, queue, secrets, path) is what the row carries.

**Also.** A declared body could `push` to a queue and had no way to READ one, so a `<worker>`
authored in DSX could not do its job. Same category: `dsx.module.queue.<q>.drain({ action })`.

### R3 · OPEN — a declaration cannot express a runtime-configured source (found 2026-08-21)

**Filed, not fixed.** Recorded here because the procedure says a row goes in when the issue is
found, and because the wrong fix is tempting.

While deleting the workarounds R2 created, the sweep found a fourth hand-written receiver:
`Core/Server/Modules/Http`'s `web/server/index.ts` exports a TypeScript `receiveWebhook` behind a
`/webhooks/:source` route. It looks exactly like the per-app copy `<webhook>` exists to eliminate,
and step 5 says delete it.

**It should not be deleted.** It does something the declaration cannot: sources are configured at
DEPLOY time from `DSX_WEBHOOK_SECRETS` (`name=secret` pairs), so an operator adds a sender by
setting an environment variable, with no rebuild. A `<webhook>` row is static by construction.
Deleting it would remove capability, which is the opposite of what this document asks for — "less
restrictive and more dynamic" cuts both ways, and a declaration that is less dynamic than the code
it replaces has not earned the replacement.

The security-critical half is already shared: it calls the same `receiveWebhook` verifier, so only
configuration parsing is duplicated. That bounds the drift risk to which secrets a source has, not
to how a signature is checked.

**What would close it.** A declared form for a dynamic source set — a `<webhook>` whose sources
resolve from a declared secret at boot rather than from the row. Until then the two shapes coexist
on purpose, and this row is why.

### R4 · The web build dropped `dsx.const` entirely (2026-08-21)

**Symptom.** A dashboard screen built its API base from `{{ dsx.const.platformApi }}`. The
interpolation resolved to empty, the URL collapsed to the relative `/apps`, and the request went
to the SITE's own origin instead of the API. Nothing errored: the page rendered a plausible
"couldn't load" state, and the misdirected request was only visible in a proxy log.

**Behind it.** `boot.ts` has always accepted a `consts` seed and `export.ts` has always read
`App.json` for the native export. The WEB build never read it, so `dsx.const.*` was permanently
empty in anything `despia build` produced. One consumer of App.json was wired and the other was
not. It fails silently by design interaction: an absent const is typed-null by law (correct, so
that it does not gate a request), which is exactly what makes a hole in a URL invisible.

**Where we limited too much.** `cli/src/build.ts`'s bootloader emission, which passed `app` and
not `consts`.

**Landed.** `readConsts` in `cli/src/config.ts` reads `App.json` `consts` with a
`dsx.config.json` override for local builds, and the bootloader carries them. Flat scalars only:
the plane is read into interpolations, so a nested object would stringify into a URL.

### R5 · A keyed list row rendered stale data one component deep (2026-08-21, fixed 2026-08-22)

**The symptom, as originally filed.** A `<list bind="appList" key="id">` and a
`<variable computed>` over the SAME array disagreed after a row's field changed in place: an app
converted from `web` to `native`, the stat tiles derived from `appList` correctly read
"Projects 3 / Wrapped 0", and the list row for that very app still rendered "Wrapped". Timing was
ruled out (the refetch was confirmed in the request log), and so was a stale source array (the
tiles read the same array and were right).

**What actually found it.** The same expression, written twice in one row:

```
<text value="OUTSIDE={{ item.mode }}"/>          ->  native   (correct)
<Card><text value="PLAIN={{ item.mode }}"/></Card>  ->  web      (stale)
```

Live and stale data side by side in one row. The first filing said "a plain `<text>` beside the
component is EQUALLY stale" — that reading was wrong; the plain text had been inside the
component's slot too.

**Behind it.** `refreshRow` re-pointed `row.ctx.item` at a freshly built overlay and fired the
row's invalidation listeners. Re-pointing reaches exactly one holder: the context object it
assigns to. Every other reader holds a **copy** — `{...ctx}` is how an element scope, a slot
mount and a component's props all descend — and a copy had frozen `item` at the value it had when
the row mounted. The listeners fired; they read a dead object.

**Where we limited too much.** We modelled a row's item as *a new object per reconciliation*.
But a keyed row keeps its DOM identity while its data changes underneath it — that is what a key
MEANS — and its item view has to keep its identity for exactly the same reason. Chasing every
spread site is not reachable (a spread is a value copy by definition), so the identity stops
moving instead.

**The fix.** `collectionItem` returns one overlay for the row's lifetime, backed by a mutable
cell the reconciler updates; `refreshRow` no longer takes an item at all. Every holder, however
it was copied, reads through to live data. Web only: the native renderers pass `item` down the
view tree by value on each render, so neither can express the defect.

**Two things it dragged out with it.**
- The store's dedupe compared the past to the present while holding only a *reference*, so it
  re-derived the "previous" key from a value that had since moved and elided the write. A live
  view handed to a component as a prop therefore stopped notifying the child. `ReactiveStore`
  now remembers each var's watch key as written. (A first write still fingerprints nothing —
  there is nothing to compare against, and a hostile row object throws on enumeration.)
- `watchKey` recursed forever on cyclic data, so a self-referencing value did not render wrong,
  it overflowed the stack on the WRITE. Now cycle-safe, byte-identical for acyclic input.

**Gates.** `packages/dom/test/composition.test.ts` (the two-bindings-one-row shape, index
liveness, the typed live prop), `packages/kernel/test/composition-conformance.test.ts` (the
`watchKey` cycle cases).

### R6 · A component could not receive structured data (found 2026-08-22, fixed 2026-08-22)

**Symptom, as measured in a browser against a real build.** A component attribute was ALWAYS a
string:

```
<ObjProbe node="{{ obj }}"/>   ->  typeof dsx.attribute.node === "string",  .label === ""
```

No error, no warning, no lint finding. A 40-deep recursive tree component compiled, mounted,
recursed and rendered forty-one blank rows.

**Behind it.** Attributes were a TEXT plane. The renderer already had a value plane beside it —
`disabled-if` binds a value where `disabled` binds text, `<api>` expressions evaluate to values,
and the module-facet component path had ALREADY made this exact decision correctly and privately
(`mountFacet` evaluated a sole hole and interpolated everything else). So the two kinds of
component disagreed about what a prop is, and the machinery for the right answer was already in
the file, five hundred lines above the wrong one.

**What it cost, which was more than a tree.** A component that takes DATA could not exist: no row
component, no chart series, no node, no record. Every data-driven component worked around it by
reading `item` from an enclosing `<list>` through ambient scope, which means it only functions
inside a list that happens to provide it, cannot be composed, and cannot recurse. A ceiling on
the component model, not a missing convenience.

**Where we limited too much.** The component attribute plane in each renderer, and the grammar
line that says an attribute value is a string.

**The fix — option (1) of the two that were filed**, promoted from a private decision to a law:
an attribute whose trimmed template is exactly one `{{ … }}` binds the VALUE; anything mixed
stays a sentence; anything with no hole is its own text. No new grammar and no new spelling to
learn, because it is what an author already writes. Option (2) — an explicit `-bound` suffix —
was rejected: it would have made the facet path and the `.dsx` path *permanently* different, and
"one more thing to learn" is the cost that never stops being paid.

The fold is `attributeBinding` in all three kernels, corpus-gated by
`Conformance/composition/attribute-binding.json` (TS + Kotlin per-PR, Swift on the record lane).
The compatibility sweep the filing worried about — `count="{{ n }}"` becoming a number — is
covered by the corpus's typed table and the full suite; nothing depended on the coercion.

**The recursion floor came with it.** With structure crossing the boundary, a component that
names itself became a real shape, so the guard had to be real too. The web renderer had **none**
(a self-reference hung the tab); Kotlin and Swift capped at 32, a number guessed before anything
recursive shipped, which caps real trees. All three are now `256`, pinned by the corpus's
`recursion` block, and the floor is documented as what it is: a corrupt-data backstop, not a
budget. Legitimate nesting must never reach it.

### R7 · The editor was a shell over four endpoints that did not exist (2026-08-22)

**Symptom.** The editor rendered: a rail, a tree pane, an inspector, a canvas. Every panel sat
in its empty state and stayed there. The tree said "Open a document to see its tree", the
inspector said "Select an element", and both were telling the truth about a screen where
nothing could ever be selected — the documents called `/edit/api/tree`, `/edit/api/node` and
`/edit/api/edit`, and the server answered 404 to all three. `/edit` itself still served
`editorPage()`, a hand-written HTML string with inline CSS, which M1 names by file and line as
the thing to replace.

**Behind it.** An empty state and a broken endpoint render identically. That is the whole
defect: a panel fed by a 404 looks exactly like a panel fed by an empty document, so the
screen reviewed clean, screenshotted clean, and had no test that could tell the difference
because each SIDE was tested — the surgery engine had 33 passing cases, the document API had
its own — and nothing exercised the seam between them.

**Where we limited too much.** Nowhere, this time: nothing was over-restricted, the work was
simply not finished and looked finished. Recorded here anyway, because the ledger's purpose is
the CATEGORY, and this category — *a surface whose failure mode is indistinguishable from its
empty state* — is the one that survives every gate we own.

**Landed.** The three structural endpoints, backed by the surgery engine (tree rows addressed
by a dotted path that is also the edit target; node attributes with `style` split for the
property panel; one edit or a batch, resolved against the original source). `despia edit` now
compiles the editor's own `.dsx` documents with `buildProject` and serves that — the same
documents the hosted studio runs and the same ones the M6 gate edits.

**The gate that would have caught it, and now does.**
`packages/dom/oracle/editor-browser.ts` drives the real loop in Chromium against a real
temporary project: open, list, open a document, read the tree, select an element, retype a
property, and then assert THE FILE ON DISK. The last step is the point — a visual gesture that
does not reach the bytes is a mockup however well it renders — and page-console noise is a
failure, because a 404 behind a panel shows up there and nowhere else.

**Two smaller things it surfaced.**
- `<textfield value="…">` is inert on every renderer: an input reads `bind=`, and `value=` is
  the spelling for what a `<text>`/`<image>`/`<progress>` shows, so it parses, renders an empty
  field and reports nothing. The inspector was a column of blank boxes beside attributes that
  all had values. This is NOT a runtime gap — `bind` is path-aware down to the current row, so
  `bind="item.value"` was always the answer — so the fix is a lint rule, not a language change:
  `input-value-inert`, in facts.json and all three linters.
- `null` and `""` were the same "nothing selected" in the editor's own state. They cannot be:
  the empty string is the ROOT element's address, and the inspector interpolates the selection
  into a URL, where a null gates the request and an empty string is a present value. Collapsing
  them either fires a pointless request or makes the root unselectable.

### R8 · Three ways the markup could do nothing and say nothing (2026-08-22)

**Symptom.** Building the canvas (`ClosedSource/DSX/Modules/Custom/Editor/Components/EditorCanvas.dsx`)
hit the same failure three times in one afternoon: the markup was accepted, the screen rendered,
and the feature was absent with no diagnostic anywhere.

1. `data-state="{{ … }}"` on an element. No renderer forwards an authored `data-*`, so the
   sheet rule keyed on it never matched and every node drew in its rest state. The editor's
   tree and rail had shipped with the same bug — `data-selected` — so the selected row had
   never highlighted, and nobody could see that because a row that is not highlighted looks
   like a row that is not selected.
2. `for (const edge of map.edges)` inside a `<variable computed>`. The body is a VALUE and the
   kernel evaluates it branch-only, so it always terminates (`JSE.evalBlock`: "no `for`/`while`").
   The loop did not error. It did not run. The variable held whatever the statements before it
   produced, which was a plausible wrong answer: an empty trace, an empty command list.
3. `commands="{{ edgeCommands }}"` on `<canvas>`. `commands` is a BARE expression attribute —
   the renderer evaluates the raw string through `bindValue` — so the braces read as a dict
   literal and the canvas replayed nothing. A canvas that draws nothing is a canvas.

**Behind it.** Each restriction is CORRECT and none should be lifted. Dropping authored
`data-*` is right: a sheet keyed on an attribute selector would work on web and silently do
nothing on the native twins, which is the divergence the unified-codebase law exists to
prevent, and the runtime already ships the portable spelling (a class formula,
`class="row {{ on ? 'row-on' : 'row-off' }}"`). Branch-only computed bodies are right: a
computed re-runs on every store publish, and an unbounded loop there is a hung frame — the
array builtins cover the folds, and an `<action>` is where iteration belongs. Bare expression
attributes are right: they take a value, not a string with a hole in it.

**Where we limited too much.** Not in the restrictions — in the SILENCE. Every one of the three
is a rule the runtime knows and the author cannot see, and all three fail into a rendered
screen. That is the R7 category again: a surface whose failure mode is indistinguishable from
its empty state.

**Landed.** Three lint rules, in both linters, with `bareExpressionAttrs` added to
`OpenSource/Conformance/lint/facts.json` as the shared table:

- an authored `data-*` attribute is an ERROR, and the message carries the class-formula spelling;
- `for`/`while` in a `<variable>`/`<formula>` body is an ERROR that says the loop never runs and
  names the alternatives (an `<action>` body is untouched — there the loop is real);
- a `{{ }}` wrapper on a bare-expression attribute is an ERROR, generalising the `visible-if`
  brace rule that already existed on one linter to `bind` · `commands` · `a11yChildren` and
  adding it to the other, which did not have it at all.

**Also found, and fixed, on the way.**
- The two linters had drifted: `lint_dsx.rb`'s `JSE_ROOTS` was missing `dsx.const`, `dsx.source`
  and `dsx.input` — real store-alias roots the resolver folds onto the global plane — so it
  warned on grammar the TS twin accepts and the kernel executes.
- An ancestor with `on:drag` captures the pointer on press, and a captured pointer retargets
  the click that follows, so a pan surface WRAPPING the nodes made every node unclickable. The
  map's pan layer is a sibling behind the nodes instead, which is also what
  `v4-launch/platform/02-canvas.md` §5 asks for: you pan the canvas, and nothing on the map
  moves.
- `.dsx-canvas` is `max-inline-size: 100%`, so a canvas sized by attribute inside a zero-size
  positioning anchor collapses to one pixel wide and draws nothing. The edge layer fills a
  sized box instead of carrying its own width.

### R9 · An attribute a head declaration does not know is dropped in silence (2026-08-22)

**Symptom.** Building the logic canvas I wrote `<api as="drawing" gate="body != null" url="…"/>`,
because gating a request on a selection is an obvious thing to want. There is no `gate`
attribute. The block accepted it, dropped it, and fired the request with a hole in its URL. No
error, no warning, and the panel rendered its empty state.

**Behind it.** The runtime was already right: an `<api>` block never fires with an unresolved
hole in its inputs, so `?body={{ body }}` with a null `body` gates itself. The feature I reached
for exists, spelled differently, and I could not see that from the markup I had written. Every
head declaration has a real attribute vocabulary and none of them is enforced, so a typo
(`urls=`), a wrong spelling (`gate=`) and an attribute that belongs on a different tag all land
the same way: accepted, ignored, invisible.

**Where we limited too much.** Nowhere in the runtime. This is R8's category one more time, on
a new surface: the rule exists, the author cannot see it, and the failure renders. Worth its own
row because it was found by walking straight into it an hour after writing R8, which is the
strongest evidence available that the category is not exhausted.

**LANDED (2026-08-22) as the attribute census.** The enumeration problem dissolved once the
census stopped being a new list and became the lists the repo already gates: per-element
vocabulary from `stack-elements.json` (the element-census reference), the style catalog
(`stack-style-properties.json` - every style key is a legal direct attribute), and the harness
vocabulary (`facts.json` `harnessAttrs`). Three runners enforce it (lint_dsx.rb in CI, the
shipped `dsx lint`, the compiler's dev-loop linter), tethered by the shared corpus fixture
`cases/shared/attribute-census.dsx`. Severity is by confidence: a known confusion
(`<button value=>` - the element spells it `label=`) or a levenshtein near-miss of a real word
is an ERROR; any other unknown is a NOTICE naming the census, so a genuinely new word is landed
rather than silenced. Head grammar and the extension dialects (watch, Live Activity markup in
JSE strings) are scoped out - their vocabularies are their own.

### R10 · Two tools decided a document's KIND by substring, and a comment flipped it (2026-08-22)

**Symptom.** I wrote a comment in the Studio's shell explaining why the inspector is hidden for
a `<server>` document. Two things immediately misread the file:

- `lint_dsx.rb` routed `Editor.dsx` to the SERVER reader and reported "the root element must be
  `<server>`, found `<stack>`" — a component file failing a rule about a kind it is not, with an
  error message that gives the reader no way to see what actually happened.
- `screengraph.ts` classified it as a `server` node, so the Studio's own map drew its shell as a
  backend. On the one surface whose entire claim is that it never invents anything.

Both tested `/<server\b/` against the raw bytes. A document that MENTIONS the tag is not a
document that IS one.

**Behind it.** Neither tool was wrong about wanting to know the kind; both were wrong about how
cheap the question is. A kind is decided by the ROOT ELEMENT, and the root element is one regex
away once comments are blanked — the linter already had `strip_comments` for exactly this reason
and did not use it here. The substring test is the shortcut that works on every document anybody
had written until one of them wrote about the other kind.

**Where we limited too much.** Nowhere; this is a correctness bug in two places, recorded because
of what it says about the CLASS. Both tools are DERIVERS — one decides which rules apply, the
other decides what a node is on a map — and a deriver that is approximately right produces a
confident wrong answer rather than a visible failure. R7, R8 and R9 were all "the rule is
invisible"; this one is "the derivation is approximate", and it is the same outcome: a surface
that looks like it is working.

**Landed.** Both now blank comments and anchor at the start of the document
(`/^\s*(?:<\?[^>]*\?>\s*)?<server[\s>]/`). `screengraph.test.ts` pins it with the exact case
that found it: a component whose comment names the tag stays a `route`, and a real `<server>`
document beside it stays a `server`. The TS residence-based detection (`server/` directory) never
had the bug and is untouched.

### R11 · A local assigned null is not null, and the guard cannot tell (2026-08-22)

**Symptom.** Rebuilding the Studio to its design sheet, the logic canvas drew its escape arrows
as diagonal slashes across the whole drawing, with the pills stacked at the origin. The
computed built a lookup with `const to = jump.to == null ? null : boxes.find(...)` and branched
on `to == null` - and the guard took the WRONG branch, every time, silently.

Measured, in isolation (`JSE.evalBlock`):

- `const to = null; return to == null` → **false**. A local ASSIGNED null holds the boxed
  sentinel (`{__nsnull: true}`), and `== null` on the boxed value does not unwrap it. Reading
  the SOURCE value directly (`jump.to == null`) answers true, so the same test is right or
  wrong depending on whether a `const` sat in between.
- `const x = null; return x + 24` → **"<null>24"**. Arithmetic on the boxed null degrades to
  string concatenation, so every coordinate downstream became a string and the canvas recorder
  drew from garbage.
- `name.split('/').pop()` → **null**. `pop` is an action-side mutation verb, not an expression
  builtin, so the navigator rendered `<null>` for every document label. Same family: accepted,
  evaluated, wrong, silent.
- `reduce((m, box) => { m[box.id] = box; return m }, {})` → `{}`. A computed-key write inside a
  lambda lands in a throwaway scope, so a reduce-built lookup map stays empty and everything
  keyed off it is skipped without a diagnostic.

**Behind it.** The null-boxing is a real runtime seam, not an authoring error: the store boxes
null so that typed absence survives the reactive plane, and the equality operator was never
taught to unwrap it for locals. The other three are the R8 category again - expression-side
grammar that accepts a spelling and silently does nothing with it.

**LANDED (2026-08-22), three of the four, corpus-first on all three runners.** The null law:
the scope sentinel reads as null in `equals`, and null equals ONLY null (`x == null` is the
guard it always should have been; `null == ''` flipped to false with the corpus pin) - and
because includes/indexOf/switch/Map/Set all ride the one `equals`, they inherit it
(jse/core-002). `pop`/`shift` are expression builtins now, as PURE reads - last/first element
out, receiver untouched, the toReversed family's law on value-typed runtimes (jse/stdlib-002).
And the classic-for trap died with the AUTHORED LOCALS law (actions corpus): a declared name
(const/let/var, loop var, catch var) is an authored local and assignment writes the LOCAL, so
`for (let i = 0; i < n; i++)` counts in its own counter on every runtime; undeclared names keep
the store-always contract, so an entry-payload key still cannot shadow a store write. TS + Kotlin
verified locally; Swift written and parse-gated, compile rides the record lane, which will
re-authoritate the corpus.

The fourth landed as BLOCK-SCOPE MUTATION (jse/core-003, all three runners + the TS compiled
tier): dotted, computed-key and indexed assignment into a scope name, compound assignment,
++/--, and statement-position `.push(…)` all REBUILD the local by copy - no reference boxes,
so value semantics hold by construction (an assignment through a second name never aliases
the first, pinned by value-semantics-boundary) and the reduce-accumulator idiom is real
(`reduce((m, box) => { m[box.id] = box; return m }, {})` builds the map). Writes stay in the
block scope, never the store - the evalBlock purity contract, unchanged. The Studio's last
spelled-around site (`parts[parts.length - 1]`) is deleted.

And the branch-only block died with it: expression blocks run the FULL LOOP GRAMMAR
(jse/core-004) - classic for with the authored-locals law, for..of, for..in, while,
do..while, break/continue - BUDGETED (one shared 10000-iteration ledger per block
evaluation), so a computed body stays total while `for (let i = 0; i < n; i++)` finally
means the same thing in a variable body as in an action body. The lint rule that flagged
the loop as "never runs" is retired on both runners - the restriction it guarded fell.
Embed cost is paid the doctrinal way: the whole subsystem is an optional fold
(`__DSX_OPTIONAL_BLOCK_ITERATION__`) that a static embed slice sheds, keeping EmbedCard
under the G10 widget law with the gates reading the flag inline so the impl DCEs.

### R12 · `container` froze every attribute below it (2026-08-22)

**Symptom.** Flow (the open flow-canvas library) computes its fitted zoom from
`dsx.attribute.contentWidth`, and the consumer binds that attribute to an api-fed computed
(`contentWidth="{{ logicDraw.width + 96 }}"`). The slot content redrew the moment the api
landed; the viewport stayed fitted to the pre-fetch extent forever. Same store, same tick, one
half live and one half frozen.

**Behind it.** In a component body, `ctx.item` IS the instance's attrs object, and the
consumer-side reactive-prop effects mutate that object in place - liveness by reference is the
web renderer's contract. The `container=` word layered `dsx.element.*` onto the local scope
with `{ ...(ctx.item ?? {}), __element }`: a shallow SNAPSHOT. Every descendant of a container
element read attributes out of the stale copy, which answered first, so the store fallback
(which is live) never fired. The decision taken on the author's behalf: that the local item
scope may be copied at mount. It may not - it is a live view, and copying it is deciding when
the author's data stops updating.

**Landed.** `mountElementFactory` now layers `__element` over a prototype chain
(`Object.create(ctx.item)`), so attribute reads fall through to the live object and only the
element scope is owned. Regression gate: composition.test.ts "a reactive prop stays live below
a container element". Found the day Flow shipped a `container="true"` root - the first
component whose ROOT both declared a container and computed from its own attributes.

### R13 · A component's state was everyone's state, except on the web (2026-08-22)

**Symptom.** The same `.dsx` component behaved differently by platform: on the web each
instance held its own counters, `<api>` envelopes and computed state (`instantiate` builds
a store per instance); on iOS, Android and desktop every instance's head declarations
landed in the CONSUMER's store, first-declaration-wins - so two instances of one component
shared one `n`, a second sibling's `<api as="data">` silently never fired, and the
authoring culture grew defensive prefixes (`bannerTint`, not `tint`) to keep components
from treading on their consumers. One grammar, two state models.

**Behind it.** The native renderers mounted a component template against the surface store
because that is what the pre-component head walk already did, and prefixing made it
tolerable. The decision taken on the author's behalf: that a component's names are global
to the surface. The web renderer never took it, which is how the divergence shipped -
every component that worked on the web was already living within isolation, so the shared
model was pure downside: collisions and swallowed `<api>` blocks that reproduced only on
native.

**LANDED as the instance-store law** (`composition/README.md` "The instance store"): every
renderer mounts a component instance against a store born with it. Kotlin `:render` and
Compose Desktop create the per-instance `StackStore` at the component branch (desktop's
`prepareDesktopDocument` no longer walks component templates into the document store);
Swift mounts through `StackComponentInstanceHost` (`@StateObject` owns the store's
lifetime). Slot content keeps the CONSUMER's scope and store on every renderer - it is the
consumer's markup. The web behavior is unchanged and now pinned
(`composition.test.ts`: independent instance state, no leak into the consumer store, slot
binds in the caller's store). The rule-9 prefixing guidance is retired
(dsx-best-practices.md); Kotlin compiles locally, Swift is parse-gated with compile riding
the mac lanes.

### R14 · The dashboard build: three small decisions the page could not see (2026-08-22)

**Symptom.** Verifying the repaired grammar by building the Atlas Analytics dashboard (the
complex-dashboard proof, demo route `/dashboard`), three element behaviors surfaced the same
way R8/R9 did - by walking into them:

- `<chart style="height: 40px">` rendered ~200px tall: the svg carried an INLINE
  `min-height:180px`, so an authored sparkline height was silently overridden. The floor
  belongs to the THEME DEFAULT (`.dsx-chart` min-height), where an authored height can win -
  landed that way; unstyled charts keep the same 180px.
- `(1245).toLocaleString('en-US')` was null: only Date dicts implemented it, so grouped
  currency - dashboard vocabulary - died silently. Landed as a NUMBER builtin on all three
  runtimes: deterministic en-US-style thousands grouping over the JSE string, hand-rolled so
  no platform locale can split the renderers (corpus stdlib-002).
- `<segmented options="rangeOptions">` rendered one pill spelling the variable's name:
  `options=` is the comma-separated TEXT form and bound rows ride `optionsKey=` - correct
  and documented, kept as-is; the dashboard uses the right spelling.

**The verification itself** (the point of the exercise): the page runs classic-for series
building, reduce-accumulator rollups with computed keys, `== null` guards on search/range,
pure `.pop()`/`.shift()` reads, isolated StatCard instances, and the v2 token skin
(light/dark, phone/desktop) - one file, browser-oracle screenshots as evidence.

**Second pass (the design polish, same day)** - two more decisions the page could not see,
both still open as runtime work:

- `<progress value="{{ item.share }}"/>` filled 0% with no error: `value=` on a value-bound
  element is a BINDING EXPRESSION (`value="item.share"` works in row scope), but a moustache
  spelling - the one every text attribute accepts - silently numbers to 0. The decision made
  on the author's behalf: which attributes template and which bind is invisible at the call
  site. Candidate fixes: teach `bindValue` to template moustaches (they produce "0.259",
  `number()` already parses it), or extend the existing input-`value=` lint to flag moustache
  on binding attributes. UNRESOLVED - workaround-free spelling exists, but the silence is the
  bug.
- `align="center"` on a stack emits an alignment CLASS that outranks an app sheet's
  `justify-content` on the same element, so a sheet-owned row layout silently re-centers.
  The rule (already in the skills): alignment belongs to EITHER the markup OR the sheet,
  never both - but nothing enforces it. Candidate fix: lint when a `.dsx`'s class also
  appears in a sheet rule that sets flex alignment while the element carries `align=`.

### R15 · OPEN — `try` in an expression block aborts the whole body to null, silently (found 2026-08-23)

**Symptom.** Building the sample-value plane (master plan P3), the State view's precedence
computed wrapped `JSON.parse` in the browser-JS idiom - `try { sv = JSON.parse(b.sample) }
catch (e) { ok = false }` - and every sample pill rendered `null`. Measured, in isolation
(`JSE.evalBlock`):

- `let x = 1; try { x = 2 } catch (e) { x = 3 } return x` → **null**. Not 2, not 1 - the
  whole body abandons at the unknown statement and answers null with no diagnostic.
- `try { return JSON.parse("5") } catch (e) { return "threw" }` → **null**. Same.
- The SAME spelling in an `<action>` body works: the statement runner (runner.ts tryStmt)
  carries try/catch/finally with the R11 catch-var law. The grammar split is between the
  two executors of one language.

**Behind it.** R11's closing law said expression blocks run the FULL statement grammar so a
body means the same thing in a `<variable>` as in an `<action>` - and try/catch is the one
statement family the block grammar never learned. The failure mode is the R8 category at
its worst: accepted spelling, zero diagnostics, and the abandonment takes the WHOLE body's
earlier statements with it (the `let x = 1` above is lost too, so the symptom appears far
from the cause).

**The pressure, named.** Nothing DECIDED this - it is an unfinished grammar, not a
load-bearing restriction. Fix: the block grammar learns try/catch/finally, corpus-first
(a jse/core-005 fixture: assignment visibility inside try, catch-var binding per R11,
finally ordering, throw propagation out of a block), TS + Kotlin per-PR, Swift on the
record lane. Until it lands, the interim truth keeps authors safe WITHOUT the statement:
the JSE stdlib is TOTAL by design - errors are values - so `JSON.parse` returns null on
malformed input and never throws; a computed never NEEDS try for stdlib calls. The Studio's
own computed now says exactly that instead of the idiom (EditorState.dsx), and that
spelling is the recommended one even after try lands.

### R16 · The dev state door decided "state" meant only the active screen (2026-08-23)

**The symptom.** The Studio's preview locale switch (P12) writes `global.locale` through the
one existing write lane - the SSE `state` event into the page's `__DSX_STATE__.set` - and
nothing happened: the door wrote a SCREEN VARIABLE named `global.locale` on the top frame
instead of touching the app-wide store, so the strings seam never saw the write.

**The decision behind it.** `devSetState` was built for the data-store panel, whose rows are
the active screen's variables, and it quietly encoded that scope as the door's whole reach.
But the door's job is "the studio writes one piece of app state"; which PLANE a name lives on
is the author's spelling (`global.` is already the app-wide prefix everywhere else - the
runner's writePath keeps exactly this split). The door was deciding on the caller's behalf.

**The fix (landed, not a workaround).** `devSetState` now routes a `global.*` name to
`DSXState` and everything else to the active screen's store - the same split the runner
keeps. The locale switch became one ordinary door write; no bespoke locale channel exists,
which is the workaround this row prevented.

### R17 · A horizontal list answered `grow` on the author's behalf, with "no" (2026-08-24)

**The symptom.** The Studio's strings table lays its language columns out as a horizontal
`<list>` whose item carries `grow="width"` - the same spelling that divides a row everywhere
else in the grammar. Measured: the list resolved to its full 384px, and the well inside it
stayed at 165px. So the column header rule ran the width of the table and the cells under it
stopped less than half way, and no column had an edge. The natural workaround - a component
sheet re-growing `.dsx-row` behind the kernel's back - is a second opinion about layout held
by one caller and tested by nobody, which is why it is not the fix.

**The decision behind it.** `.dsx-list[data-dsx-axis="horizontal"] > .dsx-row { flex: 0 0 auto }`
was written for the case a horizontal list usually IS: a scroller of chips or cards, where
content sizing is right and growing is wrong. Then it applied that to every horizontal list
ever authored. But the row wrapper is the kernel's own box - the author never sees it - and
`grow="width"` on the item is the author saying "these are columns, divide the width". The
list was overruling an instruction it had already been given, in a box the author cannot reach.

**The fix (landed).** The item grows exactly when it asked to:
`> .dsx-row > [data-dsx-grow="width"|"true"] { flex: 1 1 0; align-self: auto; min-width: 0 }`
(`packages/dom/src/structural-controls.ts`). A strict widening - nothing that content-sized
before content-sizes differently now - and the Studio's workaround was deleted in the same
commit.

**Correction (same day).** The rule first landed on `.dsx-row` itself, via
`:has(> [data-dsx-grow])`. A collection row is `display: contents`, so every flex declaration
on it is inert and the fix did nothing; the item stayed at 165 of 384 and the measurement that
was supposed to prove the fix was never re-taken. Two lessons, both cheap: a declaration on a
`display: contents` box is a comment, and in a ROW container `grow="width"` is a main-axis
instruction (`flex-grow`), not the cross-axis `align-self: stretch` that the generic
`.dsx-row > [data-dsx-grow]` rule gives it. The geometry oracle now carries an `inert-grow`
check so a growth with nothing to grow into is a finding rather than a screenshot nobody read.

### R18 · A canvas measured itself after the zoom, and drew itself at a fraction of its size (2026-08-24)

**The workaround that gave it away.** The logic editor's wires were "broken": short floating
segments that did not reach their nodes, missing arrowheads, and at 35% zoom no wires at all.
Every instinct said the layout was emitting bad polylines. It was not. Measured, all ten edges
in the reference flow start exactly on their source node's bottom edge and end exactly on their
target's top edge, to the unit, and every connector's box exactly contains its own path.

**The decision behind it.** `canvas.ts` sized the backing store from
`host.getBoundingClientRect()`. That is the COMPOSITED rect: every ancestor `transform: scale()`
folded in. A canvas inside a world at 0.53 therefore asked for a 53% backing store, had its own
CSS width overwritten with that shrunken number, and was then handed a display list authored in
untransformed units. Everything past 53% of each axis fell off the bitmap. The arrowhead, being
the last op in the list, was never drawn at all. The adapter had answered "how big am I?" with
"how big do I look from here?", on the author's behalf, and there was no way for an author to
say otherwise.

Two further consequences of the same decision: the raster factor was `devicePixelRatio` alone,
so a wire in a world magnified 2x was an upscaled bitmap; and `ResizeObserver` watches the
LAYOUT box, which an ancestor transform never changes, so a zoom scheduled no repaint and the
error was frozen at whatever the first paint produced.

**What we extended.** The size question and the resolution question are different questions.
`offsetWidth` is the layout box and is transform-independent, so it answers the first; the ratio
`getBoundingClientRect().width / offsetWidth` recovers the accumulated CSS scale exactly and
answers the second. The surface is now sized from the layout box and rasterised at
`devicePixelRatio * accumulatedScale`, and the ceiling moved from 3 to 8 so a magnified world
can still ask for the samples it needs.

**What we deleted.** Nothing yet in the Studio - the wires were always correct, so there was no
workaround to remove. What this retires is the class: every `<canvas>` in a zoomable or scaled
container was drawing a fraction of itself, and the flow editor was simply the first surface
big enough to notice.

**Still open.** The raster-lags-the-zoom half of this is CLOSED by R21: the renderer now
announces a transform write and the surface re-reads its own scale. The geometry was already
correct at every zoom because the surface's CSS size now matches its layout box and scales with the transform like any other element. There is
no conformance coverage for surface sizing, dpr, or ancestor transforms - `Conformance/canvas/`
covers a11y, display lists, fill rule, frames, gradients, paths, tier 2 and transform, and says
nothing about any of this. The browser adapter owns it uniquely and untested.

### R19 · A `disabled` bound to a boolean is disabled forever, on every renderer (2026-08-24)

**The workaround that gave it away.** There was no workaround, because nobody could see it.
`disabled="{{ !writable }}"` on a textarea, and the field was dead. The markup reads exactly
like what the author meant. It had been found once before, in the platform pane's reveal
button, fixed there, and written up in a five-line comment beside the fix - and then written
again in five shipped Foundation components, a generated demo screen, a sample document, and
the logic editor's own code surface. Eight sites, all shipped, all inert.

**The decision behind it.** `disabled=` binds as TEXT, and the kernel's `truthy` follows JS
string rules: a non-empty string is TRUE, so the four characters `false` are true. The runtime
also implements `disabled-if=`, which binds the VALUE and is correct, on all three renderers -
and did not appear in the element census, so nothing taught it to anyone. The runtime had two
spellings, one that works and one that silently does not, and told an author about neither.

**What we extended.** `disabled-if` is now a censused attribute on all 21 elements that carry
`disabled`, with a note saying which one takes a boolean and why. `lint_dsx` refuses an
interpolated `disabled=` outright and names the working spelling in the message. The rule is
an ERROR rather than a notice: there is no case where the interpolated form is what somebody
meant, and the failure is invisible in review, in a screenshot, and in a test that does not
click the control.

**What we deleted.** All eight sites, including the one in the generator rather than in its
generated output. And the five-line comment is no longer the only thing standing between an
author and this bug.

**Still open.** The same shape exists wherever a boolean-valued attribute binds as text. The
audit here covered `disabled` because that is the one with a working sibling; whether
`a11yHidden`, `keep` or `scroll` have the same trap is unmeasured.

### R20 · The insertion point had no spelling of its own (2026-08-24)

**The workaround that gave it away.** A syntax editor is a highlighted view under a transparent
input - that is the shape, on every platform, because the input owns the caret and the
selection and the view owns the colour. Making the input's text transparent also made its caret
transparent, and the first three ideas for getting it back were all dodges: swap the layers on
focus (the caret lands in the wrong place), inset the box so the caret falls outside the clip
(a lie about the geometry), or give up and ship a plain textarea.

**The decision behind it.** Every runtime drew the caret in the text's own colour. That is the
right default and it was the only behaviour: `caret-color` was not in the DSX-CSS catalog, so
an author could not say otherwise on any renderer. The same paragraph applies to the resize
grip - the kernel put `resize: vertical` on every textarea, which is right for prose and wrong
under a layer aligned to it, and there was no spelling for saying so either.

**What we extended.** `caret-color` is a catalogued property, bridged on Kotlin (the text
field's `cursorBrush`) and Swift; the phase-1 Compose bridge moves 32 properties to 33 with the
row named. `<textarea resize="none">` is a censused attribute: native text views have no user
resize handle, so `none` is what iOS and Android already do and this is the web honouring the
same contract rather than a web-only escape.

**What we deleted.** The three dodges above, before any of them was written. The overlay is now
the plain shape it should have been, and `dist/flow/codeprobe.ts` measures the two layers'
text origins against each other on open, after typing, and after a 160px drag on the grip.

**Still open.** `caret-color` is bridged but not yet exercised by a conformance case on any
renderer - the corpus covers the highlighter's spans, not the surface that paints them. And the
kernel's other textarea defaults (`min-height: 6rem`, the `maxLines` cap) are still decisions an
author cannot fully reopen; they happen not to bite this layout.

## Filing a row

When you hit one, add the row before you fix it — the symptom sentence and the "behind it"
paragraph are the work, and writing them is usually what tells you whether you have found the
decision or are still looking at a symptom. A row whose "behind it" reads "the runtime does not
support X" is not finished.

### R21 · A zoom is a repaint, and the renderer told nobody (2026-08-25)

**The workaround that gave it away.** The expression canvas's browser oracle measured every
wire's backing store against the composited rect it has to cover, and two fixtures came back
under-sampled - the widest and the deepest, the two that open at a fit zoom below 70%. The
obvious dodges were all local: re-run the probe after a nudge, widen the tolerance, or exempt
"zoomed-out" fixtures from the check. Every one of them would have shipped a canvas that
goes soft the moment somebody zooms and stays soft until an unrelated edit happens to repaint
it - which is exactly the state R18 left behind and wrote down as still open.

**The decision behind it.** R18 taught the canvas to size its backing store for where the
surface LANDS: `offsetWidth` for the layout question, the ratio to the composited rect for the
resolution question. Correct, and it made a canvas inside a zoomable world draw at full size
for the first time. What it could not fix from inside the canvas is WHEN to ask again. A
transform moves no layout box, so no `ResizeObserver` fires, no reflow happens, and nothing
downstream can observe that the right answer changed. The renderer knew: it is the thing that
wrote `transform: translate(...) scale(...)` onto the world in the first place. It just had no
word for saying so.

**What we extended.** The web renderer now announces a reactive `transform` write as a
`dsx:transform` event carrying the element it landed on (`mount.ts`, in the `__style_reactive`
binder). `canvas.ts` keeps one document-wide listener and a registry of surfaces; on each
announcement a surface whose ancestor moved re-reads its own composited scale and schedules a
repaint only if the number actually changed. The element contract has no teardown hook, so
the registry drops entries whose host has left the tree as the event passes rather than
holding a detached node alive.

**What we deleted.** R18's "still open" line, and the three dodges above before any of them
was written. `dist/expr/canvas.ts` now asserts the invariant directly on all seventeen
fixtures: a wire's backing store carries at least the samples its composited rect needs,
floor of one device pixel per layout pixel.

**Still open.** The announcement covers a transform written through the reactive style binder,
which is how every zoomable surface in this repo drives its world. A transform arriving any
other way - a CSS animation, a class swap, a sheet rule under a media query - moves no
JavaScript and is still unobserved. The honest general answer is a scale observer the platform
does not have; this is the seam that covers the cases we actually build.

### R22 · The design system was ratified, then exempted from every gate (2026-08-25)

**Symptom.** An outside read of the web renderer called the skin generic and traced it to an
absence: no type system, no elevation system, no state system, no shape system, no motion
system. 253 component classes improvising four axes independently, which is exactly what
improvisation at scale reads as.

**Behind it.** The absence was not real. `proposals/design-system.md`, the owner's ruling of
2026-08-17, already specifies all of it in its Part 1: a type ramp carrying size, weight,
tracking AND leading; `space-1..12`; a radius scale; elevation 0-4; motion durations and
easings; one focus ring; a density knob; and derived interaction states so one accent write
restyles every state in both schemes. Most of it landed. What never landed is any reason for a
component to use it. Measured on this branch: 108 box-shadow declarations against a five-level
scale that exists, only 31 tokenised. 74 font-size declarations against an eleven-role ramp
that exists, 33 of them literal. 144 hand-written `color-mix()` calls where the state layer
should be. The system was on disk and the components walked past it.

**Where we limited too much.** Not a missing feature. A ruling read one word wider than it was
written. `design-system.md` says "**Quality is enforced by the defaults, not the linter.**
Off-system styling stays a lint NOTICE (informational, never failing a build)." That is right,
and it is about what an AUTHOR writes in an app: the system should win by being the best path,
not by forbidding the alternative. It was applied by default to the framework's own element
sheet as well, and there it is a category error. The framework's element layer is not styling
that sits off the system. **It IS the defaults.** A literal in `@layer dsx-elements` is not an
author exercising freedom the ruling protects; it is the default plane disagreeing with itself.

The tell that this was a category and not an oversight: the ONE axis with a gate is the ONE
axis that held. `theme.test.ts` fails a raw hex or `rgb()` inside `@layer dsx-elements`, and
color is the only foundation that did not drift. Every ungated axis drifted, and two of them
drifted into rival token families for a single concept - `--dsx-focus-ring` beside a CSS
`outline` spelling, `--dsx-dur-*` beside `--dsx-duration-*`. The double focus ring visible on
the prominent button is not a cosmetic slip. It is two systems for one job, both firing.

**The opening.** The ruling is amended, not reversed: it governs AUTHOR styling, where it
stays a notice. The framework's own element layer is held to the corpus by a gate, because it
is the defaults the ruling relies on. The corpus grows from one axis to five (type, elevation,
state, shape, motion, beside the ratified colors), and `packages/dom/test/design-system-gate.test.ts`
fails a literal size, weight, leading, tracking, shadow, radius, bezier or duration inside
`@layer dsx-elements`. Roughly 250 declarations light up, every one a mechanical substitution
into a token that is already on disk.

**The workarounds this deletes.** Every one of the 144 `color-mix()` calls, the 77 literal
shadows, the 33 literal sizes, the 28 literal weights, the nine hand-typed line-heights, the
seven cubic-beziers where two easing sets should be, and both duplicated token families.

**The general lesson, which is the point of the row.** A ruling that a system will win on
merit is a statement about the people choosing it. It is not a mechanism, and it does not
survive the authors of the system itself, who are the ones writing at three in the morning
against a component that needs a value the corpus does not yet carry. Ratifying a vocabulary
and gating a vocabulary are two different acts, and only the second one holds. Where a
document says a plane is canonical, something must fail when the plane is bypassed - or the
document is describing an intention, not the code.

### R23 · Web renders the tag and never the contract (found 2026-08-25, OPEN)

**Symptom.** An outside read found the web skin free to drift from the other two renderers,
and it is: `OpenSource/Conformance/elements/*.json` pins per-element `geometry` and `colors`
for 80 elements, extracted from the Swift reference with a `_src` citation on every value.
Compose is held to all of it by `ElementParityTest.kt`. The web renderer reads the same
directory only to assert that a TAG IS SUPPORTED. It checks no geometry value and no colour
token. Measured: 156 keys in the corpus, 0 asserted against web.

**Where we limited too much.** Not a missing corpus and not a missing renderer. The parity
contract has one consumer per renderer and web's consumer answers a different question -
"do you have this element" instead of "does it look like the reference". A ledger that
records support is not a ledger that records fidelity, and the two got the same file.

**Why this row is OPEN and what was removed.** A scaffold for this landed in this session
and was deleted rather than shipped: `element-appearance-parity-browser.ts` plus its map,
633 lines, with a good four-way probe design (geometry probe, colour probe, source probe,
named divergence) and **every probe table empty**. It ran, it reported "156 unmapped", and
it asserted nothing. Wiring that into a lane would have bought a green check for coverage
that does not exist, which is worse than the hole it was meant to close, so it is named here
instead. The probe design is the recoverable part and it is recorded above.

**The opening, when it is taken.** The mapping is the work: a fixture key like
`headerSpacing` names an intent, not a CSS property, so each one needs a probe that measures
the same thing the Swift reference measures. Two rules make it honest. Colours want a SOURCE
read, because a token name is a fact and a computed `rgb()` string is a lossy round trip.
Geometry wants a BROWSER read, because a spacing of 8 is only real if the box measures 8.
Report coverage as three numbers - asserted, allowlisted with a reason, unmappable - and
never let the first one grow by loosening a probe.

### R24 · We ratified twelve type roles and gave the author no word for one (2026-08-25)

**Symptom.** The Studio's own sheet writes `font-size` 152 times, on 152 classes, all of them
attached to a `<text>`. Measured across the editor's markup and its sheet: 845 declarations
re-decide a skin property the element default already decides, and 517 of them - 61% - are a
`<text>` deciding its own size, weight, tracking or leading. Nothing is wrong with any single
one of them. Together they are a type system that exists in a JSON file and nowhere an author
can reach.

**Where we limited too much.** `Conformance/defaults/type.json` ratifies twelve roles with all
seven native columns filled in - `body` is `bodyLarge` on Compose, `body` on Apple,
`--dsx-type-body-*` on web - and the whole ramp is unreachable from markup. `<text>` accepts
`value`, `bind`, `color`, `lineLimit` and `markdown`. It accepts no word for WHICH TEXT THIS
IS. So an author who wants a caption does the only thing left: writes a class, picks 11px,
and picks a weight. The system did not fail to be designed. It failed to be offered, and a
system nobody can name is a system that gets re-derived per call site.

This is the exact shape the ledger keeps recording: the value was decided FOR the author (the
ramp is fixed and correct) and then the author was given no way to ASK for it, so every
caller invented a private answer to a question the framework had already answered.

**What was extended.** `<text type="...">`, one word, the twelve corpus roles. Each renderer
resolves it through its own column of the same file: web sets the four token custom
properties, Compose takes the named Material typography role, Apple takes the named text
style, and watchOS/macOS take theirs. The native columns are role NAMES rather than numbers
precisely so a role tracks Dynamic Type and the Material scale instead of freezing a pixel -
which is why this word could not have been a shared stylesheet.

**What was deleted.** The Studio's hand-written type. Every class that existed only to name a
rung is gone, and the ones that remain say something the ramp does not.

### R25 · The canvas drew everything except what a finger draws (2026-08-26)

**The workaround that gave it away.** A signing pad landed as `<Signature>`, and each of its
four renderers hand-rolled the same three things: a normalized point capture, a coalescing
floor, and a quadratic-through-midpoints curve. Then the owner asked the obvious question -
"can't we just use a Canvas element?" - and the answer was that we already have one. `<canvas>`
(U04) is a real 2-D surface on every renderer: an SVG path grammar, transforms, gradients,
effects, a keyed display-list diff, an SSR serialisation and a display-linked frame loop. The
pad had duplicated a drawing engine that shipped months earlier, and nobody noticed because
what the pad needed was the one thing the engine did not have.

**Where we limited too much.** The canvas's input story was: gestures reach the author as JSE
actions, like any other element. Correct for a tap, a pinch, a drag threshold - and unusable
for INK. A drawing surface has to paint the stroke under the finger at pointer rate; routing
every sample through the store means one store write, one display-list rebuild and one repaint
per sample, which is exactly the JS-thread shape the native renderers exist to escape. So the
canvas was a surface an author could paint ON but not draw ON, and the only way to draw was to
build a private canvas next to it. Not a missing feature: a missing SPLIT. Nothing had asked
which half of a drawing is a value and which half is a gesture in flight.

**What we extended.** `<ink>`, a canvas child that is both. The COMMITTED drawing is ordinary
tier 1 - `inkNodes` folds the stored strokes into the same stroked `path` ops an author could
have written, so the display list, the keyed diff and the SVG serialisation need no special
case - and the IN-FLIGHT stroke is transient native paint the renderer captures and draws
itself, writing the store ONCE, on pointer-up. The law (wire shape, capture folds, coalescing
floor, curve) moved into the kernel of each language as `InkCore` / `ink-core.ts`, pinned by
`OpenSource/Conformance/canvas/ink.json` and run on the TS and Kotlin cores.

**What we deleted.** Three private implementations of the ink law, and the reason the fourth
still exists is now a sentence rather than an accident: a component boundary cannot forward a
two-way binding, so a ready-made pad that writes back into the consumer's `sig` has to be an
element. `<Signature>` is that element and nothing more - box, signing rule, hint, a11y - and
its fixture now says so. Anyone who wants the surface without the pad writes
`<canvas><ink bind="drawing"/></canvas>`.

**The rule this is an instance of.** When a primitive is nearly right, the missing piece is
usually not a feature but a seam: the framework decided the shape of an interaction (every
gesture is an action) and never asked whether one kind of interaction is a value being made.

### R26 · We gave the author scroll-linked style and no way to bound it (2026-08-26)

**The workaround that gave it away.** The scroll-driven components of the PanelUI parity sweep
all wanted the same declaration: a value that rises with scroll and then STOPS. Written honestly
that is `clamp(0, calc(var(--scroll-progress) * 3 - 1), 1)`, and it dropped on the two native
renderers. The workaround already drafted was to route the scroll through `on:scroll` into a
`<variable>` so JSE could do the clamping - which is a store write per sample, and is precisely
the bus flood the `--scroll-*` plane exists to avoid. The plane was about to be abandoned by the
first component built on it.

**Where we limited too much.** U01 shipped the plane and, with it, "the native twin of what a
browser does for free": `var()` substitution and `calc()` folding. That reads complete and is
not. CSS's math is four functions, and the three we skipped are the ones that express a RANGE -
which is what a scroll-linked value almost always is, because a scroller has a top and a bottom
and the interesting behaviour happens between two offsets. Skipping them did not restrict a
corner case; it restricted the plane's main use, and it pushed exactly that use back onto the
bus. We had implemented the arithmetic and called it the language.

**What we extended.** `evaluateScrollLinked` / `ScrollCore.evaluateLinked` now fold `clamp()`,
`min()` and `max()` beside `calc()`, in all three languages, nesting in either direction. The
rules are CSS's: arguments compare like with like (same unit or the declaration drops),
`clamp()` is exactly three arguments folded as `max(low, min(value, high))` so an inverted pair
resolves to the low bound, and an identifier that merely ends in a function name (`admin(`) is
left alone. Twelve cases in `OpenSource/Conformance/scroll/linked.json` pin it on the TS and
Kotlin cores per-PR and on Swift in the record lane.

**What we deleted.** The `on:scroll`-into-a-variable draft of `<ScrollText>`, before it was
committed. The component is now a pure declaration over the plane: no handler, no store write,
nothing crossing the bus while a finger is moving.

**The rule this is an instance of.** A substrate is finished when it can express the thing it
was built for, not when its first example works. If the first real consumer of a plane reaches
past it, the plane is short a primitive - and the tell is that the workaround is the exact
mechanism the plane was introduced to replace.

### R27 · The plane reaches every element except the ones that want it (2026-08-27, FIXED)

**The workaround that gave it away.** `<ScrollFade>` - the fading edges over a long list, the
same parity sweep - could not be written at all. The fade bars are pinned chrome: they sit OVER a
scroller and must not move with it. The `--scroll-*` plane cascades from the scroll node to its
DESCENDANTS, and pinned chrome is by definition not one, so the bars saw the page's plane or none
at all. Every way to make them descendants made them scroll away.

**Where we limited too much.** The plane's scope rule is the browser's own cascade, which is
right for content that moves with the scroll and silent about chrome that does not. That is one
decision, and it is ours. The row originally named a second - "the `position` enum was cut to the
three values the native renderers already had, and `sticky` is the one we left out" - and that
half was **wrong on its facts**: `position` is a Tier A property in the DSX-CSS catalogue with no
case in either native bridge, so `relative`, `absolute` and `fixed` are all inert off the web
too. Adding a fourth value to an enum no native renderer reads would have been a fix in name
only. The native `position` hole is real and is now R32, opened rather than folded into this row.

**What we extended.** A scroll node carrying a `ref` publishes its whole plane a SECOND time
under that name, at the document root, where any element reads it whether or not it is a
descendant - `--scroll-feed-y`, `--scroll-feed-remaining`, and the rest of the family. No new
value grammar: the key is an ordinary custom property and `var()` already reads it. This is also
the web's own answer to the same problem, since `scroll-timeline` plus `timeline-scope` exist
precisely so something outside a scroller's subtree can read it.

Three rules, each corpus-pinned, and each is a way the shortcut would have gone wrong:

- A `ref` that cannot spell a CSS custom property (a space, a dot) publishes **nothing**, rather
  than a key no declaration can name or a mangled one a second ref could also spell.
- A name whose qualified key would spell a RESERVED key does not publish that key and publishes
  the rest. `ref="progress"` on a horizontal rail would otherwise silently become the page's own
  `--scroll-progress-x`: action at a distance from a name somebody chose for an unrelated reason.
- A duplicated ref resolves to its LAST provider, which is the ref registry's own law rather
  than a second opinion about it.

**The plane was also short a primitive, and its first real consumer found it.** A top fade reads
`--scroll-y`; a bottom fade had nothing to read, because `--scroll-progress` is a FRACTION of the
content and the same declaration would then fade over 40pt on a short list and over 400pt on a
long one. `--scroll-remaining` (plus `-px` and the `-x` twins) is the distance still to travel,
from the same clamped offset progress uses. That is R26's lesson arriving a second time: a
substrate is finished when it can express the thing it was built for.

**What we shipped on it.** `<ScrollFade source="feed"/>`, a pure declaration over the plane - no
handler, no store write, nothing crossing the bus while a finger is moving. It does not own the
scroller: wrapping one would mean inventing a name for its plane, and two wrappers on a screen
would then share it silently. The author names their own scroller and this is chrome that reads
it.

**Two things it dragged into the light, both fixed here.** `passthrough="true"` was implemented on
iOS and Compose and on neither the web renderer nor the element census - so a fade bar would have
eaten every touch in its own rectangle on the web, and the linter called the real word a typo.
And the scroll corpus's own README had named a Swift runner since U01 that nobody had written:
the TS and Kotlin twins were judged on every pull request and the third column was a claim. It is
written now (`ScrollConformance.swift`, all seven files), and because a conformance runner is
Foundation-only by contract it compiles and RUNS on Linux - so the Swift column of this corpus is
judged per-PR (`swift_conformance_run_test.rb`) instead of only in a record lane.

**The rule this is an instance of.** The consumers a substrate cannot serve are usually not
exotic - they are the ones standing one step outside the tree it was scoped to. Ask who is
adjacent to the plane, not only who is inside it.

### R28 · Motion that parses everywhere and runs in one place (2026-08-26, FIXED)

**The workaround that gave it away.** Two components from the parity sweep are motion and
nothing else: `<Marquee>` (a row that scrolls forever) and `<TextAnimation>` (lines that enter
one after another). Both were drafted on `@keyframes` + `animation`, which lints clean, sits in
the DSX-CSS property catalogue as a Tier B property, and is what the existing `<Confetti>` and
`<ThinkingOrb>` already use. Neither runs off the web: the Kotlin and Swift CSS resolvers fall
through on any at-rule that is not `@media`, and the property bridges have no `animation` case
at all, so the declarations are inert. The workaround on offer was to ship them anyway with a
sentence about progressive enhancement - which would make a marquee that does not move on the
two platforms the framework exists for.

**Where we limited too much.** DSX has exactly two motion words: `transition` / `enter` (a
one-shot on a state flip or first appearance) and `anim` / `animDuration` (the curve and the
length of that one shot). Both describe a transition BETWEEN two states. Nothing describes
motion that repeats, and nothing describes motion that starts LATER than its neighbour - so
loops and stagger, which are most of ambient motion, have no spelling. Then `@keyframes` was
admitted to the parser and the catalogue without being admitted to the renderers, which is
worse than not having it: an author reads the catalogue, writes a keyframe, and the phone
silently disagrees with the browser.

**What we extended.** The shape the scroll plane already proved: a pure kernel fold, a corpus,
then a driver per renderer.

- **The fold** is `MotionCore` in all three languages (`packages/kernel/src/motion-core.ts`,
  `:core MotionCore.kt`, `Engine/iOS/MotionCore.swift`): normalise `@keyframes` stops, parse the
  `animation` shorthand AND all eight longhands, sample at an elapsed time with easing,
  iteration count, direction, fill and play-state. Sampling is a PURE function of elapsed
  milliseconds, never a state machine, which is what lets a display link, a backgrounded app and
  a deterministic test all reduce to passing a different number.
- **The corpus** is `OpenSource/Conformance/motion/keyframes.json`, and its reference is unusual
  enough to state plainly: it is the BROWSER. The web renderer never calls the fold, because a
  browser owns its own animations, so every expectation in the file is what CSS itself does and
  all three runners exist to prove the two native lanes agree with it.
- **The lookup** is its own seam on each side (`CSSResolver.keyframes` / `CSSEngine.keyframes` /
  `StackStyleSeam.keyframes`), because a keyframe is a TABLE the element's `animation` names, not
  a declaration that applies to the element. A stop leaking into paint is the failure mode that
  shape rules out, and it has its own test.
- **The drivers** are the display link each renderer already owns: `:render StackKeyframes.kt`,
  `:desktop DesktopKeyframes.kt` and `Engine/iOS/StackKeyframes.swift`, each running under the
  canvas frame loop's battery law - installed only while a sample reports active, so a finite
  animation stops its own link at the last frame and a paused one never starts.

**What it deliberately refuses.** Only `opacity` and the transform family animate; every other
property in a keyframe is DROPPED and REPORTED rather than half-applied, because an animated
`width` that only moves on the web is the exact defect this row exists to end. And a sampled
transform is DECOMPOSED into the four attributes the native ladders already apply (`opacity`,
`rotation`, uniform `scale`, `offsetX`/`offsetY`) or refused whole: CSS composes transforms
leftmost-outermost and the ladder is fixed at rotation to scale to offset, so the decomposition
is exact or it is inert and logged. A silent approximation is the same class of defect as the
silent drop.

**The rule this is an instance of.** Accepting a syntax is a promise. A property that parses,
lints and appears in the reference has been promised to the author on every target; leaving one
renderer out is not a smaller feature, it is a false statement in the catalogue.

### R29 · The one layout you cannot drive with data (2026-08-26, FIXED)

**The workaround that gave it away.** `<ScrollText>` wants to reveal a passage word by word,
which means a wrapping run of individually styled words. `<flow>` is the wrap layout and it
takes no `bind`, so the first draft put a `<list>` inside a `<flow>` - which lints clean, mounts
clean, and does not wrap, because the list is one child laying out its own row. The component
shipped revealing by LINE instead, which is a real effect rather than a broken one, but it is
not the effect that was asked for.

**Where we limited too much.** The repeater is a hardcoded tag allowlist on two of the three
renderers - `list`, `grid`, `pager` on the web (`BOUND_COLLECTION_TAGS`, plus a second copy in
the embed entry) and a `when(node.tag)` switch on Android - and on iOS it is a capability of the
privileged component tier that `<flow>` was simply not registered into. Nobody decided that a
wrap layout should not repeat; three separate lists were written at three different times and
`flow` was in none of them. The scene subsystem then wrote a FOURTH implementation of the same
keying law for `<group bind>`, which is the tell: the row contract is general and its dispatch
is not.

**What we extended.** `<flow bind= key=>` on all four renderers, and it cost no layout change on
any of them: the rows ARE the subviews, so the greedy packer never learns a repeater exists. iOS
and Android moved `<flow>` from the non-privileged tier to the privileged one, which is the tier
that exposes `bound()` and the per-row render. The web gained a third `kind` in `mountList` -
`.dsx-flow`, the same two spacing custom properties the static factory binds, rows appended FLAT
(the grid path wraps every row in a real `role="row"` block, which would have put every chip on
one line and produced a wrap that does not wrap). `bind`/`key` joined the flow spec, the fixture
and `keyedCollections` in the lint facts.

**What we found on the way.** The DESKTOP `<flow>` never wrapped at all. It fell through to the
`"hstack", "toolbar", "flow"` arm of the renderer's tag switch, which is a plain horizontal flex
- so the one thing the element is defined by was missing on Windows and Linux, silently, and had
been since the element landed. It now runs the same greedy packer `:render` and the web do,
transcribed rather than reinvented. That bug was invisible for as long as nobody could put data
through the element; asking for the repeater is what surfaced it.

**What we deleted.** `<ScrollText>`'s by-line-only restriction is no longer a runtime limit, and
the components-browser oracle gained a `wraps` assertion that measures the ITEMS' distinct top
offsets - a wrap that does not wrap now reds, on the renderer where it can be measured.

**The rule this is an instance of.** When a capability is dispatched by an allowlist of names
rather than by a contract, its coverage is an accident of history. Ask what the list would
contain if it were written today, not what it contains.

### R30 · A capability row for a runtime nobody had written (2026-08-26)

**The workaround that gave it away.** `<Signature>` on Windows and Linux drew its own ink. Not
because the desktop needed a different pad - `InkCore` had already moved to `:core` and every
number was shared - but because the surface the pad is chrome over, `<canvas>`, answered on that
renderer with a failure box: "This DSX desktop build does not bundle the 2D canvas drawing
surface." So the desktop kept a private drawing, and when `<Plot>` and `<Diagram>` landed on the
canvas a week later they simply did not reach two of the six targets. One missing surface had
started multiplying.

**Where we limited too much.** `DesktopCapabilities.tsv` is a good mechanism: it lets a build say
honestly that it does not bundle an embedded browser, a Godot engine, a 3D scene runtime. Every
other row in it names a real third-party runtime the build genuinely does not carry. `canvas` was
not that. Compose Desktop rasterises through Skia, `:desktop` already compiled `CanvasCore` and
`InkCore` verbatim, and the Android adapter turned out to be ~200 lines of `androidx.compose.*`
calls, of which exactly one - text via `android.graphics.Paint` - was Android-only. The row was
not a statement about the platform; it was a statement about our backlog, wearing the platform's
clothes. And because it was DATA rather than a TODO, it read as settled: a guard asserted it, a
test asserted it, the qualification ledger counted it, and the whole apparatus quietly certified
that the desktop could not draw.

**What we extended.** `DesktopCanvas.kt`: the display-list replay, the tier-2 command replay, the
`withFrameNanos` loop under the kernel's budget, the `<ink>` pointer capture and the declared
semantic overlay, over the same `:core` kernel every other renderer runs. Two things came out of
writing it. The colour vocabulary split into a pure `resolveColor` plus the composable wrapper,
because a `DrawScope` cannot read a theme - one vocabulary, now reachable from a draw. And the
child markup resolves in COMPOSITION rather than inside the draw, which is what makes a store
write repaint on this renderer; the Android adapter leans on a flow collect instead, and the
desktop shape is the better of the two.

**What we deleted.** The `canvas-2d-runtime` capability, its failure message, its guard rows and
its ledger entry, plus the desktop's private copy of the ink path builder. `<Signature>` draws
through the same helper the canvas does. `<canvas>`, `<ink>`, `<Signature>`, `<Plot>` and
`<Diagram>` are now one implementation on iOS, Android, macOS, Windows, Linux and the web.

**The rule this is an instance of.** A declared limitation is load-bearing: it silences the very
question that would have found it. Before writing one, ask whether the platform cannot do this or
whether we have not done it yet - and when it is the second, the honest artifact is a task, never
a capability row. Audit the ones already written the same way: `native_failure_only_elements`
going DOWN is the direction that guard should be able to celebrate.

### R31 · A style attribute that three renderers honoured and the fourth dropped (2026-08-26)

**The workaround that gave it away.** `<ImageGeneration>` exists for exactly one promise: it
takes the aspect ratio up front so the frame is reserved from the first paint and nothing moves
when the generated bytes land. The oracle that mounts it measures both states side by side, and
it failed on the web: the still-generating box was 360x88 (its content height) and the landed one
360x1 (the placeholder image's natural size). The component was about to be "fixed" by writing
`style="aspect-ratio: {{ ... }}"` instead - which works, and which would have left one component
holding a private opinion about how a documented attribute behaves.

**Where we limited too much.** `aspectRatio` is a universal style attribute. It is in
StackReference's table, it is in `stack-style-properties.json`, `CssBridge.kt` and
`CSSBridge.swift` both map CSS `aspect-ratio` onto it, and the desktop style runtime resolves it
to `Modifier.aspectRatio`. Three renderers honoured it. The web's attribute bridge - which runs
the same map in the opposite direction, attr to CSS - simply had no case for it, and neither
`BRIDGE_ATTRS` nor any gate noticed, because the bridge's coverage is a hand-written switch and
nothing compares it to the catalogue the other three read. A dropped declaration is silent by
design (that is correct for a value that is invalid at computed value) and here that silence hid
a missing feature rather than a bad value.

**What we extended.** The `aspectRatio` case in `cssmap.ts`, normalising `16:9` / `16/9` / a bare
number to CSS `aspect-ratio: W / H` - the mirror of what the native bridge already does in
reverse - plus its `BRIDGE_ATTRS` membership so the REACTIVE half of the bridge routes it too.
Both halves matter and only the second was hard to see: a static `aspectRatio="16:9"` compiled
correctly the whole time, and only `aspectRatio="{{ ... }}"` was dropped, which is the spelling
any component with a `ratio` attribute must use.

**What we deleted.** The `style="aspect-ratio: …"` draft of the component, before it was
committed, and with it the reason anyone would later wonder why one component spells a universal
attribute differently from every other.

**The rule this is an instance of.** Cross-renderer coverage that lives in a hand-written switch
is coverage nobody measures. The catalogue is the contract; a renderer that implements a subset
of it is not "partial", it is wrong - and the way you find out is by measuring what the component
CLAIMS (the box did not move) rather than by checking that it rendered.

### R32 · The catalogue promises `position` and two renderers have never read it (found 2026-08-27, OPEN)

**How it surfaced.** R27's own diagnosis, checked against the code. That row asserted the
`position` enum "was cut to the three values the native renderers already had". They have none of
them: `position` is Tier A in `dsx-css-properties.json`, along with `inset`, `top`, `right`,
`bottom` and `left`, and `CSSBridge` (Kotlin, and its Swift twin) has a case for none of the six.
Every one of them reaches the `else` branch that logs "accepted by the catalog but not yet mapped
- inert until the Taffy phase" and does nothing. 92 declarations in this repository write one.

**Where we limited too much.** Nowhere, yet - this is the R28 defect exactly, one property family
later: a property that parses, lints and appears in the reference has been promised to the author
on every target, and leaving two renderers out is not a smaller feature but a false statement in
the catalogue. The author writes `position: absolute; top: 16px`, the browser obeys, and the
phone lays the element out in flow.

**Not fixed, and deliberately not worked around.** `sticky` is separable from the other three and
would have been the cheap fix - a sticky box stays IN FLOW by definition, so it is a translation
applied in the element's own modifier, which is exactly the shape R28's keyframe driver already
proved. `absolute` and `fixed` take the element OUT of flow, so they need the container to
partition its children and hoist the positioned ones, on every container, on two renderers.
Shipping `sticky` alone would leave the catalogue lying about the other two while reading as
though `position` had been done. The honest sequence is a corpus for the whole family, then the
container work, then the driver.

**The rule this is an instance of.** When a ledger row names the decision that over-restricted,
check that decision against the code before building on it. R27's second half read as an obvious
truth for a day and was never true; the real hole was larger and in a different place.

### R33 · The film sold an app that never animated (2026-08-27, FIXED)

**The workaround that gave it away.** A commercial rendered from the KetoLock demo showed the
calorie ring and the macro bars moving only because the composition drove them with `<tween>`
rows. A progress value the film changed with a single `<set>` snapped between frames, and the
tap that locks the day flipped the button in one frame. The workaround on offer was to author
another `<tween>` per value - to re-describe, in the film document, motion the application
already defines - which is the same false statement the parity register exists to refuse: the
product has a 200ms fill transition, the advertisement does not show it.

**Where we limited too much.** The film driver opened its browser context with
`reducedMotion: "reduce"` and finished every finite animation on every frame. Both were correct
about the hazard and wrong about the remedy: a compositor animation runs on the real clock,
which the paused page clock does not govern, so sampling one mid-flight WOULD be wall-time noise
in a deterministic frame. The decision that over-restricted was inferring from "we cannot sample
it safely" that the application must not animate at all - a rendering pipeline deciding, on the
author's behalf, that the thing being advertised is static.

**The extension.** Determinism now comes from PHASING rather than from suppression. Every
animation is driven to the phase the film instant dictates: an infinite one to the scene-local
instant (unchanged), a finite one to `instant - birth`, where birth is the film instant of the
first frame the animation existed. Births are deterministic because the writes that create them
are. Two laws keep the seams honest: a MOUNT LANDS SETTLED (finite animations created while a
document boots, or while the frameless placement rewrites its shell, are finished before the
first frame, so measurements, morph crops and support snapshots never catch a half-played
entrance), and a TWEEN OWNS ITS WINDOW (while a film tween is writing, finite animations are
driven to their end, because a transition chasing a value that moves every frame only lags it).
The reduced-motion preference is left honest, so the application's own `prefers-reduced-motion`
rules mean what they say.

**What got deleted.** The blanket `reducedMotion: "reduce"` and the unconditional
`a.finish()` - the two lines that were the reason no author could put the product's own motion
on screen.

**The race the first cut had, and why the fix belongs in the settle loop.** Phasing once per
frame was not enough: an application applies a state write on ITS schedule, and a reactive
update that lands on an animation frame creates its transition AFTER the frame's evaluate
returned - so the transition ran free on the real clock until the next frame caught it, and the
frameless determinism gate went intermittent (one frame of a progress fill, 187 levels apart
between two runs). The phasing pass now runs before EVERY CAPTURE ATTEMPT inside the
capture-until-stable loop, which is the same law the pixels already answered to: a late-born
animation is caught at a birth the film instant defines, and the settle loop cannot report
stable until two consecutive phased captures agree. Both determinism gates are green over three
consecutive suite runs, and a direct two-render reproduction of the flake is clean three times
over.

**The review's five, and the one law each corrected.** (1) A phased animation is FINISHED at
its end, never paused there: an application waits on `Animation.finished` to clean up after its
own motion (the router unmounts a popped screen in that callback), and a paused animation never
resolves it. (2) An animation on a scroll or view timeline is left alone entirely - its progress
is a function of DOM state the frame already fixes, and phasing it against a timeline it does
not have threw a non-finite `currentTime` out of the evaluate. (3) "Settle" split into ALL (a
mount, permanently) and FRESH (only what was born at this instant - a tween's own transition, or
one the capture rig's DOM write created), because marking every animation alive during a tween
window as born-before-time froze a long application animation for the rest of the scene. (4) The
capture rig suppresses transitions on the pieces it toggles, so an application transitioning
`all` cannot animate a piece back into the surface crop it must be absent from. (5) A regression
test now proves the behaviour rather than only its determinism: one scene, no film track, one
`<set>`, and the frame hashes must DIFFER across the transition and then settle - the assertion
the old suppression would fail.

### R34 · Range chrome hid the glass container and missed the short min-track (2026-08-28)

**Symptom.** `<rangeslider>` on iOS 26 had two live `UISlider` donors but did not
look like `<slider>`: thumbs went flat, and a blue stub sat to the left of the
low lens. XCUI stayed green.

**Behind it.** `silenceTracks` treated any view named Track as disposable, so it
hid the glass visual element that parents `_UILiquidLensView`. The 45% width
gate then missed the low donor's min-track (78pt on a 338pt rail at value 20),
which UISlider materializes after the first layout.

**Where we limited too much.** `RangeSlider.swift` `silenceTracks` and the
host-drawn 4pt bar. The thumbs are the system part; so is the public iOS 26
thumbless slider style. A named Track that still has children is the lens
host, not the rail.

**The opening.** Leaf-only silence, using the painted box, on every fill and on
the next turn. Inactive rail and selected span are thumbless `UISlider`s
clipped so the native min-track ends at each live lens centre. Pins:
`ios_foundation_interaction_guards_test.rb`, the iPhone range XCUI cases.
