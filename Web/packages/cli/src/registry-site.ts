//
//  registry-site.ts — the registry site, generated as a real DSX project and compiled by
//  `despia build`. The dogfood claim is literal: every page on despia's package site is a .dsx
//  component the same compiler builds, SSR-exported to static HTML that renders with scripts
//  disabled. Zero infrastructure; the output is a folder GitHub Pages serves.
//
//  THE PAGE-PER-ACTION IS THE POINT (plan §2): a Swift package declares no machine-readable
//  API, so the Swift Package Index renders READMEs. Every dsx.json declares each action's
//  args, resolve shape, error codes with human messages, and executable examples — so this
//  site renders one page per ACTION, each answering one "how do I X" question, with JSON-LD
//  and a .md sibling for the crawlers and the LLMs respectively.
//
//  The generator emits SELF-CONTAINED page components (chrome repeated by generation, not by
//  hand), a route table, and the metadata post-pass: canonical + description + OpenGraph +
//  JSON-LD + a meta CSP into each page's head, plus sitemap.xml, llms.txt, atom.xml, robots,
//  and a Markdown sibling for every page.
//

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildProject } from "./build.ts";
import { loadConfig } from "./config.ts";
import type { IndexEntry, RegistryIndex } from "./registry.ts";

export class SiteError extends Error {}

export interface ActionDetail {
  name: string;
  call?: string;
  doc?: string;
  args?: { [name: string]: unknown };
  resolves?: unknown;
  errors?: Array<{ code?: string; message?: string; recoverable?: boolean }>;
  examples?: Array<{ name?: string; args?: unknown; resolve?: unknown; expectError?: string; given?: unknown }>;
}

export interface SiteInput {
  /** Where the site will be served, no trailing slash: https://despia-native.github.io/registry */
  baseUrl: string;
  firstParty: RegistryIndex;
  /** The rich per-action contracts (first-party-details.json). Optional; packages without
   *  details get name-only action pages. */
  details?: { packages: Array<{ id: string; chain: string; actions: ActionDetail[] }> };
  /** The community index.json. Optional; the site builds first-party-only without it. */
  community?: RegistryIndex;
}

export interface SitePage {
  /** The route ("/", "/packages/core/camera", "/packages/core/camera/capture"). */
  route: string;
  title: string;
  description: string;
  /** The page as Markdown — written as the route's `index.md` sibling and listed in llms.txt. */
  markdown: string;
  jsonLd: { [k: string]: unknown };
  updated?: string;
}

// ── small emitters ──────────────────────────────────────────────────────────────────────

/** Attribute-safe text: XML entities, and `{{` broken so a doc string never interpolates. */
function attr(text: string): string {
  return text
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;").replaceAll("{{", "{ {").replaceAll("\n", " ");
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function componentName(prefix: string, raw: string): string {
  const words = raw.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  return prefix + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}

function routeFor(entry: IndexEntry): string {
  return `/packages/${entry.id.replace("github:", "github/")}`;
}

function pkgTitle(entry: IndexEntry): string {
  return entry.repo !== undefined ? `${entry.name} (${entry.owner}/${entry.repo})` : entry.name;
}

function installLine(entry: IndexEntry): string {
  return entry.repo !== undefined
    ? `despia add github:${entry.owner}/${entry.repo}@${entry.version}`
    : "ships with the Despia framework";
}

function describe(entry: IndexEntry): string {
  if (entry.summary !== "") return entry.summary;
  return `${entry.name} for Despia apps: the ${entry.scheme} module — ${entry.actions.length} action(s), ` +
    `called as dsx.module.${entry.scheme}.* from DSX markup, native on ${entry.platforms.join(", ") || "every platform"}.`;
}

const CHROME_TOP = (title: string) =>
  `<stack style="gap: 1.5rem; padding: 2rem; max-width: 52rem">\n` +
  `  <stack direction="horizontal" style="gap: 1rem; align-items: baseline">\n` +
  `    <button label="Despia Packages" href="/" variant="plain" style="font-weight: 700"/>\n` +
  `    <text value="${attr(title)}" style="color: secondary"/>\n` +
  `  </stack>\n`;

const CHROME_BOTTOM =
  `  <text value="Source of truth is git. despia add verifies a tree hash against the tag it pins; this site is discovery, never resolution." style="font-size: 0.8rem; color: tertiary"/>\n` +
  `</stack>\n`;

function textRow(label: string, value: string): string {
  return `  <stack direction="horizontal" style="gap: 0.75rem">\n` +
    `    <text value="${attr(label)}" style="font-weight: 600; min-width: 7rem"/>\n` +
    `    <text value="${attr(value)}"/>\n  </stack>\n`;
}

function mono(value: string): string {
  return `  <text value="${attr(value)}" style="font-family: monospace; background: secondaryBackground; padding: 0.5rem; border-radius: 0.4rem"/>\n`;
}

function heading(value: string, size = "1.5rem"): string {
  return `  <text value="${attr(value)}" style="font-size: ${size}; font-weight: 700"/>\n`;
}

// ── page generators ─────────────────────────────────────────────────────────────────────

function packagePage(entry: IndexEntry, actions: ActionDetail[], baseUrl: string): { dsx: string; page: SitePage } {
  const route = routeFor(entry);
  const lines: string[] = [CHROME_TOP(entry.scheme)];
  lines.push(heading(pkgTitle(entry), "2rem"));
  lines.push(`  <text value="${attr(describe(entry))}" style="color: secondary"/>\n`);
  lines.push(mono(installLine(entry)));
  lines.push(textRow("scheme", entry.scheme));
  lines.push(textRow("version", entry.version));
  if (entry.platforms.length > 0) lines.push(textRow("platforms", entry.platforms.join(" · ")));
  if (entry.license !== undefined) lines.push(textRow("license", entry.license));
  if (entry.repo !== undefined) {
    lines.push(`  <button label="${attr(`github.com/${entry.owner}/${entry.repo}`)}" href="${attr(`https://github.com/${entry.owner}/${entry.repo}`)}" variant="plain"/>\n`);
  }
  if (entry.actions.length > 0) {
    lines.push(heading(`Actions (${entry.actions.length})`));
    for (const action of entry.actions) {
      const detail = actions.find((a) => a.name === action);
      const label = `dsx.module.${entry.scheme}.${action}`;
      lines.push(`  <stack style="gap: 0.15rem">\n` +
        `    <button label="${attr(label)}" href="${attr(`${route}/${action.toLowerCase()}`)}" variant="plain" style="font-family: monospace"/>\n` +
        (detail?.doc !== undefined ? `    <text value="${attr(detail.doc)}" style="font-size: 0.85rem; color: secondary"/>\n` : "") +
        `  </stack>\n`);
    }
  }
  lines.push(CHROME_BOTTOM);

  const md = [
    `# ${pkgTitle(entry)}`,
    "",
    describe(entry),
    "",
    "```sh",
    installLine(entry),
    "```",
    "",
    `- scheme: \`${entry.scheme}\``,
    `- version: ${entry.version}`,
    ...(entry.platforms.length > 0 ? [`- platforms: ${entry.platforms.join(", ")}`] : []),
    ...(entry.license !== undefined ? [`- license: ${entry.license}`] : []),
    ...(entry.repo !== undefined ? [`- repository: https://github.com/${entry.owner}/${entry.repo}`] : []),
    "",
    ...(entry.actions.length > 0 ? [
      "## Actions", "",
      ...entry.actions.map((a) => `- [\`dsx.module.${entry.scheme}.${a}\`](${baseUrl}${route}/${a.toLowerCase()}/index.md)`),
    ] : []),
    "",
  ].join("\n");

  return {
    dsx: lines.join(""),
    page: {
      route,
      title: pkgTitle(entry),
      description: describe(entry).slice(0, 300),
      markdown: md,
      ...(entry.updated !== undefined ? { updated: entry.updated } : {}),
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: entry.name,
        description: describe(entry),
        programmingLanguage: "DSX",
        version: entry.version,
        url: `${baseUrl}${route}/`,
        ...(entry.repo !== undefined ? { codeRepository: `https://github.com/${entry.owner}/${entry.repo}` } : {}),
        ...(entry.license !== undefined ? { license: `https://spdx.org/licenses/${entry.license}` } : {}),
      },
    },
  };
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function actionPage(entry: IndexEntry, detail: ActionDetail, baseUrl: string): { dsx: string; page: SitePage } {
  const route = `${routeFor(entry)}/${detail.name.toLowerCase()}`;
  const call = detail.call ?? `dsx.module.${entry.scheme}.${detail.name}`;
  const doc = detail.doc ?? `The ${detail.name} action of the ${entry.name} module.`;
  const lines: string[] = [CHROME_TOP(`${entry.scheme}.${detail.name}`)];
  lines.push(heading(call, "1.6rem"));
  lines.push(`  <text value="${attr(doc)}" style="color: secondary"/>\n`);
  lines.push(mono(`const r = await ${call}(${detail.args !== undefined && Object.keys(detail.args).length > 0 ? "{ … }" : ""})`));

  const md: string[] = [`# ${call}`, "", doc, ""];

  if (detail.args !== undefined && Object.keys(detail.args).length > 0) {
    lines.push(heading("Arguments", "1.15rem"));
    md.push("## Arguments", "");
    for (const [name, spec] of Object.entries(detail.args)) {
      const type = typeof spec === "string" ? spec
        : `${(spec as { type?: string }).type ?? "any"}${(spec as { optional?: boolean }).optional === true ? " (optional)" : ""}`;
      lines.push(textRow(name, type));
      md.push(`- \`${name}\`: ${type}`);
    }
    md.push("");
  }
  if (detail.resolves !== undefined) {
    lines.push(heading("Resolves", "1.15rem"));
    lines.push(mono(renderValue(detail.resolves)));
    md.push("## Resolves", "", "```json", renderValue(detail.resolves), "```", "");
  }
  if (detail.errors !== undefined && detail.errors.length > 0) {
    lines.push(heading("Errors", "1.15rem"));
    md.push("## Errors", "");
    for (const error of detail.errors) {
      lines.push(textRow(error.code ?? "error", error.message ?? ""));
      md.push(`- \`${error.code ?? "error"}\`: ${error.message ?? ""}`);
    }
    md.push("");
  }
  if (detail.examples !== undefined && detail.examples.length > 0) {
    lines.push(heading("Examples", "1.15rem"));
    md.push("## Examples", "");
    for (const example of detail.examples) {
      if (example.name !== undefined) {
        lines.push(`  <text value="${attr(example.name)}" style="font-weight: 600; font-size: 0.9rem"/>\n`);
        md.push(`### ${example.name}`, "");
      }
      const line = `await ${call}(${example.args !== undefined ? JSON.stringify(example.args) : ""})` +
        (example.expectError !== undefined ? `  // rejects: ${example.expectError}`
          : example.resolve !== undefined ? `  // resolves: ${JSON.stringify(example.resolve)}` : "");
      lines.push(mono(line));
      md.push("```js", line, "```", "");
    }
  }
  lines.push(`  <button label="All ${attr(entry.name)} actions" href="${attr(routeFor(entry))}" variant="plain"/>\n`);
  lines.push(CHROME_BOTTOM);

  return {
    dsx: lines.join(""),
    page: {
      route,
      title: call,
      description: doc.slice(0, 300),
      markdown: md.join("\n") + "\n",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: call,
        description: doc,
        url: `${baseUrl}${route}/`,
        isPartOf: { "@type": "SoftwareSourceCode", name: entry.name, url: `${baseUrl}${routeFor(entry)}/` },
      },
    },
  };
}

function homePage(entries: IndexEntry[], baseUrl: string): { dsx: string; page: SitePage } {
  const firstParty = entries.filter((e) => e.repo === undefined);
  const community = entries.filter((e) => e.repo !== undefined);
  const lines: string[] = [CHROME_TOP("index")];
  lines.push(heading("Despia Packages", "2rem"));
  lines.push(`  <text value="Native capability for Despia apps. Source of truth is GitHub and git tags; a package installs with one command and no code runs at install time." style="color: secondary"/>\n`);
  lines.push(mono("despia search camera"));
  const section = (title: string, list: IndexEntry[]): void => {
    if (list.length === 0) return;
    lines.push(heading(`${title} (${list.length})`));
    for (const entry of list) {
      lines.push(`  <stack direction="horizontal" style="gap: 0.75rem; align-items: baseline">\n` +
        `    <button label="${attr(entry.scheme)}" href="${attr(routeFor(entry))}" variant="plain" style="font-family: monospace; font-weight: 600"/>\n` +
        `    <text value="${attr(describe(entry).slice(0, 110))}" style="font-size: 0.85rem; color: secondary"/>\n` +
        `  </stack>\n`);
    }
  };
  section("First-party", firstParty);
  section("Community", community);
  lines.push(CHROME_BOTTOM);

  const md = [
    "# Despia Packages", "",
    "Native capability for Despia apps. Source of truth is GitHub and git tags.", "",
    ...(firstParty.length > 0 ? ["## First-party", "", ...firstParty.map((e) => `- [${e.scheme}](${baseUrl}${routeFor(e)}/index.md): ${describe(e).slice(0, 120)}`), ""] : []),
    ...(community.length > 0 ? ["## Community", "", ...community.map((e) => `- [${e.id}](${baseUrl}${routeFor(e)}/index.md): ${describe(e).slice(0, 120)}`), ""] : []),
  ].join("\n");

  return {
    dsx: lines.join(""),
    page: {
      route: "/",
      title: "Despia Packages",
      description: `The Despia package registry: ${entries.length} packages of native capability for DSX apps, installable with one command.`,
      markdown: md,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Despia Packages",
        url: `${baseUrl}/`,
      },
    },
  };
}

// ── the project ─────────────────────────────────────────────────────────────────────────

export interface GeneratedSite {
  pages: SitePage[];
  components: number;
}

/** Write the complete DSX project for the site into `projectDir`. */
export function generateSiteProject(input: SiteInput, projectDir: string): GeneratedSite {
  const entries = [...input.firstParty.packages, ...(input.community?.packages ?? [])];
  const detailsById = new Map<string, ActionDetail[]>();
  for (const pkg of input.details?.packages ?? []) detailsById.set(pkg.id, pkg.actions);

  const componentsDir = join(projectDir, "Components");
  mkdirSync(componentsDir, { recursive: true });

  const pages: SitePage[] = [];
  const routes: Array<{ path: string; component: string; meta: { title: string } }> = [];
  const used = new Set<string>();
  const emit = (name: string, dsx: string, page: SitePage): void => {
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}V${n}`;
    used.add(unique);
    writeFileSync(join(componentsDir, `${unique}.dsx`), dsx);
    pages.push(page);
    routes.push({ path: page.route, component: `registry.${unique}`, meta: { title: page.title } });
  };

  const home = homePage(entries, input.baseUrl);
  emit("Home", home.dsx, home.page);

  for (const entry of entries) {
    const details = detailsById.get(entry.id) ??
      entry.actions.map((name) => ({ name }) satisfies ActionDetail);
    const pkg = packagePage(entry, details, input.baseUrl);
    emit(componentName("Pkg", entry.id), pkg.dsx, pkg.page);
    for (const action of details) {
      if (!entry.actions.includes(action.name)) continue;
      const act = actionPage(entry, action, input.baseUrl);
      emit(componentName("Act", `${entry.id} ${action.name}`), act.dsx, act.page);
    }
  }

  writeFileSync(join(projectDir, "dsx.json"), JSON.stringify({
    name: "Despia Packages", scheme: "registry", version: "0.1.0", platforms: ["desktop", "phone"],
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, "dsx.config.json"), JSON.stringify({
    name: "Despia Packages", entry: "Home", outDir: "dist", routes,
  }, null, 2) + "\n");
  mkdirSync(join(projectDir, "public"), { recursive: true });
  writeFileSync(join(projectDir, "public", "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${input.baseUrl}/sitemap.xml\n`);

  return { pages, components: used.size };
}

// ── the build + post-pass ───────────────────────────────────────────────────────────────

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'";

function pageFile(outDir: string, route: string): string {
  return route === "/" ? join(outDir, "index.html") : join(outDir, ...route.slice(1).split("/"), "index.html");
}

export interface SiteResult {
  outDir: string;
  pages: number;
  components: number;
}

/**
 * Generate, compile with `despia build`, then post-pass every page: canonical + description +
 * OpenGraph + JSON-LD + a meta CSP into the head (GitHub Pages serves no response headers, so
 * the policy rides the document), a `.md` sibling next to every page, and the site-wide
 * artifacts: sitemap.xml, llms.txt, atom.xml.
 */
export function buildSite(input: SiteInput, projectDir: string): SiteResult {
  const generated = generateSiteProject(input, projectDir);
  const config = loadConfig(projectDir);
  buildProject(config);

  // ── shared-CSS extraction ──
  // SSR inlines the complete system style layers into every page (page-render.ts) — right for
  // an app shell, ~200KB of identical bytes per page for a static site of hundreds. The blocks
  // are byte-identical across pages, so they extract mechanically into ONE cached site.css and
  // each page keeps a link. Page weight is a ranking factor, and so is not shipping the same
  // stylesheet 800 times.
  const homeHtml = readFileSync(pageFile(config.outDir, "/"), "utf8");
  const shared: string[] = [];
  for (const match of homeHtml.matchAll(/<style>[\s\S]*?<\/style>/g)) {
    if (match[0].length > 1024) shared.push(match[0]);
  }
  writeFileSync(join(config.outDir, "site.css"),
    shared.map((s) => s.slice("<style>".length, -"</style>".length)).join("\n"));

  for (const page of generated.pages) {
    const file = pageFile(config.outDir, page.route);
    if (!existsSync(file)) throw new SiteError(`route ${page.route} produced no page at ${file}`);
    const depth = page.route === "/" ? 0 : page.route.slice(1).split("/").length;
    const cssHref = `${"../".repeat(depth)}site.css`;
    const canonical = `${input.baseUrl}${page.route === "/" ? "/" : `${page.route}/`}`;
    const head = [
      `<link rel="canonical" href="${xml(canonical)}">`,
      `<meta name="description" content="${xml(page.description)}">`,
      `<meta property="og:title" content="${xml(page.title)}">`,
      `<meta property="og:description" content="${xml(page.description)}">`,
      `<meta property="og:url" content="${xml(canonical)}">`,
      `<meta property="og:type" content="website">`,
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      `<script type="application/ld+json">${JSON.stringify(page.jsonLd)}</script>`,
    ].join("");
    let html = readFileSync(file, "utf8");
    if (!html.includes("</head>")) throw new SiteError(`${file} has no head to annotate`);
    let extracted = false;
    for (const block of shared) {
      if (!html.includes(block)) continue;
      html = html.replace(block, extracted ? "" : `<link rel="stylesheet" href="${cssHref}">`);
      extracted = true;
    }
    writeFileSync(file, html.replace("</head>", `${head}</head>`));
    writeFileSync(join(dirname(file), "index.md"), page.markdown);
  }

  const urls = generated.pages.map((p) => `${input.baseUrl}${p.route === "/" ? "/" : `${p.route}/`}`);
  writeFileSync(join(config.outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${xml(u)}</loc></url>`).join("\n") + "\n</urlset>\n");

  writeFileSync(join(config.outDir, "llms.txt"), [
    "# Despia Packages",
    "",
    "> The Despia package registry: native capability for DSX apps. Every page has a Markdown",
    "> sibling at <page>/index.md with the full machine-readable content.",
    "",
    ...generated.pages.map((p) =>
      `- [${p.title}](${input.baseUrl}${p.route === "/" ? "/" : `${p.route}/`}index.md): ${p.description.split("\n")[0]}`),
    "",
  ].join("\n"));

  const dated = generated.pages.filter((p) => p.updated !== undefined);
  const feedUpdated = dated.map((p) => p.updated!).sort().at(-1) ?? new Date().toISOString();
  writeFileSync(join(config.outDir, "atom.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `  <title>Despia Packages</title>\n  <id>${xml(input.baseUrl)}/</id>\n` +
    `  <link href="${xml(input.baseUrl)}/atom.xml" rel="self"/>\n  <updated>${xml(feedUpdated)}</updated>\n` +
    dated.map((p) =>
      `  <entry>\n    <id>${xml(`${input.baseUrl}${p.route}/`)}</id>\n    <title>${xml(p.title)}</title>\n` +
      `    <link href="${xml(`${input.baseUrl}${p.route}/`)}"/>\n    <updated>${xml(p.updated!)}</updated>\n` +
      `    <summary>${xml(p.description)}</summary>\n  </entry>`).join("\n") +
    "\n</feed>\n");

  return { outDir: config.outDir, pages: generated.pages.length, components: generated.components };
}
