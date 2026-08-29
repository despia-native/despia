# Cost guardrails — the spend plane

**Status: ACCEPTED — the server plane LANDED 2026-08-27** (same day as the proposal, on the
owner's "fully implement it"). The owner's directive, distilled: *an AI developer must not be
able to wake up to a fifty-thousand-dollar Cloudflare bill because a generated action called
itself in a loop.* Builds on `backend-authoring.md` (the request sandbox and its budgets,
LANDED), `full-stack.md` W1/W2 (the Workers bootloader + `deploy cloudflare`, LANDED),
`durability.md` (envelope, explain ledger, assembly receipt — the governance this inherits), and
the rate plane (`packages/server/src/ratelimit.ts`, LANDED). First customer: every app whose
backend an AI wrote, which is the customer the product exists for.

**Landed state, measured** (`node --test packages/server/test/spend.test.ts` → 18/18 unit ·
`spend.postgres.test.ts` → 4/4 against REAL Postgres (PGlite + the emitted migration, byte for
byte: the batched upsert accumulates, a fresh isolate discovers another's spending from the
durable counts, the depth ceiling's three answers, the shared sweep prunes spend windows) · the
whole server suite green · workerd suite 10/10 · `server_document_test.rb` 47/47 ·
`prepare_server.rb` ×2 idempotent · corpus `OpenSource/Conformance/spend/` in the index with its
runner, egress resolution pinned LONGEST-DECLARATION-WINS): the `<budget>` grammar + guarded defaults + loud `unbounded` (G1); the plane —
sync charge, write-behind flush, bounded staleness, `429 spend_capped` naming the budget,
`spend.warning`/`tripped`/`recovered` on the feed (G2, `packages/server/src/spend.ts`, counters
riding `dsx_rate_counter` so nothing new needs provisioning); queue `depth` backpressure
(`saturated`) + the build-time self-egress refusal with `self="allow"` as the acknowledgement
(G3's landed half); `/dsx-internal/spend` with the deploy-minted read token + CORS for the
browser-direct dashboard (G4) — whose card now exists as **Spend Guard** in the dashboard's
money column (`ClosedSource/StudioApps/SpendGuard/Components/SpendGuard.dsx` + the `kit.SpendMeter` row;
each ceiling a bar with a state pill, the card wearing its worst row, sample rows shaped like
the wire snapshot until an app origin is bound, browser-proven under Chromium); the edge-triggered HMAC beacon, off unless BOTH halves are
configured (G5's sender; the stateless ingest document lives in despia-platform, deployed when
that repo scaffolds); `limits.cpu_ms` in the emitted wrangler.jsonc (G6's first attachment).

**The reserved namespace, provisioned (landed 2026-08-27, third wave).** The product law, in the
owner's words: *customer-owned infrastructure is not customer-managed plumbing.* They connect an
account; Despia owns the `dsx_` system tables inside their database the way any framework owns
its migration table. This landed on a real defect rather than a gap: the monorepo emitter wrote
`dsx_rate_counter` and `dsx_event` into its migration and the standalone `despia build` wrote
NEITHER, so a customer deployment metered spend against a table that did not exist and published
events into one that did not either — while the runtime's own error message claimed "the emitted
migration creates it". The same divergence had eaten the G6 CPU ceiling and the Hyperdrive
binding on that path. All four are closed by ONE registry (`postgres.ts systemTables`) that the
migration, the provisioner and the damage report all read, so a table cannot be created by one
and forgotten by another. `despia provision` inspects, creates what is missing, verifies by
reading back, and writes `deploy/receipt.json`; `despia deploy --apply` runs it before publishing
and refuses to publish unverified. An ALTERED system table is named and left alone on purpose —
a restored column is not a restored constraint, so repairing it silently could report success
over a still-broken deployment. Proven against a real Postgres (PGlite): a bare database, damage,
repair, idempotence, and the spend counters and event feed running on a namespace the
provisioner alone created.

**Authoring surfaces beyond the monorepo (landed 2026-08-27, second wave):** the STANDALONE
twin — `despia build`'s `<server>` compile step (`packages/cli/src/server-document.ts`) reads
the same `<budget>` and `self="allow"` grammar with the same aborts, merges the guarded
defaults per attribute (`spendPlane`, the prepare_server.rb merge verbatim: an egress budget
must name a declared host or a suffix-parent, a queue budget a drained queue, and what the
author did not touch stays guarded), emits the merged table as `spendBudgets` in the generated
barrel for `createHost({ spend })`, and prints every unbounded seam loudly at build
(`server-document.test.ts`, the spend block). And the STUDIO — the server screen's fourth view
(`despia edit` → Server → **Spend**, `Custom/Editor/Components/EditorServer.dsx`, fed by the
`/edit/api/server/<doc>` projection): the deployment-wide plane as rows, provenance on every
one (a default IS a budget, just one nobody had to write), the unbounded row the screen's one
loud cell, and the tapped row answering with the exact `<budget …/>` head line that pins it
plus its file and line — browser-proven under Chromium.

**Two open corrections, in the open (section 3 of the contract):** the runtime HOP COUNTER is
deferred with its trigger named — analysis while landing showed a `<server>` body has NO seam
that can call a route (actions call siblings only), self-egress is refused at build, and a
queue cycle is bounded three ways (window ceiling at the push seam, `depth` backpressure, the
idempotency UNIQUE) — so a hop header would today be a check nothing can set; it lands with the
first mechanism that can actually recurse (an acknowledged `self="allow"` fetch is that
mechanism's front door, and the guard should land with its first real user). And the CLIENT
half (the kernel honouring the advisory headers with automatic backoff) is a cross-renderer
kernel wave — three runtimes, corpus first, per the unified-codebase law — not a server patch,
so it is scheduled as its own wave rather than smuggled into this one.

## The problem, stated as a bill

Usage-billed platforms have **no hard spend ceiling**. Cloudflare Workers bills per request, per
CPU millisecond, per queue operation, per row read and written, and offers notifications, not
brakes; the famous five-figure invoices are not exotic attacks, they are ordinary defects
metered honestly: a worker that fetches its own URL, a queue consumer that re-enqueues what it
consumed, a retry loop with no floor under it, a client effect that fires on every render, an
LLM call inside a loop that was supposed to run once. AI-generated code produces exactly these
defects, at the exact moment the author is least equipped to notice — and Despia's stated
audience is people shipping AI-generated backends to their own linked accounts.

The platform will not protect them. The framework can, because of a property no general-purpose
platform has: **a Despia backend's effects are already enumerable.** That is the message behind
the ask, and it is why this plane is a differentiator rather than a checkbox.

## The law

**Everything that costs money crosses a seam we own, so everything that costs money is
budgeted, by default, before the first author declares anything.** Four sentences carry the
whole design:

1. **The seam list is the meter.** A `<server>` body can reach `data`, `queue`, `secret`,
   declared packages, and egress-gated `fetch` — nothing else exists (`backend-authoring.md`).
   Money leaves through invocations arriving, compute spent, rows written, messages queued,
   bytes stored, and calls leaving. Each is a seam the host already funnels. Metering the seams
   meters the spend; there is no fifth place for money to exit an authored backend.
2. **Ceilings default ON with no declaration.** The author who writes nothing gets the guarded
   profile. Declaring a `<budget>` raises or lowers a ceiling; removing one is an explicit,
   loud act (`max="unbounded"`), printed by the deploy and badged in the dashboard. The
   feature flag the owner asked for is the declaration itself: absence is locked, presence is
   the opt-out, and both are visible.
3. **A tripped ceiling is a refusal with a name, never a silent throttle.** The request answers
   `429 spend_capped` naming which budget went and when the window resets, the trip lands on
   the durable event feed, the dashboard notifies, and the window's roll re-opens the breaker.
   Fail-closed at the wallet is the point; fail-*mute* would be the bug.
4. **The truth lives on the owner's infrastructure.** Meters, trips, and the analytics the
   editor renders are rows in the app's own data plane, under the reserved `dsx_` namespace
   the deploy already owns. Despia's backend receives at most a doorbell (§ the beacon), never
   the ledger.

## Why "99.9999" is an enumeration, not a probability

The owner asked whether the coverage can be five-nines-plus. For authored backends the honest
answer is yes, and not statistically: the request sandbox has no ambient I/O — no `import`, no
`process`, no sockets — so the set of cost-bearing operations is *closed*, and a closed set can
be covered by enumeration. The claim this proposal makes checkable: **every seam in the closed
list carries a meter, every meter carries a default ceiling, and the conformance corpus walks
the list** — so a new seam cannot land without landing its meter (the corpus census moves, the
gate goes red). What sits outside the enumeration is §"What this cannot do", kept honest
rather than rounded up.

## The three decisions, recorded as law

1. **Budgets are counted in UNITS, never in currency.** Requests, calls-per-host, messages,
   rows, bytes, CPU milliseconds — things the runtime can count exactly, on every target,
   forever. A dollar figure is a vendor price sheet multiplied by a unit count, and price
   sheets change without a deploy; a plane denominated in dollars silently re-prices itself.
   The dashboard translates units to an estimated bill per target (that is presentation); the
   runtime enforces units (that is law).
2. **There are two kinds of ceiling, and they answer to different owners.** The request
   sandbox caps (50 000 iterations, 10 s wall, 64 module calls) protect the *platform* from
   one request; `backend-authoring.md`'s sentence — a document may ask for less, never more —
   stays exactly as true as it is today. Spend ceilings protect the *owner's wallet* from the
   fleet; they are the owner's policy, so raising them is legal and loud. The plane that must
   never be raisable and the plane that must be raisable in the open are different planes,
   and collapsing them is how a guardrail becomes either a straightjacket or a fiction.
3. **The guard costs ~nothing to run, on BOTH ledgers, or it is wrong.** Despia's hosting
   offer is *free when you bring your own Cloudflare account*, so this plane may not create a
   Despia-side bill that scales with customer traffic: Despia stays OUT of the data path
   entirely (§"What the guard itself costs"), and only edge-triggered transitions ever reach
   us. On the owner's ledger the guardrails must fit inside the free-tier allowances they
   ride on: a meter that pushes a free app onto a paid plan is the bill it exists to prevent.

## The grammar

Head rows in the `<server>` document, beside `<egress>` and `<secret>` where the deploy already
reads declarations:

```dsx
<budget of="requests"                per="day" max="250000"/>
<budget of="egress:api.openai.com"   per="day" max="25000"/>
<budget of="queue:billing"           per="day" max="50000" depth="10000"/>
<budget of="data:writes"             per="day" max="500000"/>
<budget of="egress:api.stripe.com"   per="day" max="unbounded"/>
```

- `of` names a metered seam: `requests`, `egress:<declared host>`, `queue:<name>`,
  `data:writes`, `data:reads`, `content:bytes`. The vocabulary is closed and lint-enforced,
  like every attribute on this surface.
- `per` is the window (`hour` | `day` | `month`), epoch-aligned like the rate plane's windows
  and for the same reason: two isolates must agree which window a unit falls in.
- `max="unbounded"` is the opt-out — a word, not an absence, so a reviewer greps for it, the
  deploy prints it, `prepare_server` writes it into the assembly receipt, and the dashboard
  badges the deployment *unguarded* on that seam.
- **No declaration = the guarded profile.** The defaults live in ONE generated place
  (`generated/spend-defaults`, corpus-pinned), provisional numbers to be ratified by the
  owner: 250 000 requests/day, 25 000 egress calls/day per declared host, 50 000 queue
  messages/day with 10 000 outstanding, 500 000 row writes/day, warning at 80%. Generous
  enough that a real small app never meets them; a runaway meets them in minutes. The
  egress-per-host ceiling is the one that matters most: the largest real-world runaway for AI
  apps is not Cloudflare's own meter, it is a paid model API called in a loop, and Despia is
  the only framework where outbound hosts are already declared grammar — the allowlist that
  exists for security becomes a spend firewall for free.

`<route rate="…">` stays what it is: per-caller fairness inside the window. Budgets are the
aggregate ceiling over all callers. One is about who, the other about how much; both answer
429 with honest headers.

## The runtime — meter, breaker, and what a blocked request may cost

Enforcement lives at the host choke point (`host.ts`), where the rate verdict already sits, and
reuses the rate plane's store shape: one atomic upsert per bucket
(`insert … on conflict do update set count = count + n returning count`), epoch-aligned
windows, counters swept by the retention tick that already runs. What is new is the posture:

- **Metering is write-behind and must cost ~nothing.** Units accumulate in isolate memory and
  flush batched (`ctx.waitUntil` on Workers, the interval on Node); a meter that added a
  round trip per request would be a second bill. Exactness is not load-bearing — ceilings are
  safety margins, not invoices — so the plane states its honesty bound the way `ratelimit.ts`
  states its 2× window fact: overrun is capped by `flush interval × request rate`, and the
  bound is written here so nobody rediscovers it from a graph.
- **The breaker is cached state with bounded staleness, not a per-request read.** Each isolate
  refreshes the verdict at most every few seconds. If the store is unreachable, the LAST KNOWN
  verdict holds — open stays open (a wallet guard must not convert a database hiccup into an
  outage; the rate plane's fail-open reasoning applies), tripped stays tripped (the runaway is
  exactly when the store is likeliest to be drowning). The failure itself lands on the event
  feed.
- **A tripped answer must be nearly free.** The refusal is decided at the host's threshold —
  before its auth gate, before the body is read, before the handler and every binding: static
  `429 spend_capped`, `Retry-After` at the window's real end, the budget's name in the body.
  Stated precisely: the platform entries resolve bearer identity before handing the request
  in (isolate-cached JWKS; a refetch is possible on cache expiry), so token verification is
  the one cost a blocked request can still pay beside the platform's invocation charge
  (§ honesty). Everything else is zero — no parse, no queries, no egress — and the expensive
  part of every runaway is the fan-out, which is what the breaker amputates.
- **The meter boundary is the platform's fetch, not only the interpreter's.** The bootloader
  installs the counting (and per-host-budget-enforcing) `fetch` at isolate boot, so declared
  packages' own I/O and ejected TypeScript handlers are counted too, not just seam-routed
  calls. Where a future runtime freezes the global, the guarantee narrows to the seam tier
  and the platform-mapping table says so.
- **Refusal vocabulary:** `spend_capped` joins the closed reason table at 429, distinct from
  `rate_limited` (who) and `budget_exceeded` (one request's sandbox). Three names, three
  facts, no diagnosis by vibes.

## Amplification guards — the loops themselves

Ceilings bound the damage; these attack the defect class directly:

- **Hop depth on internal dispatch.** Every server-originated call into the host — scheduled
  dispatch already travels as `https://dsx.internal` with `X-DSX-Internal-Key` — carries a hop
  counter; every queue message carries one. Default ceilings (4 request hops, 8 message hops)
  refuse the cycle with `loop_detected` naming the chain. A worker that re-enqueues to its own
  queue still works — N times, then loudly stops.
- **Queue backpressure.** `dsx.module.queue.push` answers a typed `over_capacity` refusal when
  the declared `depth` is exceeded. Retries are already bounded into dead-letter; depth was
  the remaining unbounded axis.
- **Prepare-time self-reference lint.** An `<egress>` row naming the deployment's own hostname
  is the recursion bill's front door; `prepare_server` aborts on it unless the row carries an
  explicit acknowledgement. Same pass flags a worker whose action pushes to the queue it
  drains, as information, since the hop ceiling already holds it.
- **The client half of the wire.** The rate plane sends advisory headers on every answer
  precisely so a client can back off before refusal; today no client reads them. The kernel's
  api path learns to: honour `Retry-After`/`x-ratelimit-remaining` with automatic backoff, and
  carry a per-device circuit breaker so a reactive loop in a screen cannot hammer the backend
  from ten thousand installs at once. Both ends of the wire defend it.

## The internal plane — the owner's own infrastructure

The owner's sketch — "a Despia system worker plus storage the user does not touch, that the
editor reads" — lands with one correction: **no second worker.** The emitted worker already IS
the system (one worker hosts routes, site, MCP, cron); a guardian sidecar would add a hop, a
bill, and a thing to drift. The internal plane is a reserved *namespace inside* the deployment
the app already owns:

- **Storage:** `dsx_`-prefixed tables in the app's own data plane (the namespace `dsx_events`
  and the rate counters already claimed) — meters, trips, and the analytics rows the editor
  renders. On Cloudflare that is the Hyperdrive-bound Postgres today; a Workers-native
  provider (D1 / Durable Objects / Analytics Engine) is a provider module under decision 1 of
  `full-stack.md`, vendor-named, never smuggled into the common grammar.
- **Access:** `/dsx-internal/*` routes on the same host, admitted exactly like worker rows —
  service-role key or a dashboard token the deploy mints, byte-identical 404 to everyone
  else. The editor and dashboard READ the owner's deployment; Despia's backend stores account
  linkage and doorbells, not app data. That is the GDPR posture stated positively: the
  product's own Observe pillar (`product-vision.md`) runs on the customer's infrastructure,
  and Despia never warehouses what it only needs to display.
- **"The user cannot touch it" is convention plus evidence, not enforcement**, and the
  proposal says so rather than pretending: it is their account and root is root. The assembly
  receipt (`durability.md` P3) records what was provisioned; the deploy verifies and
  re-provisions drift and reports it. Tamper-evident, honestly not tamper-proof.

## Notification, and the beacon that cannot spam us

- **Warning before refusal:** crossing 80% of any ceiling lands `spend.warning` on the durable
  event feed, once per window (edge-triggered). The trip lands `spend.tripped` with the
  budget, the counts, and the reset time; the roll lands `spend.recovered`. The dashboard
  renders the feed it already reads.
- **The beacon is a doorbell, not a ledger.** For the owner who has the dashboard closed, the
  deployment sends Despia one signed HTTPS beacon per (budget, window) transition —
  edge-triggered, so bounded by construction; HMAC'd with a deploy-minted key; carrying app
  id, budget name, window — no payloads, no user data. Despia's ingest is a worker with its
  own rate plane (per-app ceiling, silent drop beyond), and losing a beacon loses nothing:
  the truth is on the owner's plane, the beacon only rings the bell for a push/email. The
  cost-effective, spam-proof architecture the owner asked about falls out of edge-triggering:
  a system that can only speak on state *transitions* cannot flood anyone, including us.

## What the guard itself costs — two ledgers, and the goal is zero on ours

The hosting offer is *free when you bring your own Cloudflare account*. That sentence is a
constraint on this design, and the design meets it by keeping Despia out of every path that
scales with customer traffic:

**Despia's ledger — three paths, each held at ~zero:**

- **The read path does not exist on our side.** The dashboard and editor read the owner's
  deployment DIRECTLY from the browser — a fetch from the editor page to the app's own
  `/dsx-internal/*` routes, CORS-allowed for the editor origin, authenticated by the
  deploy-minted read token. Analytics bytes travel owner-worker → owner's-browser and never
  transit a Despia server, not even as a proxy hop. Zero Despia compute, zero Despia egress,
  and the GDPR posture gets stronger: we do not even *see* the data we display.
- **The write path is transitions only.** The beacon fires on state changes (§ above), so its
  volume is bounded by deployments × budgets × windows, not by traffic. The ingest is one
  STATELESS worker on Despia's own Cloudflare: verify the HMAC, ring the bell (push/email
  enqueue), store nothing durable — the truth already lives on the owner's plane, so there is
  nothing to warehouse. A free-tier WAF rate rule sits in front of it, so garbage is refused
  before it becomes billable compute. Envelope in units: even 100 000 apps each tripping a
  budget daily is ~100 000 requests/day — the free tier's boundary, pennies past it.
- **Provisioning is per-deploy, not per-request.** `dsx deploy` runs against the owner's
  account with the owner's token; Despia's involvement is the CLI and the receipt, both
  already paid for.

**The owner's ledger — the guard fits inside what it guards:**

- **The free plan IS the strongest guardrail, and the default posture says so.** A BYO
  Workers Free deployment cannot produce a bill: the platform fails closed at its daily
  request allowance, static asset requests are free, and no payment method is attached to
  usage. The emitter therefore treats free-plan deploys as ALREADY GUARDED (the spend plane
  meters and warns but the hard cap is the platform's own), and the moment of real exposure
  is named honestly: upgrading to Workers Paid is the act that removes the platform's brake,
  so THAT is when the spend plane's ceilings become the only brake — the deploy says so in
  those words when it detects the plan.
- **The meters must never push a free app onto a paid plan.** Write-behind flushing fires at
  most every 5 s (`SPEND_FLUSH_MS`) and only while traffic flows — an idle isolate writes
  nothing — so the meter's own writes are bounded at ≤ 17 280 tiny single-statement upserts
  per isolate per day flat out, noise on any plan; the breaker refresh is one read per
  interval, and the cron ticks are already conditional (no worker rows → no queue cron),
  ~1 440 invocations/day when present. The suite asserts the batching (a thousand charges
  are ONE statement), so "the watcher is cheaper than the watched" is a gate, not a hope.

## Platform mapping — Cloudflare first-class, everywhere by construction

Enforcement lives in the host and bootloaders, so **every deploy target inherits the plane the
day it exists** — Vercel, Netlify, self-hosted Node included, since they run the same
`createHost` path. What differs per target is the *attachments*: native controls the emitter
can additionally provision. Named per target, parity-register style:

| Target | Attachments the emitter adds | Named degradation |
|---|---|---|
| Cloudflare (preferred) | `limits.cpu_ms` in wrangler.jsonc (provisional 5 000 ms); Workers Free tier as the honest hard cap for hobby apps; native rate-limit/WAF rules on tripped routes where the token's scope allows; usage notifications via API | none — full plane + attachments |
| Supabase | pg_cron cadence already fixed; counters in the same Postgres | no edge-native rules; runtime plane only |
| Vercel / Netlify (future) | provider spend caps / usage APIs where exposed | attachments TBD when the target lands; runtime plane full from day one |
| Self-hosted Node | none needed — the bill is a server you already bought | metering still on (the feed feeds the dashboard) |

The unified-codebase posture, applied to deployment: the *behaviour* (ceilings, refusals,
events) is identical on every target and corpus-gated once (`OpenSource/Conformance/spend/`,
run on the server runtime per PR and under workerd in the `server-workers` lane); the
*attachments* are per-target and listed, never load-bearing for correctness.

## What this cannot do

- **Traffic that arrives still costs its invocation.** A tripped breaker makes each blocked
  request nearly free, not free; a determined external flood spends platform-floor cents per
  million. The Cloudflare attachment (edge rules on trip) pushes that toward zero; DDoS
  economics beyond it are the platform's layer, not the runtime's.
- **The `requests` ceiling meters the API surface, deliberately.** Site pages and static
  assets are served ahead of the host (the site face) and ride the platform attachments
  instead: static asset requests are free on Workers, and `limits.cpu_ms` bounds what an SSR
  page can burn. A page-traffic ceiling would double-charge every API call the page makes and
  protect against the one traffic class the platform already prices at zero; if a target ever
  bills page serving meaningfully, that is a new attachment row, not a change to this plane.
- **An ejected TypeScript handler and a declared package are host-tier code.** The fetch-seam
  meter covers their I/O on runtimes that allow it; their CPU and their non-fetch effects are
  covered only by route-level ceilings and platform attachments. Ejection is a deliberate,
  receipted act, and this is one more line in what it means.
- **A hand-edited worker is outside the plane.** We guard what we emit. Drift is detected and
  reported via the receipt, not silently re-guarded.
- **A ceiling is enforced to a stated bound, never to the exact unit — and the bound is
  measured, not asserted.** Enforcement is per-isolate against a durable count synchronized at
  the write-behind flush, so the fleet-wide overshoot is at most `isolates × one staleness
  window of traffic` plus a boundary unit per isolate, and an isolate crash can additionally
  lose (and therefore re-admit) at most its unflushed tail — one flush cadence, since the
  flush rides every request's completion. Both cases are pinned by tests that measure the
  exact numbers (`spend.test.ts` crash-before-flush; `spend.postgres.test.ts` overshoot
  against real SQL). A globally-atomic pre-check would close the gap by putting a durable
  round trip on every charge, which is the meter becoming the bill; "2,000 means 2,000 ±
  seconds of traffic" is the honest sentence, and marketing may not say anything harder.
- **The owner's account is the owner's.** Ceilings, namespaces, and locks on their
  infrastructure are enforceable exactly until the account holder decides otherwise — which
  is the correct sovereignty, and the reason the plane defaults on rather than depending on
  anyone's restraint.

## The program

- **G1 — grammar + defaults.** `<budget>` rows, closed vocabulary, lint; the guarded profile
  applied with zero declarations; `unbounded` printed by deploy and written into the receipt.
  Gate: `server_document_test.rb`, corpus rows for parse/refuse.
- **G2 — meter + breaker.** Counters on the rate-store shape; write-behind flush; cached
  verdicts with the stated staleness bound; cheap `spend_capped` answers; `spend.*` events on
  the feed. Gate: `OpenSource/Conformance/spend/` on node + workerd, including "tripped costs
  no subrequests" asserted, not assumed.
- **G3 — amplification guards.** Hop counters, `loop_detected`, queue `depth` + `over_capacity`,
  the prepare-time self-egress abort; kernel client backoff honouring the advisory headers.
- **G4 — the internal plane.** `/dsx-internal/*` read routes, service-role gated; the
  dashboard and editor read the owner's deployment browser-direct (CORS for the editor
  origin + the deploy-minted read token — no Despia proxy hop); receipt-verified
  provisioning.
- **G5 — notification + beacon.** Dashboard surfaces the `spend.*` feed; the edge-triggered
  signed beacon; Despia-side ingest STATELESS, WAF-fronted, free-tier-sized, with its own
  rate plane; free-plan detection and the paid-upgrade warning in the deploy output.
- **G6 — Cloudflare attachments.** `limits.cpu_ms` emitted; edge rules + usage notifications
  where token scope allows; the mapping table above kept as the register.

Each phase lands with its gate in the same commit, per the gate-coverage law.

## What could ruin it

The known failure modes, named so they stay refused: a plane denominated in dollars (decision
1); a meter that becomes the bill (write-behind is load-bearing, and the corpus should assert
call counts); a breaker that fails mute (every trip is an event, and refusals carry names); a
silent opt-out (`unbounded` is a word in the receipt, never an absence); a second guardian
worker (the host is the choke point — adding infrastructure to watch infrastructure is how
watchers get bills); a Despia-side component that accumulates state or sits in the read path
"for convenience" (decision 3 — the day owner analytics transit a Despia server is the day
free hosting has a marginal cost and the GDPR story has an asterisk); and quietly promising
tamper-proofing on an account we do not own (the
receipt proves what we deployed; it cannot govern what the owner does next, and saying
otherwise would be the kind of lie Article 7 exists to prevent).
