# InterVariable, as vendored here

These two `.woff2` files are DERIVED from one upstream artifact. This page is the
proof, so a reviewer can reproduce the bytes rather than trust them.

## Upstream

| | |
|---|---|
| Package | `inter-ui@4.1.1` (npm), the Inter project's own web distribution |
| File | `variable/InterVariable.woff2` |
| Size | 352240 bytes |
| sha256 | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| Version (name ID 5) | `Version 4.001;git-9221beed3` |
| Licence (name ID 13) | `This Font Software is licensed under the SIL Open Font License, Version 1.1.` |
| Licence URL (name ID 14) | `http://scripts.sil.org/OFL` |
| Axes (fvar) | `opsz 14..32`, `wght 100..900` |

The licence line above was read out of the font's own `name` table, not off a web
page. `LICENSE.txt` beside this file is the upstream text verbatim.

## What was done to it

`fontTools.subset` (fonttools 4.63.0), twice, once per unicode-range. Nothing was
instanced: both files keep the full `wght 100..900` range AND the `opsz 14..32`
optical-size axis, which is the reason for bundling a face at all.

```sh
FEAT="calt,ccmp,clig,curs,dnom,frac,kern,liga,locl,mark,mkmk,numr,rclt,rlig,rvrn,tnum,zero,case"

LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
python3 -m fontTools.subset InterVariable.woff2 \
  --unicodes="$LATIN" --layout-features="$FEAT" --flavor=woff2 \
  --output-file=InterVariable-latin.woff2

EXT="U+0100-017F,U+0192,U+01FA-01FF,U+0218-021B,U+0259,U+2020,U+20A0-20BF,U+2113"
python3 -m fontTools.subset InterVariable.woff2 \
  --unicodes="$EXT" --layout-features="$FEAT" --flavor=woff2 \
  --output-file=InterVariable-latin-ext.woff2
```

## What came out

| File | Bytes | Codepoints | Axes |
|---|---|---|---|
| `InterVariable-latin.woff2` | 72372 | 230 | `opsz 14..32`, `wght 100..900` |
| `InterVariable-latin-ext.woff2` | 35856 | 171 | `opsz 14..32`, `wght 100..900` |
| total | 108228 | | |

```
dd7d3a2b93ee73c1af7ba029d02bb86d4f3d67875bf46b53f9f7ea147baf3423  InterVariable-latin.woff2
591488ba1d8e6ba2fb1ef7bc39c80c53c8a7a871b091083f0da3845b76dabfdf  InterVariable-latin-ext.woff2
```

The two ranges do not overlap, so a page never fetches both unless it actually
sets a Latin Extended-A character. A page in Cyrillic, Greek or any CJK script
fetches NEITHER: those ranges are not in this subset at all and the browser falls
straight through to the system stack for them, which is the correct outcome for a
UI face that does not carry those scripts.

## The features kept, and why

The default `fontTools.subset` feature set drops `tnum`. That is wrong for this
framework: `fontFeature="tnum"` is a documented style attribute
(`OpenSource/Skills/module-fonts.md` and `ClosedSource/DSX/Modules/Core/Fonts`),
and a price column that jitters as its digits change is the exact defect tabular
figures exist to prevent. `zero` (slashed zero) and `case` (case-sensitive
punctuation) ride along for 0 measurable cost on top of it.

## What is NOT here

- **No italic.** Inter's italic is a second variable file of comparable size, and
  doubling the bundle for a slant a UI uses in a handful of places is not a trade
  worth making. `italic` synthesises an oblique, which the Fonts primitive already
  documents as the behaviour when a family declares no italic face. Weight never
  synthesises, and does not have to here: `wght 100..900` is real.
- **No Cyrillic, Greek or Vietnamese subsets.** Same reason, larger: each is
  another 40-90 KB serving a page that has not asked for it. Add one as its own
  `@font-face` with its own `unicode-range` when a surface needs it.
