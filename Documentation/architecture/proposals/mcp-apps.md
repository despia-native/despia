# MCP Apps — DSX as the interface layer of agent hosts

> **Status: PARTLY LANDED** (2026-08-12) — U0 · U1(grammar) · U2 · U3 are in the tree and
> gated; U1(fan-in emitters), U4 and U5 remain, named in §10 with what each needs. Measured
> against the FINAL upstream extension
> (`modelcontextprotocol/ext-apps`, specification `2026-01-26`), not against memory: every field
> name in §1 was read off the published spec on the date above. Builds on `Core/MCP` (the `mcp`
> facet namespace + the `mcp` scheme — LANDED), `OpenSource/MCP` (the package: loopback server,
> declared rows, approve-before-execute), the constitution (Articles 1, 7, 9), `system-defaults.md`
> (the precedence ladder + token corpus) and `backend-authoring.md` (the residence-with-a-seam-list
> pattern this reuses for the fourth time).
>
> **The one-sentence claim:** an MCP host is a **surface**, the web renderer already renders it,
> and a self-contained zero-dependency HTML view is a thing this build system already emits — so
> DSX can be the interface layer of Claude, ChatGPT, VS Code and Goose without a fourth renderer,
> a new bridge class, or a single new law.

---

## 1 · The standard, as it actually is

MCP Apps (SEP-1865) is the **first official MCP extension**, authored jointly by MCP core
maintainers at Anthropic and OpenAI with the mcp-ui creators. It shipped in Claude, VS Code and
Goose on 2026-01-26, with ChatGPT following the same week. It is FINAL, not a draft, and it is
the convergence point of the older community `mcp-ui` SDK and OpenAI's Apps SDK — which is the
reason to implement the extension rather than either vendor shape.

The mechanism, exactly:

| Concern | The spec |
|---|---|
| Resource identity | the `ui://` URI scheme, reserved for MCP Apps (`ui://weather-server/dashboard`) |
| Content type | exactly one for the MVP: `text/html;profile=mcp-app` |
| Tool → view link | `_meta.ui.resourceUri` (nested). The flat `_meta["ui/resourceUri"]` is DEPRECATED — do not emit it |
| Audience control | `_meta.ui.visibility: ["model" \| "app"]` — whether a result reaches the model, the view, or both |
| Capability negotiation | the host declares `capabilities.extensions["io.modelcontextprotocol/ui"] { mimeTypes }` at initialize; a server checks it **before** registering UI-enabled tools |
| Handshake | view → `ui/initialize` (declares its display modes) → host answers `hostCapabilities` + `hostInfo` + `hostContext` → view sends `ui/notifications/initialized`. **No tool data flows before this completes** |
| Data in | `ui/notifications/tool-input` then `ui/notifications/tool-result`; `tool-input-partial` MAY stream during agent streaming and a view MUST NOT depend on it |
| Calls out | the view calls `tools/call {name, arguments}`; the **host proxies** it to the server and returns a standard `CallToolResult` |
| Sizing | `hostContext.containerDimensions` says fixed or flexible; when flexible the view emits `ui/notifications/size-changed {width, height}` |
| Theming | `hostContext.styles.variables` carries standard CSS custom properties (`--color-text-primary`, `--font-sans`, `--border-radius-md`, …) |
| Network | `_meta.ui.csp` declares `connectDomains` / `resourceDomains` / `frameDomains` / `baseUriDomains`. **Omitted means locked down**: `default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'`. A host MUST NOT relax it |
| Transport | JSON-RPC over `postMessage`, inside a sandboxed iframe — structured and auditable by construction |

**The requirement that governs our design:** *"If host does not support MCP Apps, tool behaves as
standard tool (text-only fallback)."* A UI-enabled tool MUST still return a meaningful `content`
array. UI is an enhancement on a tool that works without it — never a mode the tool only works in.

## 2 · The law: an MCP host is a surface

Article 1 says the kernel names no surface. Article 9 says the web view and the native view are
**equal consumers** that attach to the bus. The agent host is the third consumer class and it
needs no new vocabulary:

```
              modules PROVIDE  (dsx.action / facets.mcp rows)
                        │
                   the bus (dsx)
                        │
   ┌────────────┬───────┴────────┬──────────────────┐
   ▼            ▼                ▼                  ▼
<DSXView/>  <DSXWebView/>   the web page      the AGENT HOST
 SwiftUI /    in-app          (SSR/DOM)      sandboxed iframe,
 Compose      WebKit                          postMessage JSON-RPC
```

Three consequences fall out immediately, and each one is a thing we do **not** have to build:

1. **No fourth renderer.** MCP Apps is HTML in an iframe, so the view is rendered by the
   TypeScript kernel — the renderer that already passes the shared corpus. The unified-codebase
   law is satisfied for free, and a `.dsx` component that renders in Claude is the *same file*
   that renders as SwiftUI on the phone.
2. **No new bridge class.** Article 9's logic transfers verbatim: the postMessage JSON-RPC relay
   is a bounded transport between a web surface and the bus, so exactly **one** module owns it
   (`Core/MCP`'s UI facet), it is policy-free, and no other module may hold the port. The
   in-app precedent is `DSXWebDelegate` reaching the bus through its bound `dsx`.
3. **No new fallback doctrine.** The spec's mandatory text fallback IS Article 7. We already
   require that absence degrades a feature and never bricks anything.

## 3 · Why this is a strong position for us specifically

The spec's hardest practical constraint is that a view must be **entirely self-contained**: the
default CSP blocks every external fetch, script, style and font. Most teams meet that by
inventing a bundling story.

We emit self-contained views already, as a first-class build output:

- `CanvasEditor.html` — the generated page: template + deck + SDK inlined, "double-click the HTML,
  no server, no node_modules".
- `dist/despia-editor.js` — 453.8KB / 138.5KB gz, `<despia-editor>` self-contained, budget-gated.
- `@despia/element` wraps any exposed DSX component as a real Web Component.
- The DOM renderer carries no runtime dependency to inline in the first place.

So the format MCP Apps demands is the format `build:editor-dist` already produces. This is the
unusual case where an external standard landed on our existing shape.

## 4 · The declaration: `facets.mcp` gains `ui`

`Core/MCP` owns the `mcp` facet namespace, and its manifest states the discipline to preserve:
there is no `schema` field and there never will be, because the target action's `args` block
already IS the runtime-validated shape and restating it creates a second place to drift.

`ui` obeys the same rule. A row names a **component**, never a duplicated contract:

```jsonc
"facets": {
  "mcp": {
    "catalogue_search": {
      "action": "search",
      "description": "Search the catalogue.",
      "ui": "Components/SearchResults.dsx"   // OWNED by this module; build-checked
    }
  }
}
```

**LANDED.** `ui` is a new field kind in the graph's closed vocabulary — `ownComponent`, the
one-directory-out twin of `ownAction` (`dsx_graph.rb`). A row naming a component its module
does not carry, or reaching outside its own folder with `..`, **aborts prepare**; that is
mutation-proven, not asserted:

```
✖ module 'Core/Scene': facets.mcp "scene_nodes" field "ui" names component
  "Components/DoesNotExist.dsx", which the module does not carry — the stale-target class
```

Nothing about `ownComponent` is MCP-specific, which is why it joined the generic vocabulary
rather than the MCP owner's emitter — the next facet that needs to name a component gets it
for free.

**The remainder, named:** per-row `visibility` and `csp` are spec passthroughs this grammar
does not carry yet. They are deliberately absent rather than stringly-typed into the current
field kinds: the shaping functions already accept both (`uiToolMeta`, corpus-pinned), so the
work is a manifest grammar decision, not an implementation gap.

What the build does with it (`prepare_modules` fan-in, the pattern every facet already uses):

1. Compile the named `.dsx` through the web compiler into ONE self-contained
   `text/html;profile=mcp-app` document.
2. Register it as a resource at `ui://despia/<scheme>.<action>` and emit `_meta.ui.resourceUri`
   on the tool row (nested form only).
3. Fail the BUILD when the component is missing, is not owned by the declaring module, or names a
   capability the `ui` residence does not admit (§6). The `ownAction` stale-target gate is the
   precedent.
4. Drop all of it when the module is excluded — exclusion stays the one deployment switch.

## 5 · The fallback is derived, not hand-written

The spec requires a text `content` array on every UI tool. The industry default is to maintain
two representations by hand, and they drift.

We should not do that. A `.dsx` document's head declares its contract and state; its body is pure
markup. That is enough to derive a faithful text rendering of the same data the view shows — the
same way `dsx-anatomy.md` lets the linter reason about a document without executing it.

**The rule:** the action's declared `resolve` shape is the fallback, always emitted; the view is
an additional rendering of that same payload. A row whose view needs data the action does not
resolve is a build error, not a runtime surprise. This makes "works in a text-only host" a
property of the grammar rather than a discipline someone has to remember.

## 6 · The `ui` residence and its seam list

`backend-authoring.md` established the pattern: a residence names exactly the seams a body may
reach, and the list is exhaustive because the runtime interprets rather than evals. The `ui`
residence is the fourth run of that playbook, and the CSP makes it non-negotiable:

| Seam | Admitted in a `ui` document? |
|---|---|
| `ui/notifications/tool-input` / `tool-result` payloads (the document's own data) | yes |
| `tools/call` back to the server, proxied by the host | yes, and it is the ONLY egress |
| `dsx.module.<chain>.<action>()` | compiled to a proxied `tools/call`; the target must itself be a declared `mcp` row |
| bare `fetch` / WebSocket / `crypto.subtle` over the network | **no** — `connect-src 'none'` by default; lint rejects at build |
| external fonts, images, scripts | **no** unless declared in `_meta.ui.csp.resourceDomains` |
| host state, app state, `dsx.global` from the phone app | no; a view is not a node |

This is a lint tier, not a runtime hope — the same posture as the W9 execution tiers and the
server document's seam list. A document that cannot be admitted fails `lint_dsx --strict`.

## 7 · Theming: the host is a platform

`system-defaults.md` says the unstyled baseline IS the platform, with one precedence ladder
(defaults < tokens < sheets < shared < `:native` < exact target). An agent host is simply a new
platform on that ladder: it hands us `hostContext.styles.variables`, which is a token table by
another name.

**Map host CSS custom properties into the token layer at initialize.** Then an unstyled DSX view
looks correct in Claude, in ChatGPT and in VS Code for the same structural reason an unstyled
button looks correct on iOS and Android, and an author who wants to override still does it through
the one ladder. The token corpus (`Conformance/defaults/tokens.json`) gains the host mapping as
fixtures, so parity is falsifiable rather than eyeballed.

## 8 · Size, and the profile that fixes it

Views are prefetched and cached by hosts, but 138KB gz per view is the wrong shape if every tool
inlines a full renderer.

The fix is an existing mechanism, not a new one: **a release profile for the MCP-UI renderer.**
`select_release_profile.rb` already resolves an allowlist into `excluded.json`; an `mcp-view`
profile drops the editor, the canvas tooling and every element family a view cannot use. Budget it
the way the embed slice is budgeted (`__DSX_OPTIONAL_FETCH__`, the 40,960-byte G10 law with its
measured spare) — a named ceiling with headroom proven by measurement, gated in CI.

## 9 · Security

The bridge is the attack surface, and three of the four mitigations already exist:

- **`mutates` is the consent hook, already in the row.** A view calling `tools/call` toward an
  action that declares `mutates` is approval-gated no matter which protocol asked — `Core/MCP`'s
  manifest already states this law. It now also governs view-initiated calls.
- **Descriptions are untrusted text that changes no policy.** Same rule, extended: markup arriving
  in a view's data is content, never instruction, and it can never widen the seam list.
- **One owner for the port.** `Core/MCP` owns the postMessage relay as a policy-free transport;
  `check_module_rules` should grow the twin of the WebKit-confinement rule so no other module can
  open one.
- **New:** a view must never be able to reach a tool that was not declared UI-reachable. Add
  `reach: ["ui"]` semantics to the existing `provides`/`reach` grammar so view-callable is a
  declaration, fail-closed, exactly like `["widget"]` and `["activity"]` are for snapshot nodes.
  (The studio-apps program applies the same fail-closed declaration discipline one tier up: an
  app's `tool` slot projects only its own declared actions, and its grants are manifest-static —
  `studio-apps.md` §4–§6.)

## 10 · Execution plan

Each phase is independently shippable and gated; none blocks v4.

| Phase | Deliverable | State | Gate |
|---|---|---|---|
| **U0** | Conformance corpus `OpenSource/Conformance/mcp-apps/{apps,server}.json` — handshake order, buffering, partial-channel advisory rule, id matching, error-as-value, size coalescing, theming, capability negotiation, fallback presence, csp omission | **LANDED** | 19 + 18 cases green on TS, in `npm test` and `npm run conformance` |
| **U1** | `facets.mcp` `ui` key (the `ownComponent` field kind) + the view compiler | **grammar + compiler LANDED**; the prepare-time fan-in that WRITES the resource table is the remainder | stale-target abort mutation-proven; `mcp-view.test.ts` 7 cases |
| **U2** | The view bridge: `ui/initialize`, both data notifications, proxied `tools/call`, `size-changed`, theming | **LANDED** — protocol in `kernel/src/mcp/apps.ts` (pure), DOM binding in `dom/src/mcp-app.ts` | corpus green; typecheck |
| **U3** | Derived text fallback + capability-gated metadata off one code path | **LANDED** — `kernel/src/mcp/result.ts` | `server.json` asserts a text-only host gets full function |
| **U4** | Host token mapping into the precedence ladder + `mcp-view` release profile with a measured budget | **PARTLY** — `applyTokens` writes host variables onto the view and the compiler enforces a `budgetKB`; the profile itself and the token fixtures remain | needs `Conformance/defaults` rows + profile `--check` |
| **U5** | The package face: `OpenSource/MCP` docs + the Kotlin/Swift routers running `server.json` | **OPEN** | `check_despia_mcp.rb`; mirror lane |

**The seam list is enforced, and how it is enforced is worth recording.** The first honest
attempt asserted that the compiled bundle contains no `fetch(` call site. It failed
immediately, and correctly: the bundled kernel *contains* its network surface because it is
ONE kernel shared with every renderer, and carving a per-surface hole in it would be exactly
the `#if` disease Article 2 bans. So the gate moved to where it belongs — the **authored
document** (`viewSeamViolations`), which rejects `fetch()`, `WebSocket`, `EventSource`,
`XMLHttpRequest`, `sendBeacon` and `<api>` at build time with the fix named in the message.
A view that reaches past the list now fails the build instead of compiling clean and dying
silently inside a host. Comments are stripped before the scan, so a doc block explaining the
ban does not trip it. Known limit, stated rather than hidden: the scan reads the named
component's own source and does not yet walk child components — that belongs in the
`lint_dsx --strict` twin, and it is the U1 remainder's natural companion.

## 11 · Decisions for the owner

1. **Do our own hosted developer-tooling MCP ship views?** Recommendation: yes, and it is the
   showcase — a build result, a lint report, or a rendered preview of the screen the agent just
   wrote, drawn with DSX inside Claude. It is also dogfood: the MCP that teaches agents about
   Despia would be rendering DSX to make its point.
2. **Do we expose this to app authors' own MCP servers?** Recommendation: yes, and it is the
   stronger product claim — "if you can build a backend you can build an MCP" becomes "…and its
   interface is the same markup as your app's."
3. **`mcp-ui` community SDK compatibility.** Recommendation: no. It converged into this extension;
   supporting both doubles the surface for a shrinking audience. Revisit only on demand.
