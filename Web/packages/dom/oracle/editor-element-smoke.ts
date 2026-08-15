//
//  editor-element-smoke.ts - drive <despia-stack-editor> (OpenSource/CanvasEditor's
//  custom-element wrapper) in the selected locked Playwright engine: the element
//  upgrades, mounts the SDK, loads the inline deck, re-dispatches SDK events as
//  CustomEvents, and the imperative surface (el.canvas / el.tree) answers.
//
//  Usage: node packages/dom/oracle/editor-element-smoke.ts
//

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve, extname, normalize } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

function repoRoot(): string {
  // URL.pathname leaves spaces percent-encoded on Node 24+, which makes
  // existsSync walk a non-existent ".../Despia%20Framework" path.
  let dir = resolve(dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const editorRoot = join(repoRoot(), "OpenSource/CanvasEditor");
const MIME: { [ext: string]: string } = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const server = createServer((req, res) => {
  void (async () => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
      const full = join(editorRoot, path === "/" ? "StackEditorElement.html" : path);
      if (!full.startsWith(editorRoot)) { res.writeHead(403).end(); return; }
      const body = await readFile(full);
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  })();
});
const port = await new Promise<number>((r) => {
  server.listen(0, () => {
    const a = server.address();
    r(typeof a === "object" && a !== null ? a.port : 0);
  });
});

const errors: string[] = [];
const engine = browserEngine();
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });

  // the element upgraded and the SDK mounted into it
  await page.waitForSelector("despia-stack-editor .sc-viewport", { timeout: 8000 });
  // load() fits the canvas and emits ready on the next animation frame. Wait
  // through that frame before measuring pointer targets; otherwise the initial
  // transform can legitimately land between mousemove and pointerdown.
  await page.evaluate(() => new Promise<void>((resolveReady) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveReady()));
  }));
  console.log("✓ <despia-stack-editor> upgraded and mounted the SDK viewport");

  // the inline deck loaded — the canvas drew the nodes
  const drew = await page.evaluate(() => {
    const el = document.querySelector("despia-stack-editor") as HTMLElement & { tree: { children?: unknown[] } | null };
    return el.tree !== null && Array.isArray(el.tree.children) && el.tree.children.length > 0;
  });
  if (!drew) errors.push("inline text/dsx deck did not load into the tree");
  else console.log("✓ inline <script type=\"text/dsx\"> deck loaded");

  // SDK events re-dispatch as CustomEvents: programmatic select → "select" event
  const selected = await page.evaluate(() => new Promise<string>((resolveEvent) => {
    const el = document.querySelector("despia-stack-editor") as HTMLElement & {
      canvas: { getTree(): { children: Array<{ id: string }> }; select(id: string): void };
    };
    el.addEventListener("select", (e) => resolveEvent(JSON.stringify((e as CustomEvent).detail ?? {})), { once: true });
    el.canvas.select(el.canvas.getTree().children[0]!.id);
    setTimeout(() => resolveEvent("TIMEOUT"), 3000);
  }));
  if (selected === "TIMEOUT" || !selected.includes("id")) errors.push(`select did not re-dispatch as a CustomEvent: ${selected}`);
  else console.log("✓ SDK events re-dispatch as CustomEvents (select carried the node id)");

  // a real pointer drag on the canvas reorders (the SDK's own gesture engine, inside the element)
  const before = await page.evaluate(() => {
    const el = document.querySelector("despia-stack-editor") as HTMLElement & { tree: { children: Array<{ tag: string }> } };
    return el.tree.children.map((c) => c.tag).join(",");
  });
  const childIds = await page.evaluate(() => {
    const el = document.querySelector("despia-stack-editor") as HTMLElement & {
      tree: { children: Array<{ id: string }> };
    };
    const events: unknown[] = [];
    (window as unknown as { __dsxDragEvents: unknown[] }).__dsxDragEvents = events;
    for (const name of ["dragstart", "drophint", "drop", "cancel"]) {
      el.addEventListener(name, (event) => {
        events.push({
          name,
          detail: (event as CustomEvent).detail,
        });
      });
    }
    return el.tree.children.map((c) => c.id);
  });
  const first = childIds[0] === undefined
    ? null
    : await page.locator(`despia-stack-editor .sc-world [data-id="${childIds[0]}"]`).boundingBox();
  const last = childIds.at(-1) === undefined
    ? null
    : await page.locator(`despia-stack-editor .sc-world [data-id="${childIds.at(-1)}"]`).boundingBox();
  if (first === null || last === null || childIds.length < 3) errors.push("root canvas rows not found for the drag");
  else {
    const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    const end = { x: last.x + last.width / 2, y: last.y + last.height * 0.75 };
    const hit = await page.evaluate(({ start, end }) => {
      const describe = ({ x, y }: { x: number; y: number }) => {
        const element = document.elementFromPoint(x, y);
        return {
          tag: element?.tagName ?? null,
          className: element?.getAttribute("class") ?? null,
          id: (element?.closest("[data-id]") as HTMLElement | null)?.dataset.id ?? null,
        };
      };
      return { start: describe(start), end: describe(end) };
    }, { start, end });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => {
      const el = document.querySelector("despia-stack-editor") as HTMLElement & { tree: { children: Array<{ tag: string }> } };
      return el.tree.children.map((c) => c.tag).join(",");
    });
    const dragEvents = await page.evaluate(
      () => (window as unknown as { __dsxDragEvents: unknown[] }).__dsxDragEvents,
    );
    if (after === before) {
      errors.push(`pointer drag did not reorder the tree (${before}); hit=${JSON.stringify(hit)}; events=${JSON.stringify(dragEvents)}`);
    }
    else console.log(`✓ pointer drag reordered the tree (${before} → ${after})`);
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length > 0) {
  console.error(`✗ ${errors.length} error(s):`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`\neditor element smoke [${engine}] green`);
