# Security model: what JSE/DSX can do, and what holds it

> JSE can fetch, upload files, read/write cookies and shared state, use crypto, call
> modules, and open sockets. That power needs a stated model. This doc is honest about
> **what is enforced today** vs **what is specified for the next layer** — a security doc
> that overstates enforcement is worse than none.

## Trust tiers

| Tier | What it is | Capability |
|---|---|---|
| **Bundled DSX** | `.dsx` files baked into the binary at build time (the registry) | Full: every JSE global, every installed module via `dsx.module`, fetch to any origin. It shipped in the app — it IS the app. |
| **Native modules** | Swift `Module` subclasses | Privileged by definition (they hold the device APIs). Gated at BUILD time: `excluded.json` removes a module entirely — a call to a missing module is a typed error / `{ ok:false, error:"unavailable" }`, never a crash. |
| **Remote DSX** | Markup fetched at runtime (`DSXView` remote sources) | **Trusted, because its SOURCE is** (see below): remote views load only from sources the app itself configured (routes/manifests baked at build time or served by the app's own backend) — there is no user-controlled "load DSX from any URL" door. Content from a configured source gets the full engine, like bundled. |

## Trust is source-anchored — and transitive

The model: **trust attaches to where code was LOADED FROM, not to what it does next.**
Anything running from a trusted source may render more of itself:

- A web view on an **allowed host** renders whatever it likes — allowed.
- **Bundled DSX** renders more DSX (inline `<component>` definitions, `<node>` trees,
  mounted components) — allowed.
- A **remote view from a configured source** renders DSX — allowed. Same engine, full
  capability. No per-call fetch-origin or module allowlists.

The ONE suspicious shape is a trusted surface **loading a view from an UNCONFIGURED
source** and letting *that* render DSX. The defense for that sits at the only honest
place — **load time**: web views and remote-DSX views open only against the app's
configured hosts/sources (the infra contract — routes and manifests are app-authored,
never user-supplied URLs). Gate the door, not every step inside the house. Per-call
capability checks on already-loaded content would be theater: the content is either
from your source (trust it) or it never loads.

## Enforced today

- **Total evaluation.** No `eval`, no JS VM, no dynamic code paths beyond the JSE grammar.
  Bad input → `[JSE …]` log + null. Loops draw on a shared per-event budget (100k
  iterations) and abort with a log past it; recursion is depth-capped; intervals have a
  250 ms floor. Remote DSX **cannot freeze or crash** the app.
- **Surface-scoped resources.** Timers and WebSockets die with the surface's store
  (`StackStore.deinit`) — no leaked connections or background tickers (see
  `lifecycle.md`).
- **Log redaction (`JSERedact`).** Any dict key that looks like a credential (`token`,
  `secret`, `password`, `authorization`, `cookie`, `api_key`, `bearer`, `credential`,
  `private_key`, …) masks to `•••` in `console.*` output before it reaches NSLog or the
  ring buffer. NSLog rides in sysdiagnoses and crash uploads; secrets must never ride
  along. (Live store values are untouched — only serialization is masked.)
- **Crypto hygiene.** Internal `__` fields (key material) never serialize through
  `JSON.stringify`, fetch bodies, or console output (`jsonSanitize` strips them);
  `exportKey` honors `extractable`. Key *usage* enforcement is advisory — DSX is
  app-author code, not adversarial-tenant code.
- **Build-time exclusion.** `DSX/Modules/Config/excluded.json` removes modules from
  the binary entirely — the only complete capability denial.
- **Remote-bundle verification (opt-in).** When `App.json` ships a `bundle_signing` public
  key, the kernel verifies the remote route/bundle manifest's signature at the load gate
  (`RemoteBundleGate`, CryptoKit) before trusting it — unsigned/unverified content is refused
  (fail-closed) and the app degrades to its fallback. OFF by default ⇒ no change. See "The load
  gate" below + `architecture/remote-bundle-signing.md`.
- **No web-bridge bypass.** Modules never `evaluateJavaScript`; everything crosses
  through `dsx` (resolve/error/event/broadcast) — one auditable choke point.

## The load gate (the one place enforcement belongs)

Per-call capability allowlists for remote DSX were considered and REJECTED — they gate
the wrong layer (see "source-anchored" above). What the model actually requires:

1. **Source configuration is app-authored.** Web-view hosts and remote-DSX sources come
   from the app's routes/manifests (baked) or the app's own backend — never from
   user-supplied URLs. This already holds by construction in the current infra; it is
   the invariant to PROTECT when adding features (deep links, in-app browsers, "open
   URL" actions must never become "load arbitrary DSX").
2. **Remote bundle integrity — signed manifests (IMPLEMENTED, opt-in, OFF by default).** The
   remote cache already content-addresses; signed manifests are the **other half**, now built.
   The app's build/backend signs the remote-bundle manifest with a private key; a PUBLIC key is
   baked into `App.json` (`bundle_signing`) — the app-authored trust anchor (Article 5). At the
   **one load gate** (the kernel `Router` reading the remote route table), the engine verifies the
   manifest's detached signature against the baked key(s) via `RemoteBundleGate` (CryptoKit —
   Ed25519 default, or ECDSA P-256). The engine **consumes** the verdict; it does not special-case
   node kinds. **Fail-closed when enabled:** an unverified or unsigned manifest is REFUSED — the
   remote table is dropped and every path degrades to the configured `entry.fallback` (Article 7:
   degrade, never brick); unverified remote content is **never rendered**. **Fail-open by default:**
   no `bundle_signing` block ⇒ verification is a no-op pass ⇒ every existing app is unaffected
   (config-presence is the switch, not a `#if`). Until you turn it on, HTTPS + your own backend
   remains the integrity story. Full contract — threat model, signing flow, key management,
   failure mode: `OpenSource/Documentation/architecture/remote-bundle-signing.md`.

## Secrets guidance (for module + DSX authors)

- Server identity rides `token` payload fields and `dsx.cookie` — both redacted in logs by
  name. Name your secret fields so redaction catches them (`*_token`, `*_secret`,
  `authorization`) — don't get clever with `t` or `auth_blob`.
- OS-protected secrets (Keychain, Secure Enclave) stay in **modules** — JSE crypto keys
  are value objects by design; if the key must never exist in app memory as a value, it
  doesn't belong in JSE.
- The webhook/event pipeline (`ui.onAny` relays) forwards payloads verbatim — don't put
  secrets in `dsx.event` payloads; they're analytics by definition.

## The boundary rule (restated)

Core JSE = portable computation and networking. DSX = the UI graph. **Modules =
privileged capability, individually excludable.** Anything permission-gated by the OS
(camera, location, push, health, keychain) is a module *because* that's the audit and
denial point.
