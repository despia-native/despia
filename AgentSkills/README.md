# Despia DSX agent skills

The app-authoring skills for [Despia DSX](https://despia.com), packaged for any agent
host that installs skills:

```sh
npx skills add despia-native/skills
```

Three skills, one loop: `writing-dsx-apps` (the language, so agents stop guessing DSX
from React), `designing-dsx-apps` (the design bar, so generated apps stop looking
generated), `thinking-in-dsx` (the React Native translation table). Each tells the
agent to verify with the real toolchain: `despia lint --strict`, `despia review
--strict`, `despia build`, and `despia dev` with eyes on the screen.

## Where these come from

This repository is a generated standalone mirror; the tree is replaced on every sync.
The sources live in the monorepo and are gated there (linted examples, a browser-driven
worked app, a design lint that dogfoods them):

| Skill | Source |
|---|---|
| `writing-dsx-apps` | `OpenSource/Skills/writing-an-app.md` |
| `designing-dsx-apps` | `OpenSource/Skills/designing-an-app.md` |
| `thinking-in-dsx` | `OpenSource/Skills/thinking-in-dsx.md` |

The full framework, the documentation, and the single issue tracker live at
[despia-native/despia](https://github.com/despia-native/despia). Maintained by the
Despia team; Apache-2.0.
