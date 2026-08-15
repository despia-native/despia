// Real-engine proof that bootDsx's ROOT PLAN wiring actually runs.
//
// These cases used to have a Node-only duplicate, but bootDsx touches a real DOM (style
// injection, host mounting, window listeners), so that copy could only skip. The mandatory
// `npm test` now routes the corpus here instead. Conformance/router/root-plan.json drives
// RootPlanFold through a stub Host and never constructs a FrameRouter, so it cannot cover this
// wiring either. Here the scenarios run in Chromium, where `document` is real and the
// assertions bite.
//
//   npm run browser:boot                  (chromium)
//   DSX_BROWSER=webkit npm run browser:boot

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const source = String.raw`
  // THROUGH THE PACKAGE, exactly as boot.ts imports it. Reaching into
  // ./packages/kernel/src/* instead gives esbuild a SECOND module instance: the hooks land on
  // a registry the runtime never fires, every assertion reads zero, and the harness passes or
  // fails for reasons unrelated to the code.
  import { ModuleRegistry, DSXState, ScreenReadiness } from "@despia/kernel";
  import { bootDsx } from "./packages/dom/src/boot.ts";

  const failures = [];
  const check = (ok, label) => { if (!ok) failures.push(label); };

  // A minimal but STRUCTURALLY REAL ComponentIR. Passing "{}" per component behind an
  // "as never" cast can typecheck while mount() immediately dereferences missing fields.
  const comp = (name) => ({
    name, scheme: "demo", reactive: false,
    head: { attributes: [], apis: [], expects: [], events: [], inputs: [], variables: [],
            formulas: [], actions: [], watches: [], scripts: [], globalScripts: [] },
    root: { tag: "stack", attrs: {}, children: [], text: "" },
  });

  // 1 — an unregistered candidate fails forward through the REAL registered() check.
  {
    const fired = [];
    const un = ModuleRegistry.registerDelegate("root.failed", 0, (input) => { fired.push(input.error.code); return null; });
    bootDsx({ registry: { components: { "demo.B": comp("demo.B") }, css: "", routes: [] },
              host: document.createElement("div"), entry: ["A", "demo.B"] });
    check(fired.length === 1 && fired[0] === "root.component_missing",
          "unregistered candidate: expected [root.component_missing], got " + JSON.stringify(fired));
    un();
  }

  // 2 — advancing a candidate RELEASES the frames of the one it replaces. A record left behind
  //     would let its queued settle crown whatever holds that id next.
  {
    const before = ScreenReadiness.pending().length;
    bootDsx({ registry: { components: { "Ghost": comp("Ghost") }, css: "", routes: [] },
              host: document.createElement("div"), entry: ["Missing", "Ghost"] });
    ModuleRegistry.foldDelegate("module.error", { origin: "root", code: "boom" }, "void");
    check(ScreenReadiness.pending().length <= before + 1,
          "advance did not release the retired candidate's frames: pending went " +
          before + " -> " + ScreenReadiness.pending().length);
  }

  // 3 — THE ZOMBIE: a settle carrying a RETIRED candidate's real frame must not crown its
  //     successor. Frames are recorded off the production reporting path; hard-coding an id
  //     makes this vacuous, because nextFrameId is module-scoped and never resets.
  {
    const ready = [], frames = [];
    const unStart = ModuleRegistry.registerDelegate("surface.viewStart", 0, (input) => {
      if (typeof input?.frame === "number") frames.push(input.frame);
      return null;
    });
    const un = ModuleRegistry.registerDelegate("root.ready", 0, (input) => { ready.push(input); return null; });
    bootDsx({ registry: { components: { "A": comp("A"), "B": comp("B") }, css: "", routes: [] },
              host: document.createElement("div"),
              entry: [{ view: "A", timeoutMs: 600000 }, { view: "B", timeoutMs: 600000 }] });
    const retired = frames[0];
    check(typeof retired === "number", "candidate A never reported a frame");
    ModuleRegistry.foldDelegate("module.error", { origin: "root", code: "boom" }, "void");
    check(ready.length === 0, "the failed candidate crowned somebody");

    DSXState.set("screen.frame", retired);
    ModuleRegistry.foldDelegate("screen.ready", "/", "void");
    check(ready.length === 0, "a retired candidate's frame crowned its successor");

    DSXState.set("screen.frame", frames[frames.length - 1]);
    ModuleRegistry.foldDelegate("screen.ready", "/", "void");
    check(ready.length === 1, "the live candidate did not settle");
    check(ready[0] && ready[0].view === "B", "the winner was not the live candidate");
    un(); unStart();
  }

  // 4 — an empty plan renders the kernel diagnostic and fires root.exhausted.
  {
    let exhausted = 0;
    const un = ModuleRegistry.registerDelegate("root.exhausted", 0, () => { exhausted += 1; return null; });
    const host = document.createElement("div");
    bootDsx({ registry: { components: {}, css: "", routes: [] }, host, entry: [] });
    check(exhausted === 1, "root.exhausted fired " + exhausted + " times");
    check(host.querySelector("[data-dsx-boot-diagnostic]") !== null, "no diagnostic in the host");
    un();
  }

  window.__DSX_BOOT_FAILURES__ = failures;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "boot-integration-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("boot-integration harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  // A REAL origin, not about:blank: the router resolves paths against `location`, and
  // `new URL(path, ...)` throws on an opaque document — which is a harness artifact, not a bug.
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=utf-8><body></body>" }));
  await page.goto("http://dsx.test/");
  await page.addScriptTag({ content: output });
  const failures = await page.evaluate(
    () => (globalThis as { __DSX_BOOT_FAILURES__?: string[] }).__DSX_BOOT_FAILURES__ ?? ["harness never ran"],
  );
  errors.push(...failures);
} finally {
  await browser.close();
}

if (errors.length > 0) {
  console.error(`boot-integration (${engine}): ${errors.length} failure(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`boot-integration (${engine}): 4 scenarios, all green`);
