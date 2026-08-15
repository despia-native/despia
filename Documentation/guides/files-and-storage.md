# Files & storage

## Sending a file to a module

Pass a `File` or `Blob` straight in the params — DSX uploads it natively (multipart,
streamed off disk, **never** base64 in JS memory) and hands the module a local URL:

```js
const file = input.files[0];
await window.dsx.module.gallery.save({ files: [file] });   // module receives a local URL
```

This works for any module that takes a file param; arrays of files work too.

## Persisting data

Three layers — pick the tightest scope for what you're storing:

| Need | Use | Scope |
|---|---|---|
| One small web settings blob | `await window.dsx.module.writevalue.write({ value: str })` / `const v = await window.dsx.module.writevalue.read()` | a single opaque string the web owns (ValueStore; also mirrors to the legacy `window.storedValues`; the one-string `window.despia.writevalue(str)` / `window.despia.readvalue()` calls are legacy-surface only) |
| App-wide reactive state | `window.dsx.global.*` — see [state-and-events](state-and-events.md) | shared live with native + DSX screens |
| Files / larger blobs | the local **CDN** (`window.dsx.module.cdn.*`, below) | named files in buckets, on disk |

**ValueStore** is one string you serialize yourself (a settings blob, a cached token): small and
local. **`global`** is for state multiple surfaces must agree on, reactively. **CDN** is for actual
files.

## The local CDN (`cdn`)

Stores bytes under a `bucket/name` and hands back a URL the web app and the native side can both
read — caching downloads, sharing files with extensions/widgets, holding a captured image.

```js
// store
const { url } = await window.dsx.module.cdn.upload({ bucket: "avatars", name: "me.jpg", file });
// later — re-resolve; do NOT persist the URL
const { exists, url: fresh } = await window.dsx.module.cdn.url({ bucket: "avatars", name: "me.jpg" });
```

| Action | Args | Returns |
|---|---|---|
| `upload` | `{ name, bucket?, file \| path \| base64 }` | `{ ok, name, bucket, size, url }` |
| `url` | `{ name, bucket? }` | `{ exists, url, size }` |
| `list` | `{ bucket? }` | `{ bucket, items }` |
| `remove` | `{ name, bucket? }` or `{ bucket, all: true }` | `{ removed }` |
| `stats` | `{ bucket? }` | `{ bucket, items, bytes }` (or every bucket) |

- **Persist `bucket/name`, never the URL.** The loopback URL's port changes each launch; re-resolve
  with `cdn.url` at the point of use.
- **Progress?** For an upload progress bar, POST `FormData` yourself to the data plane
  (`window.__despiaUpload` on http pages, `cdn:/api/file/upload` on https) with `file` + `name` +
  `bucket` and an `xhr.upload.onprogress`.
- **Errors** reject with a stable `e.code` — see [error handling](getting-started.md#handling-errors).

A common flow — capture, cache, reuse across the app:

```js
const { url } = await window.dsx.module.cdn.upload({ bucket: "uploads", name: "photo.jpg", file });
await window.dsx.global.set("profile.avatar", { bucket: "uploads", name: "photo.jpg" });
// render later: re-resolve from the stored bucket/name
const { url: src } = await window.dsx.module.cdn.url(await window.dsx.global.get("profile.avatar"));
```

Deep-dive: [storage.md](../../Skills/storage.md) (the `cdn` module + native
`dsx.module.cdn.object("store")`); [containers.md](../../Skills/containers.md) for the
shared App Group used by widgets/extensions.
