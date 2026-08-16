# Fit and routing

Two questions, answered separately: can this device run this model, and which
model should answer this request.

## Fit

Ordered, first match wins:

1. The build cannot serve the entry (ABI too new, a missing engine capability,
   an engine or format it does not carry) - `unsupported`.
2. The model crashed the app last launch - `quarantined`.
3. Not enough disk - `too_big`, reason `disk`.
4. `footprint_mb` over the per-process memory limit - `too_big`, reason
   `memory`. `mapped_mb` never counts against this.
5. Tokens per second below the policy floor - `runs_slow`.
6. Otherwise `runs_well`.

The limit is the increased-memory-limit figure when the app declares that
entitlement, and the ordinary process limit otherwise. The tokens-per-second
number is a shipped prior until the model runs once on this device, and a
measurement afterwards - measured under memory pressure rather than cold, so
the verdict survives contact with an app that spends its own hundreds of
megabytes.

A load below the floor is REFUSED with a typed error. The recommender is
enforced, not advisory: the engine is never handed a model the device cannot
hold.

## Routing

`completion` takes a `task` hint instead of a hard model id:

```jsonc
{ "schema_version": 1,
  "tasks": { "chat":          { "prefer": ["qwen3-1.7b-q4", "qwen3-0.6b-q4"], "min_verdict": "runs_slow" },
             "agentic-tools": { "prefer": ["qwen3-1.7b-q4"], "require_caps": ["gbnf"], "min_verdict": "runs_well" } },
  "default": "chat",
  "remote": { "policy": "local", "dialect": "openai-chat" },
  "stickiness": { "prefer_loaded": true } }
```

Resolution is deterministic: the preference order, intersected with what is
installed, filtered by required capabilities and the verdict floor. A required
capability must hold on both sides - the build reports it and the entry declares
it - so a model that never claimed constrained decoding is not a candidate for a
task that needs it.

**Stickiness** prefers the model already in memory when it satisfies the task,
because a swap costs seconds and hundreds of megabytes. It never overrides the
capability filter or the verdict floor: cheapness does not beat correctness.

Every decision emits a `routing` event with the chosen model and the reason, so
a surface can always show which model answered.

Task ids are an OPEN vocabulary defined by the table itself. An unknown hint
resolves through the declared default chain, which is what makes next year's
task class a content edit rather than a release.

## The remote leg

`remote` points at YOUR backend. There is no Despia endpoint, nothing is
metered, and no credential ships in the app - your server holds the keys and
proxies whichever vendor you like. The policy is explicit: `local` never leaves
the device even with an endpoint configured, `prefer-local` falls back only when
nothing local qualifies, and `remote-only` skips local resolution entirely. Each
one announces itself in the `routing` event, because a silent hand-off to
someone else's cloud is the thing this design exists to not do.
