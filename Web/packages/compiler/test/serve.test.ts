import test from "node:test";
import assert from "node:assert/strict";

import { devResponseHeaders, startServer } from "../bin/serve.ts";

test("dev server centralizes no-store across static, fragment, and SPA 200 responses", () => {
  assert.deepEqual(devResponseHeaders("text/html; charset=utf-8"), {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  assert.deepEqual(devResponseHeaders("text/html", { "access-control-allow-origin": "*" }), {
    "content-type": "text/html",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
});

test("dev server sends no-store on a real successful file response", async () => {
  const server = await startServer(0);
  try {
    const response = await fetch(`http://localhost:${server.port}/package.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  } finally {
    await server.close();
  }
});
