//
//  report.ts — `despia report verify <file>`: the support macro as a command
//  (architecture/proposals/live-logs.md §3.6). A pasted diagnostic blob is judged by the
//  corpus-pinned verifier: `not_report` (the AI-fabricated paste of the motivating incident
//  dies here, in one run), `modified` (edited after export), `genuine` (the seal verifies),
//  plus whether an integrity attestation rides the seal. The paste may carry prose around the
//  envelope — Copy report ships text with the sealed JSON inside — so extraction runs first.
//
//  Exit codes are the verdicts, so support tooling can branch without parsing prose:
//  0 genuine · 2 modified · 3 not a report · 1 usage/read failure.
//

import { readFileSync } from "node:fs";

import { liveReportExtract, liveReportVerdict } from "@despia-native/kernel";

import type { Io } from "./cli.ts";

export function commandReport(
  flags: { [k: string]: string | boolean },
  positional: readonly string[],
  io: Io,
): number {
  const [verb, file] = positional;
  if (verb !== "verify" || file === undefined || flags["help"] === true) {
    io.err("usage: despia report verify <file>   (a .dsxreport, or any paste containing one; '-' reads stdin)");
    return 1;
  }
  let text: string;
  try {
    text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (e) {
    io.err(`despia report: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const envelope = liveReportExtract(text);
  if (envelope === null) {
    io.out("not a report — no .dsxreport envelope found. This is not a Despia diagnostic export.");
    io.out("Ask for one: shake the test install, then Copy report (or Send to developer).");
    return 3;
  }
  const { verdict, assertion } = liveReportVerdict(envelope);
  if (verdict === "genuine") {
    io.out(`genuine — the seal verifies${assertion
      ? "; an integrity attestation rides it (verify it against Apple/Google via the relay or platform)"
      : ""}.`);
    return 0;
  }
  if (verdict === "modified") {
    io.out("modified — this is a Despia report envelope, but the bytes no longer match its seal.");
    return 2;
  }
  io.out("not a report — the envelope shape is wrong. This is not a Despia diagnostic export.");
  return 3;
}
