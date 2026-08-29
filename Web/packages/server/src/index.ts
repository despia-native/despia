//
//  @despia/server - SSR v0: IR → HTML strings, static export, redirects (/web/02).
//  The browser-safe surface is `renderToString`; the node-side exporter lives in
//  ./static (imported directly by build scripts).
//

export { renderToString, renderEmbedFragment, renderEmbedFragmentAsync, executeSsrApis } from "./render.ts";
export {
  renderPage,
  renderPageAsync,
  renderRedirect,
  exportStatic,
  assertSafeRoutePath,
  assertSafeRouteTable,
  assertSafeRedirectTarget,
  resolveRouteOutput,
  rebaseShellForDepth,
  shellDepthForRequestPath,
  type ShellOptions,
  type RouteOutputOptions,
  type RouteOutput,
} from "./static.ts";
export { createPageHandler, type PageHandlerOptions } from "./live.ts";
// A1 — the SITE face: static assets + SSR pages in front of the API host. NODE-SIDE (it reads
// the filesystem), exported for the same reason `exportStatic` is: a host cannot be assembled
// without it, and leaving the production face unimportable is what left `createPageHandler`
// wired to nothing for so long. `resolveWithin` is exported deliberately too — it is the
// [S-BOUNDARY] traversal check, and a custom host that serves files needs the same one rather
// than a second, different policy.
export {
  createSiteHandler, resolveWithin, contentTypeFor, cacheControlFor, type SiteOptions,
} from "./site-node.ts";
export { renderPageStream, STREAM_ERROR_MARKER } from "./stream.ts";
export { offlineManifest, offlineManifestText, type EmitOptions, type EmittedManifest } from "./offline-manifest.ts";
// `<api via="server">` — the proxy route (/web/05 "the secrets story"). [S-BOUNDARY]:
// credentials arrive only through the host-supplied `headers` provider.
export {
  handleApiProxy, parseApiProxyRequest, resolveProxyTarget, apiProxyRoutePath,
  API_PROXY_PREFIX, type ApiProxyOptions, type ApiProxyRequest,
} from "./api-proxy.ts";
// The INBOUND webhook boundary (signature · clock window · replay defense), the request budget,
// the durable subscription feed and W3C trace context. Exported for the same reason the site
// handler is: a production host cannot be assembled without them, and a plane nobody can import
// is a plane nobody uses.
export {
  receiveWebhook, verifyWebhook, webhookResponse, statusFor, webhookReceiver,
  DEFAULT_WEBHOOK_TOLERANCE_MS, MAX_WEBHOOK_BODY_BYTES,
  type WebhookSource, type WebhookVerdict, type WebhookOutcome, type WebhookRefusal,
  type WebhookDeclaration,
} from "./webhook.ts";
export {
  spend, rateHeaders, RateLimitSeam,
  type RateLimitRule, type RateLimitStore, type RateVerdict,
} from "./ratelimit.ts";
export {
  publishEvent, subscriptionResponse, assertChannel, parseCursor, RealtimeSeam, RealtimeError,
  REALTIME_BATCH_LIMIT,
  type RealtimeEvent, type RealtimeTransport, type SubscriptionOptions,
} from "./realtime.ts";
export { readTraceContext, traceHeaders, traceparentHeader, type TraceContext } from "./trace.ts";
export {
  enqueueMessage, listDeadLetters, replayDeadLetters, QUEUE_DEAD_LETTER_LIMIT,
  type QueueEnqueueRequest, type QueueEnqueueResult, type QueueDeadLetter,
} from "./queue.ts";
export { secretEquals } from "./secrets.ts";
export {
  chargeSpend,
  configureSpend,
  flushSpendIfDue,
  flushSpendNow,
  queueDepthCeiling,
  resetSpend,
  SpendSeam,
  spendHeaders,
  spendSnapshot,
  SPEND_CHANNEL,
  type SpendBudget,
  type SpendStore,
  type SpendVerdict,
} from "./spend.ts";
