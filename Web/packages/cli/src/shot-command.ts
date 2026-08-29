//
//  shot-command.ts - `despia shot`, the CLI face over the one shot core.
//
//  Thin by design: the three faces (this, the MCP tools, the Studio button) must not drift in
//  what they consider a passing shot, so all three call renderAll/planAll/checkAll and none of
//  them re-decides anything.
//

import { findProjectRoot } from "./config.ts";
import { findWebRoot } from "./shot-render.ts";
import { planAll, renderAll, checkAll } from "./shot-run.ts";

type Io = { out(text: string): void; err(text: string): void };

/** The web workspace root, for bundling the in-page harness. */
function webRoot(): string {
  return findWebRoot(import.meta.url);
}

export async function commandShot(
  flags: { [k: string]: string | boolean | undefined },
  positional: string[],
  io: Io,
): Promise<number> {
  const start = typeof flags["project"] === "string" ? flags["project"] : process.cwd();
  const root = findProjectRoot(start);
  if (root === null) {
    io.err("no dsx.config.json found - run this inside a DSX project, or pass --project");
    return 1;
  }
  const only = positional.length > 0 ? positional : undefined;

  if (flags["plan"] === true) {
    const plan = planAll(root);
    io.out("despia shot --plan");
    for (const line of plan.lines) io.out(line);
    if (!plan.ok) {
      io.err("");
      io.err("Nothing was rendered: a shot with an unresolved binding would publish a placeholder.");
    }
    return plan.ok ? 0 : 1;
  }

  if (flags["check"] === true) {
    const budget = typeof flags["budget"] === "string" ? Number(flags["budget"]) : 0;
    const result = await checkAll(root, webRoot(), Number.isFinite(budget) ? budget : 0);
    io.out("despia shot --check");
    for (const line of result.lines) io.out(line);
    return result.ok ? 0 : 1;
  }

  const result = await renderAll(root, webRoot(), only);
  io.out("despia shot");
  for (const line of result.lines) io.out(line);
  if (!result.ok) {
    io.err("");
    io.err("No image was written for the failed shots - a refused frame is never published.");
  }
  return result.ok ? 0 : 1;
}
