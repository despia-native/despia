//
//  templates.ts — the scaffolded project, as data. Every template is a plain
//  {relativePath: contents} map produced from the answers, so `scaffold()` is a pure
//  function and the tests assert on the exact bytes a user gets.
//
//  A scaffolded project IS a DSX package: dsx.json (identity + scheme) + Components/**.dsx,
//  the same shape buildRegistry consumes for a module inside the monorepo. dsx.config.json
//  adds only what a standalone app needs — the entry component and the output directory.
//

export const TEMPLATES = ["minimal", "routed"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export type TemplateOptions = {
  /** directory name / package name (npm-safe) */
  name: string;
  /** the DSX package scheme — namespaces every component in this project */
  scheme: string;
  template: TemplateName;
  /** the workspace version the generated package.json depends on */
  version: string;
  /** file: specifiers for @despia-native/* instead of registry versions (in-repo development) */
  link?: { [pkg: string]: string };
};

export function renderTemplate(opts: TemplateOptions): { [relativePath: string]: string } {
  const files: { [relativePath: string]: string } = {
    "package.json": packageJson(opts),
    "dsx.json": dsxJson(opts),
    "dsx.config.json": dsxConfig(opts),
    ".gitignore": "node_modules/\ndist/\n",
    "README.md": readme(opts),
    "AGENTS.md": AGENTS_MD,
    "CLAUDE.md": "@AGENTS.md\n",
    "Components/App.dsx": APP_DSX,
  };
  if (opts.template === "routed") {
    files["Components/About.dsx"] = ABOUT_DSX;
  }
  return files;
}

function dependency(opts: TemplateOptions, pkg: string): string {
  return opts.link?.[pkg] ?? opts.version;
}

function packageJson(opts: TemplateOptions): string {
  return `${JSON.stringify({
    name: opts.name,
    private: true,
    version: "0.1.0",
    type: "module",
    engines: { node: ">=22.18" },
    scripts: {
      build: "despia build",
      dev: "despia dev",
      lint: "despia lint --strict",
      review: "despia review --strict",
    },
    dependencies: {
      "@despia-native/compiler": dependency(opts, "@despia-native/compiler"),
      "@despia-native/dom": dependency(opts, "@despia-native/dom"),
      "@despia-native/kernel": dependency(opts, "@despia-native/kernel"),
      "@despia-native/server": dependency(opts, "@despia-native/server"),
    },
    devDependencies: {
      "@despia-native/cli": dependency(opts, "@despia-native/cli"),
    },
  }, null, 2)}\n`;
}

function dsxJson(opts: TemplateOptions): string {
  return `${JSON.stringify({
    name: opts.name,
    scheme: opts.scheme,
    version: "0.1.0",
    platforms: ["phone", "desktop"],
  }, null, 2)}\n`;
}

function dsxConfig(opts: TemplateOptions): string {
  const config: { [key: string]: unknown } = {
    name: opts.name,
    entry: "App",
    outDir: "dist",
  };
  if (opts.template === "routed") {
    config["routes"] = [
      { path: "/", component: `${opts.scheme}.App`, meta: { title: opts.name } },
      { path: "/about", component: `${opts.scheme}.About`, meta: { title: `About ${opts.name}` } },
    ];
    config["router"] = { transition: "dsx" };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

// The entry screen. Deliberately small AND real: an attribute (the component's inbound
// contract), a variable (own state), an action (named logic in the head), and a body that
// is pure markup — the document anatomy every DSX file follows (dsx-anatomy.md).
const APP_DSX = `<stack style="gap: 1rem; padding: 2rem">
  <head>
    <!-- an attribute default is a JSE EXPRESSION, so a string literal keeps its quotes -->
    <attribute as="title" default="'Hello, DSX'"/>
    <variable as="count">return 0</variable>
    <action as="bump">
      dsx.variable.count = dsx.variable.count + 1;
    </action>
  </head>
  <text value="{{ dsx.attribute.title }}" style="font-size: 1.5rem; font-weight: 600"/>
  <text value="Tapped {{ dsx.variable.count }} times"/>
  <button label="Tap me" on:tap="dsx.action.bump()"/>
</stack>
`;

const ABOUT_DSX = `<stack style="gap: 1rem; padding: 2rem">
  <head>
    <variable as="built">return 'compiled by despia build'</variable>
  </head>
  <text value="About" style="font-size: 1.5rem; font-weight: 600"/>
  <text value="{{ dsx.variable.built }}"/>
</stack>
`;

// The agent brief every scaffolded project carries. DSX postdates every model's training
// data, so the essentials ride in-project: the verify loop, the grammar in one screen, and
// the design bar. CLAUDE.md is a one-line import of this file, so Claude Code, Cursor and
// Codex all read the same brief. Kept deliberately stable: knowledge that changes lives in
// the linked references, not here.
const AGENTS_MD = `# Working in this DSX project (agent brief)

DSX is a declarative app language that renders natively on iOS, Android, web and desktop
from one set of \`.dsx\` sources. It is NOT React, React Native, HTML, Vue or Flutter, and
it is newer than your training data: do not guess syntax from adjacent frameworks. When
unsure, check the references at the bottom, and always close the verify loop; never invent
tags or attributes.

## The verify loop (run it, every time)

After every meaningful edit:

\`\`\`sh
npm run lint     # despia lint --strict: markup + logic validation, zero warnings allowed
\`\`\`

Before claiming anything done:

\`\`\`sh
npm run review   # despia review --strict: the design bar (a11y, tap targets, type scale, contrast)
npm run build    # compiles Components/**.dsx to dist/
npm run dev      # serve + watch; open the FRAMED PREVIEW it prints (/__dsx/preview)
                 # and LOOK: phone frame, size presets, light/dark toggle
\`\`\`

\`npx despia doctor\` diagnoses a project that will not build. If you can render the dev
server in a browser and screenshot it, do that and actually look at the result: layout and
hierarchy mistakes are visible, not inferable from source.

## The language in one screen

One \`.dsx\` file is one component; the file basename is the component name.

\`\`\`xml
<stack style="gap: 1rem; padding: 2rem">
  <head>
    <attribute as="title" default="'Hello'"/>  <!-- input; the default is an expression -->
    <variable as="count">return 0</variable>   <!-- own state -->
    <variable as="label" computed="true">'Tapped ' + dsx.variable.count</variable>
    <action as="bump">dsx.variable.count = dsx.variable.count + 1</action>
  </head>
  <text value="{{ dsx.attribute.title }}" style="font-size: 1.5rem; font-weight: 600"/>
  <text value="{{ dsx.variable.label }}" color="secondary"/>
  <button label="Tap me" on:tap="dsx.action.bump()"/>
</stack>
\`\`\`

Rules the linter enforces (violations fail \`npm run lint\`):

- One root element per file. \`<head>\` is the root's first child and the only place
  declarations live, in this order: attribute, expects, event, variable (plain then
  computed), formula, action, script, watch, style, component.
- The body is pure markup. An inline \`on:\` handler holds one call or one assignment;
  anything bigger becomes a named \`<action>\` in the head.
- Derive, do not watch: a value that follows from other state is a
  \`computed="true"\` variable, never a \`<watch>\` that maintains it.
- Props down, events up: \`<attribute>\` in, \`dsx.event('name')\` out, wired as
  \`on:name\` at the call site. Never mutate an attribute.
- Lowercase tags are built-in elements (stack, vstack, hstack, zstack, scroll, list,
  grid, text, image, button, textfield, toggle, spacer, ...). Capitalized tags are
  components: \`Components/Card.dsx\` mounts as \`<Card/>\`. There is no div, span, img
  or a; navigation is the \`href\` attribute on any element, or
  \`dsx.module.route.push({ path })\`.
- Logic is JSE, a JavaScript subset: no classes, no imports, no DOM. State lives in
  \`dsx.variable.*\`; row scope in a list is \`item\`; conditional display is
  \`visible-if="expr"\`.

## The design bar (not optional)

- Colors are semantic tokens first: \`label\`, \`secondary\`, \`tertiary\`,
  \`background\`, \`groupedBackground\`, \`secondaryGroupedBackground\`, \`fill\`,
  \`separator\`, \`accent\`, \`destructive\`. They adapt to light and dark for free.
  Raw hex is for deliberate brand moments only. One accent color, one job.
- Type comes from a scale (12 / 13 / 15 / 17 / 20 / 24 / 34), weight before size for
  emphasis. Body text stays at the default size.
- Spacing in multiples of 4; screen padding 16 or 20; prefer container \`gap\` or
  \`spacing\` over per-child margins.
- Tap targets are at least 44 points. Every icon-only button carries \`a11yLabel\`
  (or \`aria-label\`; both spellings work on every renderer).
- Every list ships its empty, loading and error states, not just the happy path.
- The unstyled baseline IS the platform look. Restyle with intent, never by habit,
  and never rebuild a system control out of stacks when an element exists.

## References

- Element + attribute reference, tokens, navigation, state:
  https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md
- Document anatomy with a worked golden template:
  https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/dsx-anatomy.md
- App-authoring skills (fluency, design, React Native translation), installable into
  this project for any agent host: \`npx skills add despia-native/skills\`
  (sources: https://github.com/despia-native/despia/tree/main/OpenSource/Skills)
`;

function readme(opts: TemplateOptions): string {
  return `# ${opts.name}

A DSX app. The package scheme is \`${opts.scheme}\`, so \`Components/App.dsx\` is the
component \`${opts.scheme}.App\`.

\`\`\`sh
npm install
npm run dev      # build, serve, watch, reload
npm run build    # compile to dist/
npm run lint     # DSX markup + JSE validation (strict)
npm run review   # the design bar: a11y names, tap targets, the type scale
\`\`\`

## Layout

| Path | What it is |
|---|---|
| \`AGENTS.md\` | the agent brief: the verify loop, the grammar, the design bar (CLAUDE.md imports it) |
| \`dsx.json\` | package identity, the \`scheme\` that namespaces every component |
| \`dsx.config.json\` | app configuration: entry component, output directory${opts.template === "routed" ? ", route table" : ""} |
| \`Components/**/*.dsx\` | the components; the file basename IS the component name |
| \`public/\` | optional static assets, copied verbatim into the build output |

The same \`.dsx\` sources compile on the iOS and Android renderers of the DSX framework;
markup is never platform-forked.
`;
}
