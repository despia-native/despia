# library/ - the TRINITY MATRIX (the component-library scoreboard)

`matrix.json` is the machine-readable scoreboard of the Trinity Program
(`OpenSource/Documentation/architecture/proposals/component-library.md`): one component
library, library-grade on web, SwiftUI, and Compose alike. One row per census component,
one block per renderer (`web` / `ios` / `android`), the eight library-grade contract
dimensions as checkable fields. "Is the trinity done" is answered by ONE command:

```bash
ruby ClosedSource/scripts/check_library_matrix.rb --report
```

## What it unifies (and does not replace)

The matrix READS the repo's existing ledgers; each stays the source of truth for its own
plane, and the generator folds them into one scoreboard:

| Source | Plane it owns |
|---|---|
| `OpenSource/Documentation/reference/stack-elements.json` | the census: every renderable tag + kernel structural tag, attribute contracts (itself generated + CI-checked) |
| `OpenSource/Web/support/element-support.json` | the web renderer's per-element status (its own gate: `packages/dom/test/element-support-ledger.test.ts`) |
| `OpenSource/Conformance/elements/elements-gaps.json` | the Android parity allowlist (`ElementParityTest.kt`); the matrix only reads its buckets |
| `OpenSource/Conformance/elements/*.json` | the per-element parity fixtures (extracted from the Swift reference renderer) |
| `OpenSource/Conformance/parity/fixtures/*.dsx` | the cross-renderer screen fixtures (layout-bearing proof) |
| `ClosedSource/DSX/Modules/Custom/Demo/Components/Gallery.dsx` | the `/system` gallery (the living spec; specimen presence) |

## Generated plus asserted (the census pattern)

Two cell grammars, and the distinction is the whole design:

- **GENERATED** - `{ "value": ..., "source": "<the ledger that owns this fact>" }`.
  Machine-derived on every run of the generator. Never hand-edit one; regenerate.
- **ASSERTED** - `{ "value": ..., "verified": "YYYY-MM-DD" | null, "evidence": "..." | null }`.
  The judged dimensions. A human or agent audits the component, then stamps the cell with
  a value, the audit date, and an evidence string (what was exercised, where the proof
  lives). The checker keeps this honest: **a value without a dated stamp and evidence is a
  schema violation; a null value is unaudited and red**. No stamp = red, never silently
  green.

Asserted `value` vocabulary:

| value | meaning | scoreboard |
|---|---|---|
| `null` | unaudited | RED |
| `true` | audited and holding (dated + evidence) | green |
| `false` | audited and FAILING (dated + evidence) | RED, but named |
| `"review"` | verified by review pending a CI capture lane (dated) - the native-capture interim the proposal names | counted separately |
| `"n/a"` | the dimension does not apply to this component (dated decision, e.g. `sizes` on a layout container) | decided |

## The eight dimensions

Per renderer: `grammar` (GENERATED) + `states`, `sizes`, `adaptivity`, `motion`, `a11y`,
`proof` (ASSERTED). Per component: `docs` (ASSERTED once - one generated reference page
serves all three renderers). `grammar` values: web = the element-support status verbatim;
ios = `reference` (the fixtures are extracted from the Swift reference renderer);
android = `enforced` | `module-facet` | `ios-only` | `missing` (the elements-gaps
buckets); `kernel` = structural declaration tag on any renderer.

## Scope and decisions

Every census row is in the matrix, and out-of-scope rows carry their decision instead of
asserted cells, so the scoreboard stays truthful without blocking the trinity:

- `library` (65) - the audited set: 3 renderer blocks x 6 asserted dimensions + `docs`.
- `module-owned` (11) - the native-first module tags (Godot, Studio*, Waveform,
  LevelMeter, Scene3D/360, lottie), out of scope by the proposal's dated ruling. Pinned
  as a LIST in the generator: a future web-unsupported tag ABORTS generation until it is
  decided in the open.
- `structural` (13) - kernel declaration tags (`head`, `variable`, ...): logic, not UI;
  their grammar rides the kernel conformance corpora.

## The commands

```bash
ruby ClosedSource/scripts/generate_library_matrix.rb           # regenerate (idempotent; preserves asserted stamps)
ruby ClosedSource/scripts/generate_library_matrix.rb --check   # CI staleness gate (byte-compare)
ruby ClosedSource/scripts/check_library_matrix.rb              # CI gate: schema + sources + regression
ruby ClosedSource/scripts/check_library_matrix.rb --report     # the scoreboard: red cells named
cd OpenSource/Web && node --test packages/dom/test/library-matrix.test.ts   # the TS twin: web column vs the DOM registry
```

Red cells never fail the gate - they are the audit backlog the report names (W11 closes
them). The gate fails on DISHONESTY:

1. schema violations (a value without its dated stamp/evidence, a missing decision,
   census drift, a stale pinned summary);
2. a generated field contradicting its source ledger (the matrix is rebuilt in memory and
   byte-compared - hand-edits and staleness both land here);
3. REGRESSION against the merge-base: a previously-stamped cell may move only to another
   dated state. A dated `true -> false` flip is a finding and legal; a silent return to
   `null` (or a vanished row still in scope) fails CI.

## The audit workflow (backfill and beyond)

1. Audit one component x renderer x dimension against the proposal's contract.
2. Edit the cell in `matrix.json`: set `value`, `verified` (ISO date), `evidence`.
3. `ruby ClosedSource/scripts/generate_library_matrix.rb` - reflows the pinned summary,
   preserves your stamps, keeps the one-line-per-cell diff shape.
4. `ruby ClosedSource/scripts/check_library_matrix.rb --report` - the cell leaves the red
   list.

The file is diff-friendly by construction: sorted component keys, fixed field order, one
line per leaf cell - an audit stamp is a one-line diff.
