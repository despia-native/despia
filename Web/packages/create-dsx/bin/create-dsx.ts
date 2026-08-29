#!/usr/bin/env node
//
//  The `create-despia` executable (`npm create despia <dir>`; `create-dsx` stays as an
//  alias bin). Node ≥ 22.18 runs this
//  TypeScript source directly (native type stripping).
//

import { runCreate } from "../src/cli.ts";

process.exitCode = runCreate(process.argv.slice(2));
