// Real-engine proof that `despia edit` serves a WORKING editor, not a shell that renders.
//
// The editor is a DSX app the CLI compiles and serves (M1), and every panel in it is fed by
// an endpoint (M5). Both halves fail silently when they fail: a 404 behind the tree renders
// the same empty state as a document with no elements, and a prop that never arrives renders
// an empty field rather than an error. Neither is visible from a unit test of either side.
//
// So this drives the real loop in a real engine, against a real temporary project: open the
// page, list its documents, open one, read the tree, select an element, retype a property,
// and then assert the FILE ON DISK. The last step is the one that matters — the editor's
// whole claim is that the code is the single source of truth (M4), and a visual gesture that
// does not reach the bytes is a mockup no matter how well it renders.
//
//   npm run browser:editor                (chromium)
//   DSX_BROWSER=webkit npm run browser:editor

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const APP = `<stack class="shell" style="gap: 1rem">
  <head>
    <action as="settle">
      let sum = 0
      for (const row of rows) {
        if (row.paid) {
          sum = sum + row.amount
        } else {
          skipped = skipped + 1
        }
      }
      return sum
    </action>
  </head>
  <hstack class="bar">
    <text value="Title"/>
    <button label="Go"/>
  </hstack>
  <row href="/detail"/>
</stack>
`;

const engine = browserEngine();
const errors: string[] = [];
const check = (ok: boolean, label: string): void => { if (!ok) errors.push(label); };

const root = mkdtempSync(join(tmpdir(), "dsx-editor-oracle-"));
for (const [path, contents] of Object.entries({
  "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
  // ROUTED, because the map is the shell's landing view and an unrouted project has no
  // reachable surface to draw. Two routes and one orphan is the smallest fixture that
  // exercises every state the canvas has: a root, a target, an edge, and dead code.
  "dsx.config.json": JSON.stringify({
    name: "Fixture",
    entry: "App",
    routes: [{ path: "/", component: "fix.App" }, { path: "/detail", component: "fix.Detail" }],
  }),
  "Components/App.dsx": APP,
  "Components/Detail.dsx": `<stack><text value="detail screen"/></stack>\n`,
  "Components/Other.dsx": `<stack><text value="second"/></stack>\n`,
  // A backend, because "click a route, see its logic" is the seam between the two views and
  // a seam nothing crosses in a test is a seam that breaks quietly.
  "server/notes.dsx": `<server>
  <head>
    <entity as="note" ownership="owner">
      <field as="title" type="text"/>
    </entity>
    <entity as="tag" ownership="public-read">
      <field as="label" type="text"/>
    </entity>
    <action as="digest" inputs="since">
      let count = 0
      for (const note of notes) {
        count = count + 1
      }
      return count
    </action>
  </head>
  <route as="digest" method="GET" path="/digest" action="digest" auth="required"/>
  <route as="tags" method="GET" path="/tags" entity="tag" op="list"/>
</server>
`,
})) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const base = `http://127.0.0.1:${server.port}`;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage();
  const noise: string[] = [];
  page.on("pageerror", (e) => noise.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => { if (m.type() === "error") noise.push(`console.error: ${m.text()}`); });
  // A failed build serves a page rather than an error, so a broken fixture would otherwise
  // read as a working one with odd content. Any 4xx/5xx is noise, and noise is a failure.
  page.on("response", (r) => { if (r.status() >= 400) noise.push(`http ${r.status()} ${r.url()}`); });

  const leaves = (): Promise<string[]> => page.evaluate(() =>
    Array.from(document.querySelectorAll("span,p,div,button"))
      .filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 0)
      .map((e) => (e.textContent ?? "").trim()));

  // `load`, not `networkidle`: the map's live renders are iframes onto the dev server, which
  // holds an SSE reload channel open for as long as the page exists. Network idle is a state
  // this page is designed never to reach.
  //  The URL carries this run's admission credential exactly as the command prints it; the
  //  308 to /edit/ then rides the cookie the mount set, which is the real browser path.
  const res = await page.goto(`${base}/edit?token=${encodeURIComponent(server.admission)}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".map-node").length > 0, null, { timeout: 15000 });
  // A node in the DOM is not a node that answers yet: the map arrives from an <api> block and
  // its handlers are wired on the pass after the rows first appear. Clicking in that gap is a
  // click that lands on nothing, which reads exactly like a broken handler.
  await page.waitForTimeout(1200);
  check(res?.status() === 200, `/edit answered ${res?.status()}`);
  // /edit must land on /edit/: the document addresses its runtime relatively, so the missing
  // slash would resolve every module against the developer's project instead of the editor.
  check(page.url().endsWith("/edit/"), `/edit did not redirect to /edit/ (${page.url()})`);
  check(await page.title() === "Despia Studio", `title was ${JSON.stringify(await page.title())}`);

  const shell = await leaves();
  // THE SHELL, AS STRUCTURE FIRST AND COPY SECOND. Asserting each word on its own turned one
  // rename into six failures that each said "never rendered X" and none of which said what
  // the screen actually held - and the wall of them buried the real defects underneath. The
  // landmarks are checked by their own handles, and the copy is ONE assertion that prints
  // both sides, so a deliberate rename is a one-line diff to make here.
  check(await page.locator('img[alt="Despia"], [aria-label="Despia"]').count() > 0,
    "the brand mark is not on the shell");
  const missing = ["Screens", "Components", "App", "Detail", "Other"].filter((w) => !shell.includes(w));
  check(missing.length === 0,
    `the shell is missing ${JSON.stringify(missing)}. It rendered ${JSON.stringify(shell.slice(0, 40))}. `
    + `These are LANDMARKS, not decoration: a rename is fine, but it belongs in this line too.`);
  check(!shell.some((t) => t.includes(".dsx")), `a file extension leaked into the UI: ${JSON.stringify(shell.filter((t) => t.includes(".dsx")))}`);

  // ── THE MAP (02-canvas.md) ────────────────────────────────────────────────────────────
  //
  //  The shell lands on the map, because "what IS this project" is the question a folder
  //  cannot answer at all. Every assertion below is a fact DERIVED from the fixture's own
  //  source: nothing here is authored, positioned or stored, so a wrong map is a bug in the
  //  extractor rather than a stale drawing somebody forgot to update.
  for (const expected of ["App", "Detail", "Other", "ROUTE", "COMPONENT", "3 surfaces"]) {
    check(shell.includes(expected), `the map never rendered ${JSON.stringify(expected)}`);
  }

  // The nodes are PLACED, and placed apart. A map whose nodes all sit at the origin renders
  // as one node and passes every text assertion above.
  const boxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".map-node")).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    }));
  check(boxes.length === 3, `the map drew ${boxes.length} nodes, not 3`);
  check(new Set(boxes.map((b) => `${b.x},${b.y}`)).size === 3, `nodes overlap: ${JSON.stringify(boxes)}`);
  check(boxes.every((b) => b.w > 0), `a node had no width: ${JSON.stringify(boxes)}`);

  // The edge layer is a real raster, not an empty element. `App -> Detail` comes from the
  // fixture's own `href`, so a blank canvas here means the edge never reached the display list.
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector(".map-edges canvas") ?? document.querySelector(".map-edges");
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return -2;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit += 1;
    return lit;
  });
  check(painted > 0, `the edge layer painted nothing (${painted})`);

  // Selecting a surface opens the detail panel and traces how anyone GETS there. `Detail` is
  // reached from `App` by a tap, and the pill is derived from the handler the call sits in.
  // Scoped to the world: the navigator now shows a row with the same name, and clicking that
  // would open the document instead of selecting the node.
  await page.locator(".map-name", { hasText: "Detail" }).first().click();
  await page.waitForTimeout(400);
  const traced = await leaves();
  check(traced.includes("TAP"), `the gesture pill never appeared: ${JSON.stringify(traced.slice(0, 20))}`);
  // The copy pluralises, so the singular is "1 surface leads here." - the oracle asserted the
  // plural stem and the missing full stop, which made a correct sentence look like a defect.
  check(traced.includes("1 surface leads here."),
    `the detail panel did not report reachability: ${JSON.stringify(traced.slice(0, 30))}`);
  check(traced.includes("Open in editor"), "the detail panel has no way into the document");

  // The map hands the shell a FILE, and the shell opens it - the same entry point the rail uses.
  await page.getByText("Open in editor", { exact: true }).click();
  await page.waitForTimeout(600);
  check(
    (await page.evaluate(() => document.querySelectorAll(".map-node").length)) === 0,
    "opening a surface from the map left the map showing",
  );
  // The three views are a segmented control in the bar now, one per question the studio
  // answers: what is this project, what does this screen look like, what does this code do.
  await page.getByRole("button", { name: "Map view" }).click();
  await page.waitForTimeout(400);
  check(
    (await page.evaluate(() => document.querySelectorAll(".map-node").length)) === 3,
    "switching back to Map did not bring the map back",
  );

  await page.locator(".studio-doc", { hasText: "App" }).first().click();
  await page.waitForTimeout(1000);
  const tree = await leaves();
  // The tree is the real element tree, labelled by what the author WROTE (M3) - never a
  // generated name. `Text "Title"` and `Button "Go"` are the fixture's own attributes, and
  // the kinds read as NAMES rather than tags (`hstack` is a Row) because a visual editor
  // shows the reader the thing, not its spelling in the file.
  for (const expected of ["Stack", "shell", "Row", "bar", "Text", "Title", "Button", "Go"]) {
    check(tree.includes(expected),
      `the tree never rendered ${JSON.stringify(expected)}. It rendered ${JSON.stringify(tree.slice(0, 30))}`);
  }

  // ── THE ADD PANEL: an element tile is one insertNode into the file ────────────────────
  //
  //  Runs BEFORE any selection: with nothing selected the insert targets the root, which is
  //  a paired tag. (Inserting into a selected self-closing leaf is REFUSED by the surgery
  //  engine, visibly - not guessed around.)
  await page.getByRole("button", { name: "Add elements" }).click();
  await page.waitForTimeout(600);
  const addPanel = await leaves();
  check(addPanel.includes("Add to Stack"), `the add panel never opened: ${JSON.stringify(addPanel.slice(0, 30))}`);
  for (const expected of ["Layout", "Display", "Input"]) {
    check(addPanel.includes(expected), `the add panel never rendered category ${JSON.stringify(expected)}`);
  }
  check(!addPanel.some((t) => t.endsWith(".dsx")), "a file name leaked into the add panel");
  await page.locator(".elem-tile", { hasText: "Button" }).first().click();
  await page.waitForTimeout(800);
  const added = readFileSync(join(root, "Components/App.dsx"), "utf8");
  check(added.includes('<button value="Button"/>'), `the element insert did not land: ${JSON.stringify(added)}`);
  check(
    (await page.evaluate(() => document.querySelectorAll(".elem-tile").length)) === 0,
    "the add panel did not close after inserting",
  );

  // ── THE STYLE PANEL ───────────────────────────────────────────────────────────────────
  await page.getByText("Title", { exact: true }).first().click();
  await page.waitForTimeout(600);
  const inspector = await leaves();
  check(inspector.includes("Style") && inspector.includes("Attributes"),
    `the style panel tabs are missing: ${JSON.stringify(inspector.slice(0, 40))}`);
  // SET-ONLY BY DEFAULT, THE CATALOG ONE PRESS AWAY. The panel opens showing what this
  // element actually decides plus the padding ring; the rest of the vocabulary is closed, not
  // hidden, behind a row that says how much of it there is. So the oracle opens it, which is
  // also the only way to reach a property the element has never set.
  await page.getByText("All properties", { exact: true }).click();
  await page.waitForTimeout(400);
  const expanded = await leaves();
  for (const expected of ["Size", "Padding", "Typography"]) {
    check(expanded.includes(expected),
      `the style panel never rendered ${JSON.stringify(expected)}: ${JSON.stringify(expanded.slice(0, 60))}`);
  }

  // A STYLE WRITE lands as ONE declaration in the file - the panel edits DSX, nothing else.
  //
  // SCOPED TO THE ROW, not indexed across every input on the page. The previous lookup asked
  // each input for its closest hstack and matched on that box's text, but a value well is
  // ITSELF an hstack, so `closest` returned the well and its text starts with the value. The
  // index it produced pointed at some other control, and the write landed on `offsetY` while
  // the failure said "the write did not land" - a wrong-target bug wearing a missing-target
  // message. Find the LABEL, walk up to the row that owns it, take the input inside that row.
  const widthRow = page.locator(".inspect-props > *").filter({
    has: page.locator(".inspect-prop-label", { hasText: /^Width$/ }),
  }).first();
  check(await widthRow.count() > 0, "no Width control on the style panel");
  const width = widthRow.locator("input").first();
  await width.fill("200px");
  await width.press("Enter");
  await width.blur();
  await page.waitForTimeout(800);
  const styled = readFileSync(join(root, "Components/App.dsx"), "utf8");
  check(styled.includes('style="width: 200px"'), `the style write did not land: ${JSON.stringify(styled)}`);

  // The inspector's three tabs, BY POSITION and asserted BY NAME. Reaching a tab through
  // getByText left this oracle dead for two days when the words were renamed: a 30-second
  // Playwright timeout says nothing about which label moved, so the failure read as "the
  // editor hangs" rather than "a tab was renamed". Position is the stable handle; the words
  // are then checked as their own assertion, which fails in one line and names both sides.
  const tabs = page.locator(".inspect-tabbtn");
  const tabNames = await tabs.allInnerTexts();
  check(tabNames.length === 3 && tabNames[0]!.trim() === "Style"
        && tabNames[1]!.trim() === "Attributes" && tabNames[2]!.trim() === "Actions",
    `the inspector's tabs are ${JSON.stringify(tabNames)}; this oracle drives them by `
    + `position and expects Style / Attributes / Actions. If they were renamed on purpose, `
    + `rename them here in the same commit.`);
  // The attributes tab: the element's own attributes, current values shown, edits spliced.
  await tabs.nth(1).click();
  await page.waitForTimeout(400);
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => i.value));
  check(fields.includes("Title"), `the property field was ${JSON.stringify(fields)}, not the current value`);
  const valueIndex = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).findIndex((i) => i.value === "Title"));
  const input = page.locator("input").nth(valueIndex);
  await input.fill("Renamed by the editor");
  await input.press("Enter");
  await input.blur();
  await page.waitForTimeout(800);

  // THE ASSERTION THE WHOLE FILE EXISTS FOR: the bytes moved, and ONLY the bytes that had
  // to - byte-exact against the file as it stood before this one edit.
  const after = readFileSync(join(root, "Components/App.dsx"), "utf8");
  check(
    after === styled.replace('value="Title"', 'value="Renamed by the editor"'),
    `a visual edit did not land as a one-line splice:\n${JSON.stringify(after)}`,
  );

  // ── THE LOGIC CANVAS: node-based development, true to the code ────────────────────────
  //
  //  One block per step, in human language; the loop is a LITERAL loop (a labelled back
  //  edge re-entering its head); every connector carries a + that knows where it splices.
  //  What is asserted is truth and the round trip, not pixels.
  await page.getByRole("button", { name: "Logic view" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".logic-bodies").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const logicIndex = await leaves();
  check(logicIndex.includes("settle"), `the logic index never listed the action: ${JSON.stringify(logicIndex.slice(0, 20))}`);

  await page.getByText("settle", { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".logic-node").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(800);

  const nodes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".logic-node")).map((e) => ({
      title: (e.querySelector(".logic-node-title")?.textContent ?? "").trim(),
      sub: (e.querySelector(".logic-node-sub")?.textContent ?? "").trim(),
    })));
  const titles = nodes.map((n) => n.title);
  for (const expected of ["For Each Loop", "If", "Set Variable", "Return"]) {
    check(titles.includes(expected), `no ${JSON.stringify(expected)} block: ${JSON.stringify(titles)}`);
  }
  // With argument rows on the card, the loop names its data in the Items row.
  const rowValues = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".logic-row-text")).map((e) => (e.textContent ?? "").trim()));
  check(rowValues.includes("rows"), `the loop's Items row is empty: ${JSON.stringify(rowValues)}`);

  // The lanes ride their connectors; the loop is a CONTAINER, not a back edge.
  const lanes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".logic-lane-label")).map((e) => (e.textContent ?? "").trim()));
  check(lanes.includes("Then"), `no Then lane: ${JSON.stringify(lanes)}`);
  check(
    (await page.evaluate(() => document.querySelectorAll(".logic-loop-frame").length)) === 1,
    "the loop container is not drawn",
  );
  // The argument rows: the statement's own expressions, rendered inside the card.
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".logic-row-name")).map((e) => (e.textContent ?? "").trim()));
  check(rows.includes("Name") && rows.includes("Value"), `no argument rows: ${JSON.stringify(rows)}`);
  check(rows.includes("Items"), `the loop card has no Items row: ${JSON.stringify(rows)}`);
  check(rows.includes("Condition"), `the If card has no Condition row: ${JSON.stringify(rows)}`);
  // The wires are Connector components now - at least one canvas per edge painted.
  const wires = await page.evaluate(() => document.querySelectorAll(".flow-connector").length);
  check(wires >= 4, `too few connector wires: ${wires}`);

  // EVERY connector carries a +. Pressing one opens the searchable picker; choosing Log
  // splices dsx.log at that connector's own offset - the file is the model.
  const pluses = await page.evaluate(() => document.querySelectorAll(".logic-plus").length);
  check(pluses >= 4, `too few insertion points: ${pluses}`);
  await page.locator(".logic-plus").first().click();
  await page.waitForTimeout(400);
  const picker = await leaves();
  check(picker.includes("Set Variable") && picker.includes("Go To Page"), `the picker is not offering the vocabulary: ${JSON.stringify(picker.slice(0, 30))}`);
  await page.locator(".logic-pick", { hasText: "Log" }).first().click();
  await page.waitForTimeout(900);
  const inserted = readFileSync(join(root, "Components/App.dsx"), "utf8");
  check(inserted.includes("dsx.log('message')"), `the node insert did not land: ${JSON.stringify(inserted)}`);
  check(
    (await page.evaluate(() =>
      Array.from(document.querySelectorAll(".logic-node-title")).filter((e) => (e.textContent ?? "").trim() === "Log").length)) > 0,
    "the inserted node did not come back drawn",
  );

  // And the surface is not claiming to be an editor over a projection that cannot round-trip.
  check(
    (await page.evaluate(() => document.querySelectorAll(".logic-warn").length)) === 0,
    "the logic canvas reported that the body did not round-trip",
  );

  // ── THE BACKEND VIEW, and the seam into the logic canvas ──────────────────────────────
  //
  //  A backend here is a document, so this view is a projection like every other. A route
  //  with no auth is named PUBLIC rather than left blank, and clicking a route's action
  //  lands on that action in the SAME logic editor the frontend uses.
  await page.getByRole("button", { name: "Server view" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".server-row").length > 0
    || document.querySelectorAll(".editor-rail").length > 0, null, { timeout: 15000 });
  await page.getByText("Notes", { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".server-row").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(400);

  const backend = await leaves();
  for (const expected of ["/digest", "/tags", "required", "tag · list"]) {
    check(backend.includes(expected), `the backend view never rendered ${JSON.stringify(expected)}`);
  }
  check(!backend.some((t) => t.endsWith(".dsx")), "a file name leaked into the backend view");
  // Absent auth is PUBLIC and says so. This is the assertion that earns the view its place.
  check(backend.includes("public"), `a route with no auth was not named public: ${JSON.stringify(backend)}`);

  // The permission surface is in the bar rather than behind a tab, and an undeclared egress
  // says the backend cannot call out at all.
  check(backend.includes("cannot call out"), "the egress state is not on screen");

  // The backend's three tabs, BY POSITION and asserted BY NAME, for the same reason the
  // inspector's are: this oracle sat red for two days because "Data" became "Entities" and a
  // getByText timeout cannot say so. The counts ride the label, so the assertion is a prefix
  // match and a rename still fails loudly while a changed count does not.
  const srvTabs = page.locator(".server-tabs .editor-view, .editor-view").filter({ hasText: /^(Routes|Entities|Workers) \d+$/ });
  const srvNames = (await srvTabs.allInnerTexts()).map((t) => t.trim().replace(/ \d+$/, ""));
  check(srvNames.join("/") === "Routes/Entities/Workers",
    `the backend's tabs are ${JSON.stringify(srvNames)}; this oracle drives them by position `
    + `and expects Routes / Entities / Workers. If they were renamed on purpose, rename them `
    + `here in the same commit.`);
  // The data view: ownership is drawn, and no relation is invented.
  await srvTabs.nth(1).click();
  await page.waitForTimeout(300);
  const data = await leaves();
  check(data.includes("note") && data.includes("owner"), `the data view: ${JSON.stringify(data.slice(0, 20))}`);
  check(data.includes("public-read"), "a wide ownership is not on screen");
  // The note used to read "No relations declared", which says the schema HAS none yet and
  // implies you could add one. You cannot: the vocabulary is a closed set of scalars, so the
  // absence is structural, and the trap it protects against is a column named author_id that
  // looks like a key and is not.
  check(data.some((t) => t.includes("No relation is drawn") && t.includes("author_id")),
    `the view does not say what it omits, or why: ${JSON.stringify(data.slice(0, 30))}`);

  // THE SEAM. A route answered by an action is a link, and following it lands on that action
  // in the logic canvas - one product, ONE editor for both surfaces.
  await srvTabs.nth(0).click();
  await page.waitForTimeout(300);
  await page.getByText("digest", { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".logic-node").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const serverRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".logic-row-text")).map((e) => (e.textContent ?? "").trim()));
  check(
    serverRows.includes("notes"),
    `following a route did not draw its action's loop: ${JSON.stringify(serverRows)}`,
  );

  // Page noise is a finding, not decoration: a 404 behind a panel shows up here and nowhere
  // else. Hydration mismatches are excluded — they are reported, fail-open, by design.
  const real = noise.filter((n) => !n.includes("[dsx hydrate]"));
  check(real.length === 0, `the editor logged ${real.length}: ${real.slice(0, 3).join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

if (errors.length > 0) {
  console.error(`editor (${engine}): ${errors.length} failure(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`editor (${engine}): served, listed, opened, mapped, drew the logic, inspected and WROTE THE FILE — all green`);
