# The reserved-directory contract

> What the Despia toolchain owns inside YOUR repository, named once and promised narrow.
> Every combination guide (`guides/combinations/`) references this file instead of restating
> it, so the promise cannot drift per guide. The other half of the promise: **everything not
> named here is yours**, and no Despia tool will create, rewrite or delete it.

## Names the toolchain owns

| Path (relative to your project root) | Owner | What happens there |
|---|---|---|
| `dsx.json` | you write it, tools read it | the project/module identity: name, scheme, version. Scaffolded once by `npm create dsx`; never rewritten by a build. |
| `dsx.config.json` | you write it, tools read it | the web build's entry component and options. Same discipline. |
| `Components/` | yours, by convention | your `.dsx` documents. `dsx build`/`dsx lint`/`dsx dev` read here by default; nothing writes here. |
| `dist/` (or your configured `outDir`) | **generated** | `dsx build` output. Deleted and rewritten on every build. Never commit, never edit. |
| `dist-ota/` (or your `--out`) | **generated** | `dsx ota build` output: the servable content tree + `manifest.json`, plus `.history/` (the publisher's local generation store — never uploaded, never edited). |
| `server/` | yours, by convention | `<server>` documents (backend-authoring). The emitter compiles them; it does not touch anything else in the folder. |
| `deploy/` | **generated** | the deploy emitters' artifacts (migrations, function entries, `wrangler.jsonc`, Dockerfile). Written by `despia build` whenever the project has `<server>` documents, and published by `despia deploy`. Regenerated on every build; hand edits are overwritten by design. |
| `native/Modules/<Name>/` | yours, shape-checked | a Custom module beside an existing web codebase (combination C2): `dsx.json` manifest + `swift/` and `kotlin/` lane folders (rule 11: the lane names the toolchain; there is no default platform). |
| `Modules/<Name>/` | yours, shape-checked | your own native modules in a DSX project, the same grammar (`dsx.json` + lane folders + `Components/` + `config.json`); read by `dsx export` ([native-export](native-export.md)). |
| `export/ios/`, `export/android/` (or your `--out`) | **generated** | `dsx export` output: a complete Xcode / Android Studio project, byte-deterministic. Deleted and rewritten on every export. Never edit; regenerate. |
| `node_modules/` | npm's | as ever. |

## The three promises

1. **Generated means regenerable.** Anything in a generated directory can be deleted and
   reproduced by the tool that wrote it. If deleting it loses information, that is a bug in
   the tool, not a property of your project.
2. **Yours means untouched.** No Despia command edits a file it did not generate. `dsx ota
   build` reads your content and writes only its `--out`; the deploy emitters write only
   `deploy/`; the backend emitter writes only its generated tables.
3. **The names are stable.** A new tool version may add a NEW reserved name (announced in the
   CHANGELOG), but an existing name never changes meaning. Renames are major-version events.
