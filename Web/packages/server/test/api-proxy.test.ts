//
//  api-proxy.test.ts - the `<api via="server">` proxy route (/web/05 "the secrets story").
//  The CLIENT half is corpus-gated on all three runtimes
//  (Conformance/api/api-blocks.json → via-server-rewrites-the-request-to-the-proxy-route);
//  this suite pins the SERVER half: routing, the SSRF allowlist, credential confinement.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  handleApiProxy, parseApiProxyRequest, resolveProxyTarget, apiProxyRoutePath, API_PROXY_PREFIX,
} from "../src/api-proxy.ts";

const BASE = "https://app.example";

type LocalServer = {
  origin: string;
  close: () => Promise<void>;
};

async function listenLocal(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<LocalServer> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

async function readIncoming(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function proxyRequest(as: string, target: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${apiProxyRoutePath(as)}?u=${encodeURIComponent(target)}`, init);
}

test("api-proxy: the route path matches the kernel's client half", () => {
  assert.equal(API_PROXY_PREFIX, "/dsx/api/");
  assert.equal(apiProxyRoutePath("rates"), "/dsx/api/rates");
  const parsed = parseApiProxyRequest(new URL(`${BASE}/dsx/api/rates?u=%2Fapi%2Frates%3Fbase%3Dusd`));
  assert.deepEqual(parsed, { as: "rates", target: "/api/rates?base=usd" });
});

test("api-proxy: a non-proxy path, a bad name and a missing target all decline", () => {
  assert.equal(parseApiProxyRequest(new URL(`${BASE}/about`)), null);
  assert.equal(parseApiProxyRequest(new URL(`${BASE}/dsx/api/not a name?u=/x`)), null);
  assert.equal(parseApiProxyRequest(new URL(`${BASE}/dsx/api/rates`)), null);
});

test("api-proxy: an undeclared block is 404, never a fetch", async () => {
  let calls = 0;
  const res = await handleApiProxy(proxyRequest("secretly", "/api/rates"), {
    allow: ["rates"],
    base: BASE,
    fetchImpl: async () => { calls += 1; return new Response("no"); },
  });
  assert.equal(res?.status, 404);
  assert.equal(calls, 0);
  assert.equal((await res!.json() as { error: { kind: string } }).error.kind, "unknown_api");
});

test("api-proxy: the target allowlist is the SSRF guard", () => {
  // relative → pinned to the configured base
  assert.deepEqual(resolveProxyTarget("/api/rates?base=usd", { base: BASE }),
    { url: "https://app.example/api/rates?base=usd" });
  // absolute, declared → allowed
  assert.deepEqual(resolveProxyTarget("https://rates.example/v1", { base: BASE, origins: ["https://rates.example"] }),
    { url: "https://rates.example/v1" });
  // absolute, undeclared → refused
  assert.ok("error" in resolveProxyTarget("https://evil.example/v1", { base: BASE, origins: ["https://rates.example"] }));
  // the classic metadata-service probe and non-http schemes are refused too
  assert.ok("error" in resolveProxyTarget("http://169.254.169.254/latest/meta-data/", { base: BASE }));
  assert.ok("error" in resolveProxyTarget("file:///etc/passwd", { base: BASE }));
  assert.ok("error" in resolveProxyTarget("https://user:pass@rates.example/v1", {
    base: BASE,
    origins: ["https://rates.example"],
  }));
  // a relative target with no base declares nothing to resolve against
  assert.ok("error" in resolveProxyTarget("/api/rates", {}));
});

test("api-proxy: server-held headers are added, browser credentials are NOT forwarded", async () => {
  let seen: Headers | null = null;
  const res = await handleApiProxy(
    proxyRequest("rates", "https://rates.example/v1", {
      headers: {
        "content-type": "application/json",
        authorization: "Bearer BROWSER-TOKEN",
        cookie: "session=abc",
      },
    }),
    {
      allow: ["rates"],
      base: BASE,
      origins: ["https://rates.example"],
      // [S-BOUNDARY] the host supplies the credential; the proxy never reads one itself.
      headers: () => ({
        authorization: "Bearer SERVER-HELD",
        host: "attacker.example",
        connection: "close",
        "content-length": "99999",
      }),
      fetchImpl: async (_url, init) => {
        seen = init.headers as Headers;
        return new Response(JSON.stringify({ rate: 1 }), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "upstream=1" },
        });
      },
    },
  );
  assert.equal(res?.status, 200);
  assert.deepEqual(await res!.json(), { rate: 1 });
  const headers = seen as unknown as Headers;
  assert.equal(headers.get("authorization"), "Bearer SERVER-HELD");
  assert.equal(headers.get("cookie"), null, "the browser's cookie must never ride the proxy");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("host"), null, "host-supplied routing headers are forbidden");
  assert.equal(headers.get("connection"), null, "hop-by-hop headers are forbidden");
  assert.equal(headers.get("content-length"), null, "fetch computes the buffered body length");
  // hop-by-hop + Set-Cookie are stripped from the response
  assert.equal(res!.headers.get("set-cookie"), null);
});

test("api-proxy: a mutation forwards method + body; an unreachable upstream is 502", async () => {
  let method = "";
  let body = "";
  const ok = await handleApiProxy(
    proxyRequest("save", "https://rates.example/v1", {
      method: "POST",
      body: JSON.stringify({ n: 1 }),
      headers: { "content-type": "application/json" },
    }),
    {
      allow: ["save"],
      base: BASE,
      origins: ["https://rates.example"],
      fetchImpl: async (_url, init) => {
        method = String(init.method);
        body = new TextDecoder().decode(new Uint8Array(init.body as ArrayBuffer));
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      },
    },
  );
  assert.equal(ok?.status, 201);
  assert.equal(method, "POST");
  assert.equal(body, '{"n":1}');

  const down = await handleApiProxy(proxyRequest("save", "https://rates.example/v1", { method: "POST" }), {
    allow: ["save"],
    base: BASE,
    origins: ["https://rates.example"],
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down?.status, 502);
});

test("api-proxy: an oversize upstream response is refused, not streamed through", async () => {
  const res = await handleApiProxy(proxyRequest("big", "https://rates.example/v1"), {
    allow: ["big"],
    base: BASE,
    origins: ["https://rates.example"],
    maxResponseBytes: 8,
    fetchImpl: async () => new Response("0123456789ABCDEF", { status: 200 }),
  });
  assert.equal(res?.status, 502);
  assert.equal((await res!.json() as { error: { kind: string } }).error.kind, "response_too_large");
});

test("api-proxy: a request that is not a proxy route declines so the host can route it", async () => {
  const res = await handleApiProxy(new Request(`${BASE}/about`), { allow: ["rates"] });
  assert.equal(res, null);
});

test("api-proxy redirects: an allowed origin cannot bounce into an unlisted private origin", async () => {
  let privateHits = 0;
  const privateServer = await listenLocal((_request, response) => {
    privateHits += 1;
    response.end("PRIVATE-METADATA");
  });
  const allowedServer = await listenLocal((_request, response) => {
    response.writeHead(302, { location: `${privateServer.origin}/metadata` });
    response.end("redirecting");
  });
  try {
    const res = await handleApiProxy(proxyRequest("rates", `${allowedServer.origin}/start`), {
      allow: ["rates"],
      origins: [allowedServer.origin],
    });
    assert.equal(res?.status, 403);
    assert.equal((await res!.json() as { error: { kind: string } }).error.kind, "target_not_allowed");
    assert.equal(privateHits, 0, "the denied redirect target must never reach the network");
  } finally {
    await allowedServer.close();
    await privateServer.close();
  }
});

test("api-proxy redirects: a relative same-origin redirect succeeds", async () => {
  let finalHits = 0;
  const upstream = await listenLocal((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    finalHits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("SAFE");
  });
  try {
    const res = await handleApiProxy(proxyRequest("rates", `${upstream.origin}/start`), {
      allow: ["rates"],
      origins: [upstream.origin],
    });
    assert.equal(res?.status, 200);
    assert.equal(await res!.text(), "SAFE");
    assert.equal(finalHits, 1);
  } finally {
    await upstream.close();
  }
});

test("api-proxy redirects: cross-origin allowlisted hops shed every server-held header", async () => {
  let firstAuthorization: string | undefined;
  let redirectedHeaders: IncomingMessage["headers"] | undefined;
  const destination = await listenLocal((request, response) => {
    redirectedHeaders = request.headers;
    response.end("OK");
  });
  const source = await listenLocal((request, response) => {
    firstAuthorization = request.headers.authorization;
    response.writeHead(302, { location: `${destination.origin}/sink` });
    response.end();
  });
  try {
    const res = await handleApiProxy(proxyRequest("rates", `${source.origin}/start`, {
      headers: { accept: "application/json" },
    }), {
      allow: ["rates"],
      origins: [source.origin, destination.origin],
      headers: () => ({
        authorization: "Bearer SERVER-HELD",
        cookie: "server-session=secret",
        "x-api-key": "api-secret",
        "x-custom-secret": "custom-secret",
      }),
    });
    assert.equal(res?.status, 200);
    assert.equal(firstAuthorization, "Bearer SERVER-HELD");
    assert.equal(redirectedHeaders?.authorization, undefined);
    assert.equal(redirectedHeaders?.cookie, undefined);
    assert.equal(redirectedHeaders?.["x-api-key"], undefined);
    assert.equal(redirectedHeaders?.["x-custom-secret"], undefined);
    assert.equal(redirectedHeaders?.accept, "application/json", "non-secret client headers survive");
  } finally {
    await source.close();
    await destination.close();
  }
});

test("api-proxy redirects: the hop cap rejects the next target without fetching it", async () => {
  const hits: string[] = [];
  const upstream = await listenLocal((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/0") response.writeHead(302, { location: "/1" });
    else if (request.url === "/1") response.writeHead(302, { location: "/2" });
    else if (request.url === "/2") response.writeHead(302, { location: "/never" });
    response.end();
  });
  try {
    const res = await handleApiProxy(proxyRequest("rates", `${upstream.origin}/0`), {
      allow: ["rates"],
      origins: [upstream.origin],
      maxRedirects: 2,
    });
    assert.equal(res?.status, 502);
    assert.equal((await res!.json() as { error: { kind: string } }).error.kind, "too_many_redirects");
    assert.deepEqual(hits, ["/0", "/1", "/2"]);
    assert.ok(!hits.includes("/never"));
  } finally {
    await upstream.close();
  }
});

test("api-proxy redirects: malformed and credentialed targets are rejected before another fetch", async () => {
  for (const location of ["http://[", "https://user:pass@next.example/private"]) {
    const calls: string[] = [];
    const res = await handleApiProxy(proxyRequest("rates", "https://rates.example/start"), {
      allow: ["rates"],
      origins: ["https://rates.example", "https://next.example"],
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    assert.ok(res?.status === 403 || res?.status === 502);
    assert.deepEqual(calls, ["https://rates.example/start"]);
  }
});

test("api-proxy redirects: a generator-backed origin allowlist remains valid across hops", async () => {
  function* origins(): Generator<string> {
    yield "https://rates.example";
  }
  const calls: string[] = [];
  const res = await handleApiProxy(proxyRequest("rates", "https://rates.example/start"), {
    allow: ["rates"],
    origins: origins(),
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("OK");
    },
  });
  assert.equal(res?.status, 200);
  assert.equal(await res!.text(), "OK");
  assert.deepEqual(calls, ["https://rates.example/start", "https://rates.example/final"]);
});

test("api-proxy redirects: 301/302/303 rewrite safely while 307/308 preserve method and body", async () => {
  const seen = new Map<string, { method: string; body: string; contentType?: string }>();
  const upstream = await listenLocal(async (request, response) => {
    const current = new URL(request.url ?? "/", "http://local.test");
    if (current.pathname === "/start") {
      response.writeHead(Number(current.searchParams.get("status")), {
        location: `/sink?id=${current.searchParams.get("id")}`,
      });
      response.end();
      return;
    }
    const id = current.searchParams.get("id") ?? "missing";
    seen.set(id, {
      method: request.method ?? "",
      body: await readIncoming(request),
      ...(request.headers["content-type"] !== undefined
        ? { contentType: request.headers["content-type"] }
        : {}),
    });
    response.end("OK");
  });
  const cases = [
    { id: "post301", status: 301, method: "POST", expectedMethod: "GET", expectedBody: "" },
    { id: "put301", status: 301, method: "PUT", expectedMethod: "PUT", expectedBody: "payload" },
    { id: "post302", status: 302, method: "POST", expectedMethod: "GET", expectedBody: "" },
    { id: "patch302", status: 302, method: "PATCH", expectedMethod: "PATCH", expectedBody: "payload" },
    { id: "put303", status: 303, method: "PUT", expectedMethod: "GET", expectedBody: "" },
    { id: "post307", status: 307, method: "POST", expectedMethod: "POST", expectedBody: "payload" },
    { id: "post308", status: 308, method: "POST", expectedMethod: "POST", expectedBody: "payload" },
  ] as const;
  try {
    for (const entry of cases) {
      const res = await handleApiProxy(proxyRequest(
        "save",
        `${upstream.origin}/start?status=${entry.status}&id=${entry.id}`,
        {
          method: entry.method,
          body: "payload",
          headers: { "content-type": "text/plain" },
        },
      ), {
        allow: ["save"],
        origins: [upstream.origin],
      });
      assert.equal(res?.status, 200, entry.id);
      assert.equal(await res!.text(), "OK");
      assert.deepEqual(seen.get(entry.id), {
        method: entry.expectedMethod,
        body: entry.expectedBody,
        ...(entry.expectedBody.length > 0 ? { contentType: "text/plain" } : {}),
      }, entry.id);
    }
  } finally {
    await upstream.close();
  }
});

test("api-proxy bounds: chunked request and response bodies are cancelled on overflow", async () => {
  let fetchHits = 0;
  const requestStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.enqueue(new TextEncoder().encode("67890"));
      controller.close();
    },
  });
  const request = new Request(
    `${BASE}${apiProxyRoutePath("save")}?u=${encodeURIComponent("https://rates.example/v1")}`,
    { method: "POST", body: requestStream, duplex: "half" } as RequestInit,
  );
  const requestResult = await handleApiProxy(request, {
    allow: ["save"],
    origins: ["https://rates.example"],
    maxRequestBytes: 8,
    fetchImpl: async () => { fetchHits += 1; return new Response("never"); },
  });
  assert.equal(requestResult?.status, 413);
  assert.equal((await requestResult!.json() as { error: { kind: string } }).error.kind, "request_too_large");
  assert.equal(fetchHits, 0);

  let cancelled = false;
  const responseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.enqueue(new TextEncoder().encode("67890"));
    },
    cancel() { cancelled = true; },
  });
  const responseResult = await handleApiProxy(proxyRequest("big", "https://rates.example/v1"), {
    allow: ["big"],
    origins: ["https://rates.example"],
    maxResponseBytes: 8,
    fetchImpl: async () => new Response(responseStream),
  });
  assert.equal(responseResult?.status, 502);
  assert.equal((await responseResult!.json() as { error: { kind: string } }).error.kind, "response_too_large");
  assert.equal(cancelled, true);
});

test("api-proxy bounds: a hung live upstream is cut off by the total chain deadline", async () => {
  const upstream = await listenLocal((_request, _response) => {
    // Deliberately never send headers: global fetch itself remains pending until aborted.
  });
  try {
    const started = performance.now();
    const res = await handleApiProxy(proxyRequest("rates", `${upstream.origin}/hang`), {
      allow: ["rates"],
      origins: [upstream.origin],
      timeoutMs: 75,
    });
    const elapsed = performance.now() - started;
    assert.equal(res?.status, 504);
    assert.equal((await res!.json() as { error: { kind: string } }).error.kind, "upstream_timeout");
    assert.ok(elapsed < 1_000, `deadline response took ${elapsed.toFixed(1)} ms`);
  } finally {
    await upstream.close();
  }
});

test("api-proxy bounds: the incoming request signal aborts the active hop", async () => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  const pending = handleApiProxy(proxyRequest("rates", "https://rates.example/v1", {
    signal: controller.signal,
  }), {
    allow: ["rates"],
    origins: ["https://rates.example"],
    timeoutMs: 5_000,
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("client gone"));
  const res = await pending;
  assert.equal(res?.status, 499);
  assert.equal(upstreamSignal?.aborted, true);
});

test("api-proxy response integrity: HEAD stays bodyless and buffered lengths are exact", async () => {
  const head = await handleApiProxy(proxyRequest("rates", "https://rates.example/v1", {
    method: "HEAD",
  }), {
    allow: ["rates"],
    origins: ["https://rates.example"],
    fetchImpl: async () => new Response(null, {
      status: 200,
      headers: { "content-length": "999", "content-encoding": "gzip" },
    }),
  });
  assert.equal((await head!.arrayBuffer()).byteLength, 0);
  assert.equal(head!.headers.get("content-length"), null);
  assert.equal(head!.headers.get("content-encoding"), null);

  const body = await handleApiProxy(proxyRequest("rates", "https://rates.example/v1"), {
    allow: ["rates"],
    origins: ["https://rates.example"],
    fetchImpl: async () => new Response("hello", {
      headers: { "content-length": "999", "content-encoding": "gzip" },
    }),
  });
  assert.equal(await body!.text(), "hello");
  assert.equal(body!.headers.get("content-length"), "5");
  assert.equal(body!.headers.get("content-encoding"), null);
});
