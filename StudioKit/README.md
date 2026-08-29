# StudioKit

The component library every Despia app is built from. An app that installs into the Studio
composes these so its surfaces read as part of the editor, in any theme, on any renderer.

Two halves, and both matter. The **components** are the shapes; `kit.css` is the **unscoped
class vocabulary** they are built from, declared as `web.styles` so it folds into the design
layer of every app's sub-registry. That means an author's own markup can use the same classes
the components use. A kit that shipped only components would be one an author cannot extend,
and the first time they needed a shape it did not anticipate they would invent one.

## The components

**Scaffolds** — `SidePanel` is the default shape of an app: a docked column beside the live
preview, with a header, a scrolling body and an optional footer for the one commit. `RailPane`
is the full-window scaffold, for an app that genuinely is a destination. `Section` groups rows
under a quiet section word; `Toolbar` is a strip of controls under a hairline.

**Structure** — `PanelHeader`, `PropertyRow` (a label beside the control that edits it),
`Field` (a labelled control in a well, with a hint), `Card`, `Row` (a selectable line with a
glyph, a name and a trailing fact), `Divider`.

**Controls** — `Button` in three variants and no fourth (`primary` is the one commit on a
surface, `quiet` is everything else, `danger` destroys something), `Segmented` for two to four
visible choices, `Select` for the long vocabularies.

**Marks** — `Chip`, `Badge` (`ok`, `warn`, or plain), `Stat` (a number with its unit and
caption).

**States** — `EmptyState` (a fact and the one control that changes it), `Toast` (an inline
notice that stays; the floating kind is `dsx.module.studio.ui.toast`, which the Studio draws
outside your app).

## The rules the kit encodes

Three ink tiers carry the whole legibility story: a section word is chrome and recedes, a
property label is quiet, and the value is the brightest thing in its row. The accent means
"you chose this" and nothing else, so selection is a wash and a hairline ring rather than a
filled slab. A control whose whole surface is text wears a resting well; a readout wears none.
Whitespace before lines.

Every value in `kit.css` is a `--dsx-*` token. `despia review --app` holds your package to
exactly that and names the token in the refusal, and this package is the reference it holds
you to.

## Using it

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

  <studiokit.Field label="Note" hint="Kept in your app's own storage.">
    <textfield bind="note" class="sk-input" grow="width" a11yLabel="Note"/>
  </studiokit.Field>

  <studiokit.Button slot="footer" label="Keep note" variant="primary" on:tap="keep()"/>
</studiokit.SidePanel>
```

The law behind this package is
`OpenSource/Documentation/architecture/proposals/studio-apps.md`, sections 4.1 and 13.
