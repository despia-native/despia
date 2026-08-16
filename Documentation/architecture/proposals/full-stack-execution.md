# Full-stack execution — the agent playbook

**Status: EXECUTION COMPANION** to `full-stack.md` (the program) and
`durability.md` (the governance). This document is the handoff memory: a
fresh agent session should be able to read THIS, the two companions, and
the monorepo working rules, and start shipping T1 without rediscovering anything.

## The mental model (internalize before touching anything)

1. **The kernel names nobody.** `OpenSource/Engine/` + the TS kernel know no
   module, scheme, platform, or provider. Everything is modules on a bus.
2. **Modules provide, surfaces consume.** The web view, native UI, watch —
   and now the server — are equal consumers attached to the same bus.
3. **Three call shapes, pick by shape:** `dsx.module.<chain>.<action>()`
   (point-to-point, you can name the callee) · `fire`⇄`hook` (1-to-N
   events) · `claim` (who owns this role?). Never a fourth channel.
4. **File presence is the gate.** Excluded module ⇒ its code is not in the
   artifact. This is the authority model AND the provider-selection
   mechanism (ship Supabase OR Firebase — the push-provider precedent).
5. **Identity derives.** A module's chain comes from `Modules/` nesting;
   manifests declare only the LOCAL segment. Nobody hand-writes a full chain.
6. **Facet words are registered, never known.** A target owner binds its
   word (`facet` binding / `extensionTargets.facet` / `node.role`); scripts
   ship knowing zero names. Registered today: `activity · app · watch ·
   widget` (+ `legacy` as a declaration namespace).
7. **Residence ≠ reach.** `provides` = where a local implementation lives;
   `reach` = who may call over a link, compiled into fail-closed capability
   tables. This IS the API gateway.
8. **Actions ARE workflows.** One business-logic grammar, corpus-gated on
   three runners (TS per-PR · Kotlin gradle · Swift reference). NEVER a
   second language; new authoring surface ships fixtures-first on all three.
9. **Hosts are bootloaders.** Platform adapters are translation lines. The
   Supabase edge entry is ~15 lines; everything else is the shared host.
10. **The build explains itself.** `prepare_modules --explain`, the
    assembly receipt, `contract_diff` — landed; use them, extend them.

> **Picking this up cold?** `/STATUS.md` is the LIVE status — what is done, what is open, and the
> command that proves each row. The archived handoff (`ClosedSource/Documentation/archive/plans/NEXT.md`)
> still carries this program's workstream detail and the environment memory, but its branch
> state, what B1–B3 landed, what is deliberately unfinished, and the next steps in order. Read it
> before this file; this file is the workstream spec it points back to.

## What is already landed (do not rebuild)

| Piece | Where | Gate |
|---|---|---|
| Manifest envelope (`"dsx": 1`) | `DSXGraph::MANIFEST_ENVELOPE` / `envelope_error`, aborted in `nodes_from_manifests` | `dsx_graph_test.rb` |
| Explain ledger | `DSXGraph.explain_ledger` · `prepare_modules.rb --explain[=json] [<token>]` | golden fixtures, 73/73 |
| Assembly receipt | `DSX/Modules/Config/DespiaAssembly.json`, prepare §13, digest-pinned | double-run idempotence |
| Contract gate | `scripts/contract_diff.rb` (pure classify/gate + `--self-test`), codemagic chain | self-test + live diff |
| Facet fan-in grammar | `DSXGraph.facet_declaration_*` (registrations, rows, conflicts, abort-tier errors) | `dsx_graph_test.rb` |
| Residence/reach + relay tables | facet-contracts (LANDED); the watch link (`__cmd`/`__reply` two-leg RPC) is the reference implementation | prepare + watch manifests |

| T1 server node | `Core/Server` + `Core/Server/Modules/Http` (words `server`/`api`) · `ClosedSource/scripts/prepare_server.rb` · host + bootloaders in `packages/server` (`src/host.ts` · `bootloader-node.ts` · `bootloader-deno.ts` · `generated-loader.ts`) | prepare_server ×2 · `npm test` host suite · codemagic chain |
| T2 identity core | `src/identity.ts` (JWT/JWKS via WebCrypto) wired in both bootloaders · api-row `auth: "required"` → 401 · `schedule` rows → `deploy/supabase/schedule.sql` (the emitter is live and cron-injection-gated, but **no api row in the tree declares `schedule` yet, so that artifact is absent on disk by design** — the emitter deletes it when there are no scheduled rows; the first scheduled route is the v4 build poller). **Configuration is DECLARED, not raw env (B4)**: `Core/Server/config.json` owns `auth_mode`/`auth_secret`/`auth_jwks_url`/`auth_issuer`/`auth_audience`; the env names (`DSX_JWT_*`) are how a deploy DELIVERS them, and env still wins over the declared default | identity suite (16) · host suite · prepare_server ×2 |
| T3 schema facet + providers | `Core/Server/Modules/Data` registers the narrow `schema` word (`fields` object · `indexes` · `ownership`) · `Core/Server/Providers/{Postgres,Firestore}` are the two emission owners, named for the DATASTORE (Core/Firebase is the FCM push module — scheme collision avoided) · closed type vocabulary (text·integer·real·boolean·timestamptz·jsonb·uuid) and 3 ownership policies, fail-closed in prepare_server · Postgres → `deploy/supabase/migrations/000_dsx_schema.sql` (tables + indexes + RLS), Firestore → `deploy/firebase/firestore.rules` — SAME input, two targets (the freeze rule) | prepare_server ×2 · `object` field kind in `dsx_graph_test.rb` · portability gate 3/3 · exclusion switch verified (drop a provider ⇒ its artifact is deleted) |
| T4 workers + queues | api-row `worker: "<queue>"` + `idempotencyKey: "<field>"` (POST + `auth: "required"` FORCED) · queue table per worker with `idempotency_key text not null unique` — idempotency is a ROW-LEVEL DECLARATION enforced by the database, never handler code · `deploy/supabase/queue.sql` pg_cron drains · dogfood: `server.http.drainWebhooks` | prepare_server ×2 · live boot: 200 open / 401 no-token / 401 forged / 200 valid-token with `ctx.identity.sub` in the reply |

| B1 request boundary | handler exceptions never reach the client (fixed reason + `x-dsx-correlation-id`, detail to `config.onError`) · body capped against the STREAM, not the lieable `Content-Length` · `exp` REQUIRED on a JWT + 24h lifetime ceiling + `typ` pin + 8 KiB token cap · `ctx.query`/`ctx.body`/`ctx.params` kept distinct so a write never trusts the merged bag | `host.security.test.ts` (13) · `identity.security.test.ts` (15), each mutation-proven |
| B2 the gateway made real | `provides`/`reach` was documented law that nothing read. Now `prepare_server.rb` ABORTS when an api row publishes an action without `provides: ["server"]`; a `worker` row emits `reach: []` and `host.ts` admits only a service-role caller, answering everyone else with the BYTE-IDENTICAL 404 an absent route returns | live: a valid USER token on the queue drain went 200 → 404 |
| B3 repository + declared CRUD | `repoFor(ctx)` is user-scoped and forwards the caller's verified token (RLS as the user); `serviceRepo()` is a DIFFERENT type tsc refuses to cross-cast; writes are allowlisted to the entity's declared fields; `id`/`owner_id`/`created_at` are server-assigned; list pages bounded. An api row may name `entity`+`op` instead of an action and the emitter writes the handler — **no author code exists**, so no data-access bug can be written into it | `repo.security.test.ts` (14) · portability 3/3 |
| B4 config, not env | The server node read raw env while every other module declares config, so an unset secret meant a SILENT 401 on every `auth: "required"` route. Now `Core/Server/config.json` declares the settings (→ `PackageCatalog.json` → the dashboard form) with two generic grammars — `provides_when` (a value provides a capability) and `required_when` (a sibling's value makes this required). `prepare_server.rb` ABORTS when a route needs a capability nothing provides; the runtime REFUSES TO BOOT when a required setting's env is unset, naming the label, the reason and the variable. `scripts/dsx_deploy.rb` is the one button: plan by default, `--apply` executes, secrets never in argv or logs | `config.test.ts` (12, both wirings mutation-proven) · `server_config_guards_test.rb` (executes the build abort) · live: boot refused with no secret, then 404/404/200 on the drain |

LANDED LOCALLY (this branch), verified end-to-end on a developer machine: the node
boots (`node --experimental-strip-types packages/server/src/bootloader-node.ts`,
`DSX_JWT_SECRET=…`), `GET /health` returns the assembly digest, and the T4 drain
route answers 404 anonymous / 404 with a user token / 200 with a `service_role`
token (B2 replaced T4's original 401s: an internal route must not confirm it exists).
Booting with **no** signing secret now refuses to start instead of coming up healthy
and refusing every caller.

| B6 the AUTHORING SURFACE | **LANDED 2026-08-12** — `backend-authoring.md` is the document. A `<server>` .dsx document in a module's server residence declares entities/secrets/egress/actions in its head and routes/workers in its body; every tag compiles to a facet row prepare_server ALREADY aggregates, so the merge happens before any validator runs and no gate learns a row came from markup. The handler is generated (`actions.generated.ts`, the declared-CRUD precedent), so `host.ts` needed NO change. What a body can reach IS the security argument: `data` (scoped to the verified caller), `queue`, `secret` (declared names only), a declared package — and nothing else, because JSE has no name for `import`/`process`/`globalThis`. Budgets (loops · wall clock · module calls) are per-request and clamped by the platform; `fetch` is refused unless the document declared the host. The IMPORT primitive (`Core/Server/Modules/Import`, the `packages` word) binds a PINNED npm coordinate's exports to a bus scheme — the coordinate is not re-declared, it must already be in `web.server_dependencies`. The kernel gained only an optional per-request `callModule` funnel, an `egress` gate, budget fields and `takeThrow()`, all unset on every surface (measured cost 186 bytes gzip; the media-qualification ledger was re-pinned in the same change) | `server_document_test.rb` (23) · `packages/server/test/actions.test.ts` (24, secret + egress gates mutation-proven) · prepare_server ×2 idempotent · `lint_dsx --strict` routes a `<server>` root to the document reader |

| B5 the transport, proven AND installed | `src/postgres.ts` compiles a `RepoQuery` into ONE parameterised statement inside a transaction that first adopts the caller's identity (the PostgREST convention, transaction-local). The DRIVER is the provider module's own: `Core/Server/Providers/Postgres/web/server/` loads `pg`/`npm:pg` lazily, external to every bundle; the emitted providers barrel + `installDataBackend`/`installConfiguredDataProvider` boot it in all three wrappers BEFORE the port opens. `data_backend` (config) provides the `data` capability — a CRUD row with no backend is a BUILD ABORT; `database_url` is a required secret while postgres is chosen. TWO LEAKS FOUND BY EXECUTION, both now regression-gated: the table-owner bypass (`enable` does not bind the owner role ⇒ the migration now emits `force row level security` on owner tables) and the pool scatter (per-call `pool.query()` scatters begin/set_config/statement across connections ⇒ Bob read Alice's row 1-in-4 under load; the transport holds each transaction on one checked-out connection, and single-client transports serialise) | `rls.postgres.test.ts` (6, PGlite, emitted migration byte-for-byte) · `postgres.connection.test.ts` (6, mutation-proven) · `postgres.live.test.ts` (3, real Postgres 17, skips without one) · live HTTP: anonymous 401 → Alice creates via declared CRUD (posted `owner_id` ignored) → Bob lists `[]`, gets `null`, cannot update/delete → boot with no URL refuses naming the field |

**LANDED since (correction 2026-07-29 — this paragraph listed both as open):**

- **Firestore, the second implementation.** `src/firestore.ts` is a REST transport with ZERO
  dependencies (the runtime's own `fetch`), and the headline is what did NOT change: `RepoQuery`
  survived it COMPLETELY UNCHANGED, all nine fields, every divergence absorbed transport-side.
  Rules are not row filters, so an owner-scoped list adds `owner_id == subject` to make an honest
  request expressible while the emitted rules remain the authority. Firestore has no column
  defaults, so `owner_id`/`created_at` are written from the VERIFIED subject and an injected
  clock, mirroring the migration's `default auth.uid()`. Denial and absence both answer `null` to
  match RLS — but **401 ALWAYS throws**, because an expired credential must never read as "the
  database is empty". The provider is now whole: `Providers/Firestore/web/server/index.ts` fills
  the seam (credential INJECTED from `DSX_FIRESTORE_ACCESS_TOKEN`, never minted), `"firestore"` is
  a real `data_backend` option, and the SAME `schema` facet compiles to `firestore.rules` AND
  `firestore.indexes.json` — the composite indexes are part of the schema, not tuning, because an
  equality filter plus an order-by on another field is a hard `FAILED_PRECONDITION` in Firestore
  until one is declared.
- **`drainWebhooks`.** The queue is a SECOND SEAM with its own two-method vocabulary
  (`claim`/`settle`), deliberately not a widened `RepoQuery` — a lease protocol has no CRUD
  spelling, and forcing one in is exactly the Postgres-ism leak the freeze rule exists to catch.
  The claim is ONE statement (a CTE wrapping `update … returning` with `for update skip locked`)
  because atomicity is the correctness property and there must be no read-then-own window; SKIP
  LOCKED is liveness only. Ack KEEPS the row, since deleting it would destroy the
  `idempotency_key` UNIQUE guarantee the emitter declares. The whole worker handler is now two
  statements and reports a REAL count.

STILL OPEN after B1–B5: the PostgREST/pooler binding for the deployed Supabase edge
(the local proof speaks SQL directly; a hosted edge function reaches Postgres through
the pooler — point `database_url` at the project's pooler address and it is the same
transport), and the first LIVE `dsx_deploy.rb --apply`. Docker turned out to be
unnecessary: PGlite covers CI, and a Homebrew Postgres covers the live lane on this
machine.

**`RepoQuery` IS FROZEN (2026-08-06).** The freeze instrument was always in place — one
portability corpus (12 cases, naming no store) run against BOTH transports, 24/24 — and the
interface came through the second implementation unchanged, which is what the rule was for.
The one thing missing was a run against a real service, because the Firestore leg had only
met an in-process fake whose rules are parsed from the emitted `firestore.rules`. That run
has now happened: the Firestore emulator, loading the EMITTED `firebase.json` +
`firestore.rules`, answered the identical corpus **11 pass / 0 fail / 1 skip** — the skip
being the negative control, which cannot run against a live service by construction
(isolation cannot be switched off from a test) and is carried by the always-on in-process
backends. The assumption the whole owner-filter design rests on is settled: an owner-scoped
`runQuery` IS refused unless it names its owner.

The blocker had not been the work; it was an unchecked claim ("no emulator is installable in
this container"). `firebase-tools` installs fine, the JAR downloads, Java is present — the
same lesson `ClosedSource/Documentation/archive/plans/HANDOFF.md` (archived) §5.3 already records. **The live run immediately earned its keep:**
it exposed that the emitted Firestore rules let an owner REASSIGN `owner_id` on an update
(in a rule `resource` is the pre-write document, so "do you own this row?" passes a write
that gives it away), where the Postgres twin's `with check` refuses it. Fixed in the emitter
by splitting `read, delete` / `update` / `create`, verified both ways against the emulator,
and pinned by `prepare_server_test.rb`.

**The queue plane is Postgres-only, on purpose.** `installFirestore` leaves `QueueSeam`
empty because an atomic claim there is a transaction with a per-document precondition and
a retry loop — a different protocol from SKIP LOCKED, which deserves to be written rather
than approximated. A tree configured for firestore that also drains a queue therefore gets
a typed `no_provider` naming the fix, never a silent `drained: 0`.

**Durability P4 (typed absence) is LANDED** (correction 2026-07-28 — this line
previously said Open; `durability.md` is the authority: all five phases enforce
in CI, and T2's link resolution consumes P4's reason enum as designed). Open:
**full-stack T2–T4** below. T1 is LANDED (see the table row and full-stack.md);
its W-sections below stay as the reference spec for how it is shaped.

## T1 — four workstreams, agent-parallel

Merge order: **GRAMMAR → HOST → EMITTER → DOGFOOD.** Each lands green under
the standard gates or it doesn't land.

### W-GRAMMAR (ClosedSource Ruby — smallest, first)

- New module `Core/Server` (feature-parent): `dsx.json` with
  `"facet": "server"` — registers the word; modules may then declare
  `provides: ["server"]` and put server sources under `web/server/`.
- New child `Core/Server/Modules/Http`: binds the **`api`** declaration
  namespace via the object form — the LANDED grammar, exactly:

  ```jsonc
  "facet": { "word": "api", "declarations": {
    "key": "word",
    "fields": {
      "method":   { "type": "string",    "required": true },
      "path":     { "type": "string",    "required": true },
      "action":   { "type": "ownAction", "required": true },
      "schedule": { "type": "string" }
    },
    "emit": "ServerRoutes"
  } }
  ```

- Any module then declares rows:
  `"facets": { "api": { "create": { "method": "POST", "path": "/orders", "action": "create" } } }`
  — `ownAction` already validates against the declarer's `actions`
  (stale-target gate, existing); `facet_declaration_conflicts` already
  aborts duplicate keys among ENABLED declarers.
- NEW gate to add: method+path uniqueness across enabled rows (two rows may
  not claim `POST /orders`) — same abort tier, lives in prepare_server.
- Gates: `prepare_modules` ×2 idempotent · `dsx_graph_test.rb` ·
  `contract_diff.rb` (actions untouched ⇒ clean).

### W-HOST (OpenSource/Web — the biggest)

- `packages/server` grows the module host: load the routes table
  (emitter's JSON), dispatch request → action (the kernel's existing action
  executor — the same one the conformance runner drives headless) → typed
  resolve → response. NO envelope in either direction: a success is `200`
  carrying the handler's value verbatim, a failure is its real status carrying
  `{reason, message}` — the status line is the only success/failure signal, and
  it is deliberately NOT the error-ledger shape (that ledger is the client's
  error plane, not the wire).
- Two bootloaders around ONE host: `bootloader-deno.ts` (the Supabase edge
  entry — `Deno.serve`, fat function, `/functions/v1/dsx/*`) and
  `bootloader-node.ts` (custom/docker HTTP loop). The kernel is
  browser-proven (dom package) ⇒ platform-API-free; keep it that way — any
  fs/env access lives ONLY in bootloaders.
- Identity: a `verifyIdentity(req)` seam in the bootloader resolving JWT →
  request context (Supabase JWKS in T2; T1 ships the seam + a dev-mode
  stub). Secrets via `Deno.env`/`process.env` at the bootloader only.
- Gates: `npm test` (add a server-host suite: route dispatch, method
  mismatch, unknown route ⇒ typed error, action resolve round-trip) ·
  `npm run typecheck` · `npm run conformance` (must stay green — proof the
  kernel didn't fork).

### W-EMITTER (ClosedSource Ruby)

- `ClosedSource/scripts/prepare_server.rb`: nodes via `DSXGraph.nodes_from_manifests`
  (envelope-gated for free) → ENABLED subset (reuse the exclusion recipe) →
  `facet_declaration_rows(enabled, 'api')` → emit:
  - the routes table JSON (module chain + action + method + path + schedule),
  - the Supabase function wrapper (`supabase/functions/dsx/index.ts`),
  - a Dockerfile for the Node bootloader.
- Deterministic (sorted, no clocks, repo-relative — the receipt rules);
  double-run idempotent; the method+path uniqueness abort lives here.
- Wire a codemagic step (the check-chain pattern); the portability gate
  (all three artifacts per PR) completes in T2 when the Firebase wrapper
  exists.
- Gates: run ×2 = no diff · a golden-fixture test (parser_test style).

### W-DOGFOOD

- First real endpoint(s): `GET /dsx/health` (Core/Server/Modules/Http's own
  action — resolves `{ ok, version, digest }` from the assembly receipt)
  plus ONE real platform endpoint — the OAuth code-exchange or RevenueCat
  webhook class our docs currently ship as paste-this snippets, declared as
  that module's server action with an api row.
- Done-criteria for ALL of T1: the SAME routes table serves
  `curl localhost:8787/dsx/health` (Node bootloader) AND
  `supabase functions serve` (Deno bootloader) locally; all gates green.

## T2–T4 (see full-stack.md for the law)

- **T2:** Supabase JWKS identity + `Core/Supabase` provider module +
  Firebase wrapper/bootloader + cron emission (pg_cron / Cloud Scheduler)
  + the client link (resolution ladder local → link → typed unavailable —
  consumes P4's enum; the watch link is the template, including fail-NOW
  honesty). The two-implementation freeze rule and the portability gate
  activate here.
- **T3:** the NARROW schema facet + provider compilers (SQL migrations +
  RLS vs security rules); migration bundles digest-pinned.
- **T4:** queue-consumer actions (`provides: ["worker"]`), idempotency keys.

## Environment memory (the ship-fast section — read or lose an hour)

- **Fresh container:** `gem install xcodeproj` before any prepare run.
- **pbxproj drift:** containers without the Android preparer drop
  `.plugin_reporting_android.json` from the exceptions list on every
  prepare run. NEVER commit that removal — `git checkout --
  ClosedSource/Runtime.xcodeproj/project.pbxproj` before committing; if you
  must add an exception line, hand-edit it in (byte-sorted position) after
  the reset, as the receipt landing did.
- **Swift does not compile locally** — changes are compile-pending and ride
  Codemagic. Kotlin (`gradle test`) and Web (`npm test`, Node 22 runs .ts
  directly) DO verify locally: prefer proving behavior there.
- **The gates** (the monorepo working rules are authoritative): prepare ×2 idempotent ·
  `lint_dsx --strict` 0/0 · `lint_dsx_css --strict` 0/0 ·
  `check_module_rules` · plus conditionals — `dsx_graph_test.rb` (touched
  dsx_graph/exclusion consumers), `contract_diff.rb` (touched
  actions/methods), style catalog (touched Stack styles), brace-balance on
  changed .swift.
- **contract_diff base:** resolves CLI arg → `$CM_PULL_REQUEST_DEST` →
  origin/main|master|v4; soft-skips when none resolve. Never make it fail
  on git topology.
- **Commit style:** small phase commits, message explains the law being
  served, docs updated IN the same commit (status markers in the proposal
  docs — LANDED with file pointers — are how the next agent knows state).
- **The one bus rule is enforced** (`check_module_rules`): no
  `ModuleRegistry.shared`, no cross-module NotificationCenter, no aliasing
  `dsx`. Server-side the same spirit holds: business modules never import
  supabase-js/firebase-admin — only bootloaders and provider modules do.
