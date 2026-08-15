//
//  build-targets.ts — the PORTABILITY GATE (full-stack.md T2): every server
//  deployment artifact must BUNDLE from the same tree, every PR. A business
//  module change that breaks one target is a red build here, never a
//  migration-day discovery. Bundles are disposable proof (dist/ is
//  gitignored); success/failure is the product. Soft-skips a target whose
//  emitted entry is absent (the Server module excluded ⇒ prepare_server
//  removed deploy/ — exclusion is legal, the gate answers "nothing to gate").
//
//  Run: npm run build:server-targets
//

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(pkg, "dist");
mkdirSync(dist, { recursive: true });

// Provider DRIVERS are external to every bundle — a platform resolves its own driver at boot
// (node_modules on Node, npm:<name> on Deno; the residence tries both spellings). The list
// comes from the emitted providers.json, so the gate hardcodes no vendor: a new provider
// module declares its driver in its own manifest and this line picks it up.
const providersPath = join(pkg, "generated", "providers.json");
const providerDrivers: string[] = existsSync(providersPath)
  ? (JSON.parse(readFileSync(providersPath, "utf-8")) as { providers?: { drivers?: Record<string, string> }[] })
      .providers?.flatMap((p) => Object.keys(p.drivers ?? {}).flatMap((d) => [d, `npm:${d}`])) ?? []
  : [];

const targets: { name: string; entry: string; platform: "node" | "neutral"; external: string[] }[] = [
  { name: "docker",   entry: join(pkg, "deploy", "serve.ts"),                              platform: "node",    external: providerDrivers },
  { name: "supabase", entry: join(pkg, "deploy", "supabase", "functions", "dsx", "index.ts"), platform: "neutral", external: providerDrivers },
  { name: "firebase", entry: join(pkg, "deploy", "firebase", "functions", "src-entry.ts"), platform: "node",    external: ["firebase-functions", ...providerDrivers] },
];

let bundled = 0;
for (const t of targets) {
  if (!existsSync(t.entry)) {
    console.log(`[build-targets] ${t.name}: entry absent (Server excluded?) — skipped.`);
    continue;
  }
  await build({
    entryPoints: [t.entry],
    bundle: true,
    format: "esm",
    platform: t.platform,
    external: t.external,
    outfile: join(dist, `${t.name}.js`),
    logLevel: "silent",
  });
  bundled += 1;
  console.log(`[build-targets] ${t.name}: bundled.`);
}
console.log(`[build-targets] ${bundled}/${targets.length} server target(s) bundle from this tree.`);
