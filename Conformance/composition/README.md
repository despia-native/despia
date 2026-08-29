# composition/ — the attribute-binding corpus

What a component INSTANCE is handed, and how deep composition may go.

`attribute-binding.json` carries the law in its `_note`: markup has exactly one way to
write a consumer attribute (`name="…"`) and three things an author can mean by it. The
fold decides which, and it is the same function on all three renderers because a
component that receives an object on one and the string `[object Object]` on another is
not one component.

| kind | when | the child receives |
|---|---|---|
| `static` | no `{{` anywhere | the attribute text |
| `value` | the trimmed template is exactly one `{{ … }}` | the expression's VALUE |
| `text` | anything else | the interpolated sentence |

## Why `value` had to exist

Before the fold a `.dsx` component's props were interpolated unconditionally, so every
prop arrived as a string. That is invisible for a label and fatal for structure:
`<Node data="{{ item.children }}"/>` handed the child `"[object Object],[object Object]"`,
so a component that renders itself — a tree, an outliner, a comment thread, a file
browser, a DOM inspector — could not pass its own children down. The module-facet path had
already made this decision correctly and privately, so the two kinds of component
disagreed about what a prop is. This corpus is that decision promoted to law.

## The instance store

A component instance OWNS its state. `instantiate` (the web reference,
`packages/dom/src/mount.ts`) mounts every instance against a store born with it: head
declarations - variables, computed, formulas, actions, `<api>` handles, attribute
defaults, classes - register per instance, two instances hold independent state, and a
sibling's `<api as=>` cannot be swallowed by first-declaration-wins. Attributes ride the
instance scope (live), `on:<event>` handlers keep the CONSUMER's environment (bubbling,
never a self-loop), slot content is the consumer's markup and binds in the consumer's
scope AND store, and cross-surface state stays `global.*` / `route.*`.

Enforcement: TS behaviorally per-PR (`packages/dom/test/composition.test.ts`, "two
instances hold independent state" + the slot-scope case); Kotlin `:render`
(`StackNodeView.kt` component branch) and Compose Desktop (`DesktopRenderer.kt`) mount
the template against a per-instance `StackStore` with the slot path reading the caller's
store; Swift mounts through `StackComponentInstanceHost` (`Stack.swift`). The native
renderers' behavioral gates ride their platform lanes.

## The recursion block

`recursion.cap` pins the component depth floor. It is **not** a feature budget: a
self-recursive component terminates because the DATA terminates, and legitimate nesting
must never reach the cap. It exists for cyclic or corrupt data, where the alternatives are
an unbounded render and a dead stack. Each renderer asserts its own constant against
`cap`, so the three cannot drift.

| Runner | Reads | Runs |
|---|---|---|
| TS | `OpenSource/Web/packages/kernel/test/composition-conformance.test.ts` (fold + typed) · `packages/dom/test/composition.test.ts` (the renderer, incl. `COMPONENT_DEPTH_CAP`) | per-PR (`npm test`) |
| Kotlin | `:core CompositionConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `CompositionConformance`, driven by `RecordMain.swift` | record lane |

Every cross-runtime divergence bug becomes a fixture here in the same commit as its fix.
