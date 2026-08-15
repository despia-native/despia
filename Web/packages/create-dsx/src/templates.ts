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
  /** file: specifiers for @despia/* instead of registry versions (in-repo development) */
  link?: { [pkg: string]: string };
};

export function renderTemplate(opts: TemplateOptions): { [relativePath: string]: string } {
  const files: { [relativePath: string]: string } = {
    "package.json": packageJson(opts),
    "dsx.json": dsxJson(opts),
    "dsx.config.json": dsxConfig(opts),
    ".gitignore": "node_modules/\ndist/\n",
    "README.md": readme(opts),
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
      build: "dsx build",
      dev: "dsx dev",
      lint: "dsx lint --strict",
    },
    dependencies: {
      "@despia/compiler": dependency(opts, "@despia/compiler"),
      "@despia/dom": dependency(opts, "@despia/dom"),
      "@despia/kernel": dependency(opts, "@despia/kernel"),
      "@despia/server": dependency(opts, "@despia/server"),
    },
    devDependencies: {
      "@despia/cli": dependency(opts, "@despia/cli"),
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
    <variable as="built">return 'compiled by dsx build'</variable>
  </head>
  <text value="About" style="font-size: 1.5rem; font-weight: 600"/>
  <text value="{{ dsx.variable.built }}"/>
</stack>
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
\`\`\`

## Layout

| Path | What it is |
|---|---|
| \`dsx.json\` | package identity — the \`scheme\` that namespaces every component |
| \`dsx.config.json\` | app configuration — entry component, output directory${opts.template === "routed" ? ", route table" : ""} |
| \`Components/**/*.dsx\` | the components; the file basename IS the component name |
| \`public/\` | optional static assets, copied verbatim into the build output |

The same \`.dsx\` sources compile on the iOS and Android renderers of the DSX framework —
markup is never platform-forked.
`;
}
