# DSX (DespiaScript) language support for VS Code / Cursor

Syntax highlighting for `.dsx` files: **XML markup + `{{ JS }}` expressions +
inline JSON**. The grammar colours tags, attributes, comments and strings as
XML, and injects the JavaScript grammar inside every `{{ … }}` block - so the
expressions, object/array literals (the "JSON" in DSX) and operators light up
like real JS.

This folder is also the **TextMate grammar source for DespiaScript on GitHub**:
GitHub Linguist vendors grammars from public extension repos like this one, so
the grammar (`syntaxes/dsx.tmLanguage.json`, scope `text.dsx`) and the Apache-2.0
`LICENSE` at the root are load-bearing for the upstream submission - see the
Despia monorepo's `OpenSource/editors/linguist/` for the submission kit.

> Reading this on [`despia-native/vscode-dsx`](https://github.com/despia-native/vscode-dsx)?
> That repo is a generated, read-only mirror of the Despia monorepo folder
> `OpenSource/editors/vscode-dsx` (see `MIRROR.md`). Changes land in the
> monorepo, never here.

## Install

Pick whichever is least friction for you:

**A. Symlink / copy this folder into your extensions folder (no build):**

```sh
# from this folder -
# VS Code
ln -s "$(pwd)" ~/.vscode/extensions/vscode-dsx
# Cursor
ln -s "$(pwd)" ~/.cursor/extensions/vscode-dsx
```

Then reload the window (`Cmd/Ctrl+Shift+P → Developer: Reload Window`).

**B. Run it from source (Extension Development Host):**

Open this folder in VS Code and press `F5`. A second window opens with the
extension active - open any `.dsx` file there.

**C. Package a `.vsix` and install it:**

```sh
npm i -g @vscode/vsce
vsce package
code --install-extension vscode-dsx-0.1.0.vsix   # or: cursor --install-extension …
```

## Zero-install fallback (XML only)

If you don't want the extension, you can make VS Code treat `.dsx` as XML
(markup highlighting only - no `{{ JS }}` injection) by adding this to your
`settings.json`:

```json
"files.associations": { "*.dsx": "xml" }
```

Note: this **overrides** the `dsx` language above, so don't set it if you've
installed the extension and want the JS/JSON injection.
