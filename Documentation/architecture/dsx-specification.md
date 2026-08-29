# The DSX specification

> **Status: normative.** This document defines what DSX *is*, independently of Despia's
> implementations of it. Where this document and any implementation disagree, this document and
> the conformance corpora are correct and the implementation has a bug.

DSX is a declarative document format and a native message bus. A `.dsx` document describes a
surface; a module provides capability; the bus connects them. Three renderers implement it today
(SwiftUI, Compose, DOM), which is one more than is needed to prove the format is not a description
of any one of them.

## 1 · Why this document exists

A framework whose behaviour is defined by its implementation can only be adopted, never
implemented. Its users are permanently downstream of one vendor's decisions, and every
disagreement between platforms is settled by whichever platform shipped first.

DSX is defined the other way round. The behaviour is pinned by **platform-neutral fixtures** that
every renderer executes, so:

- A disagreement between renderers is a **failing test**, not a platform quirk.
- A deliberate difference is **ratified in writing** in the divergence ledger, or it does not exist.
- A fourth renderer is **implementable by a third party** against the fixtures alone.

The corpora are the specification's executable half. This document is the prose half, and its job
is to say precisely which is normative and how the two fit together.

## 2 · Conformance

### 2.1 The corpus is the test suite

`OpenSource/Conformance/` holds platform-neutral JSON fixtures. Each corpus pins one plane of the
language: the expression grammar, the action runner, the router, the element vocabulary, a
capability's fold. `OpenSource/Conformance/INDEX.generated.json` is the machine-readable index:
every corpus, how many cases it pins, and which runtimes execute it.

An implementation is **conformant to a corpus** when it executes every case in that corpus and
produces the pinned result. Nothing else counts, and in particular:

- Passing a hand-written test that resembles a corpus case does not count.
- Implementing behaviour the corpus does not pin is permitted but unspecified: another conformant
  implementation may do something else, and neither is wrong.
- A corpus no runtime executes is not specification. It is an intention. The index reports those
  as `unrun`, and `generate_conformance_index_test.rb` fails when the set changes, so the count
  can only go down.

### 2.2 Conformance classes

An implementation declares which classes it implements. The classes are cumulative in dependency,
not in obligation: a renderer may implement Core and Surface without Capability.

| Class | Corpora | What it means |
|---|---|---|
| **Core** | `jse` · `actions` · `errors` · `logs` · `functions` · `build-expressions` | The expression grammar, the statement grammar, the error and log planes. An implementation of Core can evaluate a `.dsx` head. |
| **Surface** | `elements` · `layout` · `motion` · `defaults` · `input` · `icons` · `markdown` | The element vocabulary, the layout and motion model, the unstyled-baseline law. An implementation of Core plus Surface can render a `.dsx` body. |
| **Navigation** | `router` · `lifecycle` · `overlays` · `split` | Routes, the root plan, presentation, screen lifecycle. |
| **Bus** | `chains` · `facets` · `api` · `platform` | Module identity, chain resolution, facet contracts, typed absence. |
| **Capability** | the per-capability corpora (`files` · `geo` · `crypto` · `capture` · …) | Each is independently claimable. An implementation may support any subset, and must report the rest as `unsupported_platform`. |

### 2.3 An unresolved element renders its children

An implementation that cannot resolve an element **must render that element's children in its
place**. Slot children are the author's declared fallback, and they are the whole reason an
excludable module element is safe to write: the author has already said what should appear when
the module is gone. An implementation may render a marker when there are no children, because a
blank space is the hardest failure to diagnose, but it must not render a marker *instead of* a
fallback the author supplied.

This was a two-of-three guarantee until U12: two renderers honoured it and one dropped the
children, which meant the markup written specifically for the excluded build was the markup that
disappeared. It is stated here because it is the kind of rule that is obvious in every
implementation and invisible between them.

### 2.4 Typed absence is mandatory in every class

An implementation that does not provide a capability **must** refuse it with a structured error
naming why (`unsupported_platform`, with a human-readable message). Returning null, returning a
plausible default, or silently doing nothing is non-conformant even where the corpus does not
pin the specific capability. This is the one requirement that applies outside the corpora,
because it is what makes an incomplete implementation safe to build on.

### 2.5 Ratified divergence

Renderers may differ where a platform makes agreement impossible or dishonest. Such a difference
is conformant **only if it is recorded** in the divergence ledger with the platform reason. An
unrecorded difference is a bug in whichever renderer is wrong.

The system-defaults law (`proposals/system-defaults.md`) is the largest ratified divergence: an
unstyled component is deliberately the platform's own control on every target, so an unstyled
button is not pixel-identical across renderers and must not be. What IS pinned is the precedence
ladder that decides when authored style overrides it.

## 3 · The document

A `.dsx` document has exactly two parts, and the split is lint-enforced
(`OpenSource/Documentation/reference/dsx-anatomy.md`).

**The head** is contract, state and logic: what the document requires, what it holds, what it
does. Declarations only; no markup.

**The body** is pure markup: elements, attributes, and expressions that read the head. No
statements, no logic that is not an expression.

Five document kinds share this shape. The head block names which:

| Kind | Head | Body is |
|---|---|---|
| screen / component | state, actions, api | the visual surface |
| `<server>` | entities, secrets, egress, actions | routes and workers |
| `<cli>` | env, exec, roots, actions | the command surface |

The consequence worth stating plainly: **a backend and a command-line program are `.dsx`
documents**, run by the same expression grammar and the same action runner as a screen. They are
not a second language that resembles the first.

## 4 · The bus

A module *provides*; a surface *consumes*. Neither knows the other exists.

There is exactly one handle, `dsx`. Reaching a capability any other way (a registry singleton, a
notification channel, a global) is non-conformant, because it is unobservable to the bus and
therefore unpinnable by a corpus.

Four shapes, and they are not interchangeable:

| Intent | Shape |
|---|---|
| call a capability you can name | `dsx.module.<chain>.<action>(args)` |
| announce something, 0..N may care | `dsx.fire("name")` / `dsx.hook("name")` |
| ask who owns a role | `dsx.claim("name")` / `dsx.hook("name")` |
| read a value a module declares | `dsx.module.<chain>.context.<var>` |

A module's identity is its dotted **chain**, derived from its position in the module tree. A
manifest declares only its own local segment; nothing hand-writes a full chain. Resolution is the
longest-known-prefix fold at each runtime's dispatch funnel, pinned by `Conformance/chains/`.

Everything a module exposes is declared in its manifest: each action's arguments, its resolve
shape, its error codes with human messages, and executable test cases. Those declarations are
assembled into `CapabilityManifest.json`, which is the machine-readable API surface of an
implementation (`capability-manifest.md`).

## 5 · What is deliberately unspecified

A specification that pins everything cannot be implemented twice. These are open on purpose:

- **Rendering fidelity below the layout model.** Corpora pin geometry, not pixels. Two conformant
  renderers produce different bitmaps.
- **Threading and scheduling.** Statement order is pinned; which thread runs it is not.
- **Storage medium.** The content plane pins generations and staleness, not the file format.
- **Native code beneath the bus.** A capability's implementation language is its own business.
- **Performance.** Nothing here is a latency budget. Budgets are a product decision per target.

## 6 · Reading the specification

| You want | Read |
|---|---|
| the architecture law | `constitution.md` |
| what is pinned, and by whom | `OpenSource/Conformance/INDEX.generated.json` |
| the element and attribute vocabulary | `reference/StackReference.md` + `reference/stack-elements.json` |
| the callable API surface | `ClosedSource/CapabilityManifest.json` + `capability-manifest.md` |
| the document anatomy | `reference/dsx-anatomy.md` |
| the bus in depth | `dsx-native-bus.md` + `facet-contracts.md` |
| the unstyled baseline | `proposals/system-defaults.md` |
| backends and CLIs as documents | `proposals/backend-authoring.md` + `proposals/cli-authoring.md` |

## 7 · Changing the specification

A change to DSX lands in this order, and the order is the whole discipline:

1. **The corpus first.** Write the fixtures that pin the new behaviour, including its refusals.
2. **One implementation**, judged by the corpus.
3. **The other implementations**, judged by the same corpus.
4. **The prose**, here or in the reference, saying what the fixtures mean.

A change that reaches an implementation before it reaches a corpus is how a specification becomes
a description of whatever one renderer happened to do. The `contract_diff.rb` gate enforces the
same discipline for a module's action contracts: a breaking change under a kept name fails; the
name is retired or the major version is bumped loudly.
