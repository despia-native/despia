//
//  media-conformance.test.ts - the SHARED media corpus through the TS kernel
//  (OpenSource/Conformance/media/{pick,manipulate,permissions}.json). The Kotlin twin is
//  :core MediaConformanceTest and the Swift reference is Engine/iOS/MediaCore.swift.
//
//  Opening a picker and turning a JPEG into pixels is platform work and is not pinned here.
//  What is pinned is the ARITHMETIC AND THE ORDER - crop-then-resize is not
//  resize-then-crop, EXIF orientation is normalised before the first op, and the decode hint
//  is the difference between an export and an OOM kill - plus the PERMISSION POSTURE, which
//  is law rather than documentation: the default pick prompts nowhere, full library access
//  exists only behind albums/assets, and save uses the weaker add-only grant.
//
//  This runner additionally cross-checks the SHIPPED manifest
//  (ClosedSource/DSX/Modules/Core/Media/dsx.json) against the corpus, so a posture the
//  fixture forbids cannot be reintroduced as an argument, and the resolve shape the fixture
//  declares cannot drift away from the tests the module ships.
//
//  Missing corpus = loud failure.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  MEDIA_FORMATS, MEDIA_RESIZE_FITS, MEDIA_MAX_PIXELS, MEDIA_PICK_MAX,
  MEDIA_FORMAT_SUPPORT, MEDIA_PICK_TYPES, MEDIA_PICK_SOURCES,
  foldMediaFormat, mediaQuality, mediaFormatPlan, mediaFormatLossless,
  exifNormalise, resolveMediaOps, mediaDecodeHint, mediaPickPlan, mediaPickMimeTypes,
} from "../src/media-core.ts";

type Dict = { [k: string]: unknown };

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/media"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/media not found");
    dir = parent;
  }
}

function corpus(name: string): Dict {
  const doc = JSON.parse(
    readFileSync(join(repoRoot(), "OpenSource/Conformance/media", name), "utf-8")) as Dict;
  assert.equal(doc["version"], 1, `${name}: version`);
  return doc;
}

function rows<T>(doc: Dict, key: string): T[] {
  const list = doc[key];
  assert.ok(Array.isArray(list) && list.length > 0, `${key} must be a non-empty array`);
  return list as T[];
}

function invariants(doc: Dict, keys: string[], label: string): void {
  const declared = doc["invariants"] as Dict;
  assert.ok(declared && typeof declared === "object", `${label}: no invariants block`);
  for (const key of keys) {
    assert.equal(typeof declared[key], "string", `${label} must declare the ${key} invariant`);
    assert.ok((declared[key] as string).length > 40, `${label}: ${key} must say what the promise is`);
  }
}

/** The shipped manifest, or null when the module folder is not in this checkout. */
function manifest(): Dict | null {
  const path = join(repoRoot(), "ClosedSource/DSX/Modules/Core/Media/dsx.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Dict;
}

function manifestActions(doc: Dict): { [name: string]: Dict } {
  const out: { [name: string]: Dict } = {};
  for (const [name, spec] of Object.entries((doc["actions"] as Dict) ?? {})) {
    if (name === "_note" || typeof spec !== "object" || spec === null) continue;
    out[name] = spec as Dict;
  }
  return out;
}

// ── manipulate.json ──────────────────────────────────────────────────────────────────────

test("media manipulate: the budget constant is one number on three renderers", () => {
  const budget = corpus("manipulate.json")["budget"] as Dict;
  assert.equal(MEDIA_MAX_PIXELS, budget["maxPixels"]);
});

test("media manipulate: the format fold", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "formats")) {
    assert.equal(foldMediaFormat(row["input"] as string), row["expect"], row["name"] as string);
  }
  for (const format of MEDIA_FORMATS) assert.equal(foldMediaFormat(format), format);
});

test("media manipulate: quality clamps, and a percent is read as a percent", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "quality")) {
    assert.equal(mediaQuality(row["input"]), row["expect"], row["name"] as string);
  }
});

test("media manipulate: the per-platform encode table is the corpus table", () => {
  const support = corpus("manipulate.json")["support"] as Dict;
  assert.deepEqual(Object.keys(support).sort(), Object.keys(MEDIA_FORMAT_SUPPORT).sort());
  for (const [platform, table] of Object.entries(support)) {
    assert.deepEqual(MEDIA_FORMAT_SUPPORT[platform], table, `${platform}: encode support`);
    for (const format of Object.keys(table as Dict)) {
      assert.ok(MEDIA_FORMATS.includes(format), `${platform}: ${format} is not an output format`);
    }
  }
});

test("media manipulate: the format plan falls back rather than lying about the file it wrote", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "formatPlans")) {
    const got = mediaFormatPlan(row["requested"] as string, row["platform"] as string,
                                row["deviceCanEncode"] as boolean);
    const expect = row["expect"] as Dict;
    const label = row["name"] as string;
    if (expect["error"] !== undefined) {
      assert.ok(!got.ok, `${label}: expected a refusal, got ${JSON.stringify(got)}`);
      assert.equal(got.error, expect["error"], `${label}: error`);
      continue;
    }
    assert.ok(got.ok, `${label}: expected a plan, got ${JSON.stringify(got)}`);
    const plan = got;
    assert.equal(plan.format, expect["format"], `${label}: format`);
    assert.equal(plan.requested, expect["requested"], `${label}: requested`);
    assert.equal(plan.fellBack, expect["fellBack"], `${label}: fellBack`);
    assert.equal(plan.lossless, expect["lossless"], `${label}: lossless`);
    assert.equal(plan.lossless, mediaFormatLossless(plan.format), `${label}: lossless agrees with the format`);
  }
});

test("media manipulate: EXIF orientation is normalised before anything else runs", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "exif")) {
    const got = exifNormalise(row["width"], row["height"], row["orientation"]);
    const expect = row["expect"] as Dict;
    const label = row["name"] as string;
    assert.equal(got.orientation, expect["orientation"], `${label}: orientation`);
    assert.equal(got.width, expect["width"], `${label}: width`);
    assert.equal(got.height, expect["height"], `${label}: height`);
    assert.equal(got.rotate, expect["rotate"], `${label}: rotate`);
    assert.equal(got.mirrored, expect["mirrored"], `${label}: mirrored`);
    assert.equal(got.swaps, expect["swaps"], `${label}: swaps`);
    // The axes trade places exactly when the tag says they do; a table that disagreed with
    // itself would report a portrait photo as landscape on one renderer only.
    assert.equal(got.swaps, got.rotate === 90 || got.rotate === 270, `${label}: swaps follows the rotation`);
  }
});

test("media manipulate: the op chain is exact, and its ORDER is the contract", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "chains")) {
    const got = resolveMediaOps(row["source"] as { width: number; height: number }, row["ops"]);
    const expect = row["expect"] as Dict;
    const label = row["name"] as string;
    if (expect["error"] !== undefined) {
      assert.ok(!got.ok, `${label}: expected a refusal, got ${JSON.stringify(got)}`);
      assert.equal(got.error, expect["error"], `${label}: error`);
      assert.equal(got.at, expect["at"], `${label}: the index must name the bad op`);
      continue;
    }
    assert.ok(got.ok, `${label}: expected a geometry, got ${JSON.stringify(got)}`);
    const ok = got;
    assert.equal(ok.width, expect["width"], `${label}: width`);
    assert.equal(ok.height, expect["height"], `${label}: height`);
    const steps = expect["steps"] as Dict[];
    assert.equal(ok.steps.length, steps.length, `${label}: one step per op`);
    steps.forEach((want, i) => {
      const step = ok.steps[i]!;
      assert.equal(step.op, want["op"], `${label}: step ${i} op`);
      assert.equal(step.width, want["width"], `${label}: step ${i} width`);
      assert.equal(step.height, want["height"], `${label}: step ${i} height`);
      if (want["rect"] === undefined) {
        assert.equal(step.rect, undefined, `${label}: step ${i} must select no region`);
      } else {
        assert.deepEqual(step.rect, want["rect"], `${label}: step ${i} rect`);
      }
    });
    // The last step's geometry IS the result; a resolver that reported one and returned the
    // other would be exact per-step and wrong overall.
    if (ok.steps.length > 0) {
      const last = ok.steps[ok.steps.length - 1]!;
      assert.equal(ok.width, last.width, `${label}: the result is the last step`);
      assert.equal(ok.height, last.height, `${label}: the result is the last step`);
    }
  }
});

test("media manipulate: the fits are exactly three, and an unknown one is refused", () => {
  assert.deepEqual([...MEDIA_RESIZE_FITS].sort(), ["contain", "cover", "fill"]);
  for (const fit of MEDIA_RESIZE_FITS) {
    const got = resolveMediaOps({ width: 800, height: 600 }, [{ resize: { width: 100, height: 100, fit } }]);
    assert.equal(got.ok, true, `${fit} must resolve`);
  }
});

test("media manipulate: the decode hint never allocates the full bitmap", () => {
  for (const row of rows<Dict>(corpus("manipulate.json"), "decode")) {
    const source = row["source"] as { width: number; height: number };
    const got = mediaDecodeHint(source, row["ops"]);
    const expect = row["expect"] as Dict;
    const label = row["name"] as string;
    assert.equal(got.sampleSize, expect["sampleSize"], `${label}: sampleSize`);
    assert.equal(got.width, expect["width"], `${label}: width`);
    assert.equal(got.height, expect["height"], `${label}: height`);
    // A sample size is a power of two - Android hands it straight to inSampleSize, which
    // rounds anything else down and would silently decode larger than the hint promised.
    assert.ok(got.sampleSize >= 1 && (got.sampleSize & (got.sampleSize - 1)) === 0,
      `${label}: sampleSize must be a power of two`);
    // The hint is a decode of the SOURCE, so it can never claim more pixels than exist.
    assert.ok(got.width <= source.width && got.height <= source.height,
      `${label}: a hint may only ever subsample`);
  }
});

test("media manipulate: the invariants are declared", () => {
  invariants(corpus("manipulate.json"),
    ["orientationBeforeOps", "orientationStrippedOnWrite", "decodeAtTargetSize",
     "streamToDisk", "chainIsOneRenderPass", "qualityIgnoredForLossless"],
    "manipulate.json");
});

// ── pick.json ────────────────────────────────────────────────────────────────────────────

test("media pick: the vocabulary and the selection ceiling", () => {
  const doc = corpus("pick.json");
  assert.deepEqual([...MEDIA_PICK_TYPES], doc["types"]);
  assert.deepEqual([...MEDIA_PICK_SOURCES], doc["sources"]);
  assert.equal(MEDIA_PICK_MAX, doc["maxSelection"]);
});

test("media pick: the plan fold", () => {
  for (const row of rows<Dict>(corpus("pick.json"), "plans")) {
    const got = mediaPickPlan(row["args"] as Dict);
    const expect = row["expect"] as Dict;
    const label = row["name"] as string;
    if (expect["error"] !== undefined) {
      assert.ok(!got.ok, `${label}: expected a refusal, got ${JSON.stringify(got)}`);
      assert.equal(got.error, expect["error"], `${label}: error`);
      continue;
    }
    assert.ok(got.ok, `${label}: expected a plan, got ${JSON.stringify(got)}`);
    const plan = got.plan;
    for (const key of ["type", "source", "limit", "multiple", "ordered", "permissionFree"] as const) {
      assert.equal(plan[key], expect[key], `${label}: ${key}`);
    }
    // Three folds the corpus states as prose and every facet depends on:
    assert.ok(!(plan.multiple === false && plan.limit !== 1),
      `${label}: a single pick is always limit 1`);
    assert.ok(!(plan.ordered === true && plan.multiple !== true),
      `${label}: ordered is meaningless without a multi-pick`);
    assert.equal(plan.permissionFree, plan.source === "library",
      `${label}: only the library path is permission-free`);
    assert.ok(plan.limit <= MEDIA_PICK_MAX, `${label}: the ceiling is never exceeded`);
  }
});

test("media pick: the MIME filter", () => {
  for (const row of rows<Dict>(corpus("pick.json"), "mimeTypes")) {
    assert.deepEqual(mediaPickMimeTypes(row["type"] as string), row["expect"],
      `mimeTypes for ${row["type"]}`);
  }
});

test("media pick: cancellation resolves rather than failing", () => {
  const doc = corpus("pick.json");
  const cancelled = (doc["resolve"] as Dict)["cancelled"] as Dict;
  assert.deepEqual(cancelled["assets"], [], "a cancelled pick carries an empty asset list");
  assert.equal(cancelled["cancelled"], true);
  for (const row of rows<Dict>(doc, "cancellation")) {
    const expect = row["expect"] as Dict;
    const dismissed = row["outcome"] === "dismissed";
    assert.equal(expect["cancelled"], dismissed, `${row["name"]}: cancelled follows the outcome`);
    assert.equal(expect["assets"] === 0, dismissed, `${row["name"]}: a dismissal carries no assets`);
    assert.ok(expect["error"] === undefined, `${row["name"]}: a dismissal is never an error`);
  }
});

test("media pick: the resolve shape the module ships matches the fixture", () => {
  const doc = corpus("pick.json");
  const shape = doc["resolve"] as Dict;
  const required = shape["required"] as string[];
  const optional = shape["optional"] as string[];
  assert.ok(required.length > 0, "an asset must carry at least one required field");
  for (const field of required) {
    assert.ok(!optional.includes(field), `${field} cannot be both required and optional`);
  }

  const doc2 = manifest();
  if (doc2 === null) return;
  const actions = manifestActions(doc2);
  const known = new Set([...required, ...optional]);
  let seen = 0;
  for (const name of ["pick", "pickDocument"]) {
    const spec = actions[name];
    assert.ok(spec, `the module must declare ${name}`);
    const resolves = (spec["resolves"] as Dict) ?? {};
    assert.ok("assets" in resolves && "cancelled" in resolves,
      `${name} must resolve { assets, cancelled }`);
    for (const t of (spec["tests"] as Dict[]) ?? []) {
      const resolved = (t["resolve"] ?? t["expect"]) as Dict | undefined;
      if (resolved === undefined) continue;
      for (const asset of (resolved["assets"] as Dict[]) ?? []) {
        seen += 1;
        for (const field of Object.keys(asset)) {
          assert.ok(known.has(field),
            `${name} test '${t["name"]}': '${field}' is not a field pick.json declares`);
        }
        for (const field of required) {
          assert.ok(field in asset,
            `${name} test '${t["name"]}': an asset must carry '${field}'`);
        }
      }
    }
    const cancels = ((spec["tests"] as Dict[]) ?? []).some((t) => {
      const resolved = (t["resolve"] ?? t["expect"]) as Dict | undefined;
      return resolved !== undefined && resolved["cancelled"] === true
        && Array.isArray(resolved["assets"]) && (resolved["assets"] as unknown[]).length === 0;
    });
    assert.ok(cancels, `${name} must ship a test proving a dismissal RESOLVES`);
  }
  assert.ok(seen > 0, "the pick tests must actually carry assets");
});

test("media pick: the invariants are declared", () => {
  invariants(corpus("pick.json"),
    ["cancelResolves", "orderedIsSelectionOrder", "pathIsADocumentPath",
     "copiedBeforeResolve", "limitIsAdvisory"],
    "pick.json");
});

// ── permissions.json - the fixture that matters most ─────────────────────────────────────

test("media permissions: every matrix row grades itself from the declared vocabulary", () => {
  const doc = corpus("permissions.json");
  const grades = new Set(doc["grades"] as string[]);
  const platforms = new Set(["ios", "android", "web"]);
  for (const row of rows<Dict>(doc, "matrix")) {
    const label = `${row["action"]}/${row["source"] ?? "-"}/${row["platform"]}`;
    assert.ok(platforms.has(row["platform"] as string), `${label}: unknown platform`);
    assert.ok(grades.has(row["prompts"] as string), `${label}: '${row["prompts"]}' is not a grade`);
    if (row["unsupported"] === true) {
      assert.equal(row["api"], null, `${label}: typed absence names no API`);
      assert.equal(row["prompts"], "none", `${label}: an absent capability cannot prompt`);
    } else {
      assert.ok(typeof row["api"] === "string" && (row["api"] as string).length > 0,
        `${label}: a supported row must name the platform API it uses`);
    }
    // An iOS row that prompts must name the usage string, and one that does not must not:
    // a declared usage string with no prompt behind it is an App Store question nobody can answer.
    if (row["platform"] === "ios") {
      if (row["prompts"] === "none") {
        assert.equal(row["usageKey"] ?? null, null, `${label}: a silent path declares no usage string`);
      } else {
        assert.ok(typeof row["usageKey"] === "string", `${label}: a prompt must name its usage string`);
      }
    }
  }
});

test("media permissions: the default pick prompts on no platform", () => {
  const doc = corpus("permissions.json");
  const picks = rows<Dict>(doc, "matrix")
    .filter((r) => r["action"] === "pick" && r["source"] === "library");
  assert.equal(picks.length, 3, "the permission-free path must be pinned on all three renderers");
  for (const row of picks) {
    assert.equal(row["prompts"], "none", `pick/library on ${row["platform"]} must never prompt`);
    assert.equal(row["usageKey"] ?? null, null, `pick/library on ${row["platform"]} needs no usage string`);
    assert.equal(row["androidPermission"] ?? null, null,
      `pick/library on ${row["platform"]} needs no android permission`);
  }
  // The default pick plan IS the library plan, so the row above is the one an author hits
  // without asking for anything.
  const fallback = mediaPickPlan({});
  assert.ok(fallback.ok, "the default pick must resolve to a plan");
  assert.equal(fallback.plan.permissionFree, true);
  assert.equal(fallback.plan.source, "library");
});

test("media permissions: the escalation ladder is exactly albums and assets, asked lazily", () => {
  const doc = corpus("permissions.json");
  const escalation = doc["escalation"] as Dict;
  const escalates = escalation["escalates"] as string[];
  const never = escalation["neverEscalates"] as string[];
  assert.deepEqual([...escalates].sort(), ["albums", "assets"]);
  assert.equal(escalation["timing"], "first-call", "a grant is asked at the call that needs it");
  assert.equal(escalation["refusalCode"], "permission_denied");

  const actions = new Set(rows<Dict>(doc, "matrix").map((r) => r["action"] as string));
  assert.deepEqual([...escalates, ...never].sort(), [...actions].sort(),
    "every action is graded exactly once by the ladder");
  for (const name of escalates) {
    for (const row of rows<Dict>(doc, "matrix").filter((r) => r["action"] === name)) {
      if (row["unsupported"] === true) continue;
      assert.equal(row["prompts"], "full", `${name} on ${row["platform"]} is the full-access grade`);
    }
  }
  for (const row of rows<Dict>(doc, "matrix").filter((r) => r["action"] === "save")) {
    if (row["unsupported"] === true) continue;
    assert.equal(row["prompts"], "add",
      `save on ${row["platform"]} must use the weaker add-only grant, never full access`);
  }
});

test("media permissions: the shipped manifest declares the posture and no override", () => {
  const doc = corpus("permissions.json");
  const spec = doc["manifest"] as Dict;
  const module = manifest();
  if (module === null) return;

  const infoPlist = (module["infoPlist"] as Dict) ?? {};
  for (const key of spec["infoPlist"] as string[]) {
    assert.ok(key in infoPlist, `dsx.json must declare ${key}`);
    if (spec["usageStringsAreConfigTokens"] === true) {
      assert.match(String(infoPlist[key]), /^\{\{\s*config\./,
        `${key} must be a config token, never an inline literal`);
    }
  }
  for (const key of Object.keys(infoPlist)) {
    if (key.startsWith("_")) continue;
    assert.ok((spec["infoPlist"] as string[]).includes(key),
      `dsx.json declares ${key}, which permissions.json does not sanction`);
  }

  const android = (module["androidManifest"] as Dict) ?? {};
  const declared = new Set((android["permissions"] as string[]) ?? []);
  for (const name of spec["androidPermissions"] as string[]) {
    assert.ok(declared.has(name), `androidManifest must declare ${name}`);
  }

  // The posture takes no argument. An action that accepted `fullAccess` would turn a law
  // into a default, which is the same App Store rejection with extra steps.
  const banned = spec["forbiddenArgs"] as string[];
  assert.ok(banned.length >= 4, "the forbidden-argument list must be more than a token gesture");
  for (const [name, action] of Object.entries(manifestActions(module))) {
    const args = (action["args"] as Dict) ?? {};
    for (const arg of banned) {
      assert.ok(!(arg in args), `media.${name} must not take '${arg}'`);
    }
  }
});

test("media permissions: every matrix action exists in the shipped manifest, and no other", () => {
  const doc = corpus("permissions.json");
  const graded = new Set(rows<Dict>(doc, "matrix").map((r) => r["action"] as string));
  const module = manifest();
  if (module === null) return;
  const shipped = new Set(Object.keys(manifestActions(module)));
  assert.deepEqual([...shipped].sort(), [...graded].sort(),
    "an action with no permission row is an ungraded capability");
  // Typed absence is a real resolve, so every action must be able to say it.
  for (const [name, action] of Object.entries(manifestActions(module))) {
    const errors = (action["errors"] as Dict) ?? {};
    assert.ok("unsupported_platform" in errors,
      `media.${name} must declare unsupported_platform - a capability a platform lacks is typed, never silent`);
  }
  // Only the two escalating actions may fail with permission_denied on a supported platform;
  // an action that can refuse for a grant it never asks for is a posture bug.
  const escalating = new Set((doc["escalation"] as Dict)["escalates"] as string[]);
  for (const [name, action] of Object.entries(manifestActions(module))) {
    const errors = (action["errors"] as Dict) ?? {};
    if (!("permission_denied" in errors)) continue;
    assert.ok(escalating.has(name) || name === "pick" || name === "save",
      `media.${name} declares permission_denied but asks for no grant`);
  }
});

test("media permissions: the invariants are declared", () => {
  invariants(corpus("permissions.json"),
    ["safeByDefault", "noPromptOnLaunch", "limitedLibraryIsNotAFailure",
     "denialIsRecoverable", "saveNeverReadsBack"],
    "permissions.json");
});
