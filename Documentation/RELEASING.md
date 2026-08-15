# Releasing and versioning

The rules every published Despia package follows. They exist so a developer can read a version
number and know what it promises, and so nobody has to reconstruct the process each time.

Scope: everything under `OpenSource/` that ships to npm, Maven Central, SPM, or a public GitHub
mirror. Closed packages and app builds are governed by the release lanes, not by this file.

## 1. Where a version comes from

**One version per package, in one file, and nothing restates it.**

| Package | Source of truth |
|---|---|
| The kernel, all three faces (npm `@despia/*`, Maven `com.despia.dsx`, SPM) | `OpenSource/Engine/VERSION` |
| Despia AI | `OpenSource/AI/VERSION` |
| Despiabase | `OpenSource/Base/VERSION` |
| Despia MCP | `OpenSource/MCP/VERSION` |
| Canvas Editor, vscode-dsx | their own `package.json` |

`ClosedSource/scripts/kernel_package_gate.rb` enforces the kernel row: the Maven build must
*derive* the version from `Engine/VERSION`, never restate it, because a literal in a second place
is the drift the gate exists to catch. A mirror cuts its tag from the file named in its
`mirror.json` `tag_from`, so bumping the file is the whole of "cutting a release".

## 2. The version line

**Every package starts at `0.0.1`.** Nothing here has been published, so nothing here has earned
a higher number. `0.0.x` is the honest signal and it needs no apology: it says the API is not yet
stable and no compatibility is promised between patches.

The ladder, and what each step commits us to:

| Range | Means | Compatibility promise |
|---|---|---|
| `0.0.x` | pre-release. Where we are now. | none between versions |
| `0.1.0` | the shape is settled enough that breaking it deserves a minor bump | breaking changes bump the minor |
| `1.0.0` | the API is a contract | semver in full: breaking changes bump the major |

Do not skip to `1.0.0` to look finished. A `1.0.0` that breaks in `1.1.0` costs more trust than a
`0.0.9` ever could.

**Move to `0.1.0`** when a real external consumer depends on the package and we are willing to
treat a break as a minor bump. **Move to `1.0.0`** when the API has been stable across at least
one full release cycle with outside users and we accept the major-bump discipline for every break
after it.

## 3. Lockstep, and what is independent

The three kernel faces are **one version**, always. They are one codebase compiled three ways, so
a version that means different things per face would be a lie the gate would not catch a second
time.

The standalone packages (AI, Base, MCP) version **independently**: each carries its own `VERSION`
and cuts its own tag, because each is a separate product with a separate audience. A bundle
spanning all three could not name the tag it came from, which is why `stage_bundle.rb` builds one
package per bundle.

## 4. Tags and releases

- Tag format: `v<version>`, e.g. `v0.0.1`. Signed (`git tag -s`), always.
- A tag is the only thing a release artifact may trace to. `release-packages.ts` refuses to build
  from a working tree, and that refusal is a feature.
- **Every tag gets a GitHub Release.** A tag alone is invisible: the Releases page is what a
  developer checks to answer "what changed and is it safe to upgrade". The release body is the
  matching `CHANGELOG.md` section, verbatim.
- Pre-releases (`v0.0.2-rc.1`) are marked **pre-release** on GitHub so tooling and humans both
  skip them by default.

Create the release from the tag once the mirror has pushed it:

```bash
gh release create v0.0.1 \
  --repo despia-native/despia-ai \
  --title "despia-ai 0.0.1" \
  --notes-file <(sed -n '/^## 0.0.1/,/^## /p' OpenSource/AI/CHANGELOG.md | sed '$d')
```

## 5. CHANGELOG

Every published package carries `CHANGELOG.md`, newest first, one section per version:

```markdown
## 0.0.2

### Added
- …

### Changed
- …

### Fixed
- …
```

Write it for someone deciding whether to upgrade, not for someone auditing commits. A line that
does not change a reader's decision does not belong in it. Breaking changes are called
**Breaking** and say what to do instead, not only what was removed.

## 6. House style for published prose

Package-facing text is read by people who have never seen this repo. It follows two rules the
internal architecture documents do not:

1. **No em dashes.** Use a hyphen (` - `) or a comma. `check_package_prose.rb` enforces this on
   every published `README`, `CHANGELOG`, `NOTICE`, `llms.txt`, `docs/**.md`, and `package.json`.
2. **State what is true today.** A package README says what the package does now, with the parts
   that are unfinished named plainly. `OpenSource/MCP/README.md` is the model: it says which half
   is real and which is still landing, in the second paragraph.

## 7. The release checklist

```bash
# 1. the gates that decide whether a release is even legal
ruby ClosedSource/scripts/kernel_package_gate.rb          # one version across every face
ruby ClosedSource/scripts/check_package_prose.rb          # published prose style
ruby ClosedSource/scripts/check_opensource_purity.rb      # licence coverage, permissive vendoring
cd OpenSource/Web && npm test && npm run pack:check       # real tarballs, installed and imported

# 2. bump the one version file, write the CHANGELOG section, commit

# 3. push the mirror (cuts the tag from tag_from)
MIRROR_PUSH_TOKEN=<pat> ruby ClosedSource/scripts/mirror_public.rb <folder>

# 4. create the GitHub Release from that tag, body = the CHANGELOG section

# 5. publish the registry artifacts (npm: release:artifacts -> release:verify -> npm publish;
#    Maven: ClosedSource/release/maven/RUNBOOK.md)
```

Steps 3 to 5 are deliberate acts with operator credentials. Nothing in CI publishes on its own,
and no lane holds a signing key.

## 8. Deprecation

A published version is never unpublished or force-retagged: someone's build depends on it. To
retire something, ship a new version that deprecates it, say so in the CHANGELOG under
**Deprecated** with the replacement named, and remove it no earlier than the next minor bump
(pre-`1.0.0`) or the next major (after `1.0.0`).
