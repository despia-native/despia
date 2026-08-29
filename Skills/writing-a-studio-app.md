# Writing a Despia app

An app is an ordinary package whose manifest says two more things: which Studio API it speaks,
and what it contributes. Everything else about it — the git tag, `despia add`, the lockfile
pin, the tree hash — is the package registry you already have.

Start by copying `OpenSource/StudioKit/example`. It is the reference app: a docked side panel,
a style-panel section, and a tool that runs headless, all inside the rules the shelf checks.

## 1. The manifest

```jsonc
{
  "name": "Palette",
  "scheme": "palette",              // your bus identity; the registry refuses a collision
  "version": "0.3.0",
  "summary": "Palette notes for your screens",
  "studioApi": 1,                   // the envelope. A skew refuses to mount, typed.
  "facets": {
    "apps": {
      "panel": {
        "slot": "studio.panel",     // the DEFAULT placement: a docked column
        "component": "Components/Panel.dsx",
        "title": "Palette",
        "icon": "drop.fill",
        "grants": ["project:read", "selection:read"]
      }
    }
  }
}
```

## 2. Pick the placement, and pick the panel

`studio.panel` is a docked 340px column beside the live preview. The person keeps working with
your app open, which is the only reason they will keep it open. `studio.rail` hands you the
whole work area, and it is for an app that genuinely is a destination — a board, a canvas, a
whole editor. If you are unsure, you want `studio.panel`: the host draws an expand control, so
a person can promote your panel to the full window whenever they want it there, and dock it
back when they do not.

The other five: `studio.inspector.section` and `studio.style.section` put a section inside the
Studio's own panels, `dashboard.card` puts a card on the dashboard, `tool` publishes an action,
and `automation` runs one on an event.

## 3. Ask for what you use, and nothing else

Every grant is shown to the person before your app runs, in a sentence:

| grant | what they are told |
|---|---|
| `project:read` | Read this project's documents and catalogs |
| `project:write` | Edit this project — every change lands as its own commit you can revert, and anything that reshapes the project arrives as a pull request |
| `selection:read` | See what you have selected |
| `net:<host>` | Send data to that host |
| `secret:<NAME>` | Uses the key you configure (automations only) |
| `data:<entity>` | Reads and writes your records (automations only) |
| `automation:deploy` | Adds automations to your server deployment |
| `automation:auto` | May act without a per-run confirmation |

Grants are enforced at the seam on every call, not at the dialog. An app that asks for
`project:write` and never writes is an app a reviewer will ask about. The person agrees to
them by checking a sentence with your app's name in it, so write a `summary` that makes that
sentence easy to say yes to.

## 3.1 What happens when you write

You do not manage versions, and you cannot opt out of them. Every write your app makes joins a
change set, and the HOST decides where it lands:

- an in-place edit of up to three documents → **its own commit** on the branch the person is
  on, scoped to the files you touched, with `Despia-App: <you>@<version>` in the trailer;
- a document you **add**, a wider fan-out, or any write while the person is on `main` →
  **a branch and a pull request**, and the working branch goes back to how it was.

So `studio.project.create` does not put a file in front of someone. It proposes one. Write your
copy accordingly: "Propose a pricing screen" is honest, "Add a pricing screen" is not.

Both are revertible from the Apps panel's **Changes** tab and from `despia app revert <change>`,
byte-for-byte, whether or not the project is a git repository. Your app is never told any of
this happened — which is precisely why a person can believe the record.

## 4. Build it out of StudioKit

Your app renders in a shadow root with the kernel's token sheet and StudioKit adopted, and
nothing else. That is deliberate: it is why your panel follows the Studio's theme without you
doing anything, and why it cannot restyle the editor around it.

```xml
<studiokit.SidePanel title="Palette" subtitle="Screens, notes and tone" footer="yes">
  <studiokit.Segmented slot="actions" options="{{ modes }}" value="{{ mode }}"
                       on:pick="dsx.variable.mode = dsx.this.value"/>
  <studiokit.Section title="Documents" count="{{ rows.length }}">
    <list bind="rows" key="id" scroll="false">
      <studiokit.Row name="{{ item.name }}" meta="{{ item.meta }}" icon="note.text"
                     selected="{{ item.chosen }}" on:pick="pick({ id: item.id })"/>
    </list>
  </studiokit.Section>
  <studiokit.Button slot="footer" label="Keep note" variant="primary" on:tap="keep()"/>
</studiokit.SidePanel>
```

Read `OpenSource/StudioKit/README.md` for the whole component list. Use `on:appear` to load:
your panel mounts with nothing in it until you ask for something.

## 5. What your app may reach

The seam list is closed. These names work; nothing else exists to call.

```
studio.project.list · studio.project.read · studio.project.edit · studio.project.create
studio.catalog.elements · studio.catalog.styles · studio.catalog.graph
studio.selection.get · studio.ui.toast
app.storage.get · app.storage.set · app.storage.remove · app.storage.list
```

That is the whole of "can an app reach the editor". It reads the project's documents and its
element, style and screen-graph catalogs; it knows what is selected; it edits and adds
documents through the same doors the Studio's own panels use; and it keeps its own state in a
namespace no other app can name. Everything else the editor can do — moving the selection,
running a build, opening a screen, touching another app — is not on the list, and a name that
is not on the list does not exist to call.

Every call returns the kernel's envelope, so check it:

```js
const listing = await dsx.module.studio.project.list()
if (listing.ok != true) { return }
dsx.variable.screens = listing.data.documents
```

A refused call settles `{ ok: false, error: "forbidden" }` and your body keeps running. That is
the error system, not a special case: errors are values.

## 6. Make it headless too

An interface is one consumer of your app. A `tool` row names an action in a `<server>`-grammar
document, and that one body is reachable three ways: from your own UI, from
`despia app run <scheme> <tool>`, and from an agent as `app_<scheme>_<action>` over MCP.

```jsonc
"audit": {
  "slot": "tool",
  "action": "auditProject",
  "run": "Server/Tools.dsx#auditProject",
  "title": "Audit project",
  "description": "Count this project's documents"
}
```

The document may declare actions, secrets and egress, and nothing else — routes, entities and
tools belong to the project's own backend, not to yours.

## 7. Check it the way the shelf will

```bash
despia review --app --strict --project .
despia app tools                 # your tool rows, with the arguments they declare
despia app run <scheme> <tool>   # the body, headless
despia app history               # what your app did to this project, and what git made of it
despia app revert <change>       # put it back
despia submit --coordinate github:you/your-app
```

`despia review --app` is the bar: token-only colour (a literal fails with the token named), no
hardcoded remote URLs (declare a `net:` grant and use the scoped fetch), and a one-megabyte cap
on your authored surface. `despia submit` runs all of it, hashes the tree, and prints the exact
registry row and pull-request steps.

## 8. Submitting

Tag the tree, open a pull request adding your row to the registry's `apps.json`, and the
submission workflow re-hashes your tag, validates the manifest, runs the same lint, and posts
your capability disclosure for a human reviewer. After approval the owner signs
`(coordinate, version, treeHash, grants)` offline; the toolchain verifies that signature before
your app mounts anywhere. A new version is a new submission.

The full law is `OpenSource/Documentation/architecture/proposals/studio-apps.md`; the
submission process is `CONTRIBUTING-APPS.md` in the registry repository.
