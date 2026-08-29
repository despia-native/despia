# OpenSource/Type - the bundled typeface

One permissive variable face, subsetted, licensed, and reachable from the kernel's
`--dsx-font` token. A satellite of the OSS drop, not part of the core.

## Why this folder exists at all

`--dsx-font` resolved to `system-ui, "Segoe UI", Roboto, sans-serif`, and the kernel's type
ramp specifies weights 400, 500, 600 and 700. Measure what those weights actually render on
the platforms the web renderer is for:

| Resolved face | 400 | 500 | 600 | 700 |
|---|---|---|---|---|
| SF Pro (macOS/iOS, variable) | real | real | real | real |
| Segoe UI Variable (Windows 11) | real | real | real | real |
| Segoe UI static (Windows 10) | real | -> 400 | real | real |
| Roboto (Android, static) | real | real | -> 700 | real |
| DejaVu Sans / Liberation Sans (the common Linux and headless-CI fontconfig answer) | real | -> 400 | -> 700 | real |

On the last row the ramp has two weights, not four. `--dsx-type-headline-weight: 600` and
`--dsx-type-title1-weight: 700` become the same weight; every `font-weight: 500` in the sheet
becomes body weight and the tier disappears. The hierarchy the sheet describes is not the
hierarchy that renders, and nothing reports it.

A variable face fixes it in one move: `wght 100..900` is continuous, so every weight the sheet
names is a weight the face has. The `opsz 14..32` axis comes along, which is what the ramp's
negative tracking tokens (`-0.022em` at display down to `0em` at caption) were hand-approximating.

## What is here

| Path | What |
|---|---|
| `vendor/inter/InterVariable-latin.woff2` | 72372 bytes, 230 codepoints, `opsz 14..32` + `wght 100..900` |
| `vendor/inter/InterVariable-latin-ext.woff2` | 35856 bytes, 171 codepoints, same axes |
| `vendor/inter/LICENSE.txt` | SIL Open Font License 1.1, upstream text verbatim |
| `vendor/inter/DERIVATION.md` | the upstream artifact, its sha256, and the exact subsetting command |
| `vendor/VERSIONS` | the pin: `inter  v4.1.1  OFL-1.1  https://github.com/rsms/inter` |
| `inter.css` | the ONE `@font-face` block, two faces, each with its own `unicode-range` |

**108228 bytes total in the repository. 72372 bytes on a cold cache for a Latin page** - one
request, `font-display: swap`, and the Latin Extended file is fetched only by a page that
actually sets one of its characters. A page in a script neither subset carries fetches zero
bytes and falls through to the system stack for that text, which is correct.

For comparison, the three hand-rolled copies this replaces were 352240 bytes each, unsubsetted
and with no `unicode-range`, so every one of them fetched the whole face on every cold load.

## Using it

Link `inter.css` (or copy its two rules with your own `url()` base) from any surface that serves
static files. Nothing else is required: `--dsx-font` already names `"InterVariable"` first, so
the face lands the moment the browser can load it and the surface renders in the previous system
stack when it cannot.

Do not add it to `@despia-native/dom`'s `TOKENS_CSS`. The reason is written at the top of `inter.css`.

## Why it is not under `OpenSource/Web/`

`check_opensource_purity.rb` check 2: the core - `Engine`, `Web`, `Conformance` - carries no
vendored third-party source, because every vendored tree in the core is another upstream licence
riding into every app that links the kernel. That rule is doing real work here and not getting in
the way: an app that links `@despia-native/dom` and never links this stylesheet ships no OFL bytes and
takes on no OFL obligation. Putting the face in the core would have handed the obligation to
everyone. It lives beside `AI`, `Local` and `MCP` instead, which is the shape the drop already
has for a satellite that vendors bytes.
