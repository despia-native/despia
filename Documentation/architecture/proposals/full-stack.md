# Full-stack — the server is a node

**Status: PROPOSED v1** — the backend program. Builds on `../facet-contracts.md`
(residence/reach, the facet registry, declaration fan-in — LANDED),
`../watch-runtime.md` (nodes + one bus), and `durability.md` (P1–P5 all landed:
envelope, explain ledger, assembly receipt, typed absence, contract gate — the
governance this program inherits on day one). First customer: **our own platform backend** —
Despia hosts Despia.

## The law

**The server is a node, not a product category.** The repo has added an
execution surface three times — the Android twin, the watch node, the web
renderer — with the same moves each time: register a facet word, give modules
a residence folder, compile fail-closed tables from manifests, attach to the
one bus. The server is the **fourth run of that playbook**, and the first
where the runtime exists before the program starts: the TS kernel already
executes the full action/JSE grammar headless on Node in every PR (the
conformance lane IS a headless server). Supabase Edge Functions are Deno;
Firebase Cloud Functions are Node; both run TypeScript. The runtime is not
built — it is *hosted*.

Business logic stays in the one action grammar (actions ARE workflows — the
unified-codebase law; there is no second backend language, ever). **That sentence is now
true of the tree and not only of the intent: `backend-authoring.md` (LANDED 2026-08-12)
gives a backend surface a `<server>` .dsx document whose `<action>` bodies the host
executes, and a TypeScript handler is the declared ejection hatch rather than the only
path.** What is new is residences, links, and emitters:

- **Hosts are bootloaders (Article 6), so platform adapters are small.** A
  Supabase host is: request in → route table → action → typed resolve →
  response out. Firebase is the same lines under a different signature; the
  custom host wraps them in an HTTP loop. The kernel names no platform —
  which is exactly why one bundle runs on all three.
- **Manifests compile to platform config, exactly like today.** prepare
  already turns manifests into Info.plist / entitlements / Gradle config. A
  `prepare_server` sibling turns the same manifests into route tables,
  `supabase/config.toml`, `firebase.json`, cron schedules, and a Dockerfile.
  Declare once, emit per-platform — the pattern is ten scripts old here.
- **`provides`/`reach` is the API gateway.** `createOrder: provides
  ["server"], reach ["app","web"]` compiles to a fail-closed allowlist: the
  client can invoke, never execute; a route no table admits never fires.
  Stronger than client-SDK-plus-RLS, from grammar that already shipped.
  **IMPLEMENTED (B2)** — with the scope stated exactly, because this paragraph
  described the intent for months while nothing read either key:
  the api row IS the publication act, so a plain row stays client-reachable and
  no existing route breaks (Article 7); `prepare_server.rb` ABORTS when a row
  publishes an action that does not declare `provides: ["server"]`; a `worker`
  row is INTERNAL by construction (`reach: []` emitted) and `host.ts` admits
  only a service-role caller, answering everyone else with the byte-identical
  404 an absent route returns — so an internal endpoint is not discoverable;
  an explicit `reach` is honoured, and declaring both a worker row and a client
  reach aborts as a contradiction. Build gate and runtime gate read the same
  emitted field.
- **Exclusion is the deployment switch.** Drop a module → its routes, cron
  rows, and schema contributions vanish from every emitted artifact. One
  switch, all planes — the watch law.
- **The durability tooling governs the backend for free.** `contract_diff`
  gates API breaking changes; the assembly receipt records what a deploy
  contains and why; the explain ledger answers "why is this endpoint absent."

## The two decisions, recorded as law

1. **The data interface is NARROW, forever.** Postgres and Firestore do not
   unify; an interface wide enough to pretend they do is a lie that surfaces
   as production data bugs. Modules declare a narrow schema facet — entities,
   fields, indexes, ownership policy — that provider modules compile to SQL
   migrations + RLS (Supabase/Postgres) and to security rules (Firestore).
   Vendor-specific power is always vendor-named (`dsx.module.supabase.*`),
   never smuggled through the common interface.
2. **v1 is request-scoped.** Request actions, cron, and queue consumers fit
   function platforms; long-lived durable workflows do not. Cold starts are
   where build-time resolution pays: the kernel boots from a compiled
   assembly table, no discovery, no scanning. Durable execution stays on the
   durability shelf with its wake trigger — *the first workflow that must
   survive a process restart* — and arrives as a module, not a kernel
   concept.

## The program

### T1 — the server host + the api facet

**LANDED** — `Core/Server` (domain-parent, binds the word `server`) +
`Core/Server/Modules/Http` (binds the `api` declaration namespace; declares
the `health` action with its `GET /health` row and the first `web/server/`
residence) · `ClosedSource/scripts/prepare_server.rb` (the emitter: routes table +
build-info from the assembly receipt + handler fan-in by copy + Dockerfile +
the Supabase fat-edge entry; ×2-idempotent; abort-tier method/path gates;
excluding Server removes every artifact) · the module host + Node/Deno
bootloaders in `OpenSource/Web/packages/server` (platform-free `host.ts`,
web-standard Request/Response — HTTP *is* the envelope, the server adds no
wrapper of its own: a success is `200` carrying the handler's value verbatim,
a failure is its real status carrying `{reason, message}`) · wired into the codemagic
check chain. Fan-in emitter fix landed with it: a namespace owner without an
`ios/` residence registers spelling and validates fully but ships no dead
Swift (file presence is the gate, for aggregates too).

- A target-owner module registers the facet word **`server`** (the landed
  registry — no name is script-known). A module's server residence is its
  `web/server/` sources (the symmetric `<platform>/<facet>/` tree, unchanged).
- The HTTP owner registers **`api`** as a declaration namespace (object-form
  `facet` binding — the fan-in grammar, LANDED); modules declare rows —
  `facets.api.create: { method, path, action }` — validated against their own
  `actions` (the stale-target gate, existing).
- `OpenSource/Web/packages/server` grows the **module host**: boot from the
  compiled route/action table, dispatch HTTP → action → typed resolve. Two
  bootloaders: Deno FIRST (the adopted starting deployment is Supabase —
  one "fat" edge function hosting the whole route table under
  `/functions/v1/dsx/*`; one cold start, one artifact, one log stream) and
  Node (custom/docker), same kernel. The kernel's portability proof is
  already stronger than the server needs: it runs in the BROWSER (dom
  package), so it is platform-API-free by construction — Deno is an easier
  third host than the browser was.
- `prepare_server` emits the route table + Dockerfile + the Supabase
  function wrapper. First dogfood endpoint live behind it.
- Not tri-renderer work by law: the action grammar is unchanged (already
  corpus-gated); the api facet is manifest/build tooling; the host is
  web-package infrastructure (the SSR exemption class).

### T2 — the platform emitters + identity

**IN PROGRESS — the credential-free core LANDED**: `src/identity.ts`
(platform-free JWT verification, WebCrypto only — HS256 secret + RS256/ES256
JWKS with kid cache and one-refetch rotation; iss/aud/exp/nbf checks with
60s skew; `alg:none` can never pass; the resolver never throws) wired into
BOTH bootloaders at the boundary; route-level `auth: "required"` (an api-row
field, abort-tier validated) → typed 401 `unauthenticated`; scheduled rows →
`deploy/supabase/schedule.sql` (pg_cron + pg_net, deploy-time psql variables,
secrets never baked). Provider-agnostic by construction: Supabase, Firebase,
and custom issuers are all "a JWT and a JWKS URL". ALSO LANDED: the
**Firebase wrapper** (Cloud Functions v2 fat function — emitted
`deploy/firebase/` with a predeploy esbuild bundle so the functions folder
is self-contained at deploy time; same host, same env names, translation
only) and the **portability gate** (`npm run build:server-targets`, in the
web-kernel lane: docker + Supabase edge + Firebase must all bundle from
the same tree, every PR — 3/3 today). ALSO LANDED (B4): identity is
**configured by DECLARATION, not by raw environment**. `Core/Server/config.json`
owns the settings and renders in the dashboard form like every other module's;
the `DSX_JWT_*` names are how a deploy DELIVERS a value, and env still wins over
the declared default. This closed a silent failure: with no secret set, the
verifier correctly resolves "nobody", so every `auth: "required"` route answered
a bare 401 while the server reported healthy and nothing anywhere said why. Now a
route that needs an identity nothing can verify is a BUILD ABORT, and a required
setting whose variable is unset REFUSES THE BOOT with the label, the reason and
the variable named. A secret's VALUE is never emitted into `generated/` —
`scripts/dsx_deploy.rb` carries it to the platform's secret store through a
private 0600 file, never argv, never a log. OPEN: the first LIVE deploys
(Supabase + Firebase — credentials; `dsx_deploy.rb --apply` is written and its
preflight verified, but no real deploy has run), and the client link's NATIVE
twins (consumes durability P4's now-frozen reason vocabulary; the TS/web rung is
landed). The first provider TRANSPORT is LANDED and INSTALLED (B5, below), and
the freeze rule has now BITTEN AND CLEARED: the second implementation (Firestore)
shipped and met the real service on 2026-08-06, so `RepoQuery` is FROZEN — see
`full-stack-execution.md`. The emitted Supabase EDGE wrapper is also
execution-verified now (Deno 2.9.4 against a real Postgres, 12/12 over HTTP),
which is what surfaced the missing `installEntities` in both platform wrappers.

- Supabase and Firebase emitters: the SAME bundle wrapped per platform;
  cron rows (`schedule` on an action's api row) emitted as pg_cron / Cloud
  Scheduler / crontab entries.
- Identity at the boundary, never in business args: the host verifies
  provider JWTs (Supabase/Firebase JWKS — the PowerSync-documented pattern)
  or a custom session, and resolves them into request context. The `secrets`
  plane grows a server scope that can never reach a client bundle.
- **The client link — LANDED (TS/web kernel).** `dsx.module.<chain>.<action>()` resolves
  local → server link → typed absence, the facet-contracts ladder, with rung two now real.
  A caller never spells a route, so moving an action between client and server changes the
  build and no call site.
  - `LinkSeam` in `packages/kernel/src/bus.ts` declares the rung and names NO transport;
    `packages/kernel/src/link.ts` is the HTTP filler a surface installs at boot.
  - **The emitted `generated/link.json` IS the gateway, restated for the client**: every row
    whose action reaches no client surface (`reach: []`) is OMITTED, not flagged — an internal
    endpoint is not nameable from client code, the build-time twin of the byte-identical 404
    `host.ts` answers a non-service caller.
  - **Absence is unchanged without a link.** The rung is taken only when a route is listed AND
    a transport is installed; otherwise every existing answer (`not_loaded` · `excluded` ·
    `unsupported_platform` · `unknown_action`) is exactly what it was. A table with no
    transport must not swallow them, or a caller hunts a network fault that does not exist.
  - **The vocabulary stays closed.** A transport failure is `unreachable` — the spelling
    durability P4 froze and `Conformance/errors` already pins on the ordinary call path. A
    SERVER answer keeps the server's own reason (`unauthenticated`, …): "the network failed"
    and "the server said no" are different facts and a caller acts on them differently.
  - Proven end to end against a live server + PostgreSQL: `link.test.ts` (15, stubbed
    transport) and `link.live.test.ts` (5, nothing faked) — including **the claim**, that two
    callers through the SAME call site cannot see each other's rows.
  - OPEN: the Kotlin and Swift twins fill the same seam (the kernel-side shape is deliberately
    platform-free); the watch link's two-leg contract remains the template, including its
    honesty law — no link ⇒ fail NOW, never queued, never hung.

### T3 — the schema facet + provider modules

**THE POSTGRES TRANSPORT IS LANDED AND BOOTS (plan B5).** `packages/server/src/postgres.ts`
compiles a `RepoQuery` into one parameterised statement and runs it in a transaction that
first adopts the caller's identity (`set_config('request.jwt.claim.sub', …, true)` +
`set local role` — the PostgREST convention, transaction-local so pooled connections cannot
leak identity). The DRIVER lives in the provider module's own residence
(`Core/Server/Providers/Postgres/web/server/`), loaded lazily by name (`pg` on Node,
`npm:pg` on Deno) and external to every bundle — excluding the module removes the driver,
the residence, the migration and the `data` capability together. The backend is CONFIG, not
env (`data_backend` provides the `data` capability; a CRUD row with no backend is a BUILD
ABORT; `database_url` is a required secret while postgres is chosen). Two leaks were found
by EXECUTING against Postgres 17, not by reading code, and both are now regression-gated:
(1) **the table-owner bypass** — `enable row level security` does not bind the table's own
role, so the ordinary self-hosted shape read every row; the migration now emits
`force row level security` on owner tables; (2) **the pool scatter** — issuing
begin/set_config/statement as separate `pool.query()` calls lands them on different
connections; under 8 concurrent callers Bob read Alice's row 1-in-4. The transport holds
each transaction on ONE checked-out connection (`postgres.connection.test.ts`,
`postgres.live.test.ts`, `rls.postgres.test.ts` — all mutation-proven).

- The narrow schema facet (decision 1), compiled by the
  `Core/Server/Providers/{Postgres,Firestore}` provider modules into migrations + RLS
  or rules. Migration bundles are emitted artifacts, digest-pinned like
  everything else (the receipt pattern). *(Providers are named for the DATASTORE, not the
  vendor: `Core/Firebase` is the FCM push module, and no `Core/Supabase` module exists — an
  earlier draft of this line named all three and misled readers into looking for them.)*
- Role ownership via `dsx.claim` ("who provides data / auth / storage?");
  per-app provider choice is the exclusion plane — the push-provider
  precedent (OneSignal · Pushwoosh · Firebase), unchanged.
- **The two-implementation freeze rule.** Build against Supabase first;
  the repository/auth interfaces STABILIZE only when the Firebase provider
  also passes them — the second implementation is what stops Supabase-isms
  from quietly becoming "the generic interface." Until then the interfaces
  are explicitly unstable.
- **The portability gate.** Every PR builds ALL target artifacts — edge
  bundle, Firebase bundle, docker image — from the same tree (a codemagic
  lane, the android/web-lane pattern). A business-module change that breaks
  one target is a red build, never a migration-day discovery.

### T4 — workers and queues

- Queue-consumer actions (`provides: ["worker"]`), idempotency keys as a
  row-level declaration, per-platform queue bindings via the emitters.
  Still request-scoped; still no workflow engine.

## Day one (agent-parallel)

T1 decomposes into independent workstreams that agents can run concurrently,
each gated by existing machinery:

1. **Host** — the module host in `packages/server` + Node/Deno bootloaders;
   gate: kernel + server suites (`npm test`), a route-dispatch test file.
2. **Grammar** — the `server` facet word + `api` namespace registration + a
   first module's rows; gate: `prepare_modules` double-run + the fan-in
   abort-tier checks (existing) + `contract_diff`.
3. **Emitter** — `prepare_server.rb` (route table, Dockerfile); gate:
   idempotence double-run + a golden-output fixture.
4. **Dogfood** — one real platform endpoint (an OAuth code-exchange or
   webhook handler — the class of server code our docs currently ship as
   paste-this snippets) declared as a module's server action.

Merge order: 2 → 1 → 3 → 4. Every workstream lands green under the standard
gates or it doesn't land — day-one speed never suspends the law.

## What could ruin it

The failure modes are the constitution's existing bans wearing server
clothes: a second business-logic language (the corpus law forbids it);
pretending two databases share semantics (decision 1); remote calls that hide
failure (the watch's offline contract forbids it); ambient database clients
(the bus law forbids it); backend vocabulary in the kernel (Article 1
forbids it). The program adds no new laws — it extends the reach of the
ones that already held three times.
