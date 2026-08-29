#!/usr/bin/env node
//
//  The `despia` executable (`dsx` is the alias bin; both point here). Node ≥ 22.18 runs this
//  TypeScript source directly (native type stripping) — the same way the repository runs
//  packages/compiler/bin/build-demo.ts.
//

import { runCli } from "../src/cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
