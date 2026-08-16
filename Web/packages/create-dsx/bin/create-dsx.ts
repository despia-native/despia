#!/usr/bin/env node
//
//  The `create-dsx` executable (`npm create dsx <dir>`). Node ≥ 22.18 runs this
//  TypeScript source directly (native type stripping).
//

import { runCreate } from "../src/cli.ts";

process.exitCode = runCreate(process.argv.slice(2));
