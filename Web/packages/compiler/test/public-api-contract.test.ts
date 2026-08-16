import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildPublicApiContract, type PublicApiContract } from "../../../scripts/public-api-contract.ts";

test("the published TypeScript API matches the frozen v1 compatibility contract", () => {
  const webRoot = resolve(import.meta.dirname, "../../..");
  const expected = JSON.parse(
    readFileSync(resolve(webRoot, "support/public-api-v1.json"), "utf8"),
  ) as PublicApiContract;
  const actual = buildPublicApiContract(webRoot);
  assert.deepEqual(
    actual,
    expected,
    "public API drifted; breaking changes require a major release, while intentional compatible additions require reviewing and refreshing support/public-api-v1.json",
  );
});
