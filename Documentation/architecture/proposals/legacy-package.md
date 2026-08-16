# The Legacy package — the entire v3 compat surface as ONE excludable module

**Status: ACCEPTED, owner-ratified — LANDED** (the module, the generic
facet-declaration fan-in it rides, the generated shim, the stable sink, the closed-table
routers, the conformance corpus, the rule-13 repoint) **+ HARVEST WAVE 2** (8 owners
declared and their hand parsers retired, 22 corpus verbs, the Swift native corpus
runner). The module is
`ClosedSource/DSX/Modules/Core/Legacy/` (scheme `legacy`). Companion docs:
`../facet-contracts.md` (the fan-in this applies), `../../legacy.md` (the page-facing
forms), `OpenSource/Conformance/legacy/verbs.json` (the exhaustive verb corpus).

## The law, in one paragraph

The v3 compat surface — the `window.despia` mirror, the scheme-string call forms, and
the legacy custom-scheme deeplink verbs — is owned by ONE excludable module. **The v3
API is a CLOSED FINITE set, so it is ENUMERATED, never parsed**: every verb is a
declared row in its owning module's manifest (`facets.legacy` — modules provide, Legacy
consumes), the page shim is GENERATED from that table (exactly the declared verbs exist
as functions), and the only string handling anywhere is splitting the known
`<verb>://` prefix. **The package ships INCLUDED by default** — existing apps change
nothing with zero action; **exclusion is the hardened opt-out**: no `despia.*`
injection, no scheme-string routing, no table, no legacy deeplink verbs — only
`window.dsx` remains, and the `://` grammar/injection attack surface is absent from
the build (the file-presence law doing security work).

## The mechanism — an application of the facet-declaration fan-in

Core/Legacy got **zero special treatment in shared grammar**. It registers the word
`legacy` as a **declaration namespace** — the generic, staged fan-in phase of
`facet-contracts.md`, now landed with this module as its first consumer:

```jsonc
// Core/Legacy/dsx.json — the OWNER registration (the object form of the landed `facet` binding)
"facet": {
  "word": "legacy",
  "declarations": {
    "key": "url-scheme",                                     // row keys ride real URL grammar
    "fields": {
      "action":   { "type": "ownAction", "required": true }, // must name a declared action of the DECLARER
      "args":     { "type": "template", "substitutions": ["$tail", "$url"] },
      "response": { "type": "template", "substitutions": ["$data"] },
      "push":     { "type": "template", "substitutions": ["$data"] }
    },
    "emit": "LegacyMap",                                     // → LegacyMap.generated.swift/.kt in Legacy's facets
    "embed": { "shimJS": "shared/legacy-shim.js" }           // the shim template, table-substituted
  }
}
```

```jsonc
// a DECLARING module (ValueStore) — the FULL per-verb v3 contract
"facets": {
  "legacy": {
    "writevalue": { "action": "write", "args": { "value": "$tail" } },
    "readvalue":  { "action": "read", "response": { "global": "storedValues", "value": "$data" } }
  }
}
```

- **Aggregation + validation** live in `dsx_graph.rb` (`facet_declaration_*` — generic;
  unit-gated by `dsx_graph_test.rb`). Abort tier: a row targeting an action its module
  doesn't declare (the rule-10/stale-target class), a row bound to an UNREGISTERED word
  (owner *deleted* from the tree ⇒ dead grammar fails the build), key-grammar/kernel-word
  violations, identity shadowing (a key may keep its OWN module's spelling — that is how
  a migrated hand parser keeps its verb — but never steal another module's), duplicate
  namespace owners, and two ENABLED claimants of one key.
- **Emission** lives in both preparers (`emit_facet_declarations`): each word's aggregate
  lands INSIDE the owner's platform facets as `<Emit>.generated.swift/.kt` — a typed
  `Entry` struct derived from the registered field schema. Two row sets, deliberately:
  the emitted **`entries` carry the ENABLED aggregate** (what this build routes — an
  excluded declarer's rows fall out), while the **`__DSX_FACET_ROWS_ALL__` template
  substitution carries the FULL declared aggregate** (what a page surface must answer
  for — the DespiaPackages/DespiaExcluded split applied to declarations).
- **Exclusion vs deletion**: owner EXCLUDED ⇒ the word stays registered (vocabulary from
  ALL manifests — the landed law), declarations remain valid grammar, the fan-in
  **deletes** the generated files (file-presence law; proven below). Owner DELETED ⇒
  declarations abort at prepare.
- The graph and the preparers know the generic block and the registry — **never the
  string "legacy"** (grep-proven; the only "legacy" tokens in `dsx_graph.rb` are the
  pre-existing alias-doc comments).

## The stable sink — `window.__dsxWire`

The old envelope sink was `window.despia.__proxy`: page-unreplaceable only by the
ACCIDENT of the despia accessor's string-assignment setter. With the mirror movable, the
modern wire carries its own guarantee **by construction**:

- The Dom transport scripts (`DomBridgeKit.wireScript` / `VirtualBridge.wireScript` —
  byte-level twins) install `window.__dsxWire` at document start, **frozen +
  non-configurable, non-enumerable**: `capabilities` · `send(envelope)` (structured-only)
  · `proxy(payload)` (the ONE inbound delivery entry native evaluates) · `bind(sink)`
  (**first-bind-wins**) · `bound` (the tamper-proof install probe the Android fallback
  path uses).
- `runtime.js` binds its `deliver` sink at document start, before any page script — so
  the engine can never lose the race, and page code can never replace the carrier or
  steal/rebind the sink afterwards. Native delivery (`Dom.proxyJS`, both platforms) is
  `window.__dsxWire.proxy(payload)` — byte-compatible envelopes
  (`Conformance/api/wire-contract.json` unchanged, bridgeVersion 3).
- Nothing else rides the wire: the generated shim consumes the PUBLIC `window.dsx`
  surface — one engine, one pending registry, one delivery sink, no privileged handle.
- Android detail: the Java messenger is injected as **`__dsxNative`** (an
  `addJavascriptInterface` name IS a window global, and `window.virtual` must not exist
  in a Legacy-less build). The wire-contract `messageName: "virtual"` is the iOS
  script-message CHANNEL name (`window.webkit.messageHandlers.virtual`) — not a window
  global — and is unchanged.
- `__despiaRuntime` (the fact global) keeps its historical name and gains `debug`
  (the DEBUG/KernelLog.enabled seam) for the shim's field-testing reporter.

## The generated shim (the `despia.*` surface)

`shared/legacy-shim.js` is a TEMPLATE; prepare substitutes the full declared table and
embeds the result in `LegacyMap.generated.*`; Legacy injects it via
`try? dsx.module.dom.inject(script:, atStart: true, mainFrameOnly: true)` on the
`lifecycle.launch` listener — the **same document-start slot** runtime.js rides (WKUserScript
atDocumentStart / addDocumentStartJavaScript, registration-ordered after runtime.js),
so a shipped page's immediate `if (window.despia)` sniff keeps working. **Composed app
surface only** — the bare `<WebView/>` primitive has no bridge by construction
(web-surface-policy.md) and gets no shim.

Per declared verb the shim builds ONE function: modern call
(`dsx.module[chain][action](declared args)` — `$tail`/`$url` fill from the call
argument) → on resolve, the declared **response convention** re-delivers the v3 way
(`global` → `window.<name> = value`, `callback` → `window.<fn>(value)`, `value` picks
`$data` or a dotted `$data.path`); declared **push mappings** re-deliver a module's
modern broadcast the v3 way. The two shipped STRING forms — `window.despia = "verb://…"`
and `despia("verb://…")` (incl. the watch-globals convention
`despia("verb://", ["g"], ms)`) — route through the same closed table.

**Honest unknowns**: an UNDECLARED string form falls through to the platform
NAVIGATION untouched (never parsed page-side) — the web relay's registry first-dibs
(the modern extension point) still answers registered legacy schemes/aliases there, so
field behavior for not-yet-declared URL verbs is fully preserved. An undeclared DOT
member answers a callable that rejects the v3-shaped `unknown_verb` envelope + one
`dsx.log` line (feature-sniffs stay truthy; nested paths reject the same way — no
TypeError into old pages); on **debug/test builds** (`__despiaRuntime.debug`) a
catch-all Proxy additionally logs bare member ACCESS so a forgotten verb surfaces in
field testing, never silently at a customer. A verb whose OWNER is excluded keeps its
generated function and answers the honest `not_loaded` envelope through the ordinary
wire (the excluded overlay stays readable: `despia.wasExcluded(...)`).

`window.virtual` is **retired**: the old runtime wrapped it away from page code
(docs/legacy.md pins "web code never touches window.virtual"), so the mirror was its
only caller and it dies with the mirror.

## The native routers (Legacy.swift / Legacy.kt — twins)

- `legacy.route` claim — the web relay consults it for custom-scheme NAVIGATIONS
  **before** the registry first-dibs (same order as the shim's string router):
  declared verb → the modern action + the declared response (applied through Dom:
  `dom.set` / `dom.call`); miss → `nil`, the navigation falls through untouched.
- `lifecycle.openURL` listener — the same closed table gates legacy custom-scheme DEEPLINK verbs;
  unknown schemes/verbs fall through untouched (AppsFlyer/OAuth/ShareExtension hooks and
  the host's Deep-Linking-API `?link=` branch — which remains host-owned as the
  pre-bootstrap fallback — are not Legacy's to consume).
- `dispatch` action — stray page STRING bodies (Dom's `WebMessageShell` /
  `VirtualBridge.receiveLegacy` route them here; nothing legitimate posts them anymore):
  declared → routed (`via: "map"`), unknown → ignored + logged (`via: "none"`), never
  parsed. Legacy absent ⇒ the transports log-and-drop.
- `map` action — pure introspection (`{ mapped, chain?, action? }`), the tests' and
  corpus' seam.

## Proof obligations (all landed, this wave)

1. **Exclusion** (throwaway excluded.json entry, then restored): prepare deletes
   `LegacyMap.generated.swift/.kt`; the srcDirs line, the register-map entry and the
   `LEGACY_ENABLED` swiftFlag leave the build outputs; `DespiaExcluded.json` lists
   `{ name: Legacy, scheme: legacy, reason: excluded }` and DespiaPackages drops it;
   all gates green in the excluded shape; restore settles idempotently (×2 = 0 writes).
   (The only remaining `window.despia` strings in generated outputs are the
   pre-existing labeled Demo TEACHING captions inside the component catalog —
   rule-13-conformant markup, unchanged from before the split.)
2. **The enumerated shipped-page proof** (node harness over the ACTUAL generated
   artifact): per corpus verb — function exists · wire envelope equals the fixture route
   · response convention lands · watch-globals resolves · string forms route through the
   table; the closed set (unknown_verb + debug reporter + inert probes + kept members);
   the excluded-owner law; the excluded-build shape (window.dsx alone; despia/virtual
   absent); injection timing. The OLD-vs-NEW divergences are ENUMERATED (see the ledger
   below).
3. **The corpus** (`OpenSource/Conformance/legacy/verbs.json`): one fixture per declared
   verb; `dsx_graph_test.rb` pins tree-declarations == corpus (both directions); the
   node harness pins the shim behavior; **the Swift reference runner**
   (`LegacyConformance`, `OpenSource/Engine/iOS/ConformanceHosts.swift`, driven by the
   record lane's `RecordMain.swift`) replays every fixture's `<verb>://` call spellings
   through the closed-table ROUTER fold — prefix split · verbatim tail · args template
   (`$tail`/`$url`/literal, unknown `$…` is an error) · response `value` pick — and
   throws on the first disagreement. The native TABLES are the same generated rows by
   construction, so the ruby gate owns table equality and this leg owns the fold. The
   **Kotlin `:app` twin is the one open leg** (see Follow-ups).

## The enumerated OLD-vs-NEW ledger (all deliberate)

| Surface | OLD (the dynamic mirror) | NEW (the closed set) |
|---|---|---|
| Declared verbs (all forms) | dynamic proxy → string/structured wire | generated function → modern wire + declared response; behavior preserved |
| `despia.writevalue(<data>)` object-style | posted the BARE `writevalue://` string — the argument was DROPPED (a mirror bug) | routes `{value: <arg>}` to `writevalue.write` — fidelity fix; the documented string form was never affected |
| UNDECLARED string forms (`window.despia = "hidebars://"`) | raw string down the message channel; native parsed | handed to platform NAVIGATION untouched → the registry first-dibs answers registered aliases/prefilters — field behavior preserved, zero page-wire parsing |
| UNDECLARED dot forms (`despia.audio.play()`) | dynamic bridge to the engine | typed `unknown_verb` rejection + dsx.log until declared — the security re-scope; modern pages use `window.dsx` |
| `window.virtual` | native-injected transport object | RETIRED (the mirror was its only caller) |
| `despia.pending/register/arm/__proxy/storage/call/send/href/capabilities` | engine/transport internals exposed on the mirror | absent — internals, not page API; kept members: supports · runtime · on · broadcast · packages · excluded · wasExcluded · hasPackage · package · version · global · navigate · log · error |

## The harvest — declared now vs ledgered per-verb

**Declared — wave 1** (the landing wave): `writevalue`, `readvalue` (ValueStore — hand
parser deleted both platforms), `getpushwooshid` (Pushwoosh — hand parser deleted both
platforms; ships excluded on the qa profile, the living excluded-declarer proof).

**Declared — wave 2** (the 8-owner harvest, GA-PLAN WS-E / A0-SWEEP L-02): each owner's
declaration landed together with the retirement of the hand parser it replaces, so no
owner is half-migrated. 19 verbs, 22 in the corpus total:

| Owner (chain) | declared verbs | what the declaration replaced |
|---|---|---|
| Core/Basics/Haptics (haptic) | lighthaptic · mediumhaptic · heavyhaptic · successhaptic · warninghaptic · errorhaptic | the whole-scheme `dsx.command()?.scheme` switch — DELETED both platforms; each row targets the already-modern named style action, no args, no response |
| Core/Basics/StatusBar (statusbar) | statusbarbackgroundcolor · statusbartextcolor · statusbarcolor · navbartextcolor · hidebars | the 5-branch whole-scheme pre-filter — DELETED both platforms. Three NEW modern actions absorb what had no face (`rgb` the 0-255 backdrop + luminance pick + BottomBar/PullToRefresh mirror, `navtext` the nav-bar icon appearance, `bars` the chrome toggle) and `text` gained an optional `chrome` flag for the v3 verb's extra host-chrome restyle. Every payload rode the URL HOST slot, so every row is `$tail` and the ACTIONS normalize (percent-decode + trailing slash) — `legacyValue(_:)`, one interpreter, no router parsing |
| Core/Basics/Flashlight (enableflashlight) | enableflashlight · disableflashlight | the scheme sniff (`scheme != "disableflashlight"`) — DELETED both platforms; the module gained its first DECLARED action, `set({ on })`, and both rows target it with a LITERAL `on` (the verb WAS the value) |
| Core/Basics/BottomBar (bottombar) | bottombarcolor | the alias pre-filter — DELETED both platforms; `background` now accepts BOTH `#RRGGBB[AA]` and the legacy `R,G,B` triple, so the row is a plain `$tail` |
| Core/Basics/Location (location) | stoplocation | the `stoplocation` scheme branch — DELETED both platforms (the bare-`location://` START branch stays, see below); the module gained a named `stop` action |
| Core/OneSignal (onesignal) | getonesignalplayerid · setonesignalplayerid · ~~registerpush~~ | the 3-branch URL-prefix pre-filter — DELETED both platforms. `getonesignalplayerid` carries the `onesignalplayerid` response global; `setonesignalplayerid` is a FIDELITY FIX (`$tail` → `login.user_id`; the old parser read a query param the host-slot form never carried, so it settled `missing_param`). `registerpush` MOVED (2026-08-10) to **Mandatory/PushRouting**: v3 was provider-AGNOSTIC (d-ios branched Firebase then continued into OneSignal), and an excludable provider owning the shared verb left Firebase-only builds with no route — the always-present hub owns the alias + row now and fans out to each enabled provider's own `register` (OneSignal's stays the OneSignal target); the alias-conflict gate still gives the wire verb ONE owner |
| Core/Firebase (firebase) | getfirebaseplayerid | the 2-branch scheme pre-filter — DELETED both platforms, carrying the `firebaseplayerid` response global. Its `registerpush` branch was DEAD CODE: that verb is OneSignal's alias, so the registry never routed it here |

**Ratified NON-declarations** (deliberate, with the reason — not deferrals):

| Owner (chain) | verb(s) | why never a legacy row |
|---|---|---|
| Core/Basics/ExternalApps (x) | twitter · fb · instagram · youtube · coinbase · uber · lyft · mailto · tel · sms · maps · message · googlegmail · comgooglemaps · lpa | **registry-first-dibs forever** (the candidate outcome this table already named). Two structural reasons: (1) `mailto:` · `tel:` · `sms:` · `lpa:` are OPAQUE — no `<verb>://` prefix exists for the routers or the shim's string router to split, so a row could never fire for the real form; (2) declaring the hierarchical ones would put them on Legacy's `lifecycle.openURL` listener, turning an INBOUND `twitter://` deeplink into an outbound re-open (a boomerang the registry path does not have). The navigation path preserves full field fidelity today; the module keeps its one pre-filter, which is LIVE, not dead |
| Core/Basics/Location (location) | `location` (the bare START form) | the v3 args grammar is single-string (`$tail`/`$url`); START takes an options OBJECT (`{ buffer, server, movement }`), which cannot round-trip the shim. It stays the modern `dsx.module.location(…)` bare face |
| Core/Basics/Location (location) | `geolocation` | **not a v3 verb at all** — it is this module's own internal scheme for the `navigator.geolocation` polyfill, whose injected script already calls the MODERN `window.dsx.module.geolocation.listenerAdded/Removed`. That is the "needs a split" this table asked for, resolved |
| Core/Firebase (firebase) | `registerpush` | Mandatory/PushRouting owns that alias (`_alias_note`; moved off OneSignal 2026-08-10); the build-level alias-conflict gate refuses one wire verb with two shipping owners |

**Ledgered — undeclared, with the reason.** These verbs KEEP WORKING today for the URL
forms (string-assignment → navigation fallback → registry aliases/prefilters, which are
all still live); what awaits per verb is the declaration + response harvest so the DOT
form joins the closed shim and the hand parser can be deleted. Owners keep their inbound
parsers with their existing legacy-labeled headers until then:

| Owner (chain) | v3 verbs awaiting declaration | Why deferred |
|---|---|---|
| Core/Basics/Spinner (spinner) | spinneron · spinneroff | host-slot variants; prefilter-only. **The named next increment** — it is the 9th owner of the wave-2 harvest and was held back only because a concurrent stream owned that module's files; the shape is BottomBar's (one `$tail` row per variant onto a named modern action) |
| Core/HealthKit (healthkit) | readhealthkit · writehealthkit | raw URL payload grammar — args harvest |
| Core/CameraRoll (savethisimage) | gallery (+ the savethisimage prefix form) | prefix-parser with data URL tails |
| Core/Widgets (widget) | widget:// | mangled-URL repair (`https//` → `https://`) — does not fit $tail; needs a dedicated modern arg shape |
| Core/Wallet (wallet) | addpkpass | scheme→https rewrite semantics |
| Mandatory/MultiApiCall (multiapicall) | multiapicall://a,b,c | comma-list grammar; Mandatory tier |
| Core/RevenueCat (revenuecat) | getpurchasehistory | clean candidate — next wave |
| Core/Clipboard (clipboard) | getclipboard | response global harvest |
| Core/DeviceUUID (uuid) | get-uuid | response global harvest (`auto_inject_variable`) |
| Core/Metadata (metadata) | getappversion · getstorelocation · checknativepushpermissions | response globals harvest |
| Core/Payments/LegacyIAP (inapppurchase) | inappsubscription · cancelinapppurchase · restoreinapppurchases | flow verbs with UI side effects |
| Core/IdentityVault (identityvault) | setvault · readvault | args + response harvest |
| others (AppSettings settingsapp · QRScanner qrcode · SocialShare shareapp · WebControls reconnect · FileSharing download · LocalPush sendlocalpushmsg · PullToRefresh enable/disable · AppTracking verbs · Contacts verbs · ContentServer content · State global · Watch watchhealth · AdMob displayrewardedad/increasetapcounter · OneSignalLiveActivity la-push/onesignal-live-activity) | as listed | registry aliases stay live; declare with response harvest as each is verified against v3 field docs |

**Deliberately never declared**: `esim` (removed hardcode — pages navigate to Apple's
URL, docs/legacy.md §3); `despia.storage` (the transport never shipped one — dead in
the field).

## Follow-ups (ledgered)

- The per-verb response-convention harvest above (schema landed; declare in waves).
  **Next: Core/Basics/Spinner** (`spinneron`/`spinneroff`), the held-back 9th owner of
  wave 2.
- A NATIVE corpus runner — **the Swift reference leg LANDED**
  (`LegacyConformance` in `OpenSource/Engine/iOS/ConformanceHosts.swift`, called from
  `ClosedSource/scripts/conformance/RecordMain.swift`, so it runs in the
  `conformance-record` lane beside the chains/actions/api legs). **Open: the Kotlin
  twin.** The stale premise is corrected: `:app` DOES have a test source set now
  (`ClosedSource/RuntimeAndroid/app/src/test/kotlin/despia/modules/…`, 8 module tests),
  so the leg is a one-file add — `despia/modules/legacy/LegacyConformanceTest.kt`,
  reading the same `OpenSource/Conformance/legacy/verbs.json` through `Legacy.kt`'s
  `verb`/`tail`/`arguments`/`pick`.
- **Ex-BLOCKER, FIXED** — `emit_facet_declarations` briefly read an undefined local
  (`ios_dir`, a leftover of the Q5 lane rename) that killed the preparer the moment
  Core/Legacy was enabled. The current tree uses `lane_dir` throughout
  (`prepare_modules.rb`, `emit_facet_declarations`) and `grep ios_dir` returns zero hits.
  Verified 2026-08-10 under the `webview-prod` profile (Core/Legacy + all declaring
  owners enabled): both preparers run idempotently (second pass = no diff),
  `LegacyMap.generated.swift` **and** `LegacyMap.generated.kt` emit, and the full gate
  chain is green (`lint_dsx`/`lint_dsx_css` --strict 0/0, `dsx_graph_test` 94/94,
  `check_module_rules` 0 errors on 315 swift files).
- The kernel's now-unused `VirtualBridge.injectedScript` (Engine/iOS/Bridge.swift) and
  the string branch of kernel `VirtualBridge.receive` are dead on the app path (the
  shell routes strings to Legacy; DomBridgeKit installs the wire script) — retire in a
  kernel wave (still out of the module lane's writable set).
- The host's `?link=` Deep-Linking-API inline branch stays the pre-bootstrap fallback
  (its own comment says so); a host-slimming wave can revisit.
