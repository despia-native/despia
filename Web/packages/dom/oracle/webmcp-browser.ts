// WebMCP, in a real browser, through a real `document.modelContext`.
//
// The corpus (OpenSource/Conformance/webmcp/) pins the FOLDS - what a `<tool>` row derives
// into, what the page table records. No unit test can reach the WIRING: that the compiler
// carries the rows into the IR, that mount registers them with the user agent, that an
// agent's `executeTool` reaches the declared action as an ENTRY call, that the action's
// store writes repaint the live screen, and that unmount takes the tools away again.
//
// So this installs a minimal spec-shaped `document.modelContext` (the Chrome 149 / Edge 150
// origin-trial surface), mounts a real component, and drives it the way an agent would.
//
//   DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/webmcp-browser.ts

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The document under test: three rows, one of them renamed and one of them mutating. */
const MARKUP = `<stack>
  <head>
    <tool action="addTodo" description="Add a new item to the user's todo list." mutates="todos"/>
    <tool as="count-open" action="countOpen" description="Count the todos that are not done yet."/>
    <tool action="explode" description="An action that throws."/>
    <variable as="todos">return []</variable>
    <action as="addTodo" text="''">
      dsx.variable.todos.push({ text: text });
      return { added: text, open: todos.length }
    </action>
    <action as="countOpen">return { open: todos.length }</action>
    <action as="explode">throw { reason: 'invalid', message: 'nope' }</action>
  </head>
  <text value="{{ todos.length }} todos"/>
  <list bind="dsx.variable.todos">
    <text value="{{ item.text }}"/>
  </list>
</stack>`;

const source = `
import { compileComponent } from "./packages/compiler/src/component.ts";
import { CssCollector, extractComponentCss } from "./packages/compiler/src/css.ts";
import { instantiate } from "@despia-native/dom/mount";
// THE REAL BOOT. Nothing here fills the WebMCP seam by hand: bootDsx does it, or the tools
// never register and every assertion below fails - which is the point, because the seam was
// briefly wired by a side-effect import that a sideEffects:false bundler is entitled to
// drop, and did.
import { bootDsx } from "@despia-native/dom/boot";

// A minimal ModelContext with the spec's shape: registerTool validates and stores, the
// AbortSignal unregisters, and executeTool serializes the result the way the draft says
// (a DOMString). Nothing here is Despia's; it stands in for the user agent.
const registered = new Map();
document.modelContext = {
  async registerTool(tool, options) {
    if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new TypeError("bad tool name");
    }
    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new TypeError("bad description");
    }
    if (registered.has(tool.name)) throw new TypeError("duplicate tool");
    registered.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => { registered.delete(tool.name); });
  },
  async getTools() {
    return [...registered.values()].map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations,
    }));
  },
  async executeTool(name, input) {
    const tool = registered.get(name);
    if (tool === undefined) throw new Error("unknown tool " + name);
    return JSON.stringify(await tool.execute(input ?? {}, { signal: new AbortController().signal }));
  },
};

window.__DSX_BOOT__ = () => {
  const ir = compileComponent("Todos", "test", ${JSON.stringify(MARKUP)});
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const host = document.createElement("div");
  host.id = "app";
  document.body.replaceChildren(host);
  bootDsx({
    registry: { components: { "test.Todos": ir }, globalPool: {}, css: collector.emit(), schemes: [] },
    host,
    entry: "test.Todos",
  });
  return true;
};

// A SECOND document, mounted and disposed on its own, so the lifetime rule is checked
// without tearing down the booted one (two documents declaring addTodo would collide,
// which is itself the spec's duplicate refusal).
let live = null;
window.__DSX_MOUNT_SECOND__ = () => {
  const ir = compileComponent("Aside", "test", \`<stack>
  <head>
    <tool action="ping" description="A tool that exists only while its screen does."/>
    <action as="ping">return { ok: true }</action>
  </head>
  <text value="aside"/>
</stack>\`);
  const instance = instantiate(ir, { components: { "test.Aside": ir }, globalPool: {}, css: "", schemes: [] });
  document.body.appendChild(instance.root);
  live = instance;
  return true;
};
window.__DSX_DISPOSE_SECOND__ = () => { live?.unmount(); live?.root.remove(); live = null; return true; };
window.__DSX_TOOLS__ = () => document.modelContext.getTools();
window.__DSX_CALL__ = (name, input) => document.modelContext.executeTool(name, input);
window.__DSX_TEXT__ = () => document.body.textContent ?? "";
window.__DSX_READY__ = true;
`;

const bundled = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: resolve(HERE, "../../.."), sourcefile: "webmcp-oracle-entry.ts" },
  bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent",
}).outputFiles[0]?.text;
if (bundled === undefined) throw new Error("the webmcp harness did not bundle");

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
};

const browser = await launchBrowser(browserEngine());
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 720 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`); });
  // A REAL origin, not about:blank: bootDsx resolves its base against location.href, and the
  // router it installs is history-based. An opaque origin fails both.
  await page.route("https://dsx.test/**", (route) => {
    void route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" });
  });
  await page.goto("https://dsx.test/");
  await page.addScriptTag({ content: bundled });
  await page.waitForFunction(() => (window as unknown as { __DSX_READY__?: boolean }).__DSX_READY__ === true);

  // Nothing is registered before a document mounts.
  const before = await page.evaluate(() => (globalThis as never as { __DSX_TOOLS__: () => Promise<unknown[]> }).__DSX_TOOLS__());
  check("no tools before mount", before.length === 0, `got ${before.length}`);

  await page.evaluate(() => (globalThis as never as { __DSX_BOOT__: () => boolean }).__DSX_BOOT__());
  await page.waitForTimeout(30);

  type Tool = { name: string; description: string; inputSchema?: unknown; annotations?: unknown };
  const tools = await page.evaluate(() => (globalThis as never as { __DSX_TOOLS__: () => Promise<Tool[]> }).__DSX_TOOLS__());
  check("three rows register", tools.length === 3, `got ${tools.length}`);
  check("declaration order is preserved",
    JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(["addTodo", "count-open", "explode"]),
    JSON.stringify(tools.map((t) => t.name)));

  const addTodo = tools.find((t) => t.name === "addTodo");
  check("the schema is derived from the action's declared inputs",
    JSON.stringify(addTodo?.inputSchema) === JSON.stringify({ type: "object", properties: { text: {} } }),
    JSON.stringify(addTodo?.inputSchema));
  check("a mutating row emits no read-only hint", addTodo?.annotations === undefined,
    JSON.stringify(addTodo?.annotations));
  const countOpen = tools.find((t) => t.name === "count-open");
  check("a non-mutating row is hinted read-only",
    JSON.stringify(countOpen?.annotations) === JSON.stringify({ readOnlyHint: true }),
    JSON.stringify(countOpen?.annotations));

  // THE POINT OF THE WHOLE FEATURE: an agent calls a tool, the declared action runs as an
  // entry call, and the live screen repaints under the user who is watching.
  const added = JSON.parse(await page.evaluate(
    () => (globalThis as never as { __DSX_CALL__: (n: string, i: unknown) => Promise<string> }).__DSX_CALL__("addTodo", { text: "milk" }),
  )) as { content: Array<{ text: string }>; structuredContent: { added: string; open: number } };
  check("the call answers MCP-shaped", added.content?.[0]?.text === "added: milk\nopen: 1",
    JSON.stringify(added.content));
  check("the resolved value rides as structured content",
    added.structuredContent?.added === "milk" && added.structuredContent.open === 1,
    JSON.stringify(added.structuredContent));

  await page.waitForTimeout(30);
  const text = await page.evaluate(() => (globalThis as never as { __DSX_TEXT__: () => string }).__DSX_TEXT__());
  check("the agent's write repainted the live screen", text.includes("1 todos") && text.includes("milk"), text);

  // A tool over an action with no declared inputs still answers.
  const counted = JSON.parse(await page.evaluate(
    () => (globalThis as never as { __DSX_CALL__: (n: string, i: unknown) => Promise<string> }).__DSX_CALL__("count-open", {}),
  )) as { structuredContent: { open: number } };
  check("a renamed tool reaches its action", counted.structuredContent?.open === 1,
    JSON.stringify(counted.structuredContent));

  // A throw is an error RESULT, not a rejected promise: the agent must be able to read it.
  const exploded = JSON.parse(await page.evaluate(
    () => (globalThis as never as { __DSX_CALL__: (n: string, i: unknown) => Promise<string> }).__DSX_CALL__("explode", {}),
  )) as { isError?: boolean; content: Array<{ text: string }> };
  check("a throw is an error result", exploded.isError === true, JSON.stringify(exploded));
  check("the error text carries a correlation id and not the exception",
    /^tool failed \(correlation .+\)$/.test(exploded.content?.[0]?.text ?? "") && !JSON.stringify(exploded).includes("nope"),
    JSON.stringify(exploded.content));

  // A tool lives exactly as long as its document: a second screen's row appears on mount and
  // is gone on dispose, which is what makes "the set an agent sees is the set the current
  // screen can honour" true without a line of availability logic anywhere.
  await page.evaluate(() => (globalThis as never as { __DSX_MOUNT_SECOND__: () => boolean }).__DSX_MOUNT_SECOND__());
  await page.waitForTimeout(30);
  const withAside = await page.evaluate(() => (globalThis as never as { __DSX_TOOLS__: () => Promise<Tool[]> }).__DSX_TOOLS__());
  check("a second document adds its own row", withAside.some((t) => t.name === "ping"),
    JSON.stringify(withAside.map((t) => t.name)));

  await page.evaluate(() => (globalThis as never as { __DSX_DISPOSE_SECOND__: () => boolean }).__DSX_DISPOSE_SECOND__());
  await page.waitForTimeout(30);
  const afterDispose = await page.evaluate(() => (globalThis as never as { __DSX_TOOLS__: () => Promise<Tool[]> }).__DSX_TOOLS__());
  check("dispose unregisters that document's rows and only those",
    !afterDispose.some((t) => t.name === "ping") && afterDispose.length === 3,
    JSON.stringify(afterDispose.map((t) => t.name)));

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

const checks = 14;
if (failures.length > 0) {
  console.error(`webmcp-browser: ${failures.length} failure(s) of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`webmcp-browser: ${checks} checks, 0 failures`);
