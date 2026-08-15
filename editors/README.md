# Editor integration for DSX

A `.dsx` file is its own format - **XML markup + `{{ JS }}` expressions + inline
JSON**. This folder has what each editor needs to highlight it. How close you
can get to "full XML + JS + JSON" depends on the editor:

| Editor | What you get | How |
|---|---|---|
| **VS Code / Cursor** | ✅ Full: XML + injected `{{ JS }}` + JSON literals | Install [`editors/vscode-dsx`](./vscode-dsx/) |
| **GitHub** (web + PR diffs) | ⚠️ XML only *(until DespiaScript lands in Linguist - [`linguist/`](./linguist/))* | [`.gitattributes`](../../.gitattributes) - `*.dsx linguist-language=XML` |
| **Xcode** | ⚠️ XML only, manual & per-file | see below |
| **Zed / Neovim** | ⚠️ XML via filetype association | see below |

Beyond highlighting, [`OpenSource/CanvasEditor/`](../CanvasEditor/) is the **canvas
editor SDK** (`@despia/canvas-editor`, the `StackCanvas` class): Apache-2.0 licensed, mirrored to the
public [despia-native/canvas-editor](https://github.com/despia-native/canvas-editor) repo.
`src/canvas-editor.js` is the headless, zero-dependency renderer a dashboard embeds (JSE
conformance-gated against the shared `OpenSource/Conformance/jse/` corpus), and
`CanvasEditor.html` is its generated self-contained preview page. It renders a `.dsx` deck 1:1
with the native engine (layout, leaves, state, rules; `dsx.*` only), no build or device.
Open `OpenSource/CanvasEditor/CanvasEditor.html` and go.

## VS Code / Cursor - full highlighting

The TextMate grammar in `vscode-dsx/` highlights the markup as XML and injects
the JavaScript grammar inside `{{ … }}`, so expressions and object/array
literals colour like real JS. See [`vscode-dsx/README.md`](./vscode-dsx/README.md)
to install.

Like the canvas editor, the folder is a **public mirror**
(`vscode-dsx/mirror.json` → [despia-native/vscode-dsx](https://github.com/despia-native/vscode-dsx),
gated by `ClosedSource/scripts/check_vscode_dsx.rb`) - that public repo is
also the grammar source for the Linguist submission below.

## GitHub - XML highlighting today, DespiaScript upstream

The repo's root `.gitattributes` maps `.dsx` to XML for GitHub Linguist:

```
*.dsx linguist-language=XML
```

GitHub applies a single grammar per language, so the embedded `{{ JS }}` and
JSON are **not** sub-highlighted there - XML markup colouring is the ceiling on
GitHub, and `.dsx` counts as "XML" in the repo language bar. A `linguist-language`
override can only name a language Linguist already knows, so showing
**DespiaScript** requires adding the language to
[github-linguist/linguist](https://github.com/github-linguist/linguist) itself.

That plan is staged and ready in [`linguist/`](./linguist/): the submission
playbook (usage thresholds, grammar mirror, `languages.yml` entry, samples,
color) plus a pre-filled PR draft. Once merged upstream, the `.gitattributes`
override gets **deleted** and `.dsx` shows as DespiaScript with our real
grammar.

## Xcode - no custom grammars

Xcode has **no public API for custom syntax highlighting or custom languages**.
Source Editor Extensions (XcodeKit) only run text *commands*; they can't
tokenise or colour. So a DSX-aware highlighter inside Xcode isn't possible.

The only approximation is to colour an open `.dsx` as XML manually:

- Select the file, open the File inspector, set **Type → XML**, or
- **Editor ▸ Syntax Coloring ▸ XML**.

This is per-file and not shared in the repo, and because the project uses
synchronized groups there's no persistent per-file `explicitFileType` to pin.
By default Xcode shows `.dsx` as plain text.

## Zed / Neovim - treat as XML

A proper experience wants a Tree-sitter grammar, but the quick win is a
filetype association to XML:

- **Neovim:** `autocmd BufRead,BufNewFile *.dsx set filetype=xml`
- **Zed:** in `settings.json`, `"file_types": { "XML": ["dsx"] }`
