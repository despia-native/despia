// THE CAPABILITY SCREEN'S BEHAVIOUR, PROVED END TO END (platform/09-agent-tools.md WE6+WE7).
//
// The capstone claims are behavioural: a builder selects a capability in the Studio, types an
// argument into the call preview, presses Run - and the LIVE app executes the exact entry
// call an agent's invocation is, the screen visibly changes, and the settled result lands in
// the card; and a SERVED capability's contract edits from the same panel, through the surgery
// door WE7 deliberately widened. Every link is real machinery (the SSE run lane, the kernel's
// __DSX_STATE__.call door, the entry-call runner semantics, the server-document splice), so
// only a real browser driving the real Studio against a really-running app can vouch for it:
//
//   1. an APP page is open - the run has somewhere true to execute
//   2. the STUDIO selects the capability, fills the argument slot, presses Run
//   3. the app page's DOM changes (the todo count moves) - the screen reacted
//   4. the card fills with the returned value - the agent's answer, shown
//   5. with the app page CLOSED, Run answers with the honest no-live-preview sentence
//   6. a SERVED capability's description saves from the panel into server/notes.dsx (WE7)
//
//   DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/studio-tryit-browser.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const root = mkdtempSync(join(tmpdir(), "dsx-tryit-"));
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
  "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "Todos" }),
  "Components/Todos.dsx": `<stack style="gap: 1rem; padding: 1.25rem">
  <head>
    <tool action="addTodo" description="Add a new item to the todo list." mutates="todos"/>
    <variable as="todos">return []</variable>
    <action as="addTodo" text="''">
      dsx.variable.todos.push({ text: text })
      return todos.length
    </action>
  </head>
  <text value="count {{ dsx.variable.todos.length }}"/>
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
  <tool action="recent" description="List recent notes." auth="required"/>
</server>
`,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
const base = `http://127.0.0.1:${server.port}`;
const browser = await launchBrowser();
const failures: string[] = [];
const check = (ok: boolean, label: string): void => { if (!ok) failures.push(label); };

try {
  // ── 1: the live app, in its own page - the thing the run executes IN ──
  const app = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await app.goto(`${base}/`, { waitUntil: "load" });
  await app.waitForTimeout(1500);
  check((await app.getByText("count 0", { exact: true }).count()) === 1, "the app page renders its seed state");

  // ── 2: the Studio, driving the capability screen. The whole /edit mount sits behind this
  // run's admission credential now, presented once as ?token= — the same door a developer
  // opens from the URL the command prints; the cookie carries it from there. ──
  const studio = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  await studio.goto(`${base}/edit/?token=${encodeURIComponent(server.admission)}`, { waitUntil: "load" });
  await studio.waitForTimeout(2400);
  await studio.locator(".map-name").first().click();
  await studio.waitForTimeout(600);
  await studio.getByText("Open in editor", { exact: true }).first().click();
  await studio.waitForTimeout(2000);
  await studio.getByRole("button", { name: "Tools view" }).first().click();
  await studio.waitForTimeout(1200);
  await studio.getByText("addTodo", { exact: true }).first().click();
  await studio.waitForTimeout(1200);

  // the argument slot is a real input on the call preview; the internal name stays plumbing
  await studio.locator(".tools-preview input").first().fill("milk");
  await studio.getByText("Run", { exact: true }).first().click();
  await studio.waitForTimeout(1800);

  // ── 3: the screen reacted - the run executed in the app page, not in a simulation ──
  check((await app.getByText("count 1", { exact: true }).count()) === 1, "the app page shows the mutation");

  // ── 4: the card filled with the settled value (addTodo returns the new length) ──
  check((await studio.locator(".tools-run-result").count()) === 1, "the result landed in the card");
  const result = await studio.locator(".tools-run-result").first().textContent();
  check(result !== null && result.trim() === "1", `the card carries the returned value (got ${JSON.stringify(result)})`);

  // ── 5: honesty when nothing is live - close the app, run again, read the sentence ──
  await app.close();
  await studio.waitForTimeout(400);
  await studio.getByText("Run", { exact: true }).first().click();
  await studio.waitForTimeout(4500);
  const refusal = await studio.locator(".tools-run-result").first().textContent();
  check(refusal !== null && refusal.includes("no running preview"), `a dead preview is said, not simulated (got ${JSON.stringify(refusal)})`);

  // ── 6: the SERVED face edits from the same panel (WE7) - the write lands in server/ ──
  await studio.getByText("recent", { exact: true }).first().click();
  await studio.waitForTimeout(1200);
  const description = studio.locator(".studio-side textarea").first();
  await description.fill("List the caller's ten most recent notes.");
  await studio.waitForTimeout(300);
  await studio.getByText("Save", { exact: true }).first().click();
  await studio.waitForTimeout(1200);
  const served = (await (await fetch(`${base}/edit/api/server/notes.dsx`,
    { headers: { "x-despia-edit": server.admission } })).json()) as
    { tools: Array<{ name: string; description: string }> };
  check(served.tools[0]?.description === "List the caller's ten most recent notes.",
    `the served contract saved through the panel (got ${JSON.stringify(served.tools[0]?.description)})`);
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`studio-tryit (${browserEngine()}): ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`studio-tryit (${browserEngine()}): the loop holds - app reacted, card filled, absence said honestly, served face saved`);
