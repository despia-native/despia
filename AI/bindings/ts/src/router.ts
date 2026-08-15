// router.ts - task hint to model, deterministically.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The counter to confidence-based cloud hand-off: we route across YOUR models
// on MEASURED fit, and the only remote is the app's own backend. Nothing here
// is heuristic - the table is data, the filters are stated, and every decision
// carries a reason that a surface can show the user.
//
// Task ids are an OPEN vocabulary defined by the table itself: an unknown hint
// resolves through the declared default chain, which is what makes next
// year's task class a content edit rather than a release.

import { meetsFloor } from './fit.ts';
import type { Capabilities, Dict, Verdict } from './types.ts';

export type RouterTable = {
  schema_version?: number;
  tasks?: { [task: string]: { prefer?: string[]; require_caps?: string[]; min_verdict?: string } };
  default?: string;
  remote?: { policy?: 'local' | 'prefer-local' | 'remote-only'; dialect?: string; endpoint?: string };
  stickiness?: { prefer_loaded?: boolean };
};

export type Decision =
  | { kind: 'local'; model: string; task: string; reason: string }
  | { kind: 'remote'; task: string; reason: string }
  | { kind: 'none'; task: string; reason: string };

export function route(
  task: string,
  table: RouterTable,
  installed: string[],
  entries: Map<string, Dict>,
  verdicts: Map<string, Verdict>,
  caps: Capabilities,
  loaded: string | undefined,
): Decision {
  const policy = table.remote?.policy ?? 'local';

  // remote-only does not consult local models at all. The policy IS the
  // decision, and saying so in the reason is what keeps it from looking like
  // a silent hand-off.
  if (policy === 'remote-only') {
    return { kind: 'remote', task, reason: 'policy-remote-only' };
  }

  const known = table.tasks ?? {};
  const usedDefault = !known[task];
  const resolvedTask = usedDefault ? (table.default ?? task) : task;
  const spec = known[resolvedTask] ?? {};

  const needCaps: string[] = spec.require_caps ?? [];
  const candidates = (spec.prefer ?? []).filter((id) => {
    if (!installed.includes(id)) return false;
    const entry = entries.get(id);
    if (!entry) return false;
    // A required capability has to hold on BOTH sides: the build must report
    // it, and the entry must declare it can use it. A model that never claimed
    // constrained decoding is not a candidate for a task that needs it, no
    // matter how good it is at chatting - which is also why stickiness cannot
    // rescue it below.
    const declared: string[] = (entry.requires?.engine_caps ?? []) as string[];
    if (needCaps.some((c) => !caps.features.includes(c) || !declared.includes(c))) return false;
    const v = verdicts.get(id);
    return Boolean(v && meetsFloor(v.verdict, spec.min_verdict));
  });

  if (candidates.length > 0) {
    // Stickiness is real economics: a model swap costs seconds and hundreds of
    // megabytes of churn, so a resident model that satisfies the task wins.
    // It never overrides the capability filter or the verdict floor above -
    // cheapness does not beat correctness.
    if (table.stickiness?.prefer_loaded && loaded && candidates.includes(loaded)) {
      return { kind: 'local', model: loaded, task, reason: 'sticky-loaded' };
    }
    return {
      kind: 'local',
      model: candidates[0],
      task,
      reason: usedDefault ? 'default-chain' : 'preference-order',
    };
  }

  if (policy === 'prefer-local') {
    return { kind: 'remote', task, reason: 'no-local-candidate' };
  }
  // policy `local` never leaves the device, even with an endpoint configured.
  return { kind: 'none', task, reason: 'no_candidate' };
}
