# The capability manifest

`ClosedSource/CapabilityManifest.json` is one machine-readable answer to the four questions a
consumer of this framework actually asks:

1. What can it do?
2. How do I call this specific thing, and what comes back?
3. Where does it run?
4. What can go wrong, and what do I tell the user when it does?

It is **generated**, never edited: `ruby ClosedSource/scripts/generate_capability_manifest.rb`,
gated in CI with `--check` and unit-gated by `generate_capability_manifest_test.rb`.

## Why it exists

Every fact in the manifest already existed somewhere. None of them existed together.

| Question | Where the fact already lived | Why that was not enough |
|---|---|---|
| What can it do | 583 actions across 138 module manifests | 138 files, one per capability |
| How do I call it | each action's `args` / `resolves` in its `dsx.json` | you had to know which module owned the verb before you could look it up |
| Where does it run | `ModulePlatformSupport.generated` | a separate TSV keyed by scheme, not by anything a caller holds |
| What goes wrong | `Registry/DSXErrorCatalog.json` | keyed by module, not by action, so an action's error set had to be reassembled by hand |
| The UI vocabulary | `stack-elements.json` + `stack-style-properties.json` | already single files, already published |

The manifest is assembly, not new material. That is the point: the raw material was produced as a
side effect of gating, and nobody had noticed it adds up to a complete description of the platform.

## What is in it

```
version, generatedBy, summary, platforms, reservedErrorCodes
capabilities[]        one row per PACKAGE
  kind                "bus" (has a scheme, is callable) or "package" (components, facets, config)
  chain               the dotted identity: dsx.module.<chain>
  scheme, name, id, tier, mandatory, version, path, aliases
  platforms           the concrete implementation platforms, or null if never generated
  declaredPlatforms   the form factors the manifest claims
  dependencies, context, config, permissions
  actions[]
    name, call        the literal string a caller types
    doc, args, resolves, broadcasts
    errors[]          code + the human message + recoverable
    examples[]        the action's own `tests` block
ui                    elements and styleProperties, referenced by path + bytes + sha256
```

### Three decisions worth knowing

**Examples are the `tests` blocks.** Every action already declares executable test cases as its
build gate (`verify_module_tests.rb`). Those are the only examples in this repo that cannot rot,
because a wrong one reds CI. Emitting them as `examples` costs nothing and gives a consumer call
shapes that are true by construction rather than by somebody remembering to update prose.

**The UI plane is referenced, not inlined.** `stack-elements.json` (209KB) and
`stack-style-properties.json` (42KB) are already published single-file artifacts. Copying them in
would double the repo's largest generated files to say nothing new, and would create a second copy
that can go stale against the first. They are referenced by path, byte length and SHA-256 instead,
which is strictly more useful: a consumer can fetch them and prove it got the version this
manifest describes.

**Absent platform support is `null`, not `[]`.** A scheme the support map has never been
regenerated for and a scheme that genuinely runs nowhere are different facts. Collapsing them is
how a stale map reads as a deliberate refusal.

## Reading it

A capability by name:

```bash
python3 -c "
import json; d = json.load(open('ClosedSource/CapabilityManifest.json'))
c = next(x for x in d['capabilities'] if x.get('chain') == 'orientation')
print(json.dumps(c, indent=2))
"
```

Every action that runs on watchOS:

```bash
python3 -c "
import json; d = json.load(open('ClosedSource/CapabilityManifest.json'))
for c in d['capabilities']:
    if 'watchos' in (c.get('platforms') or []):
        for a in c.get('actions', []): print(a['call'])
"
```

Every error code a consumer might have to handle, with its message:

```bash
python3 -c "
import json; d = json.load(open('ClosedSource/CapabilityManifest.json'))
seen = {}
for c in d['capabilities']:
    for a in c.get('actions', []):
        for e in a.get('errors', []): seen.setdefault(e['code'], e.get('message'))
for k in sorted(seen): print(k, '::', seen[k])
"
```

## Regenerating

```bash
ruby ClosedSource/scripts/generate_capability_manifest.rb          # write
ruby ClosedSource/scripts/generate_capability_manifest.rb --check  # CI drift gate
ruby ClosedSource/scripts/generate_capability_manifest_test.rb     # the generator's own cases
```

Run it whenever you add a module, add an action, or change an `args` / `resolves` / `errors`
block. `prepare_modules_check_test.rb` also asserts currency, so a stale manifest reds the build
even if you forget the direct gate.
