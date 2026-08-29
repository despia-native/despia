# C7: self-hosted OTA, your content, your host, no Despia hosting

Over-the-air updates for a Despia app's content are static files — a manifest plus the files
it pins. ANY static host serves them: Workers Static Assets, Netlify, S3, GitHub Pages,
nginx, a folder behind a CDN. Despia hosting is a convenience, never a dependency.

## The three commands

```bash
dsx ota build --in Components --out dist-ota    # deterministic: same bytes, same generation
dsx ota publish --out dist-ota --target dir:/srv/www/dsx --apply
dsx ota rollback --out dist-ota                 # repoint to the previous generation, then publish
```

`build` walks your content sorted, sha256-pins every file, and writes the servable tree —
`manifest.json` plus the files at their paths — with no timestamp anywhere, so rebuilding
unchanged input is byte-identical and your CI can diff it. The generation id is the hash of
the file table: your git history and the generation ladder line up without any registry.

Publish targets are a thin table: `dir:<path>` (any mounted volume or rsync root, executed
natively), `s3://bucket/prefix`, `netlify`, `cloudflare` — the vendor rows print their CLI's
exact command and run it only with `--apply` (plan-by-default, like every Despia deploy).

## Rollback, honestly

`rollback` restores the PREVIOUS generation's manifest **and files** from the local history
store (`dist-ota/.history/` — content-addressed, the publisher's memory, never uploaded) and
toggles the current/previous pointers. Publish the result and:

- a device that ever held the old generation flips without re-downloading — its own store is
  content-addressed and kept the blobs;
- a device that never saw it re-fetches by path and verifies every sha — which is why
  rollback restores the files and not only the manifest.

Or skip the command entirely: the OTA folder is build output of your repo, so reverting the
commit and re-publishing is the same operation with your VCS as the history store.

## How devices consume it

Serve `dist-ota/` under your app's content root (App.json `hosting.content_root`, default
`/dsx`). The kernel's content plane does the rest: stale-while-revalidate at folder
granularity, atomic all-or-nothing generations, `previous` kept device-side for rollback,
and — because every file is sha-pinned — a revalidation whose manifest bytes are unchanged
costs one conditional request. The law is `architecture/content-plane.md`; signing, when you
want it, is orthogonal (`remote-bundle-signing.md`).

## What CI proves, from tarballs

The matrix gate runs `dsx ota build` over the scaffolded app's `Components/` and verifies
every manifest sha against the served bytes; the deeper fixtures — build-twice determinism,
a round-trip through a plain static file server with a device-shaped fetch, the rollback
repoint and its toggle — run in the CLI's own suite on every pull request.
