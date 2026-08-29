---
name: thinking-in-dsx
description: "The React and React Native to DSX translation table: props to attributes, hooks to declarations, refs to bound values, navigation libraries to the route table, plus the habits to drop entirely. Use whenever React or React Native fluency is shaping DSX code."
---

<!-- GENERATED from OpenSource/Skills/thinking-in-dsx.md in despia-native/despia.
     Edit the source, then: ruby ClosedSource/scripts/generate_agent_skills.rb -->

# Thinking in DSX when you were trained on React

> Audience: developers and AI agents fluent in React / React Native who are about to write
> DSX app code. Your product instincts transfer whole; your syntax instincts are the main
> source of broken markup. This file is the mapping. Its sibling for porting entire npm
> packages is [`porting-a-react-native-library.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/porting-a-react-native-library.md),
> whose law applies here too: **carry over the design, never the code.**

## 1. The posture

React renders a component tree from function calls and hooks; DSX declares a document.
There is no runtime you write, no render function, no hook rules, no dependency arrays,
no memoization layer. The document IS the program: the head declares the contract, state
and logic; the body declares the pixels; the kernel makes it reactive. When you feel the
urge to "wire something up", stop: in DSX the wiring is what the declaration already
means.

## 2. The translation table

| React / React Native | DSX | Note |
|---|---|---|
| JSX expression braces `{x}` | `{{ x }}` in any attribute | every attribute interpolates |
| props | `<attribute as="x"/>`, read `dsx.attribute.x` | read-only inside the component |
| `children`, compound `Card.Header` | `<slot/>`, `<slot name="header"/>` | slot content binds in the caller's scope |
| `useState` | `<variable as="x">return 0</variable>` | store-backed, inspectable |
| `useMemo` / derived render values | `<variable computed="true">` | recomputed per read, never stale |
| a function taking row fields | `<formula as="f" a="item.x">` | the per-row derivation |
| `onPress={fn}` | `on:tap="dsx.action.fn()"` | inline handlers hold ONE call or assignment |
| `useEffect(fn, [dep])` | `<watch value="dep" on:change="..."/>` | side effects only; derived values are computed |
| `useEffect(fn, [])` | `on:appear` on the element | teardown is `on:disappear` |
| conditional render `{cond && <X/>}` | `visible-if="cond"` | plus `transition=` for free animation |
| `list.map(row => <Row/>)` | `<list bind="dsx.variable.list" key="id">` + row template | row scope is `item` |
| `FlatList` / `SectionList` | `<list>` / `<grid>` | virtualization is the element's job |
| `StyleSheet.create` / `className` | style attributes, `<style as="card"/>` + `class="card"` | tokens over hex, see below |
| context provider + `useTheme()` | `dsx.global.*`, semantic color tokens | no provider tree exists |
| React Navigation | the route table + `href` + `dsx.module.route.*` | navigation is state, not a library |
| `navigation.navigate('X', params)` | `dsx.component.push('X', { attrs: { ... } })` | `attrs` seeds declared attributes |
| modal libraries | `dsx.component.present('X', { as: 'sheet' })`, `<sheet>`, `<alert>` | detents included |
| `ref` + `ref.current.clear()` | **a bound value** | see section 3, the important one |
| `Animated` / Reanimated | `enter=` / `transition=` / `anim=` + keyframes | the motion kernel, one duration ramp |
| PanResponder / gesture-handler | universal `on:drag*`, `on:pinch`, `on:longpress` | [`custom-ux.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/custom-ux.md) |
| `SafeAreaView` | `<scaffold>` | |
| `Platform.OS === 'ios'` | attribute suffixes `label:ios=`, or `visible-if="os == 'ios'"` | losing suffixes are dropped at compile |
| `accessibilityLabel` | `a11yLabel` or `aria-label` | both spellings, all renderers |
| toast/haptic/storage hooks | `dsx.module.toast.*`, `dsx.module.haptic.*`, module calls | a capability is a module, not a hook |
| `fetch` in the component | a declared `<api>` block, or a `<server>` route | data declares itself; logic stays off the wire |

## 3. The imperative-handle rule

React hands you methods on a ref because it has no other channel. DSX has one: the value.
Before inventing an action, ask what state the method changes, and let the author write
that state.

```xml
<Signature bind="sig" placeholder="Sign here"/>
<button label="Clear" on:tap="sig = []" disabled-if="sig.length == 0"/>
<button label="Undo" on:tap="sig = sig.slice(0, sig.length - 1)"/>
```

Two methods became zero API, and what remains can be persisted, diffed, seeded in a test
or sent to a server. A method survives this test only when it changes something that is
not state (start the camera, present a sheet), and then it is a module action on the bus.

## 4. Habits to drop entirely

- **No `import`.** Elements exist; components resolve by file name; capabilities are
  module calls. Nothing is imported into a `.dsx` file, ever.
- **No state management library.** The store is the kernel's. `dsx.variable` is surface
  state, `dsx.global` is app state, and both are reactive everywhere they are read.
- **No effect choreography.** The dependency-array bug class does not exist: computed
  values cannot go stale and watches fire on real changes.
- **No per-platform component forks.** One markup runs on iOS, Android, web and desktop.
  Divergence is an attribute suffix or a `visible-if`, not a second file.
- **No pixel-pushing custom controls for things that are elements.** `<toggle>`,
  `<picker>`, `<datepicker>`, `<segmented>` are the platform's own controls. Rebuilding
  one out of stacks loses accessibility, dark mode and future OS updates in one move.

## 5. Habits to keep

- Component decomposition, props-down-events-up, controlled inputs: DSX's component
  grammar is deliberately the same shape (`<attribute>` in, `dsx.event` out).
- Designing the value shape first. The wire shape of a bound value is the real API.
- Empty, loading and error states as first-class UI. The bar is
  [`designing-an-app.md`](../designing-dsx-apps/SKILL.md); it applies verbatim.
- The verification loop. Where you would have reloaded the simulator, run
  `despia dev`, open the page, and look at it. Lint (`despia lint --strict`) replaces
  the type-checker reflex after every edit.
