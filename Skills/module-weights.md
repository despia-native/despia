# Module weights — bundling large ML blobs without committing them

Some modules need a big binary they don't author: an ML model (CoreML / ONNX / GGUF),
an embedding table, a lookup blob. Committing it to git is wrong — it's large, binary,
churns history, and is only wanted when that module ships. The **`weights`** manifest
key is the primitive for this: declare a remote blob with a pinned hash, and the build
fetches + verifies + bundles it. The repo stays small; the weight ships in the app.

This is the same shape as a `pods` entry — a module *declares a dependency*, the build
*resolves* it — except the artifact is a data blob placed in the bundle instead of a
linked library.

## Declare it

In the owning module's `dsx.json`:

```json
"weights": [
  {
    "path": "htdemucs_real.onnx",
    "url":  "https://huggingface.co/<owner>/<repo>/resolve/main/htdemucs_real.onnx",
    "sha256": "9dd30a1eef2437c745beab2dd5501bc814b9baf52a4a34944421cbf34df6dc76",
    "bytes": 302999931,          // optional — size sanity log
    "token_env": "HF_TOKEN"      // optional — env var holding a Bearer token (private host)
  }
]
```

- **`path`** — package-relative destination (no `/` prefix, no `..`). Lands in the
  module folder, which is a synchronized group → Xcode bundles it into `Runtime.app/`.
- **`url`** — HTTPS only. A committed URL on the reserved `.invalid` TLD is the
  documented *not-yet-hosted* placeholder: the entry skips gracefully until a real
  host exists. **`url_env`** names an env var that overrides `url` when set (signed
  URLs work; env-sourced URLs are never printed to logs).
- **`sha256`** — 64-hex, **mandatory in every lane**. A mismatch aborts the build, and an
  *absent* pin aborts it too: an empty or all-zeros hash is **rejected before any network
  request** ("missing a pinned sha256; refusing an unverified build-time executable/model").
  There is **no unpinned mode** — the all-zeros value is recognized only so the refusal can
  name the problem precisely. (Earlier revisions of this page described all-zeros as an
  UNPINNED placeholder that ships with a warning. `fetch_weights.rb` has never done that;
  the doc was wrong, not the script.) **`sha256_env`** overrides the literal per build and is
  held to the same rule.
  *Bringing a weight up before you know its hash?* Fetch the blob once by hand and commit
  its `shasum -a 256` output as the pin. Note the pin check runs **before** the `.invalid`
  URL skip, so a not-yet-hosted entry still needs a real 64-hex `sha256` — the placeholder
  URL defers the *download*, never the *pin*. Until you have a hash, don't declare the entry.

## How it ships

1. **`scripts/fetch_weights.rb`** runs at build time (codemagic step *Fetch Module
   Weights*, after `prepare_modules`). For every **enabled** module it downloads each
   declared weight, verifies the SHA-256, and writes it to `path`.
2. The synchronized group (`DSX/Modules/`) bundles the file like any resource.
3. The module reads it at runtime:
   ```swift
   guard let url = Bundle.main.url(forResource: "htdemucs_real", withExtension: "onnx")
   else { /* report unavailable — never fake a result */ return }
   ```
4. The file is **`.gitignored`** (`*.onnx`, `*.mlpackage`, `*.mlmodelc`, `*.ort`,
   `*.gguf` under `DSX/Modules/`), so it never enters git.

## Guarantees

- **Tamper-evident, with no exceptions.** A swapped, truncated, or corrupted blob fails the
  SHA-256 check and **aborts the build**; a declared weight with no pin aborts before the
  first byte is requested. A tampered or unverified weight never ships through this
  primitive.
- **Optional-safe.** A not-yet-hosted URL is a *soft skip* (warn, build proceeds); the
  feature degrades to "unavailable" rather than breaking the build. Host the file and
  the next build picks it up.
- **Off-package-aware.** A weight for a module excluded via `excluded.json` is skipped.
- **Idempotent.** A present file whose hash already matches is left untouched (no
  re-download). `ruby scripts/fetch_weights.rb --check` is a fast offline dry-run.
- **Private hosts.** `token_env` names an env var; the value is sent as
  `Authorization: Bearer …` (never a query param, never logged). `headers` adds any
  extra request headers. The token is only ever sent to the named host; `curl -L`
  follows the host's redirect to the (already-signed) blob.

## What these guarantees do NOT cover — runtime downloads

Everything above is **build-time**. A module that fetches a model **at runtime** (the deferred
path in [`on-device-ai.md`](../Documentation/architecture/on-device-ai.md) §2) is outside this
primitive entirely: `fetch_weights.rb` never sees it, so there is no pin, no verify step, and
no build to abort. Whatever integrity that path has, the module author wrote — and if they
wrote none, there is none.

**Live example, stated plainly:** `Core/LocalAI`'s `HuggingFaceDownloader` (Swift + Kotlin)
downloads GGUF/Whisper models and hands them to the inference engine **with no SHA-256 and no
signature check**, from a **mutable** revision — `main` (a branch) or `v<sdk version>` (a
re-pointable tag), never a commit SHA. TLS to the host is the only protection. Both downloaders
log a warning on every fetch and the gap is documented at the call site; it is **not fixed**,
and it is one of the reasons LocalAI ships in no profile. Do not cite it as a pattern.

If you must download at runtime: keep a per-model **pinned digest** in your catalog, verify the
bytes **before** the engine loads them, and delete the file on mismatch. That is the `weights`
contract, re-implemented by hand — which is exactly why bundling is preferred when it fits.

## Hosting recipes (one shape, every host)

| Host | `url` | extras |
|---|---|---|
| **Public** (HF resolve, public GitHub release asset, any CDN) | the direct file URL | — |
| **Private Hugging Face** | `https://huggingface.co/<you>/<repo>/resolve/main/<file>` | `"token_env": "HF_TOKEN"` |
| **Private GitHub release** | the **API asset** URL: `https://api.github.com/repos/<owner>/<repo>/releases/assets/<assetId>` | `"token_env": "GITHUB_TOKEN"`, `"headers": { "Accept": "application/octet-stream" }` |
| **Private S3 / GCS** | a **pre-signed** URL (no header needed), or the object URL + `token_env` | — |

```json
"weights": [
  { "path": "model.onnx",
    "url":  "https://api.github.com/repos/acme/models/releases/assets/123456789",
    "sha256": "…",
    "token_env": "GITHUB_TOKEN",
    "headers": { "Accept": "application/octet-stream" } }
]
```

Set the token as an environment variable on the Codemagic build (or your CI). A **public**
GitHub release asset (`https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`)
needs none of this — just the URL.

> Finding a private GitHub asset id: `GET /repos/<owner>/<repo>/releases/tags/<tag>` → the
> asset's `id`. (Public repos: use the human `releases/download/<tag>/<file>` URL directly.)

## When NOT to use it

- Small committed assets (a plist, an icon, a seed JSON) → use **`files`** instead.
- A library / framework → use **`pods`** or **`spm`**.
- A **vendored compiled native binary** (an `.xcframework` — a CoreML/ML engine, a DSP
  or pitch-shift framework) → use the **`build`/frameworks** primitive (compile-in-CI or
  Git LFS), *not* `weights`. The distinction: `weights` fetches a **data blob**
  (ONNX / GGUF / embeddings) the module **reads at runtime**; `build` provisions a
  **linked binary** CocoaPods must **vendor** at compile time. Same philosophy
  (no CDN, nothing large in git, gated soft-skip), different artifact — don't reach for
  `weights` to ship code. See `OpenSource/Skills/module-frameworks.md`.
- Anything you want in git history → just commit it.

`weights` is specifically for **large, regenerable, hash-pinned binaries** that are a
build-time dependency of an optional module.
