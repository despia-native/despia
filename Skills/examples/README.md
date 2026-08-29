# Trails: the worked example app

The complete app behind [`writing-an-app.md`](../writing-an-app.md) and
[`designing-an-app.md`](../designing-an-app.md): a feed with all four screen states, a
detail screen (including the deep-link absent state), grouped settings with a confirmed
destructive action, value-first onboarding, and a dismissable paywall. Elements and
semantic tokens only; no library components, so it runs in a bare toolchain.

This is a real project, not prose: `despia lint --strict` and `despia review --strict`
pass with zero findings, `despia build` compiles it, and CI gates all three
(`packages/cli/test/skills-examples.test.ts` + the review suite's dogfood test, plus every
icon name against the icon corpus), so these examples cannot rot.

```sh
cd OpenSource/Skills/examples
node ../../Web/packages/cli/bin/dsx.ts lint --project . --strict
node ../../Web/packages/cli/bin/dsx.ts review --project . --strict
node ../../Web/packages/cli/bin/dsx.ts dev --project .    # open it and look
```

What each file demonstrates:

| File | Teaches |
|---|---|
| `Components/App.dsx` | grouped-list structure, the four states, a state walker, `href` + action navigation |
| `Components/TrailRow.dsx` | a presentational component: one dict attribute, `a11yGroup`, ink hierarchy |
| `Components/Detail.dsx` | global-state handoff, the absent state, one accent job |
| `Components/Settings.dsx` | the settings grammar: sections, toggles, destructive action + `confirmDialog` |
| `Components/Onboarding.dsx` | step-driven flow, value before any ask, skippable |
| `Components/Paywall.dsx` + `PlanCard.dsx` | selection as a consumer-owned value, events up, price stated plainly |
