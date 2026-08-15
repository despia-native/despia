// fit.ts - will this model run well on THIS device.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The function is ordered and first-match-wins, and it is stated in prose in
// OpenSource/Conformance/ai/README.md so the Swift and Kotlin twins compute the
// same verdict from the same inputs. Two decisions in it are load-bearing:
//
//   - The limit is the PER-PROCESS one the probe reads (jetsam on iOS), not
//     "free RAM". Apps are killed against that number, so verdicts must be
//     computed against it or they are guesses dressed as facts.
//   - `mapped_mb` never counts toward the limit. mmap'd weights are clean
//     file-backed pages the kernel can evict; counting them would refuse
//     models that run fine. It rides the verdict as detail so a UI can explain
//     thrash instead of pretending the model is too big.
//   - The footprint is MEASURED when this device has measured it. Both numbers
//     the memory check can use live in one place (`calibrationFootprintMb`
//     below) so that "estimate or fact" is a single decision with a single
//     guard, not a condition sprinkled through the ordering.

import type { Capabilities, Dict, Verdict } from './types.ts';

/** One model's first-run measurements on THIS device.
 *
 *  Both fields are the same KIND of thing — a number this device produced
 *  itself, keyed by model and by device, replacing a shipped guess — so they
 *  ride in the same record and are persisted by the same store. `decode_tps`
 *  landed first; `footprint_mb` is the second, and inventing a second store for
 *  it would have meant two things to write, two things to key by device
 *  fingerprint, and two things to forget to clear. */
export type Calibration = {
  /** Decode throughput, tokens/sec, measured under load. */
  decode_tps?: number;
  /** Resident, non-file-backed cost of a real load, in MiB. */
  footprint_mb?: number;
};

export type DeviceProfile = {
  class?: string;
  available_memory_mb?: number;
  increased_memory_limit?: boolean;
  increased_memory_limit_mb?: number;
  /** PHYSICAL memory, when the probe reports it. Not the per-process limit and
   *  never used as one: its only job is to be the ceiling a measurement has to
   *  fall under to be believed. */
  total_memory_mb?: number;
  free_disk_mb?: number;
  quarantined?: string[];
  calibrated?: { [model: string]: Calibration };
  target?: string;
  runs_inference?: boolean;
};

export type FitPolicy = { slow_decode_tps?: number };

const DEFAULT_DEVICE: DeviceProfile = {
  class: 'phone-mid',
  available_memory_mb: 4096,
  free_disk_mb: 64000,
};

/** The memory ceiling this app will actually have. The iOS increased-memory
 *  limit entitlement materially changes which models fit, so the module
 *  declares it and the refusal is computed against the real limit - not
 *  against the one the app would have had without it. */
export function memoryLimitMb(device: DeviceProfile): number {
  if (device.increased_memory_limit && typeof device.increased_memory_limit_mb === 'number') {
    return device.increased_memory_limit_mb;
  }
  return device.available_memory_mb ?? DEFAULT_DEVICE.available_memory_mb!;
}

/**
 * The ceiling a footprint MEASUREMENT has to fall under to be believed.
 *
 * Physical memory when the probe reports it. When it does not, the per-process
 * limit stands in, and that is not a substitute chosen for convenience: the
 * measurement is taken after a load the app SURVIVED, and a process resident
 * above its own jetsam limit does not survive to report anything. So a reading
 * above the limit is already evidence about the reading rather than about the
 * model. Using the limit is the stricter of the two, which is the right way to
 * be wrong here — a discarded good measurement costs an estimate, a trusted bad
 * one costs the process.
 */
export function measurementCeilingMb(device: DeviceProfile): number {
  const physical = device.total_memory_mb;
  if (typeof physical === 'number' && Number.isFinite(physical) && physical > 0) return physical;
  return memoryLimitMb(device);
}

export type FootprintSource = 'measured' | 'estimated';

export type FootprintChoice = {
  /** The number the memory check runs against, or undefined when neither a
   *  measurement nor an estimate exists. */
  mb?: number;
  source: FootprintSource;
  /** A measurement WAS stored for this model on this device and was thrown
   *  away. It rides the verdict because a guard nobody can see is a guard
   *  nobody maintains - and because "we measured something impossible" is a
   *  thing a developer should be able to find out without a debugger. */
  rejected: boolean;
};

/**
 * Measured footprint, or the entry's estimate — one decision, one guard.
 *
 * `requirements.footprint_mb` is the ONLY estimated number an entry carries
 * (`disk_mb` is the file size and `mapped_mb` is what the loader maps; neither
 * is guessed). It is also the one the OOM reaper acts on, and the derivation is
 * measurably wrong in both directions — against the shipped catalog's eleven
 * measured rows it lands +45%, +25% and +92% high, and 39% LOW for
 * gemma-3-4b-it-Q4_K_M, which is the direction that gets a process killed. No
 * coefficient fixes that: the cause is unidentified (the file was checked and is
 * text-only, so the obvious multimodal explanation is wrong), one data point
 * cannot be fitted, and clamping to the pessimistic bound would refuse
 * gemma-3-1b at 1,154 MB against a measured 352.
 *
 * So the estimate is a placeholder for a fact, and this is where the fact
 * replaces it: the resident cost of the FIRST SUCCESSFUL LOAD on THIS device,
 * recorded beside `decode_tps` in the same per-model, per-device store. Second
 * launch onward the verdict is computed from what happened rather than from
 * what was guessed, and it stops calling itself `predicted`.
 *
 * A MEASUREMENT IS NOT AUTOMATICALLY BETTER THAN AN ESTIMATE. A wrong one is
 * worse, because it carries the authority of having been observed: zero would
 * make everything fit, a negative number would too, and a reading in bytes
 * rather than MiB would refuse everything. Anything that is not a finite,
 * positive number at or below the measurement ceiling is discarded and the
 * estimate stands.
 */
export function calibrationFootprintMb(entry: Dict, device: DeviceProfile): FootprintChoice {
  const req = (entry.requirements ?? {}) as Dict;
  const estimate = typeof req.footprint_mb === 'number' ? req.footprint_mb : undefined;
  const fallback: FootprintChoice = { mb: estimate, source: 'estimated', rejected: false };

  const raw = device.calibrated?.[String(entry.id)]?.footprint_mb;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return { ...fallback, rejected: true };
  }
  if (raw > measurementCeilingMb(device)) return { ...fallback, rejected: true };
  return { mb: raw, source: 'measured', rejected: false };
}

export function fit(
  entry: Dict,
  device: DeviceProfile,
  caps: Capabilities,
  policy: FitPolicy,
): Verdict {
  const dev = { ...DEFAULT_DEVICE, ...device };
  const req = (entry.requirements ?? {}) as Dict;
  const mapped = typeof req.mapped_mb === 'number' ? req.mapped_mb : undefined;
  // The footprint this verdict is computed against, and where it came from.
  // Resolved ONCE, above the ordering, so every return says the same thing
  // about the same number.
  const footprint = calibrationFootprintMb(entry, dev);
  // A runtime-added entry's requirements were DERIVED from a file size and a
  // GGUF header, never measured on a device, so every verdict computed from
  // them says so. It rides as detail exactly like `mapped_mb` - the ordering
  // below is untouched and still first-match-wins - because a surface that
  // shows "runs well" has to be able to show "we think" beside it.
  //
  // A MEASUREMENT RETIRES IT. `footprint_mb` is the only estimated number in
  // `requirements`, so once this device has measured it there is nothing left
  // in the verdict that was predicted, and continuing to say so would be an
  // apology for a number that no longer needs one.
  //
  // On an added entry it is stated EXPLICITLY in both directions, exactly as
  // `measured` is stated beside `decode_tps`, rather than dropping the key.
  // Absence is not an assertion: every fixture in this corpus is a SUBSET match,
  // so a missing key is indistinguishable from a key nobody looked at, and
  // "the verdict stops predicting" would be a claim no case could ever fail on.
  const measuredFootprint = footprint.source === 'measured';
  const detail = {
    ...(mapped === undefined ? {} : { mapped_mb: mapped }),
    ...(footprint.mb === undefined ? {} : { footprint_mb: footprint.mb }),
    ...(measuredFootprint ? { footprint_measured: true } : {}),
    ...(footprint.rejected ? { footprint_rejected: true } : {}),
    ...(entry.origin?.added === true ? { predicted: !measuredFootprint } : {}),
  };

  // 1. Can this build serve the entry at all? A catalog is a fleet-wide
  //    document; a row naming a backend or an ABI this build lacks is
  //    unsupported, which is a typed absence and not a failure.
  const requires = (entry.requires ?? {}) as Dict;
  if (typeof requires.abi === 'number' && requires.abi > caps.abi) {
    return { verdict: 'unsupported', reason: 'requires_newer_abi', ...detail };
  }
  const needed: string[] = Array.isArray(requires.engine_caps) ? requires.engine_caps : [];
  if (needed.some((c) => !caps.features.includes(c))) {
    return { verdict: 'unsupported', reason: 'missing_engine_caps', ...detail };
  }
  if (entry.engine && !caps.engines.includes(String(entry.engine))) {
    return { verdict: 'unsupported', reason: 'engine_not_carried', ...detail };
  }
  if (entry.format && !caps.formats.includes(String(entry.format))) {
    return { verdict: 'unsupported', reason: 'format_not_carried', ...detail };
  }

  // 2. Crash containment. A model whose marker survived a launch is refused
  //    until the user clears it, so a bad model+device pair cannot become a
  //    relaunch crash loop in a customer's app.
  if ((dev.quarantined ?? []).includes(String(entry.id))) {
    return { verdict: 'quarantined', reason: 'crash_marker', ...detail };
  }

  // 3. Disk, before any byte moves.
  if (typeof req.disk_mb === 'number' && req.disk_mb > (dev.free_disk_mb ?? 0)) {
    return { verdict: 'too_big', reason: 'disk', ...detail };
  }

  // 4. Footprint against the real process limit - the MEASURED footprint when
  //    this device has one, the entry's estimate otherwise. Mapped size is NOT
  //    part of this comparison, deliberately.
  if (typeof footprint.mb === 'number' && footprint.mb > memoryLimitMb(dev)) {
    return { verdict: 'too_big', reason: 'memory', ...detail };
  }

  // 5. Speed. The shipped band is a prior; a measurement from this device is
  //    the truth and replaces it, in both directions.
  const measuredTps = dev.calibrated?.[String(entry.id)]?.decode_tps;
  const priors = (entry.perf_priors ?? {}) as Dict;
  const prior = priors[String(dev.class)]?.decode_tps;
  const tps = typeof measuredTps === 'number' ? measuredTps : prior;
  const measured = typeof measuredTps === 'number';
  const floor = policy.slow_decode_tps;

  if (typeof tps === 'number' && typeof floor === 'number' && tps < floor) {
    return { verdict: 'runs_slow', decode_tps: tps, measured, ...detail };
  }
  return {
    verdict: 'runs_well',
    ...(typeof tps === 'number' ? { decode_tps: tps, measured } : {}),
    ...detail,
  };
}

const RANK: { [k: string]: number } = { runs_well: 2, runs_slow: 1 };

/** Verdict ordering for the router's `min_verdict` floor. Anything that is not
 *  runs_well or runs_slow never routes: too_big, unsupported and quarantined
 *  are not degrees of "works". */
export function meetsFloor(verdict: string, floor: string | undefined): boolean {
  const have = RANK[verdict] ?? 0;
  if (have === 0) return false;
  const want = RANK[floor ?? 'runs_slow'] ?? 1;
  return have >= want;
}
