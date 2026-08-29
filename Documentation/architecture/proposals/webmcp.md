# WebMCP — the tool plane, spoken by the browser

> **Status: W0 + W1 + WE1 + WE2 + WE4-WE7 LANDED (the editor plane is COMPLETE)** (2026-08-27) — the `<tool>` head row, the shared fold on all
> three renderers, the corpus, the browser projection and its oracle are in the tree and
> gated. W2 to W5 (the shell's inbound half, the loop's page source, the native document
> source) remain, each named in §8 with what it needs. Measured against the LIVE standard
> (`webmachinelearning/webmcp`, W3C Web Machine Learning CG draft of 2026-08-26; Origin Trials in
> Chrome 149 and Edge 150, shipped in ChatGPT Desktop, experimental in Brave Leo), not against
> memory: every API name in §1 was read off the published spec on the date above. Builds on
> `local-ai-engine.md` §4.6 (three tool sources, one registry — **page functions are a launch
> source whose registration API was never specified**; this proposal specifies it as the
> standard), `Core/MCP` + `Core/LocalAI` (the `facets.mcp` / `facets.tools` grammar — "one
> grammar, two protocols"), `backend-authoring.md` + v0-live W3 (the `<tool>` row on the
> `<server>` node), `mcp-apps.md` (the agent host as a surface), the constitution (Articles 1, 2,
> 3, 4, 7, 8, 9) and `web-surface-policy.md` (composition decides presence, the gate decides
> audience).
>
> **The one-sentence claim:** WebMCP is not a fourth tool system — it is the browser's spelling
> of the tool plane DSX already ships. The same declared rows that feed the in-app agent loop and
> the MCP faces project into `document.modelContext` on the renderer that lives in a browser, and
> the same standard becomes the page-tool seam §4.6 named but never specified — so a Despia app
> is drivable by the agents its users already have, and a Despia shell makes any WebMCP page
> agent-ready before most browsers do, from ONE declaration and zero new laws.

---

## 0 · Why now, and why us

The product law says the cycle is Build → Ship → Observe → Understand → Act → Grow. The agent
plane (`v4-launch/platform/07-agent-plane.md`) covered the *builder*: "the project made reachable
by ANY agent the customer already uses, over MCP." WebMCP is the same sentence for the *shipped
app*: the app made reachable by any agent the **end user** already uses — the agent in their
browser, in their ChatGPT Desktop, in their OS. The alternative the standard exists to displace
is DOM automation: agents screenshotting the page, diffing accessibility trees, and simulating
clicks. A framework whose documents already declare their contract in the head has no business
being scraped.

Our position is unusually strong for the same structural reason it was for MCP Apps: **the shape
the standard wants is a shape we already have.** A WebMCP tool is a name, an untrusted
description, a JSON Schema, and a callback that resolves a promise. A DSX tool row is a name, an
untrusted description, a schema **derived from a declared contract**, and a declared action
dispatched on the bus. Everyone else registers tools by hand in page JavaScript; DSX can derive
the entire registration from what authors already write — and the derivation cannot drift,
because there is nothing hand-written to drift.

## 1 · The standard, as it actually is

| Concern | The spec (CG draft, 2026-08-26) |
|---|---|
| Entry point | `document.modelContext` (`partial interface Document`, `[SecureContext]`) — moved from the explainer's `navigator.modelContext`; the API surface is still moving |
| Interface | `ModelContext : EventTarget` — `registerTool(tool, options)` · `getTools(options)` · `executeTool(tool, input, options)` · `ontoolchange` |
| Tool descriptor | `ModelContextTool { name (required), title, description (required), inputSchema (JSON Schema), execute (required), annotations }` |
| Annotations | `ToolAnnotations { readOnlyHint = false, untrustedContentHint = false }` — hints, explicitly untrusted |
| Execute callback | `Promise<any> (inputObject, { signal })` — an `AbortSignal` rides every call for cancellation |
| Result shape | MCP vocabulary: `{ content: [{ type: "text", text }] }`, or structured JSON; `executeTool` returns the stringified result |
| Unregistration | pass `signal` at registration; `controller.abort()` removes the tool |
| Name grammar | 1–128 chars, ASCII alphanumeric plus `_ - .` |
| Duplicates | `registerTool` rejects a duplicate name, an empty name/description, an invalid schema |
| Change signal | the `toolchange` event fires on registration and removal |
| Cross-origin | default scope is the top-level document + same-origin iframes; cross-origin needs Permissions Policy `"tools"` (`allow="tools"`, default `['self']`) and explicit `exposedTo` origin lists |
| Agent discovery | the UA "observes" registered tools on an implementation-defined agent queue; how tools reach agents (MCP or otherwise) is deliberately not mandated |
| Declarative twin | HTML forms as tools (`toolname` / `tooldescription` / `toolparamdescription` / `toolautosubmit`, `SubmitEvent#respondWith()`) — **experimental, algorithms TBD** |
| Status | W3C Web Machine Learning **Community Group** incubation; no Working Group adoption yet |
| Implementations | Chrome 149 Origin Trial · Edge 150 Origin Trial · ChatGPT Desktop shipped · Brave Leo experimental · Firefox/WebKit positions pending |

Authorship is Microsoft + Google jointly, with the response vocabulary lifted from MCP on
purpose: "WebMCP derives direct inspiration and shares a common vocabulary with MCP" while being
client-side and session-scoped — it complements backend MCP rather than replacing it, which is
exactly the relationship our loopback server and `<server>`-node face already have to each other.

**The requirement that governs our design:** the API is real (two origin trials, one shipped
host) and *young* (the entry point has already moved once, `provideContext` became `registerTool`,
the declarative half is TBD, and open issues touch cancellation events and cross-document
execution). So DSX pins **semantics in its own corpus** and confines the spec's *spellings* to
one adapter file per platform — when the CG renames something, the follow is a one-file diff per
renderer, not a grammar change, exactly the posture `mcp-apps.md` took toward `_meta` key drift.

## 2 · The law: no new vocabulary

The constitution's preamble: *"DSX is a native message bus: modules provide, surfaces consume."*
`mcp-apps.md` added the agent host as the third consumer class. WebMCP completes the square with
nothing new to invent:

- **The user's agent is a consumer.** On Despia Web the UA's agent calls the app's declared
  tools through `document.modelContext`; in a shell the in-app loop (`local-ai-engine.md` §4.6)
  is the same consumer attaching at the bus instead.
- **The page is a provider.** A page loaded in `<DSXWebView/>` that registers WebMCP tools is
  providing capability to the bus — which `Conformance/ai/tools/tools.json` anticipated
  verbatim: *"three sources feed ONE registry — module actions … **page tools** and MCP tools
  (their arbitrary JSON Schema passes through VERBATIM, never down-converted)."* The
  registration API for that source is now simply the standard, not an invention.

One tool, declared once, already has four residences. This proposal adds the fifth and projects
all of it:

| Residence | Grammar | Serves | State |
|---|---|---|---|
| module manifest `facets.tools` | `action` (ownAction) · `description` · `mutates` → ToolsMap | the in-app agent loop | grammar LANDED |
| module manifest `facets.mcp` | same + `ui` (ownComponent) → McpMap | the loopback MCP server + MCP Apps | grammar LANDED |
| `<server>` document `<tool>` body row | `as` · `action` · `description` · `auth` · `mutates` | the `/mcp` streamable-HTTP face | LANDED (W3) |
| **NEW** app document `<tool>` head row | `as` · `action` · `description` · `mutates` | `document.modelContext` (browser) · the shell's document-tool source (in-app agent) | this proposal |
| **NEW** the page itself | the standard API, implemented by Dom | the shell's page-tool table → the loop's `source:"page"` | this proposal |

The one-grammar law extends unbroken: **a tool never declares a second contract.** The row names
a declared action; the action's declared inputs are the schema; the description is untrusted
text that changes no policy; `mutates` is the approval gate no matter which protocol asked.
Every sentence of that is already law in `Core/MCP/dsx.json`, `Core/LocalAI/dsx.json`,
`server_document.rb` and the `ai/` corpora — WebMCP inherits it, word for word.

Constitution verdicts, article by article (the `web-surface-policy.md` §8 template):

| Article | Verdict |
|---|---|
| **1 — kernel names nobody** | The kernel never names `document`, `navigator`, or WebMCP. The pure halves (row → descriptor derivation, the page-tool table fold, result shaping) are platform-neutral kernel primitives beside `mcp/result`; every DOM-API spelling lives in a surface owner. |
| **2 — everything is a module** | The shell implementation is Dom's (it is injection into a web page); the loop consumes through the bus; nothing new is host code. |
| **3 — no exemptions, feature-detectable** | Projection is `dsx.has`-style detection of `document.modelContext`; the shell face is ordinary `dsx.module.dom.*`; exclusion drops it whole. |
| **4 — every value is module config** | The shell's page-facing API is governed by a Dom `config.json` key, read at surface construction. |
| **7 — fail-open** | No UA support → nothing registers → the app is byte-identical. No agent → tools lie dormant. An excluded Dom → no page tools, typed absence. Nothing bricks. |
| **8 — names, not platforms** | The corpus pins the cross-renderer contract (registration semantics, derivation, dispatch envelopes); spec spellings stay in one adapter per platform. |
| **9 — WebKit only in Dom** | The injected implementation rides `DomBridgeKit.install` / `VirtualBridge.install` and nothing else; `<WebView/>` stays bare **by construction**; no other module may open a page-facing tool channel. |

## 3 · Direction one — PROJECT: the app's declared tools reach the user's agent

The app document grows a head row, the exact mirror of the `<server>` node's body row:

```xml
<screen>
  <head>
    <tool action="addTodo" description="Add a new item to the user's todo list." mutates="todos"/>
    <tool action="search" as="search-products" description="Search the catalogue by text."/>

    <action as="addTodo" inputs="text">
      dsx.variable.todos.push({ text: text, done: false });
      dsx.module.haptic.success()
    </action>
    …
  </head>
  …body…
</screen>
```

- `action` must name an action **this document declares** — the stale-target class fails the
  build (`readTool`'s existing rule, `server-document.ts:353`). `as` defaults to the action
  name; the name must satisfy both grammars (our plain identifier is a strict subset of the
  spec's 1–128 ASCII rule, so nothing new to enforce). A duplicate name is a build error.
- **Why a row and not an attribute on `<action>`:** `<action>` cannot grow attributes —
  *"because the identifier is `as` and every other attribute is an input, a new attribute on
  `<action>` is indistinguishable from a parameter"* (the reason `lint_dsx.rb:749` defers
  `sample=` on actions). The row is not a stylistic choice; the grammar forces it. It is also
  what keeps exposure **explicit**: an action is never agent-callable by accident.
- **Registration follows the mounted document.** A row registers while its declaring document is
  mounted and aborts (the spec's `signal`) on unmount — so the tool set follows app state with
  no new machinery, `toolchange` fires for free, and a multi-screen app presents agents exactly
  the tools its current screen can honor. The entry document's rows are app-lifetime.
- **Execution is the entry call.** The agent's `inputObject` is the payload; declared inputs
  bind payload keys — the semantics `actions.json` already pins
  (`entry-declared-input-binds-the-host-payload`: "a host (HTTP request, CLI command, queue
  message) invokes an action with a payload and has no caller scope"). The agent is the fourth
  host in that sentence. The action's `return` value is shaped through the same
  `mcpToolResult` path the server face uses; a `throw` becomes an `isError` result with a
  correlation id — the tool failed, the protocol did not.
- **The schema is derived, honestly.** Document-action inputs are untyped names, so the schema
  is the server face's exact derivation (`mcp-face.ts:97`): `{ "type": "object", "properties":
  { <input>: {} } }` — *"an honest schema, never an invented one."* When the declared-args
  table lands (the same future `Core/MCP`'s README already names for module rows), types
  flow in here with zero grammar change. **That table is now specified: `proposals/action-contracts.md`
  (PROPOSED, corpus-first) — the `<contract>` head row, the one `ActionContract` IR, and the
  measured reasons the existing module `args` table cannot simply be wired into this derivation
  as it stands.** Annotations derive too: a row with no `mutates` emits
  `readOnlyHint: true`; a row with it emits none — derived from the row, never hand-written.
- **Fail-open, feature-detected.** At mount the binding does one
  `typeof document.modelContext` check. Absent (today: every browser without the origin trial)
  → no-op, zero cost, zero behavior change. Present → the rows register. Permissions Policy,
  secure contexts, cross-origin `exposedTo` are the UA's to enforce; we register only into the
  top-level document we own.

Where it lands (the `<api>`-block checklist, run once more):

| Piece | File |
|---|---|
| Lint legality | `OpenSource/Conformance/lint/facts.json` — `builtinTags`, `declTags`, `headRank` (rank 2, beside `event`: it is interface), `headOrderHint` (+ lint cases; changes both linters at once) |
| TS parse | `packages/compiler/src/component.ts` — `ComponentHead.tools`, `emptyHead()`, `parseHead` `case "tool"` with the declared-action check |
| TS pure core | `packages/kernel/src/mcp/webmcp.ts` — row → `ModelContextTool` descriptor derivation, reusing `mcp/result.ts` shaping |
| TS binding | `packages/dom/src/webmcp.ts` — feature detection + register/abort on mount/unmount, wired from `mount.ts` beside the `<api>` mount; SSR renders nothing (registration is client-only, the adopt-hydration path registers like any mount) |
| Kotlin twin | `Engine/Android/core … WebMcp.kt` (pure derivation + document tool table) + the `StackNodeView.kt` head collector; the shell consumer is §4 |
| Swift twin | `Engine/iOS/WebMcp.swift` (pure) + `Stack.swift` `StackHead.register` case; compile-pending, rides Codemagic |
| Registries | `dsx-anatomy.md` shape block + `StackReference.md` head table + `generate_editor_catalog.rb` `STRUCTURAL` — and note the audit finding: `<api>` is absent from the anatomy shape block and the STRUCTURAL map today; landing `<tool>` should close that drift for both rather than copy it |

On native surfaces the same row feeds the same table with a different consumer: the document's
tools join the in-app loop as a **document source** beside module/page/MCP rows ("a source is
just a registry contract" — §4.6's pluggability sentence, used as designed). One declaration;
the consumer is whichever agent the surface has.

## 4 · Direction two — IMPLEMENT: the Despia shell is the user agent

Inside a Despia app, *we* are the browser. `<DSXWebView/>` pages get a working
`document.modelContext` years before WebKit ships one — implemented by the one module allowed to
touch a page:

- **The script rides the bridge install.** `DomBridgeKit.install` (iOS) /
  `VirtualBridge.install` (Android) gain one document-start script implementing the
  author-facing contract: `registerTool` validates (name grammar, duplicate, empty
  description) and posts a structured registration over the existing `__dsxWire` transport;
  `executeTool`/`getTools` answer from the page-local table; the callback registry keeps the
  `execute` closures page-side. A real UA implementation, when one appears inside a WebView,
  wins: the script yields if `document.modelContext` already exists. We implement the
  **author-facing contract**, not the UA-internal observation algorithm.
- **The gate is the gate.** Registrations are wire messages, so `DomBridgeGate.allowsIngress`
  already decides which pages may register — origin-anchored, `bridge_policy` words unchanged,
  same-origin subframe rule unchanged, `web.bridgeDenied` on refusal. `<WebView/>` never gets
  the API: *component-presence is the gate, never a flag* — the primitive has no wire to ride.
  A Dom `config.json` key (`model_context`, default on for the app surface) governs the
  install per Article 4, decided at construction like everything else in the configuration.
- **Dom owns the table, policy-free.** Dom records `{ name, description, inputSchema
  (verbatim), annotations, origin, surface }` per registration, drops a page's rows on
  navigation commit (a page's tools die with the page), exposes the read face and the event —
  `dsx.module.dom.tools({ target })` · a `web.toolchange` void event on the `web.*` plane Dom
  already owns — and one dispatch verb, `dsx.module.dom.callTool({ target, name, args })`,
  which invokes the page's `execute` through the gated egress path and settles from its
  promise. Dom relays; it decides nothing — approval policy lives with the consumer, exactly
  as §4.6 places it.
- **The loop's page source closes.** `Core/LocalAI`'s registry consumes `dom.tools` +
  `web.toolchange` as its `source:"page"` adapter — and every law the `ai/` corpora already
  pin applies unchanged: schemas pass through verbatim, descriptions are provenance-tagged
  untrusted input, a page tool's hints never loosen policy (no `mutates` declaration from a
  page is trusted; page tools serialize and inherit the source's approval policy), a hung
  `execute` yields the typed `tool_timeout` the loop already speaks, and the depth cap holds.
  The corpus cases that today run against a seam (`source:"page"`, `cart.addItem`) become
  cases running against the real wire.

The payoff sentence for the web-to-app product: **a customer whose website adopts WebMCP — or
is built on Despia Web, §3 — ships an agent-ready native app by wrapping it, no app-side work,**
because the same registration their page makes for Chrome's agent is the one Dom captures for
the in-app agent and, through the existing `facets.mcp`/loopback plane on desktop, for external
agent hosts. One page, every agent tier we have.

## 4b · WebMCP is a FACE, not a replacement — the five, and which one you want

The question this section exists to answer, because it was asked and the answer was not
written down anywhere: *we already have MCP; what is this?*

**Nothing here replaces anything.** Despia now has five faces over ONE tool law. They differ
by **who is asking and on whose behalf**, which is the only distinction that matters when
choosing:

| Face | Who calls it | On whose behalf | Where the tool is declared | State |
|---|---|---|---|---|
| **Backend MCP** — the `<server>` node's `/mcp` | any MCP client, anywhere, over the network | **your service**, with the caller's identity | `<tool>` body row in a `<server>` document | LANDED (v0-live W3) |
| **WebMCP** — `document.modelContext` | the agent in the **user's own browser** | **the person**, in their live session, with their login and their screen | `<tool>` head row in an app document | LANDED (this proposal, W0+W1) |
| **Device MCP server** — loopback | the in-app agent, the app's own web surface, or (desktop, with consent) an external host | **the device**, offline | `facets.mcp` row in a module manifest | wrapper landed, transport seam unbound |
| **Device MCP client** | the app, outward | **the app**, to servers it declared | config + `connect` | registry landed, transport open |
| **Toolchain MCP** — `/edit/mcp` | a coding agent | **the developer**, building the project | generated from `dsx.cli.dsx` | LANDED (agent-plane §0) |

The first two are the ones an app author picks between, and the choice is not close once it
is stated properly:

- **Backend MCP is agent-to-your-service.** It runs with no browser open, reaches the
  database, holds secrets, declares egress, drains queues. An agent using it acts as a
  client of your API. Use it for anything privileged, anything scheduled, anything that must
  work when nobody is logged in.
- **WebMCP is agent-to-your-user's-session.** It runs in the page the person is looking at,
  with their auth already in the browser, over the state currently on screen. An agent using
  it acts *as the person*: it can add to the cart they are looking at, apply the filter they
  described, fill the form in front of them. There is no API key, no server round trip, and
  no headless copy of the app that has to be kept in sync.

Or, in one line: **the backend face is how an agent uses your product; the web face is how an
agent uses your product AS your customer.** A serious app wants both, and both are the same
`<tool>` word over the same declared action, which is why neither costs the other anything.

The upstream spec agrees and says so directly: WebMCP "complements rather than replaces
backend MCP; both can coexist."

## 4c · The agent plane is an EDITOR primitive, not a file format

> **Owner-directed 2026-08-27:** *"MCP and AI agents are a platform primitive that should
> also be nicely woven into the editor"* — front-end tools AND backend MCP functions, managed
> visually, so people can build AI-first applications without reading a proposal first.

The directive is right and the gap it names was measurable. Both faces PARSED and then
vanished before the Studio could see them:

- `serverViews()` built routes, workers, entities and actions and **never read `doc.mcp`**, so
  a `<tool>` row in a `<server>` document was invisible on the one surface that exists to show
  what a backend exposes.
- `/edit/api/head/` filtered declarations to `variable|computed|formula|action|api`, so a
  `<tool>` row in a screen was invisible too.

An app could therefore expose tools to every agent on the internet and the builder would not
mention it. **LANDED:** both endpoints now carry the rows, and the Studio has a rail
destination — **Tools** — that answers one question in one place:

```
Tools                                                          3 declared

  In this screen        the agent in your user's browser
    submit    writes orders                              → submit
      Send an order to the customer.
      id
    count-open  reads only                               → refresh
      Refresh and count the open orders.
      no arguments

  On the server   notes    any MCP client, at /mcp
    recent    signed in                                  → recent
      List the caller's ten most recent notes.
      no arguments
```

Three decisions worth keeping:

1. **One surface, both faces.** A person asking "what can an agent do with my app" is asking
   ONE question. Splitting page tools and server tools across two destinations would make the
   product's own composition (§4b) look like a limitation. The residence is a property of the
   row — a subtitle — not a different screen.
2. **The derived schema is SHOWN, never asked for.** Every row draws the arguments the named
   action declares, through the same `projectTools` fold the runtime runs. The one thing the
   surface must never grow is a schema field: the moment an author types a shape here, the
   contract has two homes. Showing the derivation is how the guarantee becomes visible
   instead of merely true.
3. **A broken row is drawn, not dropped.** A `<tool>` naming an undeclared action fails the
   build; omitting it would tell an author their document is fine when it does not compile.

**A tool is first-class in the LOGIC plane, which is where it matters most (WE1b).** A
read-only list beside the code would have made the agent face a sidecar. It is not one: a
tool is a declared action with a SECOND CALLER, so the logic plane carries it as a fact ON
the body rather than as a parallel list that could disagree.

- `/edit/api/logic/<doc>` annotates every body an agent can call with `agent` — on BOTH
  faces, since the same endpoint already draws backend documents (`server/notes.dsx`).
- The body list names the tool: `refresh` · `Agent · count-open` · `13 steps`, with the plug
  mark. An action no row names carries nothing, so the badge means something.
- **The flow's ENTRY NODE is titled for the agent.** The canvas reads `AGENT · COUNT-OPEN`
  where it used to read `Action · Refresh`, because a tap is not what starts this flow any
  more. That is the whole visualization argument in one node: the JSE below it is drawn
  exactly as it always was, and the thing that changed is who is shown pulling the trigger.
- A contract strip above the drawing carries what the node has no room for: the sentence a
  model reads to decide, where it can be called from, the derived arguments, and what the
  call writes.

**VISUALLY EDITABLE (WE2), because a surface you can only read sends people back to the
file.** The Tools destination is a three-pane direct-manipulation editor: the navigator, the
tool list (both faces), and an inspector for the one thing selected. Every field writes a
real attribute on a real `<tool>` element through the surgery door
(`/edit/api/edit/:doc` — `insertNode` to add, `setAttribute`/`removeAttribute` to edit,
`removeNode` to delete), so the file stays the truth and this is a way of typing it rather
than a second model of it. Four decisions:

1. **The field set is COMPLETE.** `as` · `action` · `description` · `mutates` is the entire
   grammar of a page row. There is no fifth attribute, so there is no reason to open the
   file — which is the actual test of whether a visual editor is finished.
2. **The action is PICKED, never typed.** The picker offers exactly the actions this
   document declares, minus the ones already wired. The build error this surface exists to
   prevent therefore cannot be authored in it at all.
3. **The schema is the one thing the form does not ask for.** It shows a live *What the
   agent sees* panel derived from the chosen action. The moment a field accepts a shape, the
   contract has two homes; showing the derivation is how the guarantee becomes visible.
4. **An edit is attribute surgery, not delete-and-reinsert**, so the author's own formatting
   and the row's position survive a change of description.

The served face is READ here and written in its own document: the surgery door is scoped to
a package's `Components/`, and widening that boundary to reach `server/` is a security
decision rather than a convenience. The inspector says so in a sentence instead of showing a
disabled form.

## 5 · What does NOT change

- **The MCP faces stay.** WebMCP is session-scoped and client-side; the loopback server, the
  `<server>` node's `/mcp` face, the toolchain MCP and MCP Apps serve different consumers over
  the same rows. The spec itself frames the two as complements. Nothing migrates. Measured,
  not asserted: landing W0+W1 touched `packages/server/src/mcp-face.ts` zero times,
  `Core/MCP` zero times and `OpenSource/MCP` zero times.
- **No auto-projection of module rows to the UA.** `facets.tools`/`facets.mcp` rows serve the
  in-app agent and the MCP server; projecting a module's tools to an arbitrary browser agent is
  a different trust boundary and stays opt-in-by-absence in v1 (a later `reach`-style
  declaration can open it deliberately, the `["ui"]` precedent from `mcp-apps.md` §9).
- **No third-party transport compat.** Extension polyfill ecosystems (the pre-standard MCP-B
  lineage) are not implemented; we speak the standard API only, feature-detected. Revisit on
  demand — the `mcp-ui` ruling's logic.
- **No declarative-forms compile.** The upstream form-attribute API is explicitly TBD; DSX
  documents are already a stronger declarative surface. When it stabilizes, a compiler pass
  could emit it — deferred, named here so it is not re-derived.
- **`window.dsx` is untouched.** The page bridge and its members stay exactly as
  `runtime.js` builds them; WebMCP is a parallel standard surface, not a replacement for the
  proprietary one.

## 6 · Security

The attack surface is two-directional, and every mitigation is an existing law applied:

| Threat | Law |
|---|---|
| A foreign page registers tools into the app | the bridge gate: ingress is origin-anchored (`bridge_policy` `app` default), `<WebView/>` has no wire, subframes follow the same-origin rule |
| A page talks the agent into a harmful call | `mutates` is a property of the **row**, approval-gated regardless of protocol; page tools carry no trusted mutates and serialize under the source's approval policy |
| Descriptions steer the model | untrusted, provenance-tagged per source, change no policy — the sentence already in three manifests and two corpora |
| A hung page callback stalls the agent | per-dispatch deadlines, typed `tool_timeout` back to the model (`ai/tools` law 6) |
| Tool results as instruction injection | results are content, never instruction; `untrustedContentHint` rides the descriptor honestly where we know the payload embeds page-derived text |
| The UA calls a mutating app tool without a human | our runner enforces the row's approval gate even when the UA asked — the UA's own human-in-the-loop is additive, never substituted |
| Spec drift breaks apps | corpus pins semantics; spellings live in one adapter per platform; a rename is a one-file follow |
| Registration as exfiltration | `registerTool` is not network; egress rules, the token boundary and the consent gates of the MCP plane are untouched |

## 7 · Conformance

`OpenSource/Conformance/webmcp/` — two files plus the README naming every runner, the
`mcp-apps` shape:

- **`project.json`** — the outbound law: row → descriptor derivation (name default, identifier
  grammar, honest input schema, `readOnlyHint` derivation), duplicate abort, entry-call
  dispatch with payload binding, `return` → result shaping, `throw` → `isError` +
  correlation, mount/unmount registration lifecycle, absence no-op. Runs on **all three
  renderers** (TS + `:core` JUnit + Swift via `RecordMain`), because the row parses on all
  three.
- **`registry.json`** — the inbound law: registration validation (spec name grammar, duplicate,
  empty description), verbatim schema pass-through, per-page table lifetime (navigation drops
  rows), `toolchange` emission, provenance tagging, dispatch round trip with deadline →
  `tool_timeout`, abort semantics, gate refusal as silence-plus-`web.bridgeDenied`. Pure-fold
  runners on TS + Kotlin; the Swift twin rides the record lane; the WebKit wiring itself is
  proven where wiring is always proven — the Dom security suites
  (`DomBridgeSecurityTest` twins) and a browser oracle, not the corpus.

Both land **with their TS runner in the same commit** — the conformance index's ratchet forbids
the unrun set from growing, and `check_gate_coverage.rb` fails any gate no lane executes. The
existing `ai/tools/tools.json` page-source cases are the third leg and need no new fixtures,
only the real adapter under them.

## 8 · Execution plan

Each wave is independently shippable and gated; W1 alone already ships the headline feature.

| Wave | Deliverable | Gate |
|---|---|---|
| **W0** · **LANDED** | Corpus (`project.json` 15 cases + `registry.json` 13 + README) + the pure folds: `kernel/src/mcp/webmcp.ts` · `:core WebMcp.kt` · `Engine/iOS/WebMcp.swift`; lint facts rows (`builtinTags`/`declTags`/`headRank` 2/`headOrderHint`), the rule in all THREE linters, and a shared lint case | 28 cases green on TS (`webmcp-conformance.test.ts`) and on Kotlin (`:core WebMcpConformanceTest`, 2989 suite green); Swift wired into `RecordMain` for the record lane; `lint_conformance.rb` 0 drift; `generate_conformance_index.rb` 0 run by nobody |
| **W1** · **LANDED** | Despia Web projection: the compiler head row + build-time stale-target abort, `dom/src/webmcp.ts` adapter, the `WebMcpSeam` mount contract, boot wiring, result shaping | `packages/dom/oracle/webmcp-browser.ts` — 14 checks through a REAL `document.modelContext` on a booted page, wired into `web-kernel`; `npm test`; `typecheck` |
| **W2** | Shell inbound, Android first (it compiles here): `VirtualBridge` script, gate wiring, Dom table + `dom.tools` / `dom.callTool` / `web.toolchange`, navigation-drop | `gradle :core:test` + the Dom security suite twin; `check_module_rules.rb` (WebKit confinement holds); `contract_diff.rb` (new actions = compatible adds) |
| **W3** | Shell inbound, iOS: `DomBridgeKit` script + `DomWebBridge` twin of W2 | `check_swift_parse.rb --changed`; compile + device pass ride Codemagic; corpus rows already pin the semantics |
| **W4** | The loop's page source: LocalAI registry adapter over `dom.tools` + `web.toolchange` | `ai/tools` + `ai/loop` corpora (the `source:"page"` cases go live on the real wire) |
| **W5** | Native document source (the `<tool>` row feeding the loop on DSXView surfaces) + docs: `dsx-anatomy.md`, `StackReference.md` row, a `Skills/agent-ready-apps.md` recipe, StackReference/editor catalog registries | `generate_editor_catalog.rb --check`; `check_package_prose.rb`; the registries' own `--check` gates |
| **WE1** · **LANDED** | The editor plane (§4c): `serverViews` and `/edit/api/head/` carry both faces' rows with their derived schemas, and the Studio's **Tools** destination draws them | `node --test packages/cli/test/edit.test.ts` -> 20/20 (3 new: the served face, the page face, a broken row) · `studio-surfaces-browser.ts` -> 20 surfaces, `12-tools` walked with content, 0 unmapped icons |
| **WE1b** · **LANDED** | The tool is first-class in the LOGIC plane: the index and drawing carry `agent` on both faces, the body list names the tool, and the flow's entry node is titled for the agent | `edit.test.ts` -> 21/21 (the new case asserts the entry node title and both faces) · the Studio walk |
| **WE2** · **LANDED** | Visual ADD / EDIT / REMOVE: a three-pane inspector over the surgery door, the action picked from the document's own declarations, the derived schema previewed live | `edit.test.ts` -> 21/21 (declaration inputs + row addressability pinned) · the Studio walk shoots `12b-tools-inspector` and `12c-tools-add` with the form on screen |
| **WE4** · **LANDED** | The CAPABILITY SCREEN (owner-directed 2026-08-27): the Tools destination is a lens over the real logic canvas - list in the shared navigator, `EditorLogic` mounted as the stage (`panels="stage"`; a served capability's `server/` flow draws on the same canvas), a 340px contract panel on the inspector grammar with the call preview in the Studio's own chat tool-trace grammar (the plan's §2.1 measured correction: Foundation's `<ToolCall>` is the product library's face and cannot mount in studio chrome). Design + audit: `ClosedSource/Documentation/v4-launch/platform/09-agent-tools.md` | `edit.test.ts` green · the Studio walk shoots `12-tools` / `12b` (populated stage + contract) / `12c` (served flow) / `12d` (new-tool) · the editor gates 0 errors |
| **WE5** · **LANDED** | New-capability-in-one-gesture: "New tool" asks what the agent should be able to do, derives the action name, and ONE surgery batch writes the `<tool>` row and the `return` action stub together - the screen lands on the new capability's canvas. Exposing an existing action is the demoted secondary path | `edit.test.ts` -> 22/22 (the one-POST round trip) · the walk creates a capability live and shoots `12e-tools-created` |
| **WE6** · **LANDED** | "Try it": the call preview's argument slots take values and Run makes the exact entry call an agent's invocation is, against the LIVE preview app - the dev server's SSE lane grew a `run` event, the kernel's `__DSX_STATE__` door grew `call`, and `/edit/api/try` answers a dead preview with an honest 409 sentence. The screen visibly reacts; the settled result lands in the card | `studio-tryit-browser.ts` (web-kernel lane) -> app reacted, card filled, absence said honestly · `edit.test.ts` -> 23/23 |
| **WE7** · **LANDED** | Served-face writes, decided the deliberate way: the containment test FIRST, then `resolveEditableDocument` widens ONLY the surgery endpoint - the read/tree/save doors stay as narrow as they were; the server view carries each row's surgery address; the contract panel edits both faces identically, with auth a stated fact rather than a field | `edit.test.ts` -> 24/24 · `studio-tryit-browser.ts` check 6 (a served description saves from the panel) |

**What W0/W1 found, recorded because a plan that only records its wins is a plan nobody can
trust twice.** Three defects, none of them visible to any gate that existed before:

1. **The seam was tree-shaken away.** The adapter first registered itself with a bare
   side-effect import from `boot.ts`. `@despia-native/dom` declares `sideEffects: false`, so a
   bundler is entitled to drop an import whose exports nobody names — and esbuild did, in
   silence. `bootDsx` now wires `WebMcpSeam.bind` explicitly. Only the browser oracle could
   see this: every unit test passed while the feature did nothing.
2. **An Apple bridging trap in the text fallback.** On Darwin an `NSNumber` holding 0 or 1
   dynamic-casts to `Bool`, so a result carrying the COUNT `1` would have rendered as
   `true` and a model would have read a quantity as a flag. Fixed with CoreFoundation's own
   type id and pinned by a corpus case carrying a number and a boolean in one payload.
3. **The fallback text had no portable key order.** A Swift dictionary has none at all, so
   the shared `fallbackText` now SORTS object keys — the only ordering three renderers can
   produce identically. This moved one landed expectation
   (`Conformance/ai/mcp/server-transport.json`), which is recorded in that file's own note:
   `structuredContent` is untouched, only the readable fallback moved.

Two byte ledgers moved with the seam and both are named where they are pinned: EmbedCard
40,475 → 40,478 B gzip (482 to spare under the 40,960 G10 law) and the media qualification
by ±6 B. The BINDING costs a slice that declares no `<tool>` row nothing at all —
`__DSX_OPTIONAL_WEBMCP__` folds it away, the same discipline `<api>` uses — so what moved is
the seam declaration alone.

Dependency notes, honest: W2–W4 land value only where an agent exists to consume — the loop is
`Core/LocalAI` (excluded from release profiles today), so the shell waves are sequenced behind
the local-AI program's own schedule and are deliberately last. W1 depends on nothing and
addresses agents that already ship (Chrome/Edge trials, ChatGPT Desktop). Dogfood targets for
W1, cheap and loud: the registry site's package search and the docs site's search — the sites
are DSX apps, so each is one `<tool>` row.

## 9 · Decisions for the owner

1. **Default posture of the shell's page API** (`model_context` Dom config key). Recommendation:
   **on** for the app surface under `bridge_policy: app` — agent-readiness is the product, the
   gate already scopes it to trusted origins, and off is one config line.
2. **The word.** Reuse `<tool>` for the app-document head row (recommended — same word, same
   law, third residence) vs a distinct name. Reuse keeps "a tool never declares a second
   contract" a single sentence everywhere.
3. **Origin-trial enrollment** for despia.com properties (docs, registry site) so W1 is
   demonstrable in Chrome/Edge today. Recommendation: yes — it is the showcase, and the trial
   token is a meta tag the site build already knows how to emit.
4. **Module rows to the UA, ever?** Recommendation: not in v1; if demand appears, it arrives as
   an explicit `reach`-style declaration on the row, fail-closed, never a default.
