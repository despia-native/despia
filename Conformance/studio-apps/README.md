# studio-apps — the Despia Apps corpora

The law is `OpenSource/Documentation/architecture/proposals/studio-apps.md`; the contract
artifact every vocabulary here must agree with is `OpenSource/Web/support/studio-api-v1.json`.

An app is an ordinary registry package whose `dsx.json` adds `"studioApi": 1` and
`facets.apps` contribution rows (slot + component + grants + events). These corpora pin the
grammar, the scoped-seam verdicts, the mount-table fold and the approval signature so the
implementations cannot drift from the proposal or from each other.

| Fixture | Pins | Runners |
|---|---|---|
| `manifest.json` | the manifest grammar: slot vocabulary, grant shapes + slot-legality, event lists, the studioApi envelope, the closed issue codes | TS `packages/cli/test/studio-apps-manifest.test.ts` (per-PR, npm test) · ruby `ClosedSource/scripts/check_studio_apps.rb` (per-PR, repo-gates) — two VALIDATORS of one grammar, the lint_conformance pattern |
| `scope.json` | grants → seam verdicts on the `studio` residence (the 5th seam list) | TS `packages/cli/test/studio-apps-scope.test.ts`, driving BOTH funnels — the module-owned web one (`Core/Apps/web/scope.js`, mounted surfaces) and the CLI's headless twin (`packages/cli/src/studio-apps/headless.ts`, `despia app run` + the MCP face) — an interface is one consumer (studio-apps.md §9.1), so every funnel added answers to this corpus |
| `slots.json` | the pure `resolveStudioApps(...)` fold: enabled/disabled, approval, denylist, studioApi skew, ordering | TS `packages/cli/test/studio-apps-slots.test.ts` — single-runner, same standing |
| `events.json` | editor-session event payload shapes + delivery rules | TS `packages/cli/test/studio-apps-events.test.ts` — single-runner, same standing |
| `approval.json` | the canonical approval bytes + Ed25519 verify | TS `packages/cli/test/studio-apps-approval.test.ts` · ruby `ClosedSource/scripts/sign_app_approval.rb --self-test` — two runners on day one (the entitlement N-implementations lesson) |
| `vcs.json` | the change plane (§14): what makes a change structural, the policy reader's fail-safe defaults, the change title, the commit sentence and its trailers, the GitHub slug | TS `packages/cli/test/studio-apps-vcs.test.ts` — single-runner, same standing; the same file also cuts REAL repositories, because "it committed" is a claim about git |

Working rules (Conformance/README.md): a cross-validator divergence becomes a fixture in the
same commit as its fix; the vocabulary lives in the fixture `_note` + `vocabulary` blocks and
in the contract artifact — never restated in prose that can rot.
