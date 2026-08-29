// The Foundation Core components, MOUNTED.
//
// A markup component is JSE plus markup, which means nothing type-checks its head and no
// corpus pins its shape: a `Number.isFinite` that is not a JSE global, a `.pop()` that does not
// mutate, a `<list>` inside a `<flow>` that never wraps - each of those is silent at lint and
// obvious the moment the thing is on screen. So this mounts every Core component that takes
// data, drives it with a realistic payload, and asserts what the component EXISTS to do.
//
// A page error anywhere fails the run, which is the point: a JSE throw in a computed variable
// surfaces here and nowhere earlier.
//
//   DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/components-browser.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
// The Foundation set, plus any MODULE component directory a probe reaches into. A module's
// components are ordinary .dsx and mount exactly the same way; the harness only ever read
// Foundation's because nothing had probed a module's surfaces before Article 10 sent this
// looking at the Studio editor.
const COMPONENT_DIRS = [
  join(ROOT, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core"),
  join(ROOT, "ClosedSource/DSX/Modules/Core/StudioEditor/Components"),
];

const sources: Record<string, string> = {};
// The SIDECAR sheets too (Foo.css beside Foo.dsx), scoped to their owner exactly as
// packages/compiler/src/registry.ts does when it builds a real app. Without them the harness
// mounts every component unstyled, which is fine for a count assertion and useless for
// anything about motion or geometry - and a `@keyframes` component would pass while standing
// perfectly still.
const sidecars: Record<string, string> = {};
for (const CORE of COMPONENT_DIRS) for (const file of readdirSync(CORE)) {
  if (!file.endsWith(".dsx")) continue;
  const name = basename(file, ".dsx");
  sources[name] = readFileSync(join(CORE, file), "utf8");
  const sheet = join(CORE, `${name}.css`);
  if (existsSync(sheet)) sidecars[name] = readFileSync(sheet, "utf8");
}

/** Each case: the markup to mount, and what must be true of the result. */
interface Probe {
  name: string;
  markup: string;
  /** Selectors that must exist, with the exact count expected. */
  counts: Record<string, number>;
  /** Substrings that must appear in the mounted text content. */
  text?: string[];
  /**
   * Boxes that must all be the SAME height and must sit at `ratio` (width / height). This is
   * how a "reserves its space" claim is tested rather than asserted: mount the component in
   * two states and prove the geometry did not move between them.
   */
  reserved?: { selector: string; ratio: number };
  /** These items must occupy MORE THAN ONE LINE: otherwise it is a wrap that does not wrap. */
  wraps?: string;
  /**
   * The matched elements must be MOVING: sampled twice a few frames apart, their computed
   * transform (or opacity) must differ. A `@keyframes` component that lints clean, mounts
   * clean, and sits perfectly still is the exact failure runtime-pressure R28 was about, and
   * a count assertion cannot see it. `staggered` additionally requires that the matched
   * elements DISAGREE with each other at one instant - which is what a stagger is.
   */
  animates?: { selector: string; staggered?: boolean };
  /**
   * `flat` must be a set of equal-height boxes and `shaped` must NOT be: the pair proves a
   * meter responds to its input rather than drawing the same thing whatever it is handed.
   */
  varies?: { flat: string; shaped: string };
  /**
   * Focus a control and send real key chords to it, then assert what the page now says. This
   * is the only way to test a KEY GRAMMAR honestly: the fold has a corpus, but whether the
   * renderer actually wired Return to it - and whether it consumed the ones it should not -
   * only shows up when a browser delivers the event.
   */
  keys?: { focus: string; press: string[]; then: string[]; notThen?: string[] };
  /**
   * Scroll a named scroller to the bottom and prove two elements OUTSIDE it changed opacity in
   * opposite directions. This is the only honest test of the named scroll plane (R27): a probe
   * that only counts elements cannot tell a fade that tracks the scroll from a fade that is
   * painted once and never moves, and the whole point of the plane is that the elements reading
   * it are not descendants of the thing they are reading.
   */
  scrolls?: { scroller: string; start: string; end: string };
  /**
   * Assert a COMPUTED style value. This is how "the attribute reaches the pixels" is tested
   * rather than assumed: a mount probe proves an element exists, and an element can exist while
   * every type attribute on it is inert — which is exactly what `fontSize=` did on this renderer
   * until Article 10 went looking (it did not even reach the DOM). Values are compared as the
   * browser reports them.
   */
  computed?: Array<{
    selector: string;
    property: string;
    value: string;
    /** Read this one under a changed ROOT font size, then restore it. Browser text scaling is
     *  what moves the root, so this is the only way to prove a Dynamic Type polyfill actually
     *  scales: at the default root the opted-in size equals the fixed one, and an inert
     *  implementation passes that assertion too. */
    rootFontSize?: string;
  }>;
}

const PROBES: Probe[] = [
  {
    name: "Tree",
    markup: `<Tree class="probe" expanded="src" bind='[
      {"id":"src","label":"src","icon":"folder","children":[
        {"id":"app","label":"App.dsx"},{"id":"main","label":"main.dsx"}]},
      {"id":"readme","label":"README.md"}]'/>`,
    // src + its two children + README: a collapsed branch would give 2, a recursive walk 4.
    counts: { ".dsx-tree-row": 4 },
    text: ["src", "App.dsx", "README.md"],
  },
  {
    name: "Post",
    markup: `<Post class="probe" name="Ada Lovelace" handle="@ada" text="**Analytical** engine notes."
                   likes="1240" comments="18" timeText="4h"/>`,
    counts: { ".dsx-post": 1, ".dsx-post-actions": 1 },
    // 1240 formatted, initials derived from the name, markdown rendered as real emphasis.
    text: ["1.2K", "AL", "4h"],
  },
  {
    name: "Attachment",
    markup: `<Attachment class="probe" name="contract.pdf" size="438000"/>`,
    counts: { ".dsx-attachment": 1 },
    text: ["contract.pdf", "428 KB"],
  },
  {
    name: "SectionRail",
    markup: `<SectionRail class="probe" letters="A,B,C,D" active="C"/>`,
    counts: { ".dsx-section-rail-letter": 4 },
    text: ["A", "D"],
  },
  {
    name: "SelectionBar",
    markup: `<SelectionBar class="probe" selected='["a","b","c"]' total="9"/>`,
    counts: { ".dsx-selection-bar": 1 },
    text: ["3 selected", "Select all", "Done"],
  },
  {
    name: "ButtonGroup",
    markup: `<ButtonGroup class="probe" items='[{"id":"copy","label":"Copy"},
      {"id":"share","label":"Share"},{"id":"more","label":"More"}]'/>`,
    // three members, two hairlines: the first member must not draw a leading rule.
    counts: { ".dsx-button-group-item": 3, ".dsx-button-group-rule": 2 },
    text: ["Copy", "More"],
  },
  {
    name: "ToggleButton",
    markup: `<ToggleButton class="probe" label="Bold" icon="bold" pressed="true"/>`,
    counts: { ".dsx-toggle-button": 1 },
    text: ["Bold"],
  },
  {
    name: "InputGroup",
    markup: `<InputGroup class="probe" prefix="https://" suffix=".com">
      <textfield placeholder="example"/>
    </InputGroup>`,
    counts: { ".dsx-input-group": 1, ".dsx-input-group input": 1 },
    text: ["https://", ".com"],
  },
  {
    name: "ColorPicker",
    markup: `<ColorPicker class="probe" value="#34C759"/>`,
    counts: { ".dsx-color-picker-swatch": 10, ".dsx-color-picker-channels": 1 },
    text: ["#34C759"],
  },
  {
    name: "Questionnaire",
    markup: `<Questionnaire class="probe" questions='[
      {"id":"role","prompt":"What do you build?","type":"choice","options":["Apps","Games"]},
      {"id":"why","prompt":"Why?","type":"long"}]'/>`,
    // one question on screen, both of its options, and the count spoken rather than drawn.
    counts: { ".dsx-questionnaire-option": 2, ".dsx-questionnaire-nav": 1 },
    text: ["What do you build?", "Question 1 of 2", "Next"],
  },
  {
    name: "MarkdownEditor",
    markup: `<MarkdownEditor class="probe" value="# Title" max="200"/>`,
    counts: { ".dsx-markdown-editor": 1, ".dsx-markdown-editor textarea": 1 },
    text: ["7 / 200"],
  },
  {
    name: "Diagram",
    markup: `<Diagram class="probe" nodes='[{"id":"a","label":"Build"},{"id":"b","label":"Test"},
      {"id":"c","label":"Ship"}]' edges='[{"from":"a","to":"b"},{"from":"b","to":"c"}]'/>`,
    counts: { ".dsx-diagram-node": 3, ".dsx-diagram-edges": 1 },
    text: ["Build", "Ship"],
  },
  {
    name: "ScrollText",
    markup: `<scroll><ScrollText class="probe" text="One two three four five"/></scroll>`,
    counts: { ".dsx-scroll-text": 1 },
    text: ["three"],
  },
  {
    name: "Answer",
    markup: `<Answer class="probe" text="Because the kernel is dynamic." streaming="true"/>`,
    counts: { ".dsx-answer": 1, ".dsx-thinking-orb": 1 },
    text: ["Because the kernel is dynamic."],
  },
  {
    // The component's whole reason to exist: the frame takes the ratio UP FRONT, so a still
    // generating box and a landed one occupy exactly the same space. Both states are mounted
    // together and measured - if arrival reflowed, the two heights would differ.
    name: "ImageGeneration",
    markup: `<ImageGeneration class="probe generating" ratio="16:9" prompt="a fox in the snow"
                              progress="0.4" label="Generating"/>
             <ImageGeneration class="probe landed" ratio="16:9" prompt="a fox in the snow"
                              src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="/>`,
    counts: {
      ".dsx-image-generation": 2,
      ".dsx-image-generation-working": 1,   // only the generating one shows the working state
      ".landed img": 1,
    },
    text: ["Generating", "a fox in the snow"],
    reserved: { selector: ".dsx-image-generation", ratio: 16 / 9 },
  },
  {
    // The composer, in its two modes. `busy` must flip the SAME button rather than adding a
    // second one, so the probe asserts exactly one primary control in each state.
    name: "PromptInput",
    markup: `<PromptInput class="probe idle" value="hello" models="fast,smart" model="fast" max="120"
                          attachments='[{"id":"a","name":"spec.pdf","size":438000}]'/>
             <PromptInput class="probe busy" value="hello" busy="true"/>`,
    counts: {
      ".dsx-prompt-input": 2,
      ".dsx-prompt-input textarea": 2,
      ".dsx-prompt-input-tray": 1,
      "[aria-label='Send']": 1,
      "[aria-label='Stop generating']": 1,
    },
    text: ["spec.pdf", "5 / 120"],
  },
  {
    // The composer's DEFAULT state: the field, the bar, and no recording chrome.
    name: "PromptInput",
    markup: `<PromptInput class="probe" voice="true" models="fast,deep" model="fast"
                          attachments='[{"id":"a","name":"brief.pdf","size":24000}]'/>`,
    counts: {
      ".dsx-prompt-input": 1, ".dsx-prompt-input-bar": 1, ".dsx-textarea": 1,
      ".dsx-prompt-input-recording": 0, ".dsx-attachment": 1,
    },
    text: ["brief.pdf"],
  },
  {
    // RECORDING is a different bar. The field and the ordinary controls are gone - with a live
    // microphone, leaving send and attach on screen invites both to be pressed by accident -
    // and the meter, the elapsed count and the two decisions are what is left.
    name: "PromptInput-recording",
    markup: `<PromptInput class="probe" voice="true" recording="true" level="0.6"
                          elapsed="75" transcript="tell me about the registry"/>`,
    counts: {
      ".dsx-prompt-input-recording": 1, ".dsx-prompt-input-bar": 0, ".dsx-textarea": 0,
      ".dsx-audio-level-bar": 9, ".dsx-prompt-input-heard": 1,
    },
    // 75s is 1:15 - the m:ss fold, not a raw seconds count.
    text: ["1:15", "tell me about the registry"],
  },
  {
    // The meter is the honest part of a voice UI, so it has to actually respond: at level 0
    // every bar sits on the floor, and the bars must not all be the same height at level 1
    // (a flat row is a progress bar standing on end, not a voice).
    name: "AudioLevel",
    markup: `<vstack>
      <AudioLevel class="probe-quiet" level="0" bars="5"/>
      <AudioLevel class="probe-loud" level="1" bars="5"/>
    </vstack>`,
    counts: { ".probe-quiet .dsx-audio-level-bar": 5, ".probe-loud .dsx-audio-level-bar": 5 },
    varies: { flat: ".probe-quiet .dsx-audio-level-bar", shaped: ".probe-loud .dsx-audio-level-bar" },
  },
  {
    name: "ToolCall",
    markup: `<ToolCall class="probe" name="search_docs" status="done" duration="340"
                       open="true" args='{"q":"canvas"}' result='{"hits":3}'/>`,
    counts: { ".dsx-tool-call": 1, ".dsx-tool-call-body": 1 },
    text: ["search_docs", "340 ms", "Arguments", "Result"],
  },
  {
    name: "Actions",
    markup: `<Actions class="probe" share="true" voted="up"/>`,
    counts: { ".dsx-actions": 1, ".dsx-actions .dsx-toggle-button": 2 },
  },
  {
    name: "Citation",
    markup: `<Citation class="probe" n="1" title="The constitution" url="https://despia.com/spec"/>`,
    counts: { ".dsx-citation": 1, "[aria-label='Reference 1, The constitution, despia.com']": 1 },
    text: ["1"],
  },
  {
    name: "ContextMeter",
    markup: `<ContextMeter class="probe" used="184320" max="200000" cost="0.043"/>`,
    counts: { ".dsx-context-meter": 1 },
    text: ["184.3k", "200k", "$0.04"],
  },
  {
    name: "Artifact",
    markup: `<Artifact class="probe" title="quicksort.ts" kind="code" version="2" download="true">
      <CodeBlock value="const a = 1" language="ts"/>
    </Artifact>`,
    counts: { ".dsx-artifact": 1, ".dsx-artifact-body": 1 },
    text: ["quicksort.ts", "v2"],
  },
  {
    name: "VoiceInput",
    markup: `<VoiceInput class="probe" listening="true" level="0.6" transcript="open the door"/>`,
    counts: { ".dsx-voice-input": 1, "[aria-label='Stop dictating']": 1 },
    text: ["open the door"],
  },
  {
    // `<flow bind>` - the repeater the wrap layout never had (runtime-pressure R29). The probe
    // asserts BOTH halves: the rows exist, and the box actually WRAPS, which is the whole
    // reason the element is not a horizontal list. Six 90px chips in a 360px box must occupy
    // more than one line; a non-wrapping flex would keep them on one and overflow.
    name: "flow-bind",
    // The rows ride a literal array expression rather than a `<variable>`, because a `<head>`
    // is only a head at the component ROOT and this markup mounts one level in.
    markup: `<flow class="probe-flow" key="id" spacing="8" lineSpacing="8"
                   bind="[{'id':'a','label':'alpha'},{'id':'b','label':'bravo'},{'id':'c','label':'charlie'},{'id':'d','label':'delta'},{'id':'e','label':'echo'},{'id':'f','label':'foxtrot'}]">
      <Chip label="{{ dsx.this.label }}" style="width: 90px"/>
    </flow>`,
    counts: { ".probe-flow": 1, ".probe-flow .dsx-chip": 6 },
    text: ["alpha", "foxtrot"],
    wraps: ".probe-flow .dsx-chip",
  },
  {
    // The two components runtime-pressure R28 held back, and the assertion that made them
    // holdable: they must MOVE. Both were drafted on `@keyframes`, which lints clean and used
    // to render a perfectly still element on three of the four renderers.
    name: "Marquee",
    markup: `<Marquee class="probe" duration="4"><text value="BTC 64,210 ETH 3,180"/></Marquee>`,
    // Two copies of the children: one visible, one the seam copy that hides the restart.
    counts: { ".dsx-marquee": 1, ".dsx-marquee-track": 1, ".dsx-marquee-copy": 2 },
    text: ["BTC 64,210"],
    animates: { selector: ".dsx-marquee-track" },
  },
  {
    name: "TextAnimation",
    markup: `<TextAnimation class="probe" duration="4" stagger="1"
                            lines="{{ ['Ship it once.', 'Run it everywhere.', 'Own the code.'] }}"/>`,
    counts: { ".dsx-text-animation-line": 3 },
    text: ["Ship it once.", "Own the code."],
    // Staggered: with a 1s step between lines, no two lines are ever at the same frame.
    animates: { selector: ".dsx-text-animation-line", staggered: true },
  },
  {
    // THE TYPE ATTRIBUTES, on the renderer that had none of them (Article 10). `fontSize`,
    // `fontWeight`, `italic` and `letterSpacing` are style-catalogue attributes that apply to
    // any element and work on both native renderers; here they were not mapped, not forwarded
    // and not even present in the DOM, so a size authored on a phone silently became the
    // theme's default in a browser. A count assertion cannot see that, which is why these are
    // computed-style assertions.
    name: "type-attributes",
    markup: `<vstack class="probe">
      <text class="tyA" value="A" fontSize="17"/>
      <text class="tyB" value="B" fontWeight="bold"/>
      <text class="tyC" value="C" italic="true"/>
      <text class="tyD" value="D" letterSpacing="2"/>
      <text class="tyE" value="E" fontSize="17" dynamicType="true"/>
      <text class="tyF" value="F" fontSize="17" dynamicType="true" dynamicTypeMax="20"/>
    </vstack>`,
    counts: { ".tyA": 1, ".tyB": 1, ".tyC": 1, ".tyD": 1, ".tyE": 1, ".tyF": 1 },
    computed: [
      { selector: ".tyA", property: "font-size", value: "17px" },
      { selector: ".tyB", property: "font-weight", value: "700" },
      { selector: ".tyC", property: "font-style", value: "italic" },
      { selector: ".tyD", property: "letter-spacing", value: "2px" },
      // Dynamic Type, polyfilled onto the root ramp. At the default 16px root the opted-in
      // size computes to the SAME pixel count as the fixed one — that identity is the whole
      // safety argument for the polyfill, and a reader who never touched the setting sees
      // nothing move. The cap holds under it.
      { selector: ".tyE", property: "font-size", value: "17px" },
      { selector: ".tyF", property: "font-size", value: "17px" },
      // The reader who DID turn text size up. A 24px root is 1.5x, so 17 becomes 25.5 - and
      // the capped twin stops at its 20px ceiling exactly as `dynamicTypeMax` does on iOS.
      // The un-opted-in size must NOT move: that is what makes this an opt-in rather than a
      // global rescale, and it is the half a browser gives away for free if nobody checks.
      { selector: ".tyE", property: "font-size", value: "25.5px", rootFontSize: "24px" },
      { selector: ".tyF", property: "font-size", value: "20px", rootFontSize: "24px" },
      { selector: ".tyA", property: "font-size", value: "17px", rootFontSize: "24px" },
    ],
  },
  {
    // The two Studio surfaces that were native-only code on two renderers and rendered on
    // NEITHER of the other two. Both carried the comment "drawn natively because markup
    // primitives can't paint a metered gradient"; both are now DSX over primitives, and this
    // probe is the browser saying so. The gradient assertions matter most: a squeezed ramp and
    // a clipped one both "have a gradient", so the STOPS are what separate them.
    name: "LevelMeter",
    markup: `<vstack class="probe">
      <LevelMeter class="lmA" level="0.25"/>
      <LevelMeter class="lmB" level="1"/>
      <LevelMeter class="lmC" level="0"/>
    </vstack>`,
    counts: {
      ".dsx-level-meter": 3, ".dsx-level-meter-track": 3,
      // level 0 renders NO fill: an unlit meter is a rail, not a zero-width gradient.
      ".dsx-level-meter-fill": 2,
    },
    computed: [
      // The ramp restricted to a quarter and renormalised: green to the ramp's colour AT 0.25,
      // which is half way to yellow. A squeezed ramp would still be reaching red here - the
      // COLOURS are what separate the clip from the squeeze. The renormalised stops land on
      // even spacing, and the bridge folds even stops away by law (cssmap: at the default
      // spacing the position is what the browser computes anyway, and this string is inside
      // the widget byte law), so the expected serialisation carries no positions.
      { selector: ".lmA .dsx-level-meter-fill", property: "background-image",
        value: "linear-gradient(90deg, rgb(48, 209, 88), rgb(152, 212, 49))" },
      // At full level the whole ramp is visible, three colours, red at the tip.
      { selector: ".lmB .dsx-level-meter-fill", property: "background-image",
        value: "linear-gradient(90deg, rgb(48, 209, 88), rgb(255, 214, 10), rgb(255, 69, 58))" },
      { selector: ".lmA .dsx-level-meter-fill", property: "flex-grow", value: "0.25" },
      { selector: ".lmB .dsx-level-meter-fill", property: "flex-grow", value: "1" },
    ],
  },
  {
    name: "Waveform",
    markup: `<vstack class="probe">
      <Waveform class="wfA" peaks="0.3,0.81,0.44"/>
      <Waveform class="wfB" seed="7"/>
      <Waveform class="wfC" peaks="1" muted="true"/>
    </vstack>`,
    // three real peaks, the 48-bar seed placeholder, one peak = 52 bars over three lanes
    counts: { ".dsx-waveform": 3, ".dsx-waveform-lane": 3, ".dsx-waveform-bar": 52 },
    computed: [
      // 48pt lane x 0.8 x peak, in POINTS - a percentage height would be inert on both
      // native bridges, which is the whole reason these are computed.
      // The browser reports its own sub-pixel rounding of 48 x 0.8 x peak; the authored values
      // are 11.52 and 38.4 and these are what a real layout pass makes of them.
      { selector: ".wfA .dsx-waveform-bar", property: "height", value: "11.5156px" },
      { selector: ".wfC .dsx-waveform-bar", property: "height", value: "38.3906px" },
    ],
  },
  {
    // R27, and the assertion that made it holdable. The bars are SIBLINGS of the scroller, not
    // descendants, so nothing in the cascade can reach them: the only way these opacities move
    // is the named plane the scroller publishes at document root. Both directions are checked,
    // because a bar that is simply always on passes any single-state probe.
    name: "ScrollFade",
    markup: `<zstack class="probe" style="height: 200px">
      <scroll ref="probeFeed" style="height: 200px">
        <vstack style="gap: 12px">
          <text value="row one"/><text value="row two"/><text value="row three"/>
          <text value="row four"/><text value="row five"/><text value="row six"/>
          <text value="row seven"/><text value="row eight"/><text value="row nine"/>
          <text value="row ten"/><text value="row eleven"/><text value="row twelve"/>
          <text value="row thirteen"/><text value="row fourteen"/><text value="row fifteen"/>
        </vstack>
      </scroll>
      <ScrollFade source="probeFeed" range="8"/>
    </zstack>`,
    counts: { ".dsx-scroll-fade": 1 },
    text: ["row one", "row fifteen"],
    scrolls: {
      scroller: '[data-dsx-scroll-axis="vertical"]',
      start: ".dsx-scroll-fade-lead",
      end: ".dsx-scroll-fade-trail",
    },
  },
  {
    // The multiline submit grammar, through a real browser's real key events. The fold has a
    // corpus; what a corpus cannot show is whether the renderer wired Return to it at all, or
    // whether it swallowed a chord it had no business consuming.
    name: "textarea-submit",
    markup: `<vstack>
      <textarea class="probe-area" bind="dsx.variable.draft" submitOnEnter="true"
                on:submit="dsx.variable.log = (dsx.variable.log || '') + '[sent]'"/>
      <text value="log={{ dsx.variable.log }}"/>
    </vstack>`,
    counts: { ".probe-area": 1 },
    keys: {
      focus: ".probe-area",
      // Shift+Enter must NOT send (it is the line-break chord), and plain Enter must.
      press: ["Shift+Enter", "Enter"],
      then: ["log=[sent]"],
      // Exactly one send: a second [sent] would mean Shift+Enter submitted too.
      notThen: ["[sent][sent]"],
    },
  },
  {
    // Without `submitOnEnter`, bare Return is a line break and only the chord sends. This is
    // the half that is easy to get wrong by wiring Return unconditionally.
    name: "textarea-submit-chord-only",
    markup: `<vstack>
      <textarea class="probe-chord" bind="dsx.variable.draft2"
                on:submit="dsx.variable.log2 = (dsx.variable.log2 || '') + '[sent]'"/>
      <text value="log2={{ dsx.variable.log2 }}"/>
    </vstack>`,
    counts: { ".probe-chord": 1 },
    keys: {
      focus: ".probe-chord",
      press: ["Enter", "Enter", "Control+Enter"],
      then: ["log2=[sent]"],
      notThen: ["[sent][sent]"],
    },
  },
  {
    name: "Sources",
    markup: `<Sources class="probe" items='[{"title":"Spec","url":"https://despia.com/spec"},
      {"title":"Docs","url":"https://despia.com/docs"}]'/>`,
    counts: { ".dsx-source-chip": 2 },
    text: ["despia.com"],
  },
];

const harness = (markup: string): string =>
  `<vstack class="probe-root">\n${markup}\n</vstack>`;

const source = String.raw`
  import { compileComponent } from "./packages/compiler/src/component.ts";
  import { CssCollector, extractComponentCss, scopeSheet } from "./packages/compiler/src/css.ts";
  import { LAYER_STATEMENT } from "./packages/compiler/src/cssmap.ts";
  import { instantiate } from "./packages/dom/src/mount.ts";
  import { registerGlobalElements, registerRichElements } from "./packages/dom/src/elements.ts";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./packages/dom/src/globals.ts";
  import { registerCanvasSurface } from "./packages/dom/src/canvas.ts";
  import { registerDataControls } from "./packages/dom/src/data-controls.ts";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "./packages/dom/src/theme.ts";
  // The STRUCTURAL sheet, which bootDsx loads and this harness did not. It carries the rules a
  // real app relies on - among them the one that makes a horizontal list lay out as a ROW - so
  // every horizontal list in every probe was laying out as a COLUMN here. A count assertion
  // cannot see that, and it is exactly the class of harness gap that turns a real finding into a
  // false one: the renderer was right and the harness was lying.
  import { STRUCTURAL_CONTROLS_CSS } from "./packages/dom/src/structural-controls.ts";

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  registerDataControls();
  registerCanvasSurface();

  const SOURCES = ${JSON.stringify(sources)};
  const SIDECARS = ${JSON.stringify(sidecars)};
  const components = {};
  const globalPool = {};
  const collector = new CssCollector();
  for (const [name, text] of Object.entries(SOURCES)) {
    const ir = compileComponent(name, "shared", text);
    components["shared." + name] = ir;
    globalPool[name] = "shared." + name;
    extractComponentCss(ir, collector);
  }
  const SIDECAR_CSS = Object.entries(SIDECARS)
    .map(([name, sheet]) => scopeSheet(sheet, name)).join("\n");

  window.__DSX_PROBE__ = (markup) => {
    const ir = compileComponent("Probe", "test", markup);
    const local = new CssCollector();
    extractComponentCss(ir, local);
    const registry = {
      components: { ...components, "test.Probe": ir },
      globalPool, css: collector.emit() + "\n" + local.emit(), schemes: [],
    };
    document.getElementById("probe-style").textContent = [
      LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
      RICH_ELEMENTS_CSS, STRUCTURAL_CONTROLS_CSS, GLOBAL_ELEMENTS_CSS, SIDECAR_CSS, registry.css,
      "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .probe-root { width:360px } }",
    ].join("\n");
    const instance = instantiate(ir, registry);
    document.body.replaceChildren(instance.root);
    return true;
  };

  window.__DSX_READ__ = (selectors) => {
    const counts = {};
    for (const selector of selectors) counts[selector] = document.querySelectorAll(selector).length;
    return { counts, text: document.body.textContent ?? "" };
  };

  // Counts the DISTINCT top offsets of the matched items. It must match the items themselves,
  // never their row wrappers: a collection row is display:contents, so its own rect is empty
  // and every wrapper reports the same top whatever the items below it did.
  window.__DSX_LINES__ = (selector) => {
    const tops = new Set();
    for (const node of document.querySelectorAll(selector)) {
      tops.add(Math.round(node.getBoundingClientRect().top));
    }
    return tops.size;
  };

  // The animated properties, read off the COMPUTED style so the browser's own sampler is what
  // answers. Reading the inline style would only echo what the sheet declared.
  window.__DSX_MOTION__ = (selector) =>
    Array.from(document.querySelectorAll(selector)).map((node) => {
      const style = getComputedStyle(node);
      return style.transform + "|" + style.opacity;
    });

  window.__DSX_RECTS__ = (selector) =>
    Array.from(document.querySelectorAll(selector)).map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

  const style = document.createElement("style");
  style.id = "probe-style";
  document.head.appendChild(style);
  window.__DSX_PROBE_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "components-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("the components harness did not bundle");

declare global {
  // eslint-disable-next-line no-var
  var __DSX_PROBE__: (markup: string) => boolean;
  // eslint-disable-next-line no-var
  var __DSX_READ__: (selectors: string[]) => { counts: Record<string, number>; text: string };
  // eslint-disable-next-line no-var
  var __DSX_RECTS__: (selector: string) => Array<{ width: number; height: number }>;
  // eslint-disable-next-line no-var
  var __DSX_LINES__: (selector: string) => number;
  // eslint-disable-next-line no-var
  var __DSX_MOTION__: (selector: string) => string[];
}

const failures: string[] = [];
const engine = browserEngine();
const browser = await launchBrowser(engine);
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_PROBE_READY__?: boolean }).__DSX_PROBE_READY__ === true);

  for (const probe of PROBES) {
    const before = pageErrors.length;
    await page.evaluate((markup) => globalThis.__DSX_PROBE__(markup), harness(probe.markup));
    await page.waitForTimeout(40);
    const seen = await page.evaluate(
      (selectors) => globalThis.__DSX_READ__(selectors),
      Object.keys(probe.counts),
    );
    const wrong = Object.entries(probe.counts)
      .filter(([selector, want]) => seen.counts[selector] !== want)
      .map(([selector, want]) => `${selector}: want ${want}, got ${String(seen.counts[selector])}`);
    const missing = (probe.text ?? []).filter((needle) => !seen.text.includes(needle));
    const moved: string[] = [];
    if (probe.reserved !== undefined) {
      const rects = await page.evaluate(
        (selector) => globalThis.__DSX_RECTS__(selector), probe.reserved.selector,
      );
      const heights = rects.map((r) => Math.round(r.height));
      if (new Set(heights).size !== 1) {
        moved.push(`the reserved boxes disagree on height: ${heights.join(" vs ")} - arrival reflowed`);
      }
      for (const rect of rects) {
        const got = rect.height > 0 ? rect.width / rect.height : 0;
        if (Math.abs(got - probe.reserved.ratio) > 0.02) {
          moved.push(`box is ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} ` +
                     `(${got.toFixed(3)}), wanted ratio ${probe.reserved.ratio.toFixed(3)}`);
        }
      }
    }
    if (probe.animates !== undefined) {
      const read = async (): Promise<string[]> =>
        page.evaluate((sel) => globalThis.__DSX_MOTION__(sel), probe.animates!.selector);
      const first = await read();
      if (first.length === 0) {
        moved.push(`${probe.animates.selector} matched nothing to animate`);
      } else {
        await page.waitForTimeout(180);
        const second = await read();
        if (first.join() === second.join()) {
          moved.push(`${probe.animates.selector} did not move in 180ms - a still marquee is ` +
                     `not a marquee (transform ${first[0]})`);
        }
        if (probe.animates.staggered === true && new Set(second).size < 2) {
          moved.push(`${probe.animates.selector} are all at the same frame - the stagger is ` +
                     `the whole component and animation-delay is what carries it`);
        }
      }
    }
    if (probe.keys !== undefined) {
      await page.focus(probe.keys.focus);
      for (const chord of probe.keys.press) await page.keyboard.press(chord);
      const after = await page.evaluate(() => document.body.textContent ?? "");
      for (const needle of probe.keys.then) {
        if (!after.includes(needle)) {
          moved.push(`after ${probe.keys.press.join(" then ")} the page never said ` +
                     `${JSON.stringify(needle)}`);
        }
      }
      for (const needle of probe.keys.notThen ?? []) {
        if (after.includes(needle)) {
          moved.push(`after ${probe.keys.press.join(" then ")} the page said ` +
                     `${JSON.stringify(needle)}, which it should not have`);
        }
      }
    }
    for (const want of probe.computed ?? []) {
      const got = await page.evaluate((q) => {
        const root = document.documentElement;
        const previous = root.style.fontSize;
        if (q.rootFontSize !== undefined) root.style.fontSize = q.rootFontSize;
        const el = document.querySelector(q.selector);
        const read = el === null ? null : getComputedStyle(el).getPropertyValue(q.property).trim();
        if (q.rootFontSize !== undefined) root.style.fontSize = previous;
        return read;
      }, want);
      if (got === null) moved.push(`${want.selector} matched nothing`);
      else if (got !== want.value) {
        moved.push(`${want.selector} ${want.property} is ${JSON.stringify(got)}, wanted ` +
                   `${JSON.stringify(want.value)} — the attribute did not reach the pixels`);
      }
    }
    if (probe.scrolls !== undefined) {
      const opacity = async (sel: string): Promise<number> =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          return el === null ? -1 : Number(getComputedStyle(el).opacity);
        }, sel);
      const background = async (sel: string): Promise<string> =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          return el === null ? "" : getComputedStyle(el).backgroundImage;
        }, sel);
      // A fade with no gradient is a rectangle whose opacity happens to move: it would pass every
      // assertion below and look nothing like a fade. `gradient=` reaches the browser through the
      // runtime bridge, which maps each stop through the colour vocabulary - and one unmapped word
      // invalidates the whole linear-gradient(), silently.
      for (const sel of [probe.scrolls.start, probe.scrolls.end]) {
        const image = await background(sel);
        if (!image.includes("gradient")) {
          moved.push(`${sel} has no gradient (background-image ${JSON.stringify(image)}) - a bar ` +
                     "that fades to nothing is the component, and a flat rectangle is not it");
        }
      }
      const rest = { start: await opacity(probe.scrolls.start), end: await opacity(probe.scrolls.end) };
      if (rest.start < 0 || rest.end < 0) {
        moved.push("the scrolls probe matched no fade bars");
      } else {
        // At the top: nothing travelled, so the leading bar is off; plenty remains, so the
        // trailing bar is on. A bar stuck at one value in both states is a bar that never read
        // the plane at all, which is exactly what a count assertion would call a pass.
        if (rest.start > 0.05) {
          moved.push(`at the top the leading fade is at ${rest.start} - nothing has been ` +
                     "scrolled past yet, so there is nothing for it to fade");
        }
        if (rest.end < 0.9) {
          moved.push(`at the top the trailing fade is at ${rest.end} - the list continues ` +
                     "below, which is the entire thing the bar exists to say");
        }
        await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement | null;
          if (el !== null) el.scrollTop = el.scrollHeight;
        }, probe.scrolls.scroller);
        await page.waitForTimeout(120);
        const bottom = { start: await opacity(probe.scrolls.start), end: await opacity(probe.scrolls.end) };
        if (bottom.start < 0.9) {
          moved.push(`at the bottom the leading fade is at ${bottom.start} (was ${rest.start}) - ` +
                     "the bars are not tracking a scroller they are not inside");
        }
        if (bottom.end > 0.05) {
          moved.push(`at the bottom the trailing fade is at ${bottom.end} (was ${rest.end}) - ` +
                     "there is nothing left below to fade toward");
        }
      }
    }
    if (probe.varies !== undefined) {
      const heights = async (sel: string): Promise<number[]> =>
        (await page.evaluate((s) => globalThis.__DSX_RECTS__(s), sel))
          .map((r) => Math.round(r.height));
      const flat = await heights(probe.varies.flat);
      const shaped = await heights(probe.varies.shaped);
      if (flat.length === 0 || shaped.length === 0) {
        moved.push("the varies probe matched nothing");
      } else {
        if (new Set(flat).size !== 1) {
          moved.push(`at rest the bars should be level: ${flat.join(",")}`);
        }
        if (new Set(shaped).size < 2) {
          moved.push(`at full input every bar is ${shaped[0]}px - the meter is not shaped by ` +
                     "its input, which makes it a progress bar standing on end");
        }
        if (Math.max(...shaped) <= Math.max(...flat)) {
          moved.push(`full input (${Math.max(...shaped)}px) is no taller than silence ` +
                     `(${Math.max(...flat)}px) - the meter does not respond at all`);
        }
      }
    }
    if (probe.wraps !== undefined) {
      const lines = await page.evaluate((sel) => globalThis.__DSX_LINES__(sel), probe.wraps);
      if (lines < 2) {
        moved.push(`${probe.wraps} laid out on ${lines} line(s) - it did not wrap`);
      }
    }
    const threw = pageErrors.slice(before);
    if (wrong.length === 0 && missing.length === 0 && moved.length === 0 && threw.length === 0) {
      console.log(`  ok    ${probe.name}`);
      continue;
    }
    const why = [...wrong, ...missing.map((t) => `never rendered ${JSON.stringify(t)}`),
                 ...moved, ...threw].join("; ");
    console.log(`  FAIL  ${probe.name} - ${why}`);
    failures.push(`${probe.name}: ${why}`);
  }
} finally {
  await browser.close();
}

console.log(`\ncomponents: ${PROBES.length} probed, ${failures.length} failure(s)`);
if (failures.length > 0) process.exitCode = 1;
