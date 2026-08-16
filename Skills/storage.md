# Storage (the `cdn` module)

File storage is owned by the **Mandatory/ContentServer module** (scheme `cdn`,
alias `content` — `ClosedSource/DSX/Modules/Mandatory/ContentServer/`, which holds
`LocalCDN.swift` and `CDNSchemeHandler.swift`). Web apps persist and fetch files
with a single `window.dsx.module.cdn.<action>(...)` call (legacy alias:
`dsx.module.cdn.*`; legacy pages spell it `window.despia.cdn.*`) - no separate SDK to learn.

```js
// upload a File from <input type="file">
const { url, name, size } = await window.dsx.module.cdn.upload({
    file: inputEl.files[0],
    name: "avatar.png",     // optional - inferred if omitted
    bucket: "tmp"           // optional - defaults to "tmp"
});

// upload a remote URL (downloaded then stored)
await window.dsx.module.cdn.upload({ file: "https://example.com/img.jpg" });

// upload base64 / a data URL
await window.dsx.module.cdn.upload({ file: "data:image/png;base64,iVBORw0..." });

// read a stored file: resolve its loopback URL, then fetch it (existence rides
// the same payload - there is no separate download/exists action)
const { exists, url } = await window.dsx.module.cdn.url({ name: "avatar.png" });
if (exists) img.src = url;                       // or: const bytes = await fetch(url)

// other methods
const { items } = await window.dsx.module.cdn.list({ bucket: "tmp" });
await window.dsx.module.cdn.remove({ name: "avatar.png" });
```

## The `file` argument handles everything

| Input | How it's handled |
|---|---|
| `File` / `Blob` | **streamed** via authenticated multipart from loopback pages and Apple HTTPS surfaces. Android WebView cannot expose a custom-scheme POST body, so remote HTTPS Android pages receive `upload_unsupported`; use a native file path or small base64 value there. |
| `data:` URL | decoded inline (base64 or percent-encoded text) - for small payloads |
| `http(s)://` URL | downloaded, then stored |
| `file://` URL | read from disk, then stored |
| bare base64 | decoded; falls back to UTF-8 text bytes if not valid base64 |

Web code never thinks about transport. Pass whatever you have; the bridge
+ native side figure out how to turn it into bytes on disk.

### Why File/Blob streams instead of base64

`readAsDataURL` would hold the whole file as a base64 string (~1.33x the
file size) in the JS heap, plus another copy when it crosses the bridge -
3x+ memory for a single upload, which crushes the WKWebView heap on large
files. Instead `runtime.js` POSTs the `File` to the native loopback route
(`window.__dsxLocalServer.upload` -> `POST /api/file/upload`) with `FormData` and the
descriptor's `X-DSX-Capability`. The
browser streams the bytes; JS memory stays flat. Native writes the
streamed body to the CDN bucket and returns a loopback URL. `runtime.js`
substitutes that URL for the `File` before the `cdn.upload` call
dispatches - so the native side just promotes the already-on-disk file to the
requested `name`/`bucket` with a rename (no second copy).

A per-file upload progress callback is available via XHR
(`xhr.upload.onprogress`) when you call the lower-level path directly.

## Methods

The module's registered blob-store actions (`ContentServer.swift`; call as
`window.dsx.module.cdn.<action>(…)`):

| Action | Args | Resolves with |
|---|---|---|
| `upload` | `{ name, bucket?, file \| path \| base64, move? }` | `{ ok, name, bucket, size, url, loopback, scheme }` |
| `url` | `{ name, bucket? }` | `{ exists, url, loopback, scheme, size }` — existence rides this payload (`{ exists: false }` when absent; there is no separate `exists`/`download` action — fetch the returned `url`) |
| `list` | `{ bucket? }` | `{ bucket, items: [name] }` |
| `remove` | `{ name, bucket? }` · `{ bucket, all: true }` | `{ removed }` — one item, or a whole bucket (explicit `all` so a missing name can't wipe one) |
| `stats` | `{ bucket? }` | one bucket's `{ bucket, items, bytes }`, or `{ buckets: […], totalBytes }` — powers "Manage storage" screens |

Errors resolve as a rejected promise carrying `{ event: "error", data: { code } }`
- e.g. `missing_file`, `unreadable_source`, `not_found`, `upload_failed`.

## Transport - HTTP vs HTTPS pages

Loopback `http://127.0.0.1:<ephemeral-port>/...` is same-origin when the page itself is
served by that exact origin, but an `https://` origin blocks loopback HTTP as mixed content.
Apple WebKit exposes custom-scheme POST bodies; Android WebView does not. The injected
descriptor therefore advertises only transports that can preserve the bytes:

| Page origin | Upload endpoint | Returned URL |
|---|---|---|
| loopback page | `POST http://127.0.0.1:<port>/api/file/upload` (ServerManager) | `http://127.0.0.1:<port>/<localCDNFolder>/bucket/name` |
| HTTPS, Apple | `POST cdn:/api/file/upload` (`WKURLSchemeHandler`) | `cdn:/api/file/data?bucket=...&name=...` |
| HTTPS, Android | none; deterministic `upload_unsupported` | authenticated `cdn:` GET remains available |

`runtime.js` selects the native-provided endpoint descriptor. A present but empty endpoint
is a deliberate denial and never falls back to a bodyless Android `cdn:` request. Supported forms:

- stream the upload body (loopback via HTTP, Apple scheme via `httpBodyStream`) - never base64,
- are directly loadable in an `<img src>` from their respective origin,
- map back to the on-disk file via `LocalCDN.localFile(forURL:)` (handles
  both URL shapes) so a handler can read the bytes with no round-trip.

To take the bytes inline (e.g. to stash in IndexedDB), `fetch` the resolved
`cdn.url(...)` loopback/scheme URL and read the response - works regardless of origin.

The custom scheme is registered on the `WKWebViewConfiguration` before the
webView is created (it's immutable afterward):

```swift
config.setURLSchemeHandler(CDNSchemeHandler(), forURLScheme: CDNSchemeHandler.scheme)
```

## Relationship to `dsx.module.cdn.object("store")`

`window.dsx.module.cdn.*` is the **web-facing** surface; `dsx.module.cdn.object("store")` is the
**native/module-facing** one. Both sit on the same `LocalCDN.shared`
backing store, so a file a module writes via `dsx.module.cdn.object("store").upload(...)`
is immediately visible to web via `cdn.list` / `cdn.url`,
and vice versa.

## Not the same as `dsx.container`

`window.dsx.module.cdn.*` / `dsx.module.cdn.object("store")` is the **LocalCDN** file store (web uploads, buckets).
`dsx.container` is the **shared App Group** - small key/value + files shared with
the app's extensions. Different store, different purpose: see
[containers.md](containers.md).

## Native source resolution

The native decode point resolves any source to bytes:

```swift
data:...;base64,...   -> Data(base64Encoded:)
data:...,...          -> percent-decoded UTF-8
http(s)://...       -> URLSession download
file://...          -> Data(contentsOf:)
<bare string>     -> base64 decode, else UTF-8 bytes
```

Async sources (http downloads) just capture `dsx` so the result emits against
the original request id even after the action body returns.
