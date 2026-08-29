# Server rendering

DSX server-renders through the **`<api>` block**. There is no separate render mode to
turn on, no second entry point, and no `getServerSideProps` twin: the block that declares
your data is the same block the server resolves before it sends the page.

That is the whole design. A screen that fetches its data is a screen a crawler can read.

## What happens on a request

1. The route resolves to a component.
2. Every **SSR-eligible** `<api>` block in that component **and the components it renders**
   runs in parallel on the server.
3. The resolved envelopes are keyed by their `as` name and embedded as hydration seeds.
4. The document ships with the data already painted.
5. On mount, a seeded block adopts its envelope instead of fetching again.

A block that is ineligible or that **fails is simply omitted** from the seeds, and the
client fetches it on mount. A failing request degrades to a client fetch; it never
produces a broken page.

## `ssr` — whether a block runs on the server

```dsx
<api as="posts"    url="/api/posts"/>                  <!-- GET: SSR by default -->
<api as="me"       url="/api/me"        ssr="false"/>  <!-- per-user: skip it -->
<api as="checkout" url="/api/checkout"  method="post"/><!-- not a GET: off by default -->
```

**Defaults to `true` on a GET and `false` on anything else.** It takes a boolean literal,
never a reactive expression, because the decision is made before there is a store to read
it from.

Turn it off for anything per-user, expensive, or irrelevant to a first paint. Leave it on
for the content a search engine should index.

## `defer` — flush the shell first, stream the data after

```dsx
<api as="reviews" url="/api/reviews" defer="true"/>
```

A deferred block is **not awaited** before the document is sent. The shell flushes
immediately with that subtree showing its loading branch, the response stays open, the
deferred blocks run concurrently on the server, and each one flushes a small script chunk
carrying its seed the moment it resolves. Chunks arrive **out of order** — first resolved,
first flushed.

If a block already settled itself client-side, its chunk is ignored, so data can only ever
arrive once.

Use `defer` for the part of a page that is slow but not above the fold: reviews under a
product, comments under a post, a recommendation rail. The user gets the shell instantly
and the slow part fills in without a second round trip from the browser.

## Choosing, in one table

| Block | `ssr` | `defer` | Result |
|---|---|---|---|
| Above-the-fold content | on (default for GET) | off | painted in the HTML, indexable |
| Slow secondary content | on | **on** | shell now, data streamed after |
| Per-user or private | **off** | — | client fetch on mount |
| Mutations (`post`, `put`) | off (default) | — | never runs on the server |

## Caching

`cache` takes `no-store` (the default), `max-age(d)` or `swr(fresh, stale)`, with durations
written `N`, `Ns`, `Nm`, `Nh`. It applies to the block, so the same declaration governs the
server pass and the client refetch rather than two systems disagreeing.

## Why this and not a render mode

An earlier design had a `<render mode="server">` head block. It was not built, and it
should not be: a page-level mode forces you to classify a whole screen when the real
answer differs per piece of data. Marking the block is finer, it is the same declaration
you already wrote, and it means a component carries its own rendering behaviour wherever
it is mounted rather than depending on which page happens to include it.

## What it means for the native renderers

`ssr` and `defer` are **web-only by construction**, and the native runtimes ignore both.
They are async by default: an iOS or Android screen mounts and its `<api>` blocks resolve
against the loading branch you already wrote. There is nothing to configure and no parity
gap, which is why neither attribute carries a cross-platform corpus fixture.

The practical consequence is that the same document is correct everywhere. You write one
screen with one data declaration; the web renders it ahead of time, and the natives fetch
it on mount.

## See also

- `Skills/attribute-classes.md` — every `<api>` attribute and its contract
- `guides/routing.md` — `href` renders a real crawlable anchor, which is the other half of being indexable
- `Skills/writing-a-backend.md` — the `<server>` side of the same grammar
