//
//  files-conformance.test.ts — the SHARED `files` corpus through the TS kernel
//  (OpenSource/Conformance/files/{paths,errors,operations,transfer}.json). The Kotlin twin
//  (:core FilesPathConformanceTest) runs the same files against the same pure core, so a path
//  that escapes its root cannot be refused on one renderer and quietly followed on another.
//
//  paths.json is the security boundary and gets the most weight: the root vocabulary, the
//  per-platform base table, the textual fold (normalise, THEN test for escape), and the
//  post-realpath containment check. errors.json pins the `recoverable` verdicts and the
//  typed-absence roster. operations.json and transfer.json describe the runtime semantics the
//  three facets implement; what is checkable here without a filesystem is checked here — every
//  action name, every error code and every path literal in those fixtures is run through the
//  real vocabulary and the real parser, and every progress sequence must be monotonic with a
//  fraction that agrees with its own arithmetic.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  FILE_ROOTS, FILE_ACTIONS, FILE_PLATFORMS, FILE_ERROR_RECOVERABLE, FILE_UNSUPPORTED,
  parseFilePath, fileRootBase, fileRootWritable, fileUnsupported, filePathContains, fileGlobMatch,
} from "../src/filepaths.ts";

type Json = { [key: string]: unknown };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/files");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/files not found");
    dir = parent;
  }
}

function corpus(name: string): Json {
  const doc = JSON.parse(readFileSync(join(corpusDir(), `${name}.json`), "utf-8")) as Json;
  assert.equal(doc["version"], 1, `${name}.json: version`);
  return doc;
}

/** Every path literal a fixture names, so none of them can be a path the sandbox would refuse. */
function pathsOf(step: Json): string[] {
  const args = (step["args"] as Json | undefined) ?? {};
  return ["path", "from", "to"]
    .map((key) => args[key])
    .filter((value): value is string => typeof value === "string");
}

test("files: the root vocabulary agrees with the corpus", () => {
  const doc = corpus("paths");
  assert.deepEqual([...FILE_ROOTS], doc["roots"]);
  assert.deepEqual([...FILE_ACTIONS], doc["actions"]);
  assert.deepEqual([...FILE_PLATFORMS], doc["platforms"]);
});

test("files: the per-platform base table agrees with the corpus", () => {
  const rows = corpus("paths")["bases"] as Json[];
  assert.equal(rows.length, FILE_ROOTS.length, "one base row per root");
  for (const row of rows) {
    const root = row["root"] as string;
    assert.ok(FILE_ROOTS.includes(root), `bases: unknown root ${root}`);
    assert.equal(fileRootWritable(root), row["writable"], `${root}: writable`);
    for (const platform of FILE_PLATFORMS) {
      assert.equal(fileRootBase(root, platform), row[platform] ?? null, `${root}/${platform}: base`);
    }
  }
  assert.equal(fileRootBase("nope", "ios"), null, "an unknown root has no base");
  assert.equal(fileRootBase("documents", "watch"), null, "an unknown platform has no base");
  assert.equal(fileRootWritable("nope"), false, "an unknown root is not writable");
});

test("files: the path fold agrees with the corpus", () => {
  const cases = corpus("paths")["parse"] as Json[];
  assert.ok(cases.length > 0, "parse corpus must not be empty");
  for (const testCase of cases) {
    const name = testCase["name"] as string;
    const expected = testCase["expect"] as Json;
    const result = parseFilePath(testCase["path"] as string);

    if ("error" in expected) {
      assert.equal(result.ok, false, `${name}: expected refusal ${String(expected["error"])}`);
      assert.equal(result.ok === false && result.error, expected["error"], `${name}: refusal code`);
      continue;
    }

    assert.equal(result.ok, true, `${name}: expected a parsed path`);
    if (result.ok !== true) continue;
    assert.equal(result.value.root, expected["root"], `${name}: root`);
    assert.equal(result.value.relative, expected["relative"], `${name}: relative`);
  }
});

test("files: a parsed relative path can never re-enter the fold as an escape", () => {
  // The property behind the corpus: whatever survives the fold is inert. Re-parsing a
  // normalised result must give back exactly the same result, or normalisation is not a
  // fixed point and some second consumer will disagree with the first.
  for (const testCase of corpus("paths")["parse"] as Json[]) {
    const first = parseFilePath(testCase["path"] as string);
    if (first.ok !== true) continue;
    const again = parseFilePath(`${first.value.root}:${first.value.relative}`);
    assert.equal(again.ok, true, `${String(testCase["name"])}: a folded path re-parses`);
    if (again.ok !== true) continue;
    assert.deepEqual(again.value, first.value, `${String(testCase["name"])}: the fold is idempotent`);
  }
});

test("files: containment agrees with the corpus", () => {
  const cases = corpus("paths")["contains"] as Json[];
  assert.ok(cases.length > 0, "contains corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(
      filePathContains(testCase["base"] as string, testCase["candidate"] as string),
      testCase["expect"],
      `${String(testCase["name"])}`,
    );
  }
});

test("files: the list glob agrees with the corpus", () => {
  const cases = corpus("paths")["glob"] as Json[];
  assert.ok(cases.length > 0, "glob corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(
      fileGlobMatch(testCase["pattern"] as string, testCase["path"] as string),
      testCase["expect"],
      `${String(testCase["name"])}`,
    );
  }
});

test("files: the error catalog agrees with the corpus", () => {
  const doc = corpus("errors");
  const codes = doc["codes"] as Json;
  assert.deepEqual(Object.keys(codes).sort(), Object.keys(FILE_ERROR_RECOVERABLE).sort());
  for (const [code, descriptor] of Object.entries(codes)) {
    assert.equal(
      FILE_ERROR_RECOVERABLE[code],
      (descriptor as Json)["recoverable"],
      `${code}: recoverable`,
    );
  }

  const roster = doc["unsupportedByPlatform"] as Json;
  assert.deepEqual(Object.keys(roster).sort(), [...FILE_PLATFORMS].sort());
  const capabilities = Object.keys(doc["capabilities"] as Json);
  for (const platform of FILE_PLATFORMS) {
    const listed = roster[platform] as string[];
    assert.deepEqual([...(FILE_UNSUPPORTED[platform] ?? [])].sort(), [...listed].sort(), platform);
    for (const capability of listed) {
      assert.ok(capabilities.includes(capability), `${platform}: undocumented capability ${capability}`);
      assert.equal(fileUnsupported(platform, capability), true, `${platform}/${capability}`);
    }
  }
  assert.equal(fileUnsupported("ios", "zip"), false, "iOS zips");
  assert.equal(fileUnsupported("web", "read"), false, "the roster names absences, not everything");
});

test("files: the operations matrix names only real actions, codes and addressable paths", () => {
  const cases = corpus("operations")["cases"] as Json[];
  assert.ok(cases.length > 0, "operations corpus must not be empty");
  for (const testCase of cases) {
    const name = testCase["name"] as string;
    const steps = testCase["steps"] as Json[];
    assert.ok(steps.length > 0, `${name}: a case runs at least one step`);

    for (const seeded of [...((testCase["given"] as Json[]) ?? []), ...((testCase["then"] as Json[]) ?? [])]) {
      const result = parseFilePath(seeded["path"] as string);
      assert.equal(result.ok, true, `${name}: the fixture seeds an unaddressable path ${String(seeded["path"])}`);
    }

    for (const step of steps) {
      const action = step["action"] as string;
      assert.ok(FILE_ACTIONS.includes(action), `${name}: unknown action ${action}`);
      assert.ok(
        !("resolve" in step && "error" in step),
        `${name}/${action}: a step settles once, either resolve or error`,
      );
      assert.ok("resolve" in step || "error" in step, `${name}/${action}: a step states its outcome`);

      const code = step["error"] as string | undefined;
      if (code !== undefined) {
        assert.ok(code in FILE_ERROR_RECOVERABLE, `${name}/${action}: undeclared error code ${code}`);
      }

      const literals = pathsOf(step);
      const refused = literals.filter((literal) => parseFilePath(literal).ok === false);
      if (code === "unsupported_root") {
        assert.ok(refused.length > 0, `${name}/${action}: an unsupported_root step must name a refused path`);
      } else {
        assert.deepEqual(refused, [], `${name}/${action}: an accepted step names only addressable paths`);
      }
    }
  }
});

test("files: every transfer stream is monotonic, arithmetically honest and settles once", () => {
  const doc = corpus("transfer");
  const streams = doc["streams"] as Json[];
  assert.ok(streams.length > 0, "transfer corpus must not be empty");

  for (const stream of streams) {
    const name = stream["name"] as string;
    const action = stream["action"] as string;
    assert.ok(FILE_ACTIONS.includes(action), `${name}: unknown action ${action}`);
    assert.ok(action === "download" || action === "upload", `${name}: only transfers stream`);

    assert.ok(
      !("resolve" in stream && "error" in stream),
      `${name}: a transfer settles once, either resolve or error`,
    );
    assert.ok("resolve" in stream || "error" in stream, `${name}: a transfer states its outcome`);

    const code = stream["error"] as string | undefined;
    if (code !== undefined) {
      assert.ok(code in FILE_ERROR_RECOVERABLE, `${name}: undeclared error code ${code}`);
    }

    const literals = pathsOf(stream);
    const refused = literals.filter((literal) => parseFilePath(literal).ok === false);
    if (code === "unsupported_root") {
      assert.ok(refused.length > 0, `${name}: an unsupported_root transfer must name a refused path`);
    } else {
      assert.deepEqual(refused, [], `${name}: a started transfer names only addressable paths`);
    }
    for (const after of (stream["then"] as Json[]) ?? []) {
      assert.equal(parseFilePath(after["path"] as string).ok, true, `${name}: unaddressable outcome path`);
    }

    let lastAt = -1;
    let lastMoved = -1;
    let lastFraction = -1;
    for (const event of (stream["events"] as Json[]) ?? []) {
      assert.equal(event["event"], "progress", `${name}: a transfer streams only progress`);
      const at = event["at"] as number;
      assert.ok(at >= lastAt, `${name}: progress at ${at} arrives after ${lastAt}`);
      lastAt = at;

      const data = event["data"] as Json;
      const moved = (action === "download" ? data["received"] : data["sent"]) as number;
      const total = data["total"] as number;
      const fraction = data["fraction"] as number;
      assert.equal(typeof moved, "number", `${name}: progress carries the bytes moved`);
      assert.ok(moved >= lastMoved, `${name}: bytes moved is monotonic (${moved} after ${lastMoved})`);
      lastMoved = moved;
      assert.ok(fraction >= 0 && fraction <= 1, `${name}: fraction ${fraction} is a fraction`);
      assert.ok(fraction >= lastFraction, `${name}: fraction is monotonic (${fraction} after ${lastFraction})`);
      lastFraction = fraction;

      // An unknown body length reports total 0 and fraction 0 — never a guessed percentage.
      const expected = total > 0 ? moved / total : 0;
      assert.ok(
        Math.abs(fraction - expected) < 1e-9,
        `${name}: fraction ${fraction} does not match ${moved}/${total}`,
      );
      if (total > 0) assert.ok(moved <= total, `${name}: bytes moved never exceeds the total`);
    }

    // A REFUSED request names its status. `http_error` exists precisely so a caller can tell a
    // 413 from a 401 without parsing a message, and that is only true if the status travels.
    if (code === "http_error") {
      const data = stream["data"] as Json | undefined;
      assert.ok(data !== undefined, `${name}: an http_error carries data`);
      const status = data!["status"] as number;
      assert.equal(typeof status, "number", `${name}: an http_error names its status`);
      assert.ok(status < 200 || status >= 300, `${name}: ${status} is not a refusal`);
    }

    // A failed transfer leaves nothing at the destination — the plan's whole point about
    // writing to a partial and moving it into place only on success.
    if (code !== undefined) {
      for (const after of (stream["then"] as Json[]) ?? []) {
        if (after["path"] === (stream["args"] as Json)["to"]) {
          assert.equal(after["exists"], false, `${name}: a failed download leaves no partial file`);
        }
      }
    }
  }

  const background = doc["background"] as Json[];
  assert.deepEqual(background.map((row) => row["platform"]).sort(), [...FILE_PLATFORMS].sort());
  for (const row of background) {
    const platform = row["platform"] as string;
    assert.equal(
      row["supported"],
      !fileUnsupported(platform, "background"),
      `${platform}: background support agrees with the typed-absence roster`,
    );
    if (row["supported"] === false) {
      assert.equal(row["error"], "unsupported_platform", `${platform}: absence is typed`);
    }
  }
});

test("files: the transfer settle table is decided by the STATUS, not by the transport", () => {
  const rows = corpus("transfer")["settle"] as Json[];
  assert.ok(rows.length > 0, "the settle table must not be empty");

  const seen = new Set<unknown>();
  for (const row of rows) {
    const when = row["when"] as string;
    const status = row["status"] as number | null;
    const outcome = row["outcome"] as string;

    assert.ok(!seen.has(status), `${when}: status ${status} is stated twice`);
    seen.add(status);

    if (outcome !== "resolve") {
      assert.ok(outcome in FILE_ERROR_RECOVERABLE, `${when}: undeclared error code ${outcome}`);
    }

    // THE RULE, in one assertion: 2xx and only 2xx resolves. A status outside that range
    // reached the server and was refused, so it is http_error; no answer at all is
    // network_failed, which is also the only outcome worth resuming.
    if (status !== null && status >= 200 && status < 300) {
      assert.equal(outcome, "resolve", `${when}: ${status} is a success`);
      assert.equal(row["destination"], "written", `${when}: a success writes the destination`);
    } else if (status === null) {
      assert.equal(outcome, "network_failed", `${when}: no answer is a transport failure`);
    } else {
      assert.equal(outcome, "http_error", `${when}: ${status} is a refusal, not a success`);
      assert.equal(
        FILE_ERROR_RECOVERABLE["http_error"], true,
        "a refusal is recoverable — 401/429/503 are routinely fixed by retrying",
      );
      // The status is the remedy. Folding it away makes a 404 and a 401 the same event.
      assert.deepEqual(
        row["carries"], ["status", "headers", "body"],
        `${when}: a refusal carries the status, the headers and the server's explanation`,
      );
    }

    // Every failing row leaves the caller's destination exactly as it was. This is the whole
    // defect: a 404 used to resolve with the server's error page written to that path.
    if (outcome !== "resolve") {
      assert.equal(row["destination"], "untouched", `${when}: a failure touches no destination`);
    }
  }

  // The table must actually exercise both refusal families, or it pins nothing.
  const outcomes = new Set(rows.map((row) => row["outcome"]));
  for (const required of ["resolve", "http_error", "network_failed"]) {
    assert.ok(outcomes.has(required), `the settle table must state the ${required} outcome`);
  }
});
