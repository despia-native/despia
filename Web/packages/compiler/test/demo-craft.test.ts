import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseDsx } from "../src/xml.ts";

function repoRoot(): string {
  let directory = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(directory, "OpenSource/Conformance"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repo root not found");
    directory = parent;
  }
}

const root = repoRoot();
const components = join(root, "ClosedSource/DSX/Modules/Custom/Demo/Components");
const read = (name: string): string => readFileSync(join(components, name), "utf8");

test("demo craft surfaces remain valid DSX and use DSX-only product branding", () => {
  for (const name of ["Launcher.dsx", "Gallery.dsx", "Workspace.dsx"]) {
    const source = read(name);
    assert.doesNotThrow(() => parseDsx(source), name);
    assert.doesNotMatch(source, /\bDespia\b/i, `${name} uses neutral DSX branding`);
  }
  const systemScreens = join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/System");
  for (const directory of [components, systemScreens]) {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".dsx"))) {
      assert.doesNotMatch(
        readFileSync(join(directory, name), "utf8"),
        /\bDespia\b/i,
        `${name} never exposes the legacy long-form brand`,
      );
    }
  }
  const builder = readFileSync(join(root, "OpenSource/Web/packages/compiler/bin/build-demo.ts"), "utf8");
  assert.match(builder, /width=device-width, initial-scale=1, viewport-fit=cover/);
  assert.doesNotMatch(builder, /interactive-widget/, "the demo viewport stays valid in WebKit");
});

test("launcher preserves the full capability catalog and every icon has a Web path", () => {
  const launcher = read("Launcher.dsx");
  const entries = launcher.match(/\{\s*id:\s*'[^']+'[^\n]+component:\s*'[^']+'/g) ?? [];
  assert.equal(entries.length, 24, "all capability routes stay visible");

  // The web icon table is DERIVED from the one cross-runtime corpus (elements.ts no longer
  // carries a private fork), so an authored demo icon is checked against that corpus here —
  // the same file iOS/Android resolve. `web` is the stroke vector, `fallback` the corpus's
  // documented unicode stand-in; either one means the browser draws something real.
  const icons = new Set(Array.from(launcher.matchAll(/icon:\s*'([^']+)'/g), (match) => match[1]!));
  const sfMap = JSON.parse(
    readFileSync(join(root, "OpenSource/Conformance/icons/sf-map.json"), "utf8"),
  ) as { icons: { [name: string]: { web?: string; fallback?: string } }; web_extra?: { [name: string]: string } };
  const extra = sfMap.web_extra ?? {};
  for (const icon of icons) {
    const row = Object.hasOwn(sfMap.icons, icon) ? sfMap.icons[icon] : undefined;
    const drawable = (row?.web ?? row?.fallback ?? "").length > 0
      || (Object.hasOwn(extra, icon) ? extra[icon] ?? "" : "").length > 0;
    assert.ok(drawable, `mapped Web icon: ${icon} — add its row to OpenSource/Conformance/icons/sf-map.json`);
  }
});

test("craft CSS keeps restrained surfaces and distinct tablet/desktop precision tiers", () => {
  const styles = ["Launcher.css", "Gallery.css", "Workspace.css"].map(read);
  for (const [index, css] of styles.entries()) {
    assert.doesNotMatch(css, /(?:radial|conic)-gradient\s*\(/i, `stylesheet ${index} has no decorative spotlight gradient`);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i, `stylesheet ${index} uses semantic tokens`);
    for (const declaration of css.match(/box-shadow\s*:[^;]+/g) ?? []) {
      assert.match(
        declaration,
        /box-shadow\s*:\s*(?:none|inset\b|0\s+0\s+0\s+2px\s+color-mix\([^;]*var\(--dsx-accent\))/,
        `restrained shadow: ${declaration}`,
      );
    }
  }
  const launcherGradients = styles[0]!.match(/linear-gradient\s*\(/g) ?? [];
  assert.equal(launcherGradients.length, 0, "workbench hierarchy comes from contextual surfaces, not decoration");
  assert.match(styles[0]!, /@media \(min-width: 45rem\)/, "launcher has a tablet tier");
  assert.match(styles[0]!, /@media \(min-width: 68rem\)/, "launcher has a desktop tier");
  assert.match(styles[0]!, /\.dsx-master \[data-dsx-owner="Launcher"\][\s\S]*\.launcher-canvas-scroll/,
    "desktop master-detail collapses the launcher to its library pane");
  assert.match(styles[1]!, /@container gallery-layout \(min-width: 90rem\)/, "gallery keeps a bounded wide precision tier");
  assert.match(styles[1]!, /container-name:\s*gallery-layout/, "gallery publishes its usable pane width");
  assert.match(styles[1]!, /container-name:\s*gallery-panel/, "gallery responds to its actual pane width");
  assert.match(styles[1]!, /@container gallery-panel \(min-width: 40rem\)/, "gallery has a two-column container tier");
  assert.match(styles[1]!, /@container gallery-panel \(min-width: 66rem\)/, "inputs gain a three-column wide tier");
  assert.match(styles[1]!, /@container gallery-layout \(min-width: 72rem\)/,
    "the inspector appears only when the actual detail pane can hold it");
  assert.match(styles[1]!, /\.gallery-workarea\s*\{[^}]*width:\s*100%/s,
    "the gallery grid cannot collapse inside a leading-aligned DSX stack");
  assert.match(styles[1]!, /\.gallery-panel-body\s*\{[^}]*align-items:\s*stretch/s,
    "uneven specimens still paint a continuous nested surface");
  assert.match(styles.join("\n"), /:focus-visible[\s\S]*box-shadow:\s*inset\s+0\s+0\s+0\s+2px\s+var\(--dsx-accent\)/,
    "keyboard focus is a dedicated accent layer");
  assert.match(styles[2]!, /container-type:\s*inline-size/, "workspace publishes its actual content width");
  assert.match(
    styles[2]!,
    /\.workspace-page\s*\{[^}]*--dsx-demo-content-max:\s*100rem/s,
    "workspace opts into a bounded large-monitor work surface before evaluating container tiers",
  );
  assert.match(styles[2]!, /@container workspace \(min-width: 48rem\)/, "workspace gains a two-pane tablet layout");
  assert.match(styles[2]!, /@container workspace \(min-width: 75rem\)/, "workspace gains a three-pane desktop layout");
  const compactStart = styles[2]!.indexOf("@media (max-width: 35rem)");
  const compactEnd = styles[2]!.indexOf("@container workspace", compactStart);
  assert.ok(compactStart >= 0 && compactEnd > compactStart, "workspace has one bounded compact rule section");
  const compactWorkspace = styles[2]!.slice(compactStart, compactEnd);
  assert.match(
    compactWorkspace,
    /\.workspace-breadcrumb,\s*\.workspace-toolbar-secondary\s*\{[^}]*display:\s*none/s,
    "compact native-safe classes remove toolbar actions before Material buttons can be compressed",
  );
  assert.match(
    compactWorkspace,
    /\.workspace-kpis\s*\{[^}]*flex-direction:\s*column/s,
    "compact KPI anatomy uses the native DSX flex contract",
  );
  assert.match(
    compactWorkspace,
    /\.workspace-sidebar-nav\s*\{[^}]*flex-direction:\s*column/s,
    "compact navigation remains fully visible instead of laying full-width pressables off-screen",
  );
  assert.match(
    compactWorkspace,
    /\.workspace-nav-pressable,\s*\.workspace-nav-row\s*\{[^}]*width:\s*100%/s,
    "compact native navigation rows use the full readable width",
  );
  assert.doesNotMatch(
    compactWorkspace,
    /\.workspace-kpis\s*\{[^}]*grid-template-columns/s,
    "compact KPI layout cannot depend on the Web-only grid bridge",
  );
});

test("Web defaults stay neutral instead of copying one native platform", () => {
  const banner = readFileSync(
    join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Banner.dsx"),
    "utf8",
  );
  const theme = readFileSync(join(root, "OpenSource/Web/packages/dom/src/theme.ts"), "utf8");
  const forms = readFileSync(join(root, "OpenSource/Web/packages/dom/src/forms.ts"), "utf8");
  const nativeControls = readFileSync(join(root, "OpenSource/Web/packages/dom/src/native-controls.ts"), "utf8");

  assert.doesNotMatch(banner, /#FF453A|#FF9F0A|#30D158|#0A84FF/, "Banner has no Apple-specific status palette");
  assert.doesNotMatch(theme + forms, /width:\s*51px|height:\s*31px/, "switches use DSX-neutral geometry");
  const wheel = nativeControls.match(/\.dsx-wheelpicker-select\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.doesNotMatch(wheel, /linear-gradient|scroll-snap/, "Web wheelpicker stays a browser-native listbox");
});

test("catalog copy and interactions stay specific enough for a product workbench", () => {
  const launcher = read("Launcher.dsx");
  const gallery = read("Gallery.dsx");
  const workspace = read("Workspace.dsx");

  assert.match(launcher, /One source\. Every surface\./);
  assert.match(launcher, /Author styles win/);
  assert.doesNotMatch(launcher, /route ready/i, "available routes do not repeat status noise");
  assert.doesNotMatch(
    gallery,
    /Clear hierarchy, quiet states|Touch-safe, keyboard precise|Progress without visual noise|Nested surfaces share one rhythm/,
  );
  assert.doesNotMatch(gallery, /31 live controls|[0-9]+ (?:primitives|controls|states|patterns)/);
  assert.doesNotMatch(gallery, /gallery-section-index/);
  assert.match(gallery, /a11yLabel="Component state"/);
  assert.match(gallery, /actionState/);
  assert.match(gallery, /role="status"/);
  assert.match(gallery, /Encodes example\.com\/dsx-preview/);
  assert.match(workspace, /Ready to validate/);
  assert.match(workspace, /Values remain in this session/);
  assert.match(workspace, /Sample settings saved locally/);
});

test("Gallery accent compositions use the adaptive Web foreground", () => {
  const gallery = read("Gallery.dsx");
  const sources = [
    ["Chip", "Chip.dsx"],
    ["Avatar", "Avatar.dsx"],
    ["EmptyState", "EmptyState.dsx"],
  ] as const;
  for (const [component, file] of sources) {
    assert.match(gallery, new RegExp(`<${component}\\b`), `${component} remains represented in the Gallery`);
    const source = readFileSync(
      join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core", file),
      "utf8",
    );
    assert.doesNotThrow(() => parseDsx(source), file);
    assert.match(source, /color:web="[^"]*var\(--dsx-on-accent\)/, `${component} consumes the adaptive Web token`);
    assert.doesNotMatch(source, /color:web="[^"]*white/, `${component} never pins white in the Web branch`);
  }
});

test("Foundation auth actions and VIP cards remain adaptive at the Web edge", () => {
  const foundation = join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core");
  for (const file of ["AuthLogin.dsx", "AuthSignup.dsx"] as const) {
    const source = readFileSync(join(foundation, file), "utf8");
    assert.doesNotThrow(() => parseDsx(source), file);
    const primary = source.match(
      /<button\s+label="\{\{\s*dsx\.attribute\.submitLabel[\s\S]*?\/>/,
    )?.[0] ?? "";
    assert.match(primary, /color="white"/, `${file} preserves the native foreground`);
    assert.match(primary, /color:web="var\(--dsx-on-accent\)"/, `${file} adapts the Web foreground`);
    assert.doesNotMatch(primary, /style="[^"]*\bcolor\s*:/, `${file} has no stronger inline foreground`);
  }

  const vip = readFileSync(join(foundation, "VipCard.dsx"), "utf8");
  assert.doesNotThrow(() => parseDsx(vip), "VipCard.dsx");
  assert.match(vip, /width:\s*100%/, "VIP card can shrink to its container");
  assert.match(vip, /max-width:\s*300px/, "VIP card retains its intended carousel measure");
  assert.doesNotMatch(vip, /(?:^|;)\s*width:\s*300px/, "VIP card no longer forces narrow-viewport overflow");
});

test("demo interactions and accessibility remain deliberate at every breakpoint", () => {
  const launcher = read("Launcher.dsx");
  const gallery = read("Gallery.dsx");
  const workspace = read("Workspace.dsx");
  const galleryCss = read("Gallery.css");
  const launcherCss = read("Launcher.css");
  const workspaceCss = read("Workspace.css");
  const workspaceBaseCss = workspaceCss.slice(0, workspaceCss.indexOf("@media"));
  const chip = readFileSync(join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Chip.dsx"), "utf8");
  const chipCss = readFileSync(join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Chip.css"), "utf8");

  for (const source of [launcher, gallery, workspace]) {
    assert.match(source, /role="main"/, "each craft screen exposes one main landmark");
    assert.doesNotMatch(source, /aria-live=/, "live announcements use a supported semantic role");
  }
  assert.match(launcher, /role="navigation" a11yLabel="Runtime routes"/);
  assert.match(workspace, /role="navigation" a11yLabel="Workspace sections"/);
  assert.match(workspace, /role="complementary" a11yLabel="Release settings"/);
  assert.match(workspace, /role="status" a11yLabel="Workspace status:/);
  assert.match(gallery, /role="status" a11yLabel="Last action:/);

  for (const control of gallery.match(/<(?:Chip|SettingsRow)\b[^>]*\/>/g) ?? []) {
    assert.match(control, /on:tap=/, `demo control is wired: ${control}`);
  }
  for (const [name, source] of [["Launcher", launcher], ["Gallery", gallery], ["Workspace", workspace]] as const) {
    for (const control of source.match(/<button\b[^>]*\/>/g) ?? []) {
      assert.match(control, /(?:on:tap=|disabled="true")/, `${name} button is actionable or explicitly unavailable: ${control}`);
    }
    for (const control of source.match(/<pressable\b[^>]*>/g) ?? []) {
      assert.match(control, /(?:on:tap=|href=)/, `${name} pressable is actionable: ${control}`);
    }
  }
  assert.match(gallery, /<EmptyState\b[^>]*action="Run checks"[^>]*on:action=/);
  assert.match(workspace, /label="Preview"[^>]*activityLine/);
  assert.match(workspace, /class="workspace-toolbar-secondary"[^>]*label="Components"/);
  assert.match(workspace, /class="workspace-toolbar-primary"[^>]*label="Run checks"/);
  assert.match(workspace, /class="workspace-context-action"[^>]*label="Preview"/);
  assert.match(
    workspaceBaseCss,
    /\.workspace-sidebar-nav\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*visible;/s,
    "native sidebar anatomy is vertical without relying on Web-only container queries",
  );
  assert.match(
    workspace,
    /<scaffold\b[^>]*class="workspace-shell"[^>]*shell="automatic"[^>]*collapse="stack"[^>]*compactAt="760"/s,
    "the Workspace uses the shared adaptive shell instead of Web-only responsive CSS",
  );
  assert.match(workspace, /class="workspace-sidebar"[^>]*pane="sidebar"/);
  assert.match(workspace, /<scroll\b[^>]*class="workspace-main"[^>]*pane="content"[^>]*grow="true"/);
  assert.match(workspace, /<scroll\b[^>]*class="workspace-inspector"[^>]*pane="inspector"[^>]*grow="true"/);
  assert.doesNotMatch(workspace, /<stack\b[^>]*class="workspace-shell"/);
  assert.doesNotMatch(
    workspace,
    /<scroll\b[^>]*a11yLabel="Atlas release workspace"/,
    "the adaptive scaffold owns the viewport instead of collapsing inside an outer scroll",
  );
  assert.match(
    workspace,
    /class="workspace-context-action"[^>]*label="Publish"[^>]*variant="prominent"[^>]*disabled="true"/,
    "the responsive Publish action stays on the native system-control path while disabled",
  );
  assert.doesNotMatch(gallery, /class="gallery-index"/, "the former non-interactive sticky index is gone");

  const nativeIconMap = JSON.parse(
    readFileSync(join(root, "OpenSource/Conformance/icons/sf-map.json"), "utf8"),
  ) as { icons: { [name: string]: { material: string; codepoint: string } } };
  const workspaceIcons = Array.from(
    workspace.matchAll(/\bicon="([^"{]+)"/g),
    (match) => match[1]!,
  );
  for (const icon of workspaceIcons) {
    assert.ok(
      Object.hasOwn(nativeIconMap.icons, icon),
      `Workspace icon ${icon} has a native Material row, not only a Web fallback`,
    );
  }

  assert.match(launcher, /avail_haptic === true/, "omitted package availability fails closed");
  assert.match(launcher, /launcher-status-missing/);
  assert.doesNotMatch(launcher, /launcher-status-available|route ready/i,
    "available routes rely on normal row anatomy instead of redundant badges");
  assert.match(launcherCss + galleryCss + workspaceCss, /\[dir="rtl"\][^{]+disclosure|\[dir="rtl"\] \.launcher-chevron/);
  assert.match(workspaceCss, /\.workspace-check-pressable:focus-visible\s*\{[^}]*box-shadow:\s*inset\s+0\s+0\s+0\s+2px\s+var\(--dsx-accent\)/s,
    "bounded check rows receive a visible keyboard ring");
  assert.match(workspaceCss, /@media \(forced-colors: active\)[\s\S]*\.workspace-nav-row-active\s*\{[^}]*border:\s*1px\s+solid\s+currentColor/s,
    "the current workspace section remains visible in forced colors");
  assert.match(chip, /aria-pressed="\{\{ dsx\.attribute\.selected == 'true' \|\| dsx\.attribute\.selected == '1' \}\}"/,
    "filter chips expose their selected state semantically");
  assert.match(chip, /a11yTrait="\{\{[^\"]*selected/,
    "native renderers receive the selected accessibility trait");
  assert.match(chipCss, /@media \(forced-colors: active\)[\s\S]*\[aria-pressed="true"\][\s\S]*border:\s*3px\s+double/,
    "selected chips retain a non-outline marker when authored fills are replaced");
  assert.doesNotMatch(chipCss, /\[aria-pressed="true"\][^{]*\{[^}]*outline:/s,
    "selected state never replaces the independent keyboard focus outline");
});

test("workspace is an honest gated product surface, not a decorative dashboard", () => {
  const workspace = read("Workspace.dsx");
  assert.match(workspace, /Seven of eight gates complete/);
  assert.match(workspace, /<button\b[^>]*label="Publish"[^>]*disabled="true"\/>/);
  assert.match(workspace, /<button label="Publish now" disabled="true"\/>/);
  assert.match(workspace, /Store policy review/);
  assert.match(workspace, /Manual owner review outside automation/);
  for (const className of ["workspace-sidebar", "workspace-main", "workspace-inspector"]) {
    assert.match(workspace, new RegExp(`class="${className}"`), className);
  }

  const routes = JSON.parse(readFileSync(join(root, "ClosedSource/DSX/Modules/Config/routes.json"), "utf8")) as {
    routes: Array<{ path: string; component?: string }>;
  };
  assert.deepEqual(
    routes.routes.find((route) => route.path === "/workspace"),
    { path: "/workspace", component: "demo.Workspace", meta: { title: "Release workspace — DSX reference" } },
  );
});
