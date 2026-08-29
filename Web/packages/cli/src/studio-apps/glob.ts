//
//  studio-apps/glob.ts — one recursive file finder for the app plane. Suffix-matched,
//  sorted (deterministic stamps + discovery order), and it skips the trees that are
//  never app content: node_modules, build output, VCS internals, the .despia state.
//

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".despia", "vendor"]);

export function globSync(root: string, suffix: string, cap = 20_000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= cap) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries.sort()) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(suffix) && out.length < cap) out.push(full);
    }
  };
  walk(root);
  return out;
}
