// THE APP PLATFORM, PHOTOGRAPHED AND COUNTED (studio-apps.md, the T-wave proof).
//
// A real project installs a THIRD-PARTY demo app (dev tier, built on StudioKit) beside the
// preinstalled first-party ones, and the walk captures every surface the program promised:
// the installed panel, the marketplace with its search, the consent detail column, the
// Marketing Studio's Distribution rail (a converted first-party app riding its own
// identity), the demo app's shadow-mounted rail surface under the provenance strip, and
// the style panel carrying an app-contributed section. Beside the pictures, two censuses:
// the RAIL IDENTITY pin (the fold's row ids, exactly) and the unmapped-icon net the
// surface walk already runs.
//
//   SHOTS=/tmp/studio-apps node packages/dom/oracle/studio-apps-browser.ts

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { execFileSync } from "node:child_process";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const OUT = process.env["SHOTS"] ?? "/tmp/studio-apps";
mkdirSync(OUT, { recursive: true });

// ── the fixture: a project + a third-party demo app, dev tier ──────────────────────────

// THE THIRD-PARTY APP IN THIS WALK IS THE SHIPPED REFERENCE APP (OpenSource/StudioKit/
// example), copied into the fixture rather than restated here. A fixture that restated it
// would drift from the package an author is handed, and then the proof set would be
// pictures of something nobody can install.

const APP = `<stack grow="true" style="gap: 1rem; padding: 1.25rem">
  <head>
    <variable as="rows">return [{ id: 1, name: 'Aster' }, { id: 2, name: 'Bramble' }]</variable>
  </head>
  <text value="Orders" style="font-size: 1.0625rem; font-weight: 600"/>
  <list bind="rows" key="id">
    <text value="{{ item.name }}"/>
  </list>
  <button label="Refresh"/>
</stack>
`;

const root = mkdtempSync(join(tmpdir(), "dsx-apps-oracle-"));
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
  "dsx.config.json": JSON.stringify({
    name: "Shop", entry: "Orders",
    packages: ["packages/copy"],
    routes: [{ path: "/", component: "shop.Orders" }],
  }),
  "Components/Orders.dsx": APP,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

// the reference app, verbatim from the package this repo ships
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "OpenSource/StudioKit/example/dsx.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/StudioKit/example not found");
    dir = parent;
  }
}
cpSync(join(repoRoot(), "OpenSource/StudioKit/example"), join(root, "packages/copy"), { recursive: true });

//  A REAL REPOSITORY. The change plane is not a simulation the panel draws: an app write in
//  this walk becomes an actual commit in an actual git repository, and the Changes tab is
//  photographed reading it back. `work` is deliberately not a protected branch, so the local
//  lane is the one exercised here (the structural lane has its own repository tests).
for (const args of [
  ["init", "-q", "-b", "work", "."],
  ["config", "user.email", "oracle@despia.test"],
  ["config", "user.name", "Oracle"],
  ["add", "."],
  ["commit", "-qm", "the project before any app touched it"],
]) execFileSync("git", args, { cwd: root });

const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const browser = await launchBrowser(browserEngine());
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const unmapped = new Set<string>();
page.on("console", (m) => {
  const hit = /unmapped icon '([^']+)'/.exec(m.text());
  if (hit !== null) unmapped.add(hit[1]!);
});

let failures = 0;
const fail = (what: string): void => { failures += 1; console.log(`  FAIL: ${what}`); };

async function shot(name: string): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`shot ${name}`);
}

async function tapByRole(name: string, what: string): Promise<boolean> {
  const b = page.getByRole("button", { name }).first();
  if (await b.count() === 0 || !await b.isVisible().catch(() => false)) { fail(`${what} is absent`); return false; }
  try { await b.click({ timeout: 4000 }); return true; } catch { fail(`${what} is not clickable`); return false; }
}

try {
  await page.goto(`http://127.0.0.1:${server.port}/edit/?token=${encodeURIComponent(server.admission)}`, { waitUntil: "load" });
  await page.waitForTimeout(2800);

  // ── THE RAIL IDENTITY PIN: the fold's rows, exactly — first- and third-party in ONE
  //    lane, the census move + the conversion + the dev app, all through /edit/api/apps ──
  const plane = await page.evaluate(async () =>
    (await (await fetch("/edit/api/apps", { credentials: "same-origin" })).json()) as unknown);
  type Lane = Array<{ app: string; contribution: { id: string } }>;
  const table = (plane as { table?: { rail: Lane; panels: Lane } }).table;
  if (table === undefined) {
    fail(`the apps plane did not answer with a table: ${JSON.stringify(plane).slice(0, 200)}`);
  }
  const name = (lane: Lane | undefined): string[] => (lane ?? []).map((r) => `${r.app}#${r.contribution.id}`);
  const rail = name(table?.rail);
  const panels = name(table?.panels);
  // THE PLACEMENT CENSUS. Full-window destinations and docked panels are separate lanes of
  // ONE fold: the Studio's own nine, the converted first-party app, and the third party's
  // panel — nobody is privileged, and the lane a row lands in is the manifest's word.
  const EXPECTED_RAIL = [
    "editor#map", "editor#screen", "editor#state", "editor#logic", "editor#theme",
    "editor#strings", "editor#chat", "editor#tools", "editor#server", "marketing#shots",
  ];
  const EXPECTED_PANELS = ["copy#panel"];
  if (JSON.stringify(rail) !== JSON.stringify(EXPECTED_RAIL)) fail(`the rail census moved: ${JSON.stringify(rail)}`);
  if (JSON.stringify(panels) !== JSON.stringify(EXPECTED_PANELS)) fail(`the panel census moved: ${JSON.stringify(panels)}`);
  if (rail.length === EXPECTED_RAIL.length && panels.length === EXPECTED_PANELS.length) {
    console.log(`placement census: ${rail.length} full-window + ${panels.length} docked, one fold, as pinned`);
  }

  // ── the installed panel ──
  if (await tapByRole("Apps view", "the Apps rail row")) await page.waitForTimeout(1200);
  await shot("01-apps-installed");
  if (await page.getByText("Marketing Studio").count() === 0) fail("the installed list does not show Marketing Studio");
  if (await page.getByText("Copy").count() === 0) fail("the installed list does not show Copy");

  // ── the marketplace, searched ──
  if (await tapByRole("Marketplace", "the Marketplace tab")) await page.waitForTimeout(900);
  await shot("02-apps-market");
  const search = page.getByPlaceholder("Search apps").first();
  if (await search.count() > 0) {
    await search.fill("copy");
    await page.waitForTimeout(900);
    await shot("03-apps-market-search");
    if (await page.locator(".apps-card").count() !== 1) fail("the search did not narrow the grid to Copy");
  } else fail("the marketplace search field is absent");

  // ── the consent detail column ──
  const card = page.locator(".apps-card").first();
  if (await card.count() > 0) {
    await card.click({ timeout: 4000 }).catch(() => fail("the Copy card is not clickable"));
    await page.waitForTimeout(700);
    await shot("04-apps-detail");
    if (await page.getByText("See what you have selected").count() === 0) {
      fail("the detail column does not speak the selection:read grant sentence");
    }
  }

  // ── the Marketing Studio's Distribution: a converted app, its own identity, boot pane ──
  if (await tapByRole("Distribution view", "the Distribution rail row")) await page.waitForTimeout(1800);
  await shot("05-distribution");

  // ── open a real screen first: a docked panel's whole point is that the work you were
  //    doing keeps rendering beside it, so a panel photographed over an empty stage would
  //    prove the opposite of the placement law ──
  if (await tapByRole("Map view", "the Map rail row")) await page.waitForTimeout(1400);
  const mapCard = page.locator(".map-name").filter({ hasText: "Orders" }).first();
  if (await mapCard.count() > 0) { await mapCard.click({ timeout: 4000 }).catch(() => fail("the Orders card")); await page.waitForTimeout(700); }
  const open = page.getByText("Open in editor", { exact: true }).first();
  if (await open.count() > 0) { await open.click({ timeout: 4000 }).catch(() => fail("Open in editor")); await page.waitForTimeout(2400); }

  // ── THE DOCKED PANEL: preview on the left, plugin on the right, both live ──
  if (await tapByRole("Copy view", "the Copy rail row")) await page.waitForTimeout(2600);
  await shot("06-panel-docked");
  const strip = await page.getByText("Copy", { exact: true }).count();
  if (strip === 0) fail("the provenance strip does not name the app");
  const inShadow = await page.evaluate(() => {
    const host = document.querySelector("[data-dsx-app='copy']");
    const sr = host?.shadowRoot ?? null;
    if (host === null || sr === null) return { mounted: false, width: 0, rows: 0, dark: "" };
    const pane = sr.querySelector(".sk-panel");
    const box = host.getBoundingClientRect();
    return {
      mounted: (sr.textContent ?? "").includes("Orders"),
      width: Math.round(box.width),
      // the plugin read the project through its granted seam: one row per document
      rows: sr.querySelectorAll(".sk-row").length,
      dark: pane === null ? "" : getComputedStyle(pane).backgroundColor,
    };
  });
  if (!inShadow.mounted) fail("the Copy panel did not render inside its shadow root");
  if (inShadow.rows < 1) fail("the plugin listed no documents — its project:read seam returned nothing");
  if (inShadow.width < 300) fail(`the docked panel is ${inShadow.width}px wide — a plugin column is a column, not a box`);
  // the kit follows the Studio's theme: a light panel inside a dark Studio is the defect
  // the shadow-root token mirror exists to prevent
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(inShadow.dark);
  if (rgb !== null && Number(rgb[1]) > 120) fail(`the panel ground is ${inShadow.dark} — the app did not follow the Studio's dark theme`);
  console.log(`docked panel: ${inShadow.width}px, ${inShadow.rows} document row(s), ground ${inShadow.dark}`);

  // ── the layout the placement exists for: preview, agent and plugin, all at once ──
  if (await tapByRole("Agent view", "the Agent rail row")) await page.waitForTimeout(1200);
  if (await tapByRole("Screen view", "the Screen rail row")) await page.waitForTimeout(1600);
  await shot("07-preview-agent-panel");

  // ── promote the panel to the full window, then dock it back ──
  const expand = page.getByRole("button", { name: /^Expand Copy/ }).first();
  if (await expand.count() > 0) {
    await expand.click({ timeout: 4000 }).catch(() => fail("the expand control"));
    await page.waitForTimeout(2400);
    await shot("08-panel-expanded");
    const wide = await page.evaluate(() => {
      const host = document.querySelector("[data-dsx-app='copy']");
      return host === null ? 0 : Math.round(host.getBoundingClientRect().width);
    });
    if (wide < 700) fail(`the promoted panel is only ${wide}px — expand did not hand it the work area`);
    else console.log(`promoted: ${wide}px of work area`);
    const dock = page.getByRole("button", { name: /^Dock Copy/ }).first();
    if (await dock.count() === 0) fail("the promoted panel offers no way back to the dock");
    else { await dock.click({ timeout: 4000 }).catch(() => fail("the dock control")); await page.waitForTimeout(1800); }
  } else fail("the docked panel has no expand control");

  // ── the style panel carrying the app's contributed section ──
  if (await tapByRole("Screen view", "the Screen rail row")) await page.waitForTimeout(1600);
  const row = page.locator(".tree-row").nth(2);
  if (await row.count() > 0) { await row.click({ timeout: 4000 }).catch(() => fail("no tree row")); await page.waitForTimeout(1800); }
  //  the app's section lives in the INSPECTOR, beside the element's own attributes, because
  //  the words an element shows are its data rather than its styling
  const attrs = page.getByRole("button", { name: "Attributes" }).first();
  if (await attrs.count() > 0) { await attrs.click({ timeout: 4000 }).catch(() => fail("the Attributes tab")); await page.waitForTimeout(1400); }
  await shot("09-inspector-section");
  if (await page.locator(".app-surface-section").count() === 0) {
    fail("the inspector does not carry the app's contributed section");
  }
  //  A SECTION SITS ON THE PANEL'S RHYTHM. Dead space above a contributed section is the
  //  tell that it is wearing chrome meant for a window, which is what made it read as a
  //  foreign box wedged between the Studio's own sections.
  const sectionGeo = await page.evaluate(() => {
    const surface = document.querySelector(".app-surface-section") as HTMLElement | null;
    const strip = surface?.querySelector(".app-surface-strip") as HTMLElement | null;
    const host = surface?.querySelector("[data-dsx-app]") as HTMLElement | null;
    if (surface === null || strip === null || host === null) return null;
    const s = surface.getBoundingClientRect();
    const surfaceStyle = getComputedStyle(surface);
    return {
      gapAboveStrip: Math.round(strip.getBoundingClientRect().top - s.top),
      gapBelowStrip: Math.round(host.getBoundingClientRect().top - strip.getBoundingClientRect().bottom),
      width: Math.round(s.width),
      padding: surfaceStyle.padding,
      radius: surfaceStyle.borderRadius,
    };
  });
  if (sectionGeo === null) fail("the contributed section did not mount");
  else {
    console.log(`inspector section: ${sectionGeo.width}px wide, ${sectionGeo.gapAboveStrip}px above its name, padding ${sectionGeo.padding}`);
    if (sectionGeo.gapAboveStrip > 4) fail(`${sectionGeo.gapAboveStrip}px of dead space above the section's name — a section sits on the panel's rhythm`);
    //  An unstyled vertical list is an inset GROUPED list by system default, which is right
    //  for a list of things and wrong for a list of app sections: it arrived wearing a card
    //  ring and 10px of row padding that put every contributed section out of step with the
    //  Studio's own. The mount list is named, so the chrome is not inherited.
    if (sectionGeo.padding !== "0px") fail(`the contributed section carries ${sectionGeo.padding} of its own padding — it should sit on the panel's gutter`);
    if (sectionGeo.radius !== "0px") fail(`the contributed section is wearing a ${sectionGeo.radius} card — a section is not a window`);
  }

  // ── THE WRITE, AND WHAT THE HOST MAKES OF IT (§14) ──
  //    The plugin edits a document through its granted seam. Nothing about the plugin knows
  //    that a commit happened — which is exactly why the record can be believed.
  //  the rail row TOGGLES a docked panel, and the walk has opened and docked it already, so
  //  "open it" means "open it if it is not open" rather than "tap it"
  const copyRows = async (): Promise<number> => page.evaluate(() =>
    document.querySelector("[data-dsx-app='copy']")?.shadowRoot?.querySelectorAll(".sk-row").length ?? 0);
  for (let attempt = 0; attempt < 3 && await copyRows() === 0; attempt += 1) {
    await tapByRole("Copy view", "the Copy rail row");
    await page.waitForTimeout(2400);
  }
  if (await copyRows() === 0) fail("the Copy panel would not open for the write step");
  const wrote = await page.evaluate(async () => {
    const host = document.querySelector("[data-dsx-app='copy']");
    const sr = host?.shadowRoot ?? null;
    if (sr === null) return "no shadow root";
    const rows = [...sr.querySelectorAll(".sk-row")] as HTMLElement[];
    const line = rows.find((r) => (r.textContent ?? "").includes("Orders"));
    if (line === undefined) return `the plugin listed no line to edit (${rows.length} row(s): ${rows.map((r) => r.textContent).join(" | ")})`;
    line.click();
    await new Promise((r) => setTimeout(r, 500));
    const field = sr.querySelector("input.sk-input, textarea.sk-input") as HTMLInputElement | null;
    if (field === null) return "the plugin offers no editor for the line it selected";
    //  a bound field is driven the way a person drives it: type, then let the binding see it
    field.value = "Orders, updated by an app";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const buttons = [...sr.querySelectorAll("button, [role='button']")] as HTMLElement[];
    const save = buttons.find((b) => (b.textContent ?? "").includes("Save this line"));
    if (save === undefined) return "the plugin offers no write control";
    save.click();
    return "";
  });
  if (wrote !== "") fail(`the plugin could not write: ${wrote}`);
  await page.waitForTimeout(3000);   // the burst closes on idle, then the plane commits

  const source = readFileSync(join(root, "Components", "Orders.dsx"), "utf8");
  if (!source.includes("Orders, updated by an app")) fail("the plugin's edit did not reach the document");
  const log = execFileSync("git", ["log", "--format=%s%n%b"], { cwd: root, encoding: "utf8" });
  if (!/copy: edit Components\/Orders\.dsx/.test(log)) fail(`no commit for the app's edit:\n${log.slice(0, 400)}`);
  if (!/Despia-App: copy@1\.0\.0/.test(log)) fail("the commit carries no app trailer");
  console.log(`the change plane committed: ${log.split("\n")[0]}`);

  // ── the Changes tab: the record, the commit, and the control that undoes it ──
  if (await tapByRole("Apps view", "the Apps rail row")) await page.waitForTimeout(1200);
  if (await tapByRole("Changes apps made", "the Changes tab")) await page.waitForTimeout(1400);
  await shot("10-apps-changes");
  const changes = await page.locator(".apps-change").count();
  if (changes < 1) fail("the Changes tab shows no change for an edit that was committed");
  if (await page.getByText("committed", { exact: true }).count() === 0) fail("the change is not marked committed");

  // ── revert: the bytes come back, and the undo is itself a recorded change ──
  const revert = page.getByRole("button", { name: "Revert this change" }).first();
  if (await revert.count() === 0) fail("a change offers no Revert control");
  else {
    await revert.click({ timeout: 4000 }).catch(() => fail("the Revert control"));
    await page.waitForTimeout(2200);
    await shot("11-apps-reverted");
    const after = readFileSync(join(root, "Components", "Orders.dsx"), "utf8");
    if (after.includes("Orders, updated by an app")) fail("Revert did not restore the document");
    else console.log("revert: the document is back to its pre-app bytes");
    if (await page.locator(".apps-change").count() < 2) fail("the revert did not record itself as a change");
  }

  // ── THE AFFIRMATIVE ACT: disable the app, and the enable control stays inert until a
  //    person has agreed to the permissions in a sentence with the app's name in it ──
  if (await tapByRole("Installed", "the Installed tab")) await page.waitForTimeout(900);
  const copyRow = page.locator(".apps-row").filter({ hasText: "Copy" }).first();
  if (await copyRow.count() > 0) {
    await copyRow.click({ timeout: 4000 }).catch(() => fail("the Copy row"));
    await page.waitForTimeout(700);
    if (await tapByRole("Disable", "the Disable control")) await page.waitForTimeout(1200);
    await shot("12-consent");
    const agree = page.getByRole("button", { name: "I agree to these permissions" }).first();
    if (await agree.count() === 0) fail("a disabled app offers no consent act");
    else {
      const cta = page.getByRole("button", { name: /^Allow 3 permissions/ }).first();
      if (await cta.count() === 0) fail("the consent button does not name the permission count");
      else {
        const inertBefore = await cta.isDisabled().catch(() => false);
        if (!inertBefore) fail("the enable control is live before anyone agreed to anything");
        await agree.click({ timeout: 4000 }).catch(() => fail("the agree checkbox"));
        await page.waitForTimeout(500);
        await shot("13-consent-agreed");
        if (await cta.isDisabled().catch(() => true)) fail("agreeing did not release the enable control");
        else console.log("consent: inert until agreed, live after");
      }
    }
  } else fail("the installed list has no Copy row to consent to");
} finally {
  await ctx.close();
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

if (unmapped.size > 0) fail(`unmapped icon(s): ${[...unmapped].join(", ")}`);
console.log(failures === 0
  ? `studio-apps-browser: OK — ${OUT} carries the proof set`
  : `studio-apps-browser: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
