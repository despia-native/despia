// EVERY SURFACE OF THE STUDIO, CAPTURED AND COUNTED.
//
// A design defect is only expensive when nobody looks. The Studio has nine views, four
// panels and two node canvases, and a change to a shared token or a shared rule reaches all
// of them - so a pass that reviews one surface and ships is a pass that shipped fifteen
// unreviewed ones. This walks the lot against a realistic project, screenshots each, and
// reports a CENSUS of the design decisions actually rendered on it: how many hues are in
// play, how many distinct type sizes, how many radii, how many box-shadows, how many
// elements carry a coloured top-edge strip.
//
// The census is the point. A number that moves when nobody meant to move it is the whole
// value of writing it down.
//
//   SHOTS=/tmp/studio node packages/dom/oracle/studio-surfaces-browser.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const OUT = process.env["SHOTS"] ?? "/tmp/studio";
mkdirSync(OUT, { recursive: true });

const APP = `<stack class="page" grow="true" style="gap: 1rem; padding: 1.25rem">
  <head>
    <variable as="query">return ''</variable>
    <variable as="onlyOpen">return true</variable>
    <variable as="rows">return [{ id: 1, name: 'Aster', status: 'open', total: 42.5, qty: 2 },
      { id: 2, name: 'Bramble', status: 'paid', total: 19, qty: 1 }]</variable>
    <variable as="visible" computed="true">
      return rows.filter(r =&gt; !onlyOpen || r.status == 'open')
    </variable>
    <variable as="subtotal" computed="true">
      return rows.reduce((sum, r) =&gt; sum + r.total * r.qty, 0).toFixed(2)
    </variable>
    <!-- THE LOGIC FIXTURE. The canvas draws one mark per STEP, not per category, so a walk
         over a two-statement action proves nothing: this body names every statement family
         the projection classifies, which is what makes a regression in the mark table
         visible in a screenshot. -->
    <!-- THE AGENT FIXTURE (proposals/webmcp.md): one mutating row and one read-only one, so
         the Tools surface is walked with both dispositions on screen. A surface photographed
         empty proves the rail entry exists and nothing else. -->
    <tool action="submit" description="Send an order to the customer." mutates="orders"/>
    <tool as="count-open" action="refresh" description="Refresh and count the open orders."/>
    <action as="refresh">
      const seen = []
      let attempts = 0
      for (const r of rows) {
        attempts = attempts + 1
        if (r.status == 'open') { seen.push(r.id) } else { continue }
        if (attempts &gt; 50) { break }
      }
      rows.forEach(r =&gt; { dsx.log('row ' + r.id) })
      dsx.log('open ' + seen.length)
      dsx.variable.query = ''
      return seen
    </action>
    <action as="submit" id="item.id">
      try {
        dsx.module.share.text({ text: 'Order ' + id })
        dsx.action.refresh()
        dsx.fire('order.sent')
        dsx.broadcast('order.sent')
      } catch (e) {
        dsx.error('share failed')
        throw 'could not share'
      } finally {
        dsx.log('done')
      }
    </action>
    <action as="sync">
      const token = secret.apiKey
      const fresh = dsx.api.orders.list({ since: 0 })
      dsx.data.order.create({ id: 99 })
      dsx.data.order.update({ id: 99 })
      dsx.variable.rows.sort()
      dsx.variable.rows.reverse()
      dsx.variable.rows.unshift({ id: 0 })
      dsx.variable.rows.pop()
      dsx.queue('reindex')
      setTimeout(() =&gt; { dsx.log('later') }, 500)
      dsx.route.push('/detail')
      dsx.route.back()
      return fresh
    </action>
  </head>
  <hstack class="bar" style="align-items: center; gap: 0.5rem">
    <text value="Orders" class="title"/>
    <spacer/>
    <searchbar bind="query" placeholder="Search orders"/>
    <button label="Refresh" variant="prominent" on:tap="refresh()"/>
  </hstack>
  <hstack style="align-items: center; gap: 0.5rem">
    <toggle bind="onlyOpen" label="Only open"/>
    <text value="{{ subtotal }}" class="total"/>
  </hstack>
  <list bind="visible" key="id" class="rows">
    <pressable class="row" on:tap="submit({ id: item.id })">
      <hstack style="align-items: center; gap: 0.75rem">
        <text value="{{ item.name }}"/>
        <spacer/>
        <text value="{{ item.total }}" class="amount"/>
      </hstack>
    </pressable>
  </list>
  <divider/>
  <text value="Nothing else to show." class="empty"/>
</stack>
`;
const SHEET = `.page { background: var(--dsx-background); }
.title { font-size: 1.0625rem; font-weight: 600; }
.total { font-size: 0.75rem; color: var(--dsx-secondary-label); }
.row { min-height: 44px; border-radius: var(--dsx-radius-control); padding: 0px 12px; }
.amount { font-family: ui-monospace, monospace; font-size: 0.75rem; }
.empty { font-size: 0.8125rem; color: var(--dsx-tertiary-label); }
`;

const root = mkdtempSync(join(tmpdir(), "dsx-studio-"));
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
  "dsx.config.json": JSON.stringify({
    name: "Shop", entry: "Orders",
    routes: [{ path: "/", component: "shop.Orders" }, { path: "/detail", component: "shop.Detail" }],
  }),
  "Components/Orders.dsx": APP,
  "Components/Orders.css": SHEET,
  "Components/Detail.dsx": `<stack style="gap: 1rem; padding: 1.25rem">
  <head><attribute as="id"/></head>
  <text value="Detail {{ dsx.attribute.id }}"/>
  <textfield placeholder="Note"/>
  <button label="Save"/>
</stack>
`,
  "server/notes.dsx": `<server>
  <head>
    <entity as="note" ownership="owner"><field as="body" type="text"/></entity>
    <action as="recent">
      return data.note.list({ limit: 10 })
    </action>
  </head>
  <route path="/notes" method="GET" action="recent"/>
  <tool action="recent" description="List the caller's ten most recent notes." auth="required"/>
</server>
`,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

/** The census: what the surface actually decided, counted. */
const CENSUS = `(() => {
  const seen = document.querySelectorAll('*');
  const hues = new Map(), sizes = new Map(), radii = new Map(), shadows = new Map();
  const weights = new Map(), fams = new Map();
  let crowns = 0, blurs = 0, gradients = 0, pills = 0, uppercase = 0, transitions = 0;
  // A count with no name is a mystery the next reader has to re-derive in a browser. Every
  // crown the census finds is reported WITH the selector that drew it.
  const crownWho = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const rgb = (v) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(v);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    if (p.length > 3 && p[3] < 0.04) return null;
    return p[0] + ',' + p[1] + ',' + p[2];
  };
  for (const e of seen) {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(e);
    const ink = rgb(s.color); if (ink) bump(hues, ink);
    const bg = rgb(s.backgroundColor); if (bg) bump(hues, bg);
    if (e.textContent && e.childElementCount === 0 && e.textContent.trim().length > 0) {
      bump(sizes, s.fontSize);
      bump(weights, s.fontWeight);
      bump(fams, s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
      if (s.textTransform === 'uppercase') uppercase += 1;
    }
    if (s.borderTopLeftRadius !== '0px') bump(radii, s.borderTopLeftRadius);
    if (s.boxShadow !== 'none') {
      bump(shadows, s.boxShadow.slice(0, 48));
      // THE EYEBROW: a strip of a FAMILY HUE along the top edge and nothing else, drawn as
      // \`inset 0 Npx 0\` or as a border-top with no other border. Two neutrals wear the same
      // geometry and are not crowns - the near-black recess under a value well, and the
      // hairline that separates a panel from its footer - so chroma is the discriminator.
      // Counting them put six phantom eyebrows on a canvas that has none, and a census nobody
      // trusts is a census nobody reads.
      const strip = /^rgba?\\(([^)]+)\\) 0px [12]px 0px 0px inset$/.exec(s.boxShadow);
      if (strip !== null) {
        // SLICE OFF THE ALPHA before measuring chroma: rgba(255,255,255,0.13) has none, and
        // reading 0.13 as a colour channel made every white hairline in the shell a crown.
        const p1 = strip[1].split(',').slice(0, 3).map(Number);
        if (Math.max(...p1) > 60 && Math.max(...p1) - Math.min(...p1) > 20) {
          crowns += 1;
          if (crownWho.length < 4) crownWho.push(e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).join('.') + ' ' + s.boxShadow);
        }
      }
    }
    if (s.borderTopWidth !== '0px' && s.borderBottomWidth === '0px'
      && s.borderLeftWidth === '0px' && s.borderRightWidth === '0px') {
      const top = rgb(s.borderTopColor);
      if (top !== null) {
        const p2 = top.split(',').map(Number);
        if (Math.max(...p2) - Math.min(...p2) > 20) {
          crowns += 1;
          if (crownWho.length < 4) crownWho.push(e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).join('.') + ' border-top ' + s.borderTopColor);
        }
      }
    }
    if (s.backdropFilter !== 'none') blurs += 1;
    if (s.backgroundImage.includes('gradient')) gradients += 1;
    if (s.borderTopLeftRadius === '999px' || parseFloat(s.borderTopLeftRadius) > 100) pills += 1;
    if (s.transitionDuration !== '0s') transitions += 1;
  }
  const top = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
  return JSON.stringify({
    elements: seen.length,
    hues: hues.size, sizes: Array.from(sizes.keys()).sort(), weights: Array.from(weights.keys()).sort(),
    families: Array.from(fams.keys()), radii: Array.from(radii.keys()).sort(),
    shadowKinds: shadows.size, crowns, crownWho, blurs, gradients, pills, uppercase, transitions,
    topHues: top(hues, 8),
  });
})()`;

const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const browser = await launchBrowser(browserEngine());
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// THE UNMAPPED-ICON HOLE, closed. An icon name the corpus does not carry draws a filled
// placeholder circle and logs a warn - so the Studio shipped a solid dot where a glyph should
// be and every lane stayed green, twice. The walk collects them and fails on them: a surface
// that draws a placeholder is not a surface that passed.
const unmapped = new Set<string>();
// A surface the walk could not reach is a FINDING, and a finding must end the run. This was
// reported to stdout and wired to nothing, so a 401 that made all 19 surfaces absent still
// exited 0 and the lane stayed green.
const absent: string[] = [];
page.on("console", (m) => {
  const t = m.text();
  const hit = /unmapped icon '([^']+)'/.exec(t);
  if (hit !== null) unmapped.add(hit[1]!);
});

/** A click that must not end the walk. A surface that cannot be reached is a finding, not a
 *  crash: the report says which one and the remaining surfaces still get captured. */
async function tap(
  locator: { count(): Promise<number>; isVisible(): Promise<boolean>; click(o?: object): Promise<void> },
  what: string,
): Promise<boolean> {
  if (await locator.count() === 0) { console.log(`  (absent: ${what})`); absent.push(what); return false; }
  // A surface kept mounted for its transition (`keep="true"`) stays in the DOM while hidden -
  // the renderer only drops it to `opacity: 0; pointer-events: none`. It therefore has a box,
  // so isVisible() says yes and the click lands on whatever is underneath, which the walk then
  // reported as the canvas blocking its own chrome. Faded out is ABSENT.
  if (!await locator.isVisible()) { console.log(`  (absent: ${what} - not rendered)`); absent.push(`${what} (not rendered)`); return false; }
  const faded = await (locator as unknown as { evaluate(fn: (el: Element) => boolean): Promise<boolean> })
    .evaluate((el) => {
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (Number(cs.opacity) === 0 || cs.pointerEvents === "none") return true;
      }
      return false;
    }).catch(() => false);
  if (faded) { console.log(`  (absent: ${what} - mounted but faded out)`); absent.push(`${what} (faded out)`); return false; }
  try { await locator.click({ timeout: 4000 }); return true; }
  catch {
    // "not clickable" on its own sends the next reader back to the browser. Name the element
    // that actually owns the pixel - that is the whole finding.
    const over = await (locator as unknown as {
      evaluate(fn: (el: Element) => string): Promise<string>;
    }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const name = (e: Element | null) => e === null ? "nothing"
        : e.tagName.toLowerCase() + (e.className && typeof e.className === "string"
          ? "." + e.className.trim().split(/\s+/).join(".") : "");
      return `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)} covered by ${name(hit)}`;
    }).catch(() => "could not measure");
    console.log(`  BLOCKED: ${what} is present but not clickable - ${over}`);
    // A BLOCKED SURFACE MUST STILL BE CAPTURED. The Studio re-renders its lists at rest
    // (a MutationObserver over 2 idle seconds counts ~100 attribute writes on
    // .dsx-collection-row and ~68 childList swaps on .tree-list), and actionability loses
    // that race often enough that one refused click used to end the walk four surfaces in -
    // every finding after it went unreviewed. The BLOCKED line above is the finding; the
    // forced click is how the remaining surfaces still get looked at.
    const forced = locator as unknown as {
      click(o?: object): Promise<void>;
      dispatchEvent(t: string, i?: object, o?: object): Promise<void>;
    };
    try {
      await forced.click({ force: true, timeout: 4000 });
      console.log(`  (captured anyway with a forced click)`);
      return true;
    } catch { /* the node detached mid-click; dispatch straight at it */ }
    try {
      await forced.dispatchEvent("click", {}, { timeout: 4000 });
      console.log(`  (captured anyway with a dispatched click)`);
      return true;
    } catch { return false; }
  }
}

async function shot(name: string): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const g = JSON.parse(String(await page.evaluate(CENSUS))) as {
    elements: number; hues: number; sizes: string[]; weights: string[]; families: string[];
    radii: string[]; shadowKinds: number; crowns: number; blurs: number; gradients: number;
    pills: number; uppercase: number; transitions: number; topHues: [string, number][];
    crownWho: string[];
  };
  console.log(
    `${name.padEnd(22)} el=${String(g.elements).padStart(4)} hues=${String(g.hues).padStart(3)}` +
    ` type=${g.sizes.length}(${g.sizes.map((s) => s.replace("px", "")).join("/")})` +
    ` w=${g.weights.join("/")} radii=${g.radii.length} shadow=${g.shadowKinds}` +
    ` crown=${g.crowns} blur=${g.blurs} grad=${g.gradients} pill=${g.pills}` +
    ` caps=${g.uppercase} anim=${g.transitions} fonts=${g.families.join("/")}`,
  );
  for (const w of g.crownWho) console.log(`  crown: ${w}`);
}

try {
  // The admission credential, as the query spelling the printed URL uses. Without it every
  // request under /edit is a 401 and the whole walk photographs an error page.
  await page.goto(`http://127.0.0.1:${server.port}/edit/?token=${encodeURIComponent(server.admission)}`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  await shot("01-map");

  // The screen that HAS the logic, by name. Taking the first card meant taking whichever one
  // sorted first, which was `Detail` - a screen with no actions - so every logic and
  // expression surface downstream captured an empty state, and the walk then reported those
  // empty states as design findings. A fixture that cannot reach the surface under review is
  // worse than no fixture: it produces a clean-looking report about nothing.
  const card = page.locator(".map-name").filter({ hasText: "Orders" }).first();
  if (await tap(card, "the Orders map card")) await page.waitForTimeout(700);
  await shot("02-map-focus");
  const open = page.getByText("Open in editor", { exact: true });
  if (await tap(open.first(), "Open in editor")) await page.waitForTimeout(2200);
  await shot("03-screen");

  // the inspector, on a real selection
  const el = page.locator(".tree-row").nth(3);
  if (await tap(el, "a tree row")) await page.waitForTimeout(900);
  await shot("04-inspector-styles");
  // The inspector's three tabs, by the words they actually carry. They were "Events" and
  // "Element" here for months after the panel was renamed, so two of its three faces went
  // unreviewed while the walk reported them as reached.
  for (const tab of ["Attributes", "Actions"]) {
    const t = page.getByRole("button", { name: tab }).first();
    if (await tap(t, tab)) { await page.waitForTimeout(600); await shot(`05-inspector-${tab.toLowerCase()}`); }
  }

  const add = page.getByRole("button", { name: "Add elements" }).first();
  if (await tap(add, "Add element")) { await page.waitForTimeout(900); await shot("06-elements"); await page.keyboard.press("Escape"); await page.waitForTimeout(500); }

  for (const [view, name] of [["Logic view", "07-logic"], ["State view", "08-state"],
    ["Theme view", "09-theme"], ["Strings view", "10-strings"], ["Server view", "11-server"],
    ["Tools view", "12-tools"], ["Agent view", "13-agent"], ["Map view", "14-map-again"]] as const) {
    const b = page.getByRole("button", { name: view }).first();
    if (!await tap(b, view)) continue;
    await page.waitForTimeout(1700);
    await shot(name);
    // A SURFACE WHOSE POINT IS DIRECT MANIPULATION cannot be reviewed from its empty state.
    // Select a page capability (stage = its real flow, contract panel up), then the served
    // one (the backend flow on the same stage), then the create form - the whole gesture.
    if (name === "12-tools") {
      // `submit` and not `count-open`: its action declares an input, so the contract panel
      // is photographed with the argument slot on the card and the mutating face in words -
      // and its try/catch flow is a drawing 07b does not already cover.
      const row = page.getByText("submit", { exact: true }).first();
      if (await tap(row, "the submit tool")) { await page.waitForTimeout(1400); await shot("12b-tools-capability"); }
      const served = page.getByText("recent", { exact: true }).first();
      if (await tap(served, "the served recent tool")) { await page.waitForTimeout(1400); await shot("12c-tools-served"); }
      const add = page.getByRole("button", { name: "New tool" }).first();
      if (await tap(add, "New tool")) { await page.waitForTimeout(700); await shot("12d-tools-add"); }
      // THE ONE-GESTURE CREATE (WE5): name the capability, describe it, press Add - one
      // batch writes the tool row AND the action stub, and the screen lands on the new
      // capability's canvas. Photographed, because this is the primary story.
      await page.getByPlaceholder("clear-done").first().fill("archive-order");
      await page.getByPlaceholder("Add a new item to the user's todo list.").first().fill("Move an order into the archive.");
      await page.locator(".studio-side input").nth(1).fill("orders");
      const create = page.getByText("Add tool", { exact: true }).first();
      if (await tap(create, "Add tool")) { await page.waitForTimeout(1800); await shot("12e-tools-created"); }
    }
    if (name === "07-logic") {
      const body = page.getByText("refresh", { exact: true }).first();
      if (await tap(body, "the refresh body")) { await page.waitForTimeout(1100); await shot("07b-logic-body"); }
      const arg = page.locator(".logic-row").first();
      if (await tap(arg, "an argument row")) { await page.waitForTimeout(700); await shot("07c-logic-field"); }
      // A DIAGRAM OF `seen` IS NOT A REVIEW OF THE DIAGRAM. The first argument row of the
      // first body is a bare name, so the expression canvas rendered two cards and the walk
      // called that surface covered. `subtotal` is a fold over a product with a method on the
      // end - a container, an operator run, a call and four literals - which is the shape the
      // canvas exists to draw.
      const rich = page.getByText("subtotal", { exact: true }).first();
      if (await tap(rich, "the subtotal body")) await page.waitForTimeout(1100);
      const richRow = page.locator(".logic-row").first();
      if (await tap(richRow, "the subtotal return row")) await page.waitForTimeout(700);
      const diagram = page.getByRole("button", { name: "Diagram" }).first();
      if (await tap(diagram, "Diagram")) { await page.waitForTimeout(1500); await shot("07d-expression"); }
      // The HEAD, not the card: a card's centre is a row, and a row tap opens the value editor
      // instead of selecting - so the selection chrome never appeared and the walk blamed the
      // pan surface for covering a control that was faded out.
      const sel = page.locator(".expr-head").nth(1);
      if (await tap(sel, "an expression node")) { await page.waitForTimeout(600); await shot("07e-expression-selected"); }
      const wrap = page.getByText("Wrap in", { exact: true }).first();
      if (await tap(wrap, "Wrap in")) { await page.waitForTimeout(700); await shot("07f-expression-catalog"); }
      const close = page.getByLabel("Close the formula").first();
      if (await tap(close, "Close the formula")) await page.waitForTimeout(700);
    }
  }
} finally {
  await browser.close(); await server.close(); rmSync(root, { recursive: true, force: true });
}
if (unmapped.size > 0) {
  console.error(`\nUNMAPPED ICONS (${unmapped.size}): ${[...unmapped].sort().join(", ")}`);
  console.error("each one drew a placeholder disc - add its row to OpenSource/Conformance/icons/sf-map.json");
}
console.log(`\nshots in ${OUT}`);
if (absent.length > 0) {
  console.error(`\nABSENT SURFACES (${absent.length}): ${absent.join(", ")}`);
  console.error("the walk could not reach these - a surface it cannot reach is a surface it did not prove");
}
if (unmapped.size > 0 || absent.length > 0) process.exit(1);
