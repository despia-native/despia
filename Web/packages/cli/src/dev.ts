//
//  dev.ts — `despia dev`.
//
//  TWO modes, mirroring `despia build`:
//
//   1. PROJECT (the default): build once, serve the output, watch the sources, rebuild on
//      change, and tell open browsers to reload over one Server-Sent Events channel. Whole
//      page, every time — v0.1 has no component-level hot swap (README: "What it does not do").
//   2. REPO DEMO (`--demo`): hands off to packages/compiler/bin/serve.ts `startServer`, the
//      repository's own dev/CI server, with its embed CORS and DSD fragment endpoint intact.
//      That server resolves its root by walking up to OpenSource/Conformance, so it can only
//      serve this repository — which is exactly what `--demo` asks for.
//

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LiveRing, LIVE_RING_CAP, LIVE_BATCH_MAX_ROWS, liveReportVerdict } from "@despia/kernel";

import { buildProject, findRepoRoot, type BuildResult } from "./build.ts";
import type { ProjectConfig } from "./config.ts";

export const MIME: { readonly [ext: string]: string } = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** The reload channel path. Chosen to be impossible to collide with a route. */
export const RELOAD_PATH = "/__dsx_dev_reload";

/** The live-state channel path (same collision reasoning). One path, three verbs:
 *  the APP PAGE POSTs snapshots of its active screen's variables (read off the kernel's
 *  __DSX_STATE__ door), the STUDIO GETs the latest snapshot for its data-store panel, and
 *  the studio PUTs one write, which rides the existing SSE channel back into the app as a
 *  `state` event. No second socket — the reload stream IS the server→app lane. */
export const STATE_PATH = "/__dsx_dev_state";

/** The live-logs door (live-logs.md, P1): a dev-channel install pointed at this server — or
 *  the web preview in another tab — batch-POSTs its scrubbed wire rows here, and the terminal
 *  is the first viewer: every row prints as a tail line, and the same rows answer GET reads in
 *  the relay's poll shape, so the local editor renders the live panel with no Cloudflare
 *  anywhere. One session slot, like the state door: one dev server, one person. The ack always
 *  reports one viewer (the terminal), so a paired device never pauses its wire locally. */
export const LOGS_PATH = "/__dsx_dev_logs";

/** The ack a local batch gets — the relay's ack shape with the terminal as the one viewer. */
export function devLogsAck(): string {
  return JSON.stringify({ ok: true, viewers: 1, ttlMs: 600_000 });
}

/** Terminal-safe text: rows come from a DEVICE, and a control character in a printed field is
 *  an injection into the developer's terminal (ANSI redraws, title writes). Wire rows are
 *  scrubbed at the fold, but this server prints what arrives, not what should have arrived. */
function cleanField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** One wire row as one terminal tail line, in the Console drawer's plain-English voice
 *  (CRASH / CALL FAILED / ERROR by origin — the same tags a tester sees on-device). */
export function formatLiveRow(row: {
  kind?: unknown; scheme?: unknown; level?: unknown; message?: unknown;
  code?: unknown; origin?: unknown; at?: unknown;
}): string {
  // Clamp to the valid Date range — a forged `at` past ±8.64e15 makes toISOString throw.
  const at = typeof row.at === "number" && Number.isFinite(row.at)
    && row.at > 0 && row.at <= 8_640_000_000_000_000 ? row.at : 0;
  const time = at > 0 ? new Date(at).toISOString().slice(11, 19) : "--:--:--";
  const message = cleanField(row.message, "");
  if (row.kind === "error") {
    const tag = row.origin === "uncaught" ? "CRASH" : row.origin === "call" ? "CALL FAILED" : "ERROR";
    const code = cleanField(row.code, "error");
    const scheme = cleanField(row.scheme, "app");
    return `[live ${time}] ${tag} ${scheme} -> ${code}${message === "" ? "" : ` : ${message}`}`;
  }
  if (row.kind === "kernel") return `[live ${time}] kernel | ${message}`;
  const scheme = cleanField(row.scheme, "app");
  const levelText = cleanField(row.level, "log");
  const level = levelText !== "log" && levelText !== "" ? ` ${levelText.toUpperCase()}` : "";
  return `[live ${time}]${level} ${scheme}: ${message}`;
}

/** Body reader with the wire's per-leaf byte caps (@despia/live LIVE_HTTP_*_MAX_BYTES). */
function readBody(req: IncomingMessage, cap: number, done: (text: string | null) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > cap) { over = true; req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => { done(over ? null : Buffer.concat(chunks).toString("utf8")); });
  req.on("error", () => { done(null); });
}

function answerJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, devHeaders("application/json; charset=utf-8"));
  res.end(body);
}

/** Owns live-logs requests against the server's one ring; false = not this door. Two path
 *  spellings, one behaviour: the short LOGS_PATH (the studio panel's local read/write), and
 *  the relay's own `/s/:sid/{batch,rows,report,attest}` — so a DEVICE pairs against this
 *  server with `relay=http://<lan-ip>:<port>` and any sid, and the module's transport speaks
 *  the exact same shape it speaks to Cloudflare. One session slot, so the sid is not judged
 *  (one dev server, one person). Exported so the branch is testable without a project
 *  fixture — the callback in startDevServer is glue. */
export function handleLogsDoor(
  req: IncomingMessage,
  res: ServerResponse,
  ring: LiveRing<unknown>,
  log: (line: string) => void,
): boolean {
  const path = (req.url ?? "/").split("?")[0];
  let leaf: "batch" | "rows" | "report" | "attest";
  if (path === LOGS_PATH) {
    leaf = req.method === "POST" ? "batch" : "rows";
  } else {
    const matched = /^\/s\/[^/]+\/(batch|rows|report|attest)$/.exec(path);
    if (matched === null) return false;
    leaf = matched[1] as typeof leaf;
    const wantsPost = leaf !== "rows";
    if (wantsPost !== (req.method === "POST")) {
      answerJson(res, 405, '{"ok":false,"error":{"code":"method_not_allowed"}}');
      return true;
    }
  }

  if (leaf === "rows") {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const after = Number(query.get("after") ?? "0");
    const limit = Number(query.get("limit") ?? "200");
    const view = ring.read(Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200);
    answerJson(res, 200, JSON.stringify({ rows: view.rows, gap: view.gap, last: ring.last }));
    return true;
  }

  if (leaf === "batch") {
    readBody(req, 1_048_576, (text) => {
      let batch: { v?: unknown; n?: unknown; rows?: unknown } = {};
      try { batch = JSON.parse(text ?? "") as typeof batch; } catch { /* not JSON */ }
      if (batch.v !== 1 || !Number.isInteger(batch.n) || !Array.isArray(batch.rows)
          || batch.rows.length > LIVE_BATCH_MAX_ROWS) {
        answerJson(res, 400, '{"ok":false,"error":{"code":"invalid_batch"}}');
        return;
      }
      const outcome = ring.appendBatch(batch.n as number, batch.rows);
      if (outcome.accepted) {
        for (const row of batch.rows) log(formatLiveRow(row as { [k: string]: unknown }));
      }
      answerJson(res, 200, devLogsAck());
    });
    return true;
  }

  if (leaf === "report") {
    readBody(req, 2_097_152, (text) => {
      if (text === null) {
        answerJson(res, 400, '{"ok":false,"error":{"code":"invalid_report"}}');
        return;
      }
      // The same verdict the relay and the CLI's `dsx report` run — one function, one law.
      const judged = liveReportVerdict(text);
      log(`[live] report received — verdict ${judged.verdict}${judged.assertion ? " (asserted)" : ""}`);
      answerJson(res, 200, JSON.stringify({ ok: true, verdict: judged.verdict, assertion: judged.assertion }));
    });
    return true;
  }

  // attest: a local dev server has no integrity policy — accept and move on.
  readBody(req, 16_384, () => { answerJson(res, 200, '{"ok":true}'); });
  return true;
}

/** The SELECT door (master plan P5) — same shape as the state door, for the editor's
 *  select-on-the-real-render: the APP PAGE POSTs what was picked (owner + nid + rect,
 *  or a reorder intent), the STUDIO GETs it and turns it into tree selection / a
 *  moveNode splice, and the studio PUTs the tool mode, which rides the SSE channel
 *  into the page as a `selectmode` event. The page reports; only the studio writes
 *  files — the division that keeps every edit on the one audited write path. */
export const SELECT_PATH = "/__dsx_dev_select";

/** The RUN door ("Try it", platform/09-agent-tools.md WE6) — the studio runs a declared
 *  action IN the live app as an entry call. The request rides the existing SSE lane into
 *  the app page as a `run` event; the page executes it through the kernel's
 *  `__DSX_STATE__.call` door and POSTs the settled result back here with the run's id.
 *  No second socket, same as state and select — and only app pages carry the client, so
 *  a run can only ever execute in the app it names. */
export const RUN_PATH = "/__dsx_dev_run";

/** Every 200 is revalidated from disk: this is a dev server, and a browser reusing a
 *  registry/module from before a rebuild renders an older build convincingly. Same policy
 *  (and same reasoning) as `devResponseHeaders` in packages/compiler/bin/serve.ts. */
export function devHeaders(contentType: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...extra, "content-type": contentType, "cache-control": "no-store" };
}

/** PREVIEW HATCH (master plan P2, section 1 constants): the deterministic recovery
 *  cadence for the hot-swap lane — a hard page recreation every 30 swaps or 20 minutes,
 *  whichever first, so drift the in-place swap cannot express is bounded by construction. */
export const HATCH_SWAPS = 30;
export const HATCH_MS = 20 * 60 * 1000;

/** The reload client, injected into every served HTML document. Zero dependencies, and it
 *  degrades to nothing if EventSource is unavailable. */
export const RELOAD_CLIENT = `<script>
(function () {
  if (typeof EventSource !== "function") return;
  var s = new EventSource(${JSON.stringify(RELOAD_PATH)});
  s.addEventListener("reload", function () { location.reload(); });
  // HOT SWAP (master plan P2): a component-level rebuild rides in without a page load -
  // the fresh registry goes through the boot door, which re-injects css and re-mounts
  // every live frame with its variable state carried. The HATCH is the recovery cadence:
  // every ${HATCH_SWAPS} swaps or ${Math.round(HATCH_MS / 60000)} minutes, one honest reload bounds any drift.
  var swaps = 0;
  var born = Date.now();
  s.addEventListener("swap", function () {
    swaps += 1;
    if (swaps >= ${HATCH_SWAPS} || Date.now() - born > ${HATCH_MS}) { location.reload(); return; }
    fetch("/registry.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (reg) {
      var door = window.__DSX_SWAP__;
      if (door) { door(reg); } else { location.reload(); }
    }).catch(function () { location.reload(); });
  });
  // PREVIEW NAVIGATION TRUTH (master plan P2): inside a preview frame, an anchor that
  // would leave the app is diverted to an honest notice with a new-tab door - external
  // pages and OAuth cannot run in an embedded frame, so pretending is worse than saying
  // so. Capture-phase, framed pages only; the app's own routes never reach this (the
  // router intercepts app-internal hrefs first).
  if (window.top !== window.self) {
    document.addEventListener("click", function (ev) {
      if (window.__dsxSelecting) return; // the select tool owns clicks - a pick is not a navigation
      var n = ev.target;
      while (n && n !== document && (!n.tagName || n.tagName !== "A")) { n = n.parentNode; }
      if (!n || n === document || !n.href) return;
      var to;
      try { to = new URL(n.href, location.href); } catch (e) { return; }
      if (to.origin === location.origin) return;
      ev.preventDefault();
      ev.stopPropagation();
      var old = document.getElementById("dsx-preview-notice");
      if (old) old.remove();
      var bar = document.createElement("div");
      bar.id = "dsx-preview-notice";
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;background:rgba(17,17,20,0.92);color:#f5f5f7;font:500 13px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);max-width:calc(100vw - 24px);box-sizing:border-box";
      var word = document.createElement("span");
      word.textContent = "Navigation blocked - you are in a preview";
      word.style.cssText = "min-width:0";
      var open = document.createElement("a");
      open.textContent = "Open page in new tab";
      open.href = to.href;
      open.target = "_blank";
      open.rel = "noopener";
      open.style.cssText = "color:#8ab4ff;text-decoration:none;font-weight:600;white-space:nowrap";
      bar.appendChild(word);
      bar.appendChild(open);
      document.body.appendChild(bar);
      setTimeout(function () { if (bar.isConnected) bar.remove(); }, 6000);
    }, true);
  }
  // SELECT ON THE REAL RENDER (master plan P5). Framed pages only, armed by the studio
  // over the selectmode event. A pointerdown picks the nearest stamped element
  // (data-dsx-n / data-dsx-owner - the same IR identity SSR emits), draws the halo, and
  // POSTs the pick through the select door; a vertical/horizontal drag among stamped
  // siblings posts a REORDER INTENT. The page never writes a file - the studio turns
  // intents into the one audited moveNode splice.
  if (window.top !== window.self) {
    var selecting = false;
    var picked = null; // { owner, nid }
    var halo = null;
    // The owning component: fresh mounts stamp data-dsx-owner on every element, SSR
    // stamps it on each component ROOT - the nearest ancestor carrying it answers both.
    var ownerOf = function (el) {
      var m = el;
      while (m && m !== document) {
        if (m.getAttribute && m.getAttribute("data-dsx-owner") !== null) return m.getAttribute("data-dsx-owner");
        m = m.parentNode;
      }
      return null;
    };
    var findPicked = function () {
      if (!picked) return null;
      var roots = document.querySelectorAll('[data-dsx-owner="' + picked.owner + '"]');
      for (var i = 0; i < roots.length; i++) {
        if (roots[i].getAttribute("data-dsx-n") === String(picked.nid)) return roots[i];
        var hit = roots[i].querySelector('[data-dsx-n="' + picked.nid + '"]');
        if (hit && ownerOf(hit) === picked.owner) return hit;
      }
      return null;
    };
    var placeHalo = function () {
      var el = findPicked();
      if (!halo) return;
      if (!selecting || !el) { halo.style.display = "none"; return; }
      var r = el.getBoundingClientRect();
      halo.style.display = "block";
      halo.style.left = (r.left - 2) + "px";
      halo.style.top = (r.top - 2) + "px";
      halo.style.width = (r.width + 2) + "px";
      halo.style.height = (r.height + 2) + "px";
      halo.style.borderRadius = getComputedStyle(el).borderRadius;
    };
    var ensureHalo = function () {
      if (halo) return;
      halo = document.createElement("div");
      halo.id = "dsx-select-halo";
      halo.style.cssText = "position:fixed;z-index:2147482000;pointer-events:none;display:none;border:2px solid #4d7fff;background:rgba(77,127,255,0.06);box-sizing:content-box";
      document.body.appendChild(halo);
      window.addEventListener("scroll", placeHalo, true);
      window.addEventListener("resize", placeHalo);
      setInterval(placeHalo, 300); // survives hot swaps: the element is re-found by identity
    };
    var postSelect = function (body) {
      fetch(${JSON.stringify(SELECT_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(function () {});
    };
    s.addEventListener("selectmode", function (ev) {
      selecting = ev.data === "select";
      window.__dsxSelecting = selecting;
      ensureHalo();
      placeHalo();
    });
    // THE MAPPING FLASH (P12): the studio names a display string; every leaf-most
    // stamped element carrying it gets a short-lived outline - table row to canvas.
    s.addEventListener("highlight", function (ev) {
      var word = "";
      try { word = JSON.parse(ev.data); } catch (e) { return; }
      if (!word) return;
      var boxes = [];
      var nodes = document.querySelectorAll("[data-dsx-n]");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var text = (el.textContent || "").trim() === word;
        var ph = el.placeholder === word;
        if (!text && !ph) continue;
        // leaf-most only: an ancestor whose stamped descendant also matches stays quiet
        if (text) {
          var deeper = false;
          var inner = el.querySelectorAll("[data-dsx-n]");
          for (var k = 0; k < inner.length; k++) {
            if ((inner[k].textContent || "").trim() === word) { deeper = true; break; }
          }
          if (deeper) continue;
        }
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        var b = document.createElement("div");
        b.style.cssText = "position:fixed;z-index:2147482000;pointer-events:none;border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,0.10);transition:opacity .3s";
        b.style.left = (r.left - 3) + "px"; b.style.top = (r.top - 3) + "px";
        b.style.width = (r.width + 2) + "px"; b.style.height = (r.height + 2) + "px";
        document.body.appendChild(b);
        boxes.push(b);
      }
      setTimeout(function () { for (var j = 0; j < boxes.length; j++) boxes[j].style.opacity = "0"; }, 1200);
      setTimeout(function () { for (var j = 0; j < boxes.length; j++) boxes[j].remove(); }, 1600);
    });
    // DRAG (P5 + P5b cross-container): every drag targets a CONTAINER and an insertion
    // SLOT in it - the source container included, so one gesture serves reorder and
    // reparent alike. The bar shows the slot; the studio turns the intent into the one
    // audited moveNode splice (toParent + slot semantics on the surgery side).
    var drag = null; // { el, owner, moved, target: { container, slot } | null }
    var bar = null;
    var ensureBar = function () {
      if (bar) return;
      bar = document.createElement("div");
      bar.id = "dsx-drop-bar";
      bar.style.cssText = "position:fixed;z-index:2147482001;pointer-events:none;display:none;background:#4d7fff;border-radius:1px";
      document.body.appendChild(bar);
    };
    var containerAxis = function (el) {
      var style = getComputedStyle(el);
      return (style.flexDirection || "column").indexOf("row") === 0 ? "x" : "y";
    };
    // The dragged element STAYS in the count: surgery's slot basis is the container's
    // current children, so a same-container drop translates exactly (slot > from → -1).
    var stampedChildren = function (container, owner) {
      var out = [];
      for (var i = 0; i < container.children.length; i++) {
        var c = container.children[i];
        if (c === halo || c === bar) continue;
        if (c.getAttribute && c.getAttribute("data-dsx-n") !== null && ownerOf(c) === owner) out.push(c);
      }
      return out;
    };
    // The drop container under the pointer: the nearest stamped same-owner ancestor of
    // the hit that lays out as flex/grid and is not inside the dragged subtree.
    var dropTarget = function (ev, d) {
      var hits = document.elementsFromPoint(ev.clientX, ev.clientY);
      for (var h = 0; h < hits.length; h++) {
        var m = hits[h];
        if (d.el.contains(m)) continue;
        while (m && m !== document.documentElement) {
          if (!d.el.contains(m) && m.getAttribute && m.getAttribute("data-dsx-n") !== null && ownerOf(m) === d.owner) {
            var disp = getComputedStyle(m).display;
            if (disp.indexOf("flex") >= 0 || disp.indexOf("grid") >= 0) {
              var axis = containerAxis(m);
              var kids = stampedChildren(m, d.owner);
              var pos = axis === "x" ? ev.clientX : ev.clientY;
              var slot = 0;
              for (var i = 0; i < kids.length; i++) {
                var r = kids[i].getBoundingClientRect();
                var mid = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
                if (pos > mid) slot += 1;
              }
              return { container: m, axis: axis, kids: kids, slot: slot };
            }
          }
          m = m.parentNode;
        }
      }
      return null;
    };
    var placeBar = function (t) {
      ensureBar();
      if (!t) { bar.style.display = "none"; return; }
      var box = t.container.getBoundingClientRect();
      var edge;
      if (t.kids.length === 0) edge = t.axis === "x" ? box.left + 4 : box.top + 4;
      else if (t.slot >= t.kids.length) {
        var last = t.kids[t.kids.length - 1].getBoundingClientRect();
        edge = t.axis === "x" ? last.right + 2 : last.bottom + 2;
      } else {
        var next = t.kids[t.slot].getBoundingClientRect();
        edge = t.axis === "x" ? next.left - 2 : next.top - 2;
      }
      bar.style.display = "block";
      if (t.axis === "x") {
        bar.style.left = edge + "px"; bar.style.top = box.top + "px";
        bar.style.width = "2px"; bar.style.height = box.height + "px";
      } else {
        bar.style.left = box.left + "px"; bar.style.top = edge + "px";
        bar.style.width = box.width + "px"; bar.style.height = "2px";
      }
    };
    document.addEventListener("pointerdown", function (ev) {
      if (!selecting) return;
      var n = ev.target;
      while (n && n !== document && (!n.getAttribute || n.getAttribute("data-dsx-n") === null)) { n = n.parentNode; }
      if (!n || n === document) return;
      ev.preventDefault();
      ev.stopPropagation();
      var owner = ownerOf(n);
      var nid = parseInt(n.getAttribute("data-dsx-n"), 10);
      picked = { owner: owner, nid: nid };
      ensureHalo();
      placeHalo();
      var r = n.getBoundingClientRect();
      postSelect({ kind: "select", owner: owner, nid: nid, tag: n.tagName.toLowerCase(), seq: Date.now(),
                   rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
      drag = { el: n, owner: owner, moved: false, target: null };
    }, true);
    document.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      drag.moved = true;
      drag.el.style.opacity = "0.5";
      drag.target = dropTarget(ev, drag);
      placeBar(drag.target);
      placeHalo();
    }, true);
    document.addEventListener("pointerup", function (ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      d.el.style.opacity = "";
      if (bar) bar.style.display = "none";
      if (!d.moved || !picked || !d.target) return;
      var containerNid = parseInt(d.target.container.getAttribute("data-dsx-n"), 10);
      postSelect({ kind: "reorder", owner: picked.owner, nid: picked.nid,
                   toIndex: d.target.slot, toContainer: containerNid, seq: Date.now() });
    }, true);
  }
  // Live state: mirror the active screen's variables to the dev server so the studio's
  // data-store panel shows the RUNNING app, and apply the studio's writes back. This
  // script is only injected into app pages (never the editor chrome), so a state event
  // can only ever land in the app it describes.
  var release = null;
  var throttled = false;
  var send = function () {
    var door = window.__DSX_STATE__;
    if (!door) return;
    var body;
    try { body = JSON.stringify(door.snapshot()); } catch (e) { return; }
    fetch(${JSON.stringify(STATE_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: body }).catch(function () {});
  };
  var push = function () {
    if (throttled) return;
    throttled = true;
    setTimeout(function () { throttled = false; send(); }, 150);
  };
  // Re-arm each second: a navigation retires the old frame's sink with its frame, and
  // the fresh snapshot covers whatever the sink missed in between.
  setInterval(function () {
    var door = window.__DSX_STATE__;
    if (!door) return;
    if (release) { try { release(); } catch (e) {} }
    try { release = door.sink(push); } catch (e) { release = null; }
    send();
  }, 1000);
  s.addEventListener("state", function (ev) {
    var door = window.__DSX_STATE__;
    if (!door) return;
    try { var m = JSON.parse(ev.data); door.set(m.name, m.value); } catch (e) {}
  });
  // "Try it" (WE6): run a declared action as an entry call and post the settled result
  // back with the run's id. Older pages without the call door simply stay silent, and
  // the server's timeout answers honestly.
  s.addEventListener("run", function (ev) {
    var door = window.__DSX_STATE__;
    if (!door || !door.call) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    Promise.resolve(door.call(m.action, m.args || {})).then(function (r) {
      var body = JSON.stringify({ id: m.id, ok: !!(r && r.ok), value: r ? r.value : null, error: r && r.error != null ? String(r.error) : null });
      fetch(${JSON.stringify(RUN_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: body }).catch(function () {});
    }).catch(function (e) {
      var body = JSON.stringify({ id: m.id, ok: false, value: null, error: String(e) });
      fetch(${JSON.stringify(RUN_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: body }).catch(function () {});
    });
  });
})();
</script>`;

/** The dev preview's typeface. The token stack names InterVariable FIRST as the intended
 *  face (theme.ts --dsx-font) and then leaves delivery to chance, so a machine without
 *  Inter installed previews every app in its OS fallback and the design reads years older
 *  than it is. In dev the server closes that gap itself: it serves the framework's own
 *  vendored subsets (assets/vendor/inter, OFL-1.1, pinned) and injects this @font-face
 *  into the HTML it serves. DEV ONLY by construction - the injection lives beside the
 *  reload client, the build output is untouched, and a production app opts into fonts
 *  through the documented fonts surface. */
export const DEV_FONTS_PREFIX = "/__dsx/fonts/";
/** The intended face's @font-face pair over a caller-supplied URL per subset: ONE
 *  spelling of the family, ranges and weights, shared by the dev server's injection
 *  (subset URLs under DEV_FONTS_PREFIX) and the parity oracle's harness page (data:
 *  URIs read from the same satellite), so the preview and the reference plane can
 *  never quietly render two different intended faces. */
export function interFontFaceCss(urlFor: (file: (typeof DEV_FONT_FILES)[number]) => string): string {
  return `@font-face{font-family:InterVariable;src:url(${urlFor("InterVariable-latin.woff2")}) format("woff2");font-weight:100 900;font-style:oblique 0deg 10deg;font-display:fallback;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}` +
    `@font-face{font-family:InterVariable;src:url(${urlFor("InterVariable-latin-ext.woff2")}) format("woff2");font-weight:100 900;font-style:oblique 0deg 10deg;font-display:fallback;unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`;
}
const DEV_FONT_STYLE = `<style data-dsx-dev-font>${interFontFaceCss((file) => `${DEV_FONTS_PREFIX}${file}`)}</style>`;

export const DEV_FONT_FILES = ["InterVariable-latin.woff2", "InterVariable-latin-ext.woff2"] as const;

/** Where the intended face's bytes live, resolved rather than carried: the CORE ships no
 *  vendored third-party source (check_opensource_purity's zero-vendored-core law), so the
 *  cli looks for the subsets instead of bundling them - first in the app's own
 *  `public/fonts/` (an app that self-hosts Inter previews and ships the same bytes), then
 *  in the monorepo's Type satellite (`OpenSource/Type/vendor/inter`, where the pinned
 *  OFL-1.1 files actually live). Neither present = the preview degrades honestly to the
 *  system stack and injects nothing. */
export function resolveDevFontsDir(projectRoot: string, override?: string): string | null {
  const candidates = [
    ...(override !== undefined ? [override] : []),
    join(projectRoot, "public/fonts"),
    ...((): string[] => {
      const repo = findRepoRoot(projectRoot);
      return repo === null ? [] : [join(repo, "OpenSource/Type/vendor/inter")];
    })(),
  ];
  for (const dir of candidates) {
    if (DEV_FONT_FILES.every((f) => existsSync(join(dir, f)))) return dir;
  }
  return null;
}

/** The PREVIEW SHELL: the app framed at device size instead of smeared across a desktop
 *  tab. A phone-designed screen full-bleed at 1400px is the single worst first impression
 *  a preview can make, and it is the first thing every evaluator sees. The shell is one
 *  self-contained page: the app in an iframe inside a device frame, size presets, a
 *  scheme toggle that stamps the documented `data-dsx-theme` pin on the framed document
 *  (the same attribute a host page uses to pin an embed), and a reload. Dev-only chrome;
 *  the raw app stays at `/`. */
export const PREVIEW_PATH = "/__dsx/preview";

export function previewPage(appName: string, fonts: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(appName)} preview</title>
${fonts ? DEV_FONT_STYLE : ""}
<style>
  :root { color-scheme: light dark; --ink: #17171b; --dim: #6f7078; --ground: #ececf0; --panel: #ffffff; --line: rgba(23,23,27,.12); --accent: #3c5cf0; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f4f4f5; --dim: #92929c; --ground: #0c0c0e; --panel: #17171a; --line: rgba(244,244,245,.14); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--ground); color: var(--ink); font: 400 14px/1.45 InterVariable, Inter, system-ui, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; }
  header b { font-weight: 650; font-size: 13px; }
  .group { display: flex; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
  .group button { appearance: none; border: 0; background: transparent; color: var(--dim); font: 550 12px/1 inherit; padding: 6px 10px; border-radius: 7px; cursor: pointer; }
  .group button[aria-pressed="true"] { background: var(--ground); color: var(--ink); }
  .spacer { flex: 1; }
  a.raw, button.raw { color: var(--dim); font: 550 12px/1 inherit; text-decoration: none; background: none; border: 0; cursor: pointer; padding: 6px 4px; }
  a.raw:hover, button.raw:hover, .group button:hover { color: var(--ink); }
  main { flex: 1; display: grid; place-items: center; padding: 8px 16px 24px; }
  .device { background: var(--panel); border: 1px solid var(--line); border-radius: 34px; padding: 10px; box-shadow: 0 24px 60px rgba(0,0,0,.14); transition: width .2s ease, height .2s ease; }
  .device.desktop { border-radius: 14px; padding: 8px; width: min(1200px, calc(100vw - 48px)); height: calc(100vh - 110px); }
  .device iframe { display: block; width: 100%; height: 100%; border: 0; border-radius: 26px; background: #fff; }
  .device.desktop iframe { border-radius: 8px; }
</style>
</head>
<body>
<header>
  <b>${escapeHtmlText(appName)}</b>
  <div class="group" id="sizes" role="group" aria-label="Preview size">
    <button data-w="390" data-h="844" aria-pressed="true">Phone</button>
    <button data-w="834" data-h="1194" aria-pressed="false">Tablet</button>
    <button data-w="0" data-h="0" aria-pressed="false">Desktop</button>
  </div>
  <div class="group" id="schemes" role="group" aria-label="Color scheme">
    <button data-scheme="" aria-pressed="true">Auto</button>
    <button data-scheme="light" aria-pressed="false">Light</button>
    <button data-scheme="dark" aria-pressed="false">Dark</button>
  </div>
  <span class="spacer"></span>
  <button class="raw" id="reload" type="button">Reload</button>
  <a class="raw" href="/" target="_blank" rel="noopener">Open raw app</a>
</header>
<main><div class="device" id="device"><iframe id="app" src="/" title="${escapeHtmlText(appName)}"></iframe></div></main>
<script>
(function () {
  var device = document.getElementById("device");
  var frame = document.getElementById("app");
  function press(group, on) {
    for (var i = 0; i < group.children.length; i++) group.children[i].setAttribute("aria-pressed", String(group.children[i] === on));
  }
  function fit() {
    var w = Number(device.dataset.w || 390), h = Number(device.dataset.h || 844);
    if (w === 0) { device.className = "device desktop"; device.style.width = ""; device.style.height = ""; return; }
    device.className = "device";
    var pad = 20, maxW = window.innerWidth - 48, maxH = window.innerHeight - 110;
    var scale = Math.min(1, maxW / (w + pad), maxH / (h + pad));
    device.style.width = Math.round((w + pad) * scale) + "px";
    device.style.height = Math.round((h + pad) * scale) + "px";
  }
  document.getElementById("sizes").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    device.dataset.w = b.dataset.w; device.dataset.h = b.dataset.h;
    press(this, b); fit();
  });
  document.getElementById("schemes").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    try {
      var doc = frame.contentDocument;
      if (b.dataset.scheme === "") doc.documentElement.removeAttribute("data-dsx-theme");
      else doc.documentElement.setAttribute("data-dsx-theme", b.dataset.scheme);
    } catch (e) { /* frame not ready yet - the pin lands on the next reload */ }
    press(this, b);
  });
  document.getElementById("reload").addEventListener("click", function () { frame.src = frame.src; });
  window.addEventListener("resize", fit);
  device.dataset.w = "390"; device.dataset.h = "844";
  fit();
})();
</script>
</body>
</html>
`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function injectReloadClient(html: string, fonts: boolean = true): string {
  const headClose = html.indexOf("</head>");
  const fonted = !fonts ? html : headClose < 0 ? DEV_FONT_STYLE + html
    : html.substring(0, headClose) + DEV_FONT_STYLE + html.substring(headClose);
  const close = fonted.lastIndexOf("</body>");
  return close < 0 ? fonted + RELOAD_CLIENT : fonted.substring(0, close) + RELOAD_CLIENT + fonted.substring(close);
}

/** HOT SWAP vs RELOAD (master plan P2): a rebuild whose registry differs only in
 *  components/css/globalPool rides the swap lane (in-place remount, state carried);
 *  anything structural — routes, schemes, the baked shell, package web assets, the
 *  not-found screen, the motion config — is a page fact and reloads honestly. The
 *  fingerprint is computed over the registry the page will fetch, so the decision and
 *  the payload cannot disagree. */
export function registryStructure(registryText: string): string {
  const r = JSON.parse(registryText) as Record<string, unknown>;
  return JSON.stringify({
    routes: r["routes"] ?? null,
    schemes: r["schemes"] ?? null,
    shell: r["shell"] ?? null,
    packageWeb: r["packageWeb"] ?? null,
    notFound: r["notFound"] ?? null,
    router: r["router"] ?? null,
  });
}

export type DevServer = {
  port: number;
  /** rebuild now (the watcher calls this; tests call it directly) */
  rebuild: () => BuildResult | Error;
  /** the latest state-door snapshot verbatim ("" until the app page posts one) — the
   *  context bundle (master plan P16) reads the same channel the data-store panel does */
  stateSnapshot: () => string;
  /** "Try it" (WE6): run a declared action in the live app page as an entry call.
   *  `answered: false` means no connected page executed it before the timeout — the
   *  caller says so honestly instead of inventing a result. */
  runInApp: (action: string, args: { [k: string]: unknown }, timeoutMs?: number) =>
    Promise<{ answered: boolean; ok: boolean; value: unknown; error: string | null }>;
  close: () => Promise<void>;
};

export type DevOptions = {
  port?: number;
  host?: string;
  /** false disables the fs watcher (tests drive `rebuild()` themselves) */
  watch?: boolean;
  log?: (line: string) => void;
  /** tried BEFORE the static handler — true means the request was owned and answered
   *  (`despia edit` mounts the editor surface this way; the reload channel stays first) */
  mount?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** rebuild outcomes, for a mount that publishes them (the studio-apps event hub):
   *  "swap" | "reload" = a successful rebuild (hot-swappable or structural), "failed" =
   *  the build broke. Fired AFTER the SSE clients are notified; never for the boot build. */
  onRebuilt?: (result: "swap" | "reload" | "failed") => void;
  /** explicit home of the intended-face subsets (tests and the repo's oracles pass the
   *  Type satellite's dir; unset, resolveDevFontsDir looks in the project then the repo) */
  fontsDir?: string;
};

/** Build, serve, watch. Resolves once the socket is listening and the first build is done. */
export async function startDevServer(config: ProjectConfig, opts: DevOptions = {}): Promise<DevServer> {
  const fontsDir = resolveDevFontsDir(config.root, opts.fontsDir);
  const log = opts.log ?? console.log;
  const clients = new Set<ServerResponse>();
  let lastError: Error | null = null;

  const rebuild = (): BuildResult | Error => {
    try {
      const result = buildProject(config);
      lastError = null;
      return result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      return lastError;
    }
  };

  const first = rebuild();
  if (first instanceof Error) log(`[despia dev] build failed: ${first.message}`);
  else log(`[despia dev] built ${first.components} components → ${first.outDir}`);

  const notify = (kind: "reload" | "swap" = "reload"): void => {
    for (const client of clients) client.write(`event: ${kind}\ndata: 1\n\n`);
  };

  let lastStructure: string | null = null;
  const notifyRebuilt = (): void => {
    let structure: string | null = null;
    try {
      structure = registryStructure(readFileSync(join(config.outDir, "registry.json"), "utf8"));
    } catch {
      // no registry to compare — the safe answer is the full reload
    }
    const swap = structure !== null && lastStructure !== null && structure === lastStructure;
    if (structure !== null) lastStructure = structure;
    notify(swap ? "swap" : "reload");
    opts.onRebuilt?.(swap ? "swap" : "reload");
  };
  // seed from the boot build, so the very first edit can already ride the swap lane
  if (!(first instanceof Error)) {
    try {
      lastStructure = registryStructure(readFileSync(join(config.outDir, "registry.json"), "utf8"));
    } catch { /* stays null — the first rebuild answers with a reload, the safe lane */ }
  }

  // The latest app-state snapshot, verbatim as the app posted it. One slot: the dev
  // server serves one project to one person, and the panel wants "now", not history.
  let lastState = "";
  // The latest pick or reorder intent off the select door (P5) — same one-slot logic.
  let lastSelect = "";

  const liveLogs = new LiveRing<unknown>(LIVE_RING_CAP);
  // Runs in flight ("Try it", WE6): id → resolver, settled by the app page's POST to
  // RUN_PATH or by the timeout. First answer wins; a late or unknown id is dropped.
  const pendingRuns = new Map<string, (result: { ok: boolean; value: unknown; error: string | null }) => void>();
  let runSeq = 0;
  const runInApp = (
    action: string,
    args: { [k: string]: unknown },
    timeoutMs = 3000,
  ): Promise<{ answered: boolean; ok: boolean; value: unknown; error: string | null }> => {
    const id = `run${++runSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRuns.delete(id);
        resolve({ answered: false, ok: false, value: null, error: null });
      }, timeoutMs);
      pendingRuns.set(id, (result) => {
        clearTimeout(timer);
        pendingRuns.delete(id);
        resolve({ answered: true, ...result });
      });
      const payload = JSON.stringify({ id, action, args }).replace(/\n/g, "");
      for (const client of clients) client.write(`event: run\ndata: ${payload}\n\n`);
    });
  };

  const server = createServer((req, res) => {
    if (handleLogsDoor(req, res, liveLogs, log)) return;
    if ((req.url ?? "/").split("?")[0] === SELECT_PATH) {
      if (req.method === "POST" || req.method === "PUT") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (req.method === "POST") {
            lastSelect = body; // the page reporting a pick or an intent
          } else {
            // the studio's two PUT commands: {mode} arms/disarms the tool; {highlight}
            // (P12 mapping view) asks the page to FLASH every element whose display
            // string matches - table row to canvas, one SSE event, nothing persisted
            let parsed: { mode?: unknown; highlight?: unknown } = {};
            try { parsed = JSON.parse(body) as typeof parsed; } catch { /* not JSON */ }
            if (typeof parsed.highlight === "string" && parsed.highlight.length > 0) {
              const payload = JSON.stringify(parsed.highlight).replace(/\n/g, "");
              for (const client of clients) client.write(`event: highlight\ndata: ${payload}\n\n`);
            } else {
              const word = String(parsed.mode ?? "");
              const mode = word === "select" || word === "interact" ? word : "interact";
              for (const client of clients) client.write(`event: selectmode\ndata: ${mode}\n\n`);
            }
          }
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        });
        return;
      }
      res.writeHead(200, devHeaders("application/json; charset=utf-8"));
      res.end(lastSelect === "" ? "{}" : lastSelect);
      return;
    }
    if ((req.url ?? "/").split("?")[0] === RUN_PATH) {
      // the app page posting a run's settled result
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const m = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
              { id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
            const settle = typeof m.id === "string" ? pendingRuns.get(m.id) : undefined;
            if (settle !== undefined) {
              settle({ ok: m.ok === true, value: m.value ?? null, error: typeof m.error === "string" ? m.error : null });
            }
          } catch { /* not JSON — dropped, the timeout answers */ }
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        });
        return;
      }
      res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
      res.end(JSON.stringify({ reason: "method_not_allowed", message: "the run door takes POSTed results" }));
      return;
    }
    if ((req.url ?? "/").split("?")[0] === STATE_PATH) {
      if (req.method === "POST" || req.method === "PUT") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (req.method === "POST") {
            lastState = body;
          } else {
            // a studio write: single-line JSON rides the SSE stream into the app page
            for (const client of clients) client.write(`event: state\ndata: ${body.replace(/\n/g, "")}\n\n`);
          }
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        });
        return;
      }
      res.writeHead(200, devHeaders("application/json; charset=utf-8"));
      res.end(lastState === "" ? '{"screen":null,"vars":[]}' : lastState);
      return;
    }
    if ((req.url ?? "/").split("?")[0] === RELOAD_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => { clients.delete(res); });
      return;
    }
    const path = (req.url ?? "/").split("?")[0]!;
    if (path.startsWith(DEV_FONTS_PREFIX)) {
      const name = path.substring(DEV_FONTS_PREFIX.length);
      const legal = (DEV_FONT_FILES as readonly string[]).includes(name);
      if (!legal || fontsDir === null) { res.writeHead(404, devHeaders("text/plain; charset=utf-8")); res.end("no such font"); return; }
      // stable within a session on purpose - the one dev asset that never changes
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=3600" });
      res.end(readFileSync(join(fontsDir, name)));
      return;
    }
    if (path === PREVIEW_PATH) {
      res.writeHead(200, devHeaders(MIME[".html"]!));
      res.end(previewPage(config.name, fontsDir !== null));
      return;
    }
    if (opts.mount !== undefined) {
      void opts.mount(req, res).then((owned) => {
        if (!owned) serveStatic(config.outDir, req, res, lastError, fontsDir !== null);
      }).catch((e: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, devHeaders("application/json; charset=utf-8"));
          res.end(JSON.stringify({ reason: "handler_failed", message: "internal error" }));
        }
        log(`[despia dev] mount failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }
    serveStatic(config.outDir, req, res, lastError, fontsDir !== null);
  });

  const port = await listen(server, opts.port ?? 5273, opts.host);

  let watcher: FSWatcher | null = null;
  if (opts.watch !== false) {
    let timer: NodeJS.Timeout | null = null;
    const onChange = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const result = rebuild();
        if (result instanceof Error) log(`[despia dev] rebuild failed: ${result.message}`);
        else log(`[despia dev] rebuilt ${result.components} components`);
        if (result instanceof Error) { notify("reload"); opts.onRebuilt?.("failed"); }
        else notifyRebuilt();
      }, 80);
      timer.unref?.();
    };
    watcher = watch(config.root, { recursive: true }, (_event, filename) => {
      if (filename === null) return onChange();
      const path = resolve(config.root, filename.toString());
      // never react to our own output, or the watcher rebuilds forever — the site build
      // (outDir) and the server-document compile step (server/generated) are both ours
      if (!relative(config.outDir, path).startsWith("..")) return;
      if (!relative(join(config.root, "server", "generated"), path).startsWith("..")) return;
      if (/\.(dsx|css|json|js|ts)$/.test(path)) onChange();
    });
  }

  return {
    port,
    rebuild,
    stateSnapshot: () => lastState,
    runInApp,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      watcher?.close();
      for (const client of clients) client.end();
      clients.clear();
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      server.closeAllConnections();
    }),
  };
}

function listen(server: ReturnType<typeof createServer>, port: number, host?: string): Promise<number> {
  return new Promise((resolvePort) => {
    const done = (): void => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : port);
    };
    if (host === undefined) server.listen(port, done);
    else server.listen(port, host, done);
  });
}

/** Serve one file out of the build output. Extensionless misses fall back to the SPA shell
 *  so client-routed deep links cold-load, exactly like the repo demo server. */
function serveStatic(outDir: string, req: IncomingMessage, res: ServerResponse, buildError: Error | null, fonts: boolean = true): void {
  if (buildError !== null) {
    res.writeHead(500, devHeaders(MIME[".html"]!));
    res.end(injectReloadClient(errorPage(buildError), fonts));
    return;
  }
  let path = "/";
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith("/")) path += "index.html";
    const full = join(outDir, path);
    if (!full.startsWith(outDir)) { res.writeHead(403).end(); return; }
    if (existsSync(full) && statSync(full).isFile()) {
      const body = readFileSync(full);
      const type = MIME[extname(full)] ?? "application/octet-stream";
      if (type.startsWith("text/html")) {
        res.writeHead(200, devHeaders(type));
        res.end(injectReloadClient(body.toString("utf8"), fonts));
      } else {
        res.writeHead(200, devHeaders(type));
        res.end(body);
      }
      return;
    }
    if (extname(path) === "") {
      const nested = join(outDir, path, "index.html");
      if (existsSync(nested)) {
        res.writeHead(200, devHeaders(MIME[".html"]!));
        res.end(injectReloadClient(readFileSync(nested, "utf8"), fonts));
        return;
      }
      const shell = join(outDir, "index.html");
      if (existsSync(shell)) {
        res.writeHead(200, devHeaders(MIME[".html"]!));
        res.end(injectReloadClient(readFileSync(shell, "utf8"), fonts));
        return;
      }
    }
  } catch { /* fall through to 404 */ }
  res.writeHead(404, devHeaders("text/plain; charset=utf-8"));
  res.end("not found");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A build failure is shown, never hidden behind a stale page. */
export function errorPage(error: Error): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>despia dev — build failed</title>
<style>body{font:14px/1.5 ui-monospace,monospace;margin:0;padding:2rem;background:#1b1b1f;color:#f7f7f8}
h1{font-size:1rem;color:#ff6b6b;margin:0 0 1rem}pre{white-space:pre-wrap;margin:0}</style></head>
<body><h1>despia dev — build failed</h1><pre>${escapeHtml(error.message)}</pre></body></html>
`;
}

// ── repo demo mode ─────────────────────────────────────────────────────────────────────

/** `despia dev --demo`: hand off to packages/compiler/bin/serve.ts. The specifier is computed at
 *  runtime on purpose — that file lives in the repository, never in an installed @despia/cli. */
export async function startDemoServer(from: string, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const repo = findRepoRoot(from);
  if (repo === null) {
    throw new Error("--demo serves the repository demo, but no despia-framework checkout was found above " + from);
  }
  const entry = join(repo, "OpenSource/Web/packages/compiler/bin/serve.ts");
  if (!existsSync(entry)) throw new Error(`the repository dev server is missing: ${entry}`);
  const mod = await import(pathToFileURL(entry).href) as {
    startServer: (port: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  return await mod.startServer(port);
}
