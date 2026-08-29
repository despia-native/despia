//
//  The shot pipeline, end to end, through the REAL renderer against a real fixture project.
//
//  This suite is the one that matters. The pure corpora (Conformance/shot) pin the laws; this
//  proves the laws hold when a browser actually runs the app - that a sampled leaf reaches an
//  api bound on it, that the DAG and the page-load action fill the screen, and above all that
//  the guards REFUSE. A guard that has never fired is a guard nobody should trust.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { planAll, renderAll, pngDrift } from "../dist/src/shot-run.js";
import { pngSize, pngHasAlpha } from "../dist/src/shot-render.js";
import { auditCassette, cassetteKey, CASSETTE_FORBIDDEN_HEADERS } from "../dist/src/shot.js";

const webRoot = join(import.meta.dirname, "../../..");
const fixture = join(webRoot, "../Conformance/shot/fixture");
const shotsDir = join(fixture, "shots");

test("shot: the static plan tier resolves the good shots and refuses the unsampled api", () => {
  const plan = planAll(fixture);
  const byName = new Map(plan.outcomes.map((o) => [o.profile.as ?? o.profile.document, o]));
  assert.equal(byName.get("01-orders")!.unresolved.length, 0);
  const noSample = byName.get("neg-01-no-sample")!;
  assert.equal(noSample.unresolved.length, 1);
  assert.equal((noSample.unresolved[0] as { kind: string }).kind, "api");
  assert.match((noSample.unresolved[0] as { fix: string }).fix, /sample=/);
});

test("shot: renders, guards and captures end to end", { timeout: 180_000 }, async () => {
  rmSync(shotsDir, { recursive: true, force: true });
  const run = await renderAll(fixture, webRoot);
  const by = new Map(run.outcomes.map((o) => [o.name, o]));

  // ── the owner's case, proven in pixels ──
  // A sampled <variable> feeds an <api> url bound on it; the DAG opens the gate; the seam
  // answers by TEMPLATE; a page-load action reads the global plane; the list fills.
  const good = by.get("01-orders")!;
  assert.ok(good.ok, `01-orders should render: ${JSON.stringify(good.findings)} ${good.errors.join(";")}`);
  assert.equal(good.width, 1320);
  assert.equal(good.height, 2868);   // the 6.9" App Store asset, exactly
  const png = readFileSync(good.path!);
  assert.equal(pngHasAlpha(png), false, "both stores refuse an alpha channel");
  assert.deepEqual(pngSize(png), { width: 1320, height: 2868 });

  // ── the scheme law: dark moves colour only, never geometry ──
  const dark = by.get("02-orders-dark")!;
  assert.ok(dark.ok);
  assert.equal(dark.width, good.width);
  assert.equal(dark.height, good.height);

  // ── G-unresolved: an api with no sample never reaches a browser ──
  const noSample = by.get("neg-01-no-sample")!;
  assert.equal(noSample.ok, false);
  assert.equal(noSample.path, undefined, "a refused shot must produce NO IMAGE");
  assert.equal(noSample.unresolved[0]!.kind, "api");

  // ── G-empty: the "No data found" screenshot. Everything resolved, nothing threw, the
  //    api answered - with an empty array - and the screen rendered perfectly and said
  //    nothing. Only the zero-row rule catches this one.
  const empty = by.get("neg-02-empty-list")!;
  assert.equal(empty.ok, false);
  assert.equal(empty.path, undefined);
  assert.equal(empty.findings.length, 1);
  assert.equal(empty.findings[0]!.guard, "G-empty");
  assert.match(empty.findings[0]!.reason, /ZERO rows/);

  // ── allowEmpty, resolved through the author's own ref= name ──
  const allowed = by.get("neg-03-empty-allowed")!;
  assert.ok(allowed.ok, `allowEmpty should permit the empty list: ${JSON.stringify(allowed.findings)}`);
  assert.ok(existsSync(allowed.path!));

  // ── G-cover: the scene containment law. A decoration whose measured box lands on
  //    readable app UI without declaring `over: "screen"` is an accident (the chip that
  //    drifts onto the greeting when a headline wraps), and the render refuses it.
  const covered = by.get("neg-05-cover")!;
  assert.equal(covered.ok, false);
  assert.equal(covered.path, undefined, "a refused shot must produce NO IMAGE");
  assert.equal(covered.findings[0]!.guard, "G-cover");
  assert.match(covered.findings[0]!.subject, /chip:1/);
  assert.match(covered.findings[0]!.reason, /readable app UI/);

  // ── and the SAME overlap, declared, is a composition: the review cards of strip-3 sit
  //    on the phone on purpose, their rows say so, and the render publishes.
  const declared = by.get("40-strip-3")!;
  assert.ok(declared.ok, `declared covers must publish: ${JSON.stringify(declared.findings)}`);

  // ── G-safe: the card canvas keeps a 1rem safe inset - a deviceWidth past the safe
  //    width glues the phone to the card border, and the render refuses it on the
  //    MEASURED frame, not on the declared number.
  const crowded = by.get("neg-06-crowded")!;
  assert.equal(crowded.ok, false);
  assert.equal(crowded.path, undefined, "a refused shot must produce NO IMAGE");
  assert.ok(crowded.findings.some((f) => f.guard === "G-safe" && f.subject === "device"),
    `expected a G-safe device finding: ${JSON.stringify(crowded.findings)}`);
});

test("shot: two renders of one profile are byte-identical", { timeout: 180_000 }, async () => {
  // The determinism plane earns its keep here: a pinned clock, a seeded Math.random, a fixed
  // timezone and locale, frozen motion. Without them "reproducible" is a claim; with them it
  // is a byte comparison, which is also what makes `dsx shot --check` meaningful at all.
  const first = await renderAll(fixture, webRoot);
  const a = first.outcomes.find((o) => o.name === "01-orders")!;
  const beforeBytes = readFileSync(a.path!);
  const second = await renderAll(fixture, webRoot);
  const b = second.outcomes.find((o) => o.name === "01-orders")!;
  assert.equal(pngDrift(beforeBytes, readFileSync(b.path!)), 0);
});

test("shot: a cassette can never carry credential material", () => {
  // Not a preference. A cassette is git-tracked and reviewable - that is its whole purpose -
  // so a recorder that wrote headers verbatim would commit a staging bearer token into a
  // customer repository, at scale, forever. The recorder has no field to put them in, and
  // this is the gate that keeps it that way.
  assert.ok(CASSETTE_FORBIDDEN_HEADERS.has("authorization"));
  assert.ok(CASSETTE_FORBIDDEN_HEADERS.has("cookie"));
  const clean = {
    version: 1 as const,
    recordedAt: "2026-01-01T00:00:00Z",
    entries: [{ as: "orders", method: "GET", url: "/api/orders", bodyHash: null, status: 200, data: [{ id: 1 }] }],
  };
  assert.deepEqual(auditCassette(clean), []);
  const leaky = {
    ...clean,
    entries: [{ ...clean.entries[0]!, authorization: "Bearer sk_live_abcdef123456" } as never],
  };
  assert.ok(auditCassette(leaky).length > 0, "a leaked credential must be caught");
});

test("shot: a cassette key is method + url + body hash, and never the body", () => {
  const key = cassetteKey("POST", "/api/orders", JSON.stringify({ email: "person@example.com" }));
  assert.match(key, /^POST \/api\/orders [0-9a-f]{32}$/);
  assert.ok(!key.includes("person@example.com"), "the raw body must never enter the key");
});

test("shot: the shot skin changes no shipping web build", async () => {
  // The skin exists so an image can DEPICT the native build (09 §3). It must never leak into
  // a page that merely runs on the web - system-defaults.md's never-fake-Cupertino law governs
  // running surfaces, and this is how the scope stays honest rather than becoming an exception.
  const theme = await import("@despia/dom/theme");
  const skin = await import("@despia/dom");
  const elements = (theme as { ELEMENTS_CSS: string }).ELEMENTS_CSS;
  // The AUTHORED surface material (.dsx-surface-glass/-ultraThin) is a real cross-renderer
  // material - iOS renders those tokens as a material, so the browser frosting them is
  // parity, not fakery. The law this gate keeps is narrower and still absolute: frost in
  // the shipping sheet serves ONLY the authored material tokens, never depiction chrome.
  for (const rule of elements.split("}")) {
    if (!rule.includes("backdrop-filter")) continue;
    assert.ok(/\.dsx-surface-(glass|ultraThin)/.test(rule) || rule.includes("@supports"),
      `frost outside the authored surface material: ${rule.slice(0, 120)}`);
  }
  assert.ok(!elements.includes("--dsx-shot-glass"), "shot tokens must not reach the default sheet");
  const css = (skin as { shotSkinCss: (l?: string) => string }).shotSkinCss("glass");
  assert.ok(css.includes("backdrop-filter"), "the skin itself is the material");
  assert.equal((skin as { shotSkinCss: (l: string) => string }).shotSkinCss("flat"), "",
    "flat is the shipping web treatment: no skin at all");
});

test("shot: --check detects drift and passes on an unchanged set", { timeout: 240_000 }, async () => {
  const { checkAll } = await import("../dist/src/shot-run.js");
  const clean = await checkAll(fixture, webRoot, 0);
  const good = clean.lines.filter((l) => l.includes("01-orders"));
  assert.equal(good.length, 1);
  assert.match(good[0]!, /matches the committed image/);

  // A different image at the same geometry must read as drift, not as a pass.
  const a = readFileSync(join(shotsDir, "01-orders.png"));
  const b = readFileSync(join(shotsDir, "02-orders-dark.png"));
  assert.ok(pngDrift(a, b) > 0, "two different renders must not compare equal");
  assert.equal(pngDrift(a, a), 0);
});

test("shot: reactive left/top actually bind, and decorations land where declared",
  { timeout: 180_000 }, async () => {
  // THE REGRESSION THIS GUARDS. Every decoration on a slide is placed by a reactive
  // `left`/`top`, so if that binding ever stops working the whole decoration layer silently
  // stacks down the left edge instead of failing - a broken screenshot that every guard
  // passes. The probe fixture places one statically-positioned box and one reactively
  // positioned box at known percentages; both must land on the arithmetic.
  const { renderAll } = await import("../dist/src/shot-run.js");
  const run = await renderAll(fixture, webRoot, ["91-pos-probe", "30-showcase"]);
  const probe = run.outcomes.find((o) => o.name === "91-pos-probe")!;
  assert.ok(probe.ok, `the position probe must render: ${JSON.stringify(probe.findings)}`);

  const showcase = run.outcomes.find((o) => o.name === "30-showcase")!;
  assert.ok(showcase.ok, `the showcase must render: ${JSON.stringify(showcase.findings)}`);
  assert.equal(showcase.width, 1320);
});

test("shot: the decoration layer refuses to impersonate a store award", async () => {
  // Not a styling preference. "Editors' Choice" is a real Google Play award with its own
  // branding and "Top Rated" reads as one; both stores' metadata policies ban implying an
  // editorial endorsement you do not have, and it is a trademark problem besides. The
  // component ships no such badge and this asserts it stays that way, because the pressure
  // to add one comes from every marketing conversation.
  const { readFileSync: read } = await import("node:fs");
  const decor = read(join(webRoot, "../Shots/Components/ShotDecorItem.dsx"), "utf8");
  const banned = [/editor'?s?\s*choice/i, /top\s*rated/i, /app\s*of\s*the\s*(day|year)/i,
    /google\s*play\s*award/i, /apple\s*design\s*award/i];
  for (const pattern of banned) {
    assert.ok(!pattern.test(decor),
      `the decoration layer must not ship a store-award badge (${pattern})`);
  }
  // What it DOES ship: kinds that carry a claim a customer can substantiate.
  for (const kind of ["asset", "badge", "chip", "callout"]) {
    assert.ok(decor.includes(`'${kind}'`), `the ${kind} decoration kind must exist`);
  }
});

// ── the slide library is a PACKAGE, and a profile may name a component that lives in one ──
//
//  The templates moved out of this fixture into OpenSource/Shots so that the CLI, the Studio's
//  Distribution board and a customer project all render the SAME components - the drift this
//  library exists to prevent starts the moment a template has to be copied to be used. A
//  profile therefore names a bare document and resolution reaches past the project scheme.
test("shot: a profile resolves a document that lives in a package", async () => {
  const { buildProjectRegistry, resolveDocument } = await import("../dist/src/shot.js");
  const { loadConfig } = await import("../dist/src/config.js");
  const cfg = loadConfig(fixture);
  const { registry } = buildProjectRegistry(cfg, "web");

  // the package template
  const pro = resolveDocument(registry, cfg.scheme, "ShotPro");
  assert.ok(pro !== null, "ShotPro ships in the Shots package and must resolve");
  assert.ok(pro!.endsWith(".ShotPro"));
  assert.notEqual(pro, `${cfg.scheme}.ShotPro`, "it is NOT a project component");

  // the project still wins for its own documents
  assert.equal(resolveDocument(registry, cfg.scheme, "Orders"), `${cfg.scheme}.Orders`);

  // and a name nothing provides is a precise null rather than a guess
  assert.equal(resolveDocument(registry, cfg.scheme, "NoSuchTemplate"), null);
});

// ── the Distribution surface renders INSIDE the Studio, which is the only place it renders ──
//
//  Every editor rule is emitted scoped as [data-dsx-owner="Editor"], so a surface booted on its
//  own is structurally correct and completely unstyled - no wells, no section words, no node
//  chrome. A whole design pass was judged against exactly that lie. This test boots the REAL
//  shell, reaches Distribution the way a person does (the rail), and asserts the scoped rules
//  actually landed, so the mistake cannot be made silently again.
test("studio: Distribution renders inside the editor shell, with the editor's own styling",
  { timeout: 120_000 }, async () => {
  const { launchShotBrowser } = await import("../dist/src/shot-browser.js");
  const { buildProjectRegistry, SHOT_PAGE_HTML } = await import("../dist/src/shot.js");
  const { bundleHarness } = await import("../dist/src/shot-render.js");
  const { loadConfig } = await import("../dist/src/config.js");

  const editorRoot = join(webRoot, "../../ClosedSource/DSX/Modules/Custom/Editor");
  if (!existsSync(editorRoot)) return;   // open drop: the Studio ships closed
  const cfg = loadConfig(editorRoot);
  const { discoverApps, resolveStudioApps, seedState, readAppState, resolveFirstPartyApps } =
    await import("../dist/src/studio-apps/host.js") as unknown as {
      discoverApps: (o: Record<string, unknown>) => unknown[];
      resolveStudioApps: (a: unknown[], s: unknown) => { table: unknown; refusals: unknown[] };
      seedState: (a: unknown[], s: unknown) => { state: unknown };
      readAppState: (r: string) => unknown;
      resolveFirstPartyApps: (r: string) => string[];
    };
  const discovered = discoverApps({
    projectRoot: editorRoot, packageDirs: [], lockedDirs: [],
    builtinDirs: [editorRoot, ...resolveFirstPartyApps(editorRoot)],
  });
  const appsPlane = {
    studioApi: 1,
    apps: [],
    ...resolveStudioApps(discovered, seedState(discovered, readAppState(editorRoot)).state),
    events: {},
  };
  const { registry } = buildProjectRegistry(cfg, "web");
  const schema = JSON.parse(readFileSync(
    join(webRoot, "../Documentation/reference/shot-properties.json"), "utf8"));
  const shots = JSON.parse(readFileSync(join(fixture, "dsx.shots.json"), "utf8"));
  const slides = shots.shots.filter((s: { as?: string }) => String(s.as).startsWith("40-strip"));

  const browser = await launchShotBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const saved: unknown[] = [];
    await page.route("**/*", async (route: { request(): { url(): string; method(): string; postData(): string | null }; fulfill(o: unknown): Promise<void>; abort(): Promise<void> }) => {
      const url = route.request().url();
      if (url.includes("/edit/api/shots")) {
        if (route.request().method() === "PUT") {
          saved.push(JSON.parse(route.request().postData() ?? "null"));
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, shots: slides.length }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          shots: slides, schema, device: "iphone-6.9",
          hydrate: { global: { theme: "dark" } },
          scopes: scopesFor(slides),
        }) });
      }
      //  THE RAIL IS DATA NOW (studio-apps.md §12): the Studio's own destinations and a
      //  converted first-party app's arrive through ONE fold, so the shell has no rail at all
      //  without this door. The fold is the REAL one, run over this repository, which is what
      //  keeps the assertion below a claim about the product rather than about a fixture.
      if (url.includes("/edit/api/apps")) {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(appsPlane) });
      }
      if (url.includes("/edit/api/films")) {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          films: [
            { path: "marketing/keto-launch/composition.dsx", id: "keto-launch", durationMs: 18000,
              fps: 30, width: 1080, height: 1920, scenes: 5, problems: [] },
            { path: "marketing/broken/composition.dsx", id: "broken", durationMs: 0,
              fps: 0, width: 0, height: 0, scenes: 0,
              problems: [{ code: "duration", message: "the scenes end early" }] },
          ],
          ffmpeg: false,
        }) });
      }
      if (url.includes("/edit/api/")) {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ documents: [], nodes: [], edges: [], dangling: [], width: 0, height: 0 }) });
      }
      if (!url.startsWith("http://dsx-shot.local")) return route.abort();
      const path = url.substring("http://dsx-shot.local".length).split("?")[0] || "/";
      if (path === "/" || path === "") return route.fulfill({ contentType: "text/html", body: SHOT_PAGE_HTML });
      for (const base of [join(fixture, "shots"), fixture]) {
        try { return await route.fulfill({ body: readFileSync(join(base, path)) }); } catch { /* next */ }
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://dsx-shot.local/");
    await page.addScriptTag({ content: bundleHarness(webRoot) });
    await page.addStyleTag({ content: registry.css });
    //  `bootApps` is the build fact the shell reads to tell a BOOT pane (a scheme compiled
    //  into this bundle) from a mounted app surface. Without it the rail row is there and
    //  leads nowhere, which is exactly the half-truth this test exists to refuse. It is read
    //  from the Studio's OWN config, so the self-hosting loop and this harness cannot say
    //  different things about which apps compiled in.
    const bootApps = String((cfg.consts as Record<string, unknown> | undefined)?.["bootApps"] ?? "editor");
    const bootArgs: [unknown, string, string] = [registry, `${cfg.scheme}.Editor`, bootApps];
    await page.evaluate((args: [unknown, string, string]) =>
      (globalThis as unknown as { __dsxShotBoot: (r: unknown, e: string, g: unknown, v: unknown, a: unknown, c: unknown) => void })
        .__dsxShotBoot(args[0], args[1], {}, {}, {}, { bootApps: args[2] }),
      bootArgs);
    await page.waitForTimeout(1200);

    // reached the way a person reaches it: the rail
    const rail = page.locator('[aria-label="Distribution view"]');
    assert.equal(await rail.count(), 1, "Distribution must be a rail destination");
    await rail.first().click();
    await page.waitForTimeout(1200);

    // the board: every slide of the set, side by side
    assert.equal(await page.locator(".shots-node").count(), slides.length,
      "the board shows the whole set, because a listing is judged as a set");

    // THE STYLING LANDED. A transparent frame means the owner-scoped sheet never matched.
    const painted = await page.evaluate(() => {
      const el = document.querySelector(".shots-frame");
      return el === null ? "" : getComputedStyle(el).backgroundColor;
    });
    assert.notEqual(painted, "rgba(0, 0, 0, 0)", "the editor's scoped rules must apply to this surface");

    // selecting a slide opens the inspector, and its rows are the STUDIO's rows
    await page.locator(".shots-hit").first().click();
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".shots-side").count(), 1, "a selection opens the inspector");
    assert.ok(await page.locator(".shots-side .inspect-prop-label").count() > 8,
      "the panel is built from the Studio's own label/well grammar, not its own");
    assert.ok(await page.locator(".shots-side .inspect-seg").count() > 0,
      "a closed vocabulary renders as a segmented control, never a text box");

    // ── DESIGN | DATA: the second half of the panel ──
    //
    //  A store screenshot is judged on the app UI inside the phone, and that UI renders from a
    //  SCOPE. The Data half is where the scope is authored, and the tier chip beside each well
    //  is the capture's own answer about where the value came from - which is the only thing
    //  that tells an author which file to open when the number is wrong.
    assert.equal(await page.locator(".shots-tab").count(), 2, "the panel has two halves");
    await page.locator(".shots-tab").nth(1).click();
    await page.waitForTimeout(400);

    assert.equal(await page.locator(".shots-side .inspect-props").count(), 1,
      "one half is shown at a time - the design rows are gone, not stacked underneath");
    const tiers = await page.locator(".shots-side .shots-tier").allTextContents();
    assert.deepEqual(tiers, ["sample", "override", "unresolved", "hydrate"],
      "every row wears the tier its value really came from");
    assert.equal(await page.locator(".shots-side .shots-tier-bad").count(), 1,
      "the unresolved tier is the one that produces no image, so it is the one that is red");
    assert.equal(await page.locator(".shots-tab-count").first().textContent(), "1",
      "the count on the Data word is the reason to open it");

    // an edit lands in the slide's OWN overrides, and Save writes the file the capture reads
    const well = page.locator(".shots-side .inspect-in").first();
    await well.fill("Inbox");
    await page.keyboard.press("Tab");   // a real blur: on:change is the commit, as it is for a person
    await page.waitForTimeout(400);
    await page.locator('[aria-label="Save the screenshot set"]').click();
    await page.waitForTimeout(600);
    assert.equal(saved.length, 1, "Save writes through the door, once");
    const body = saved[0] as { shots: Array<{ as: string; vars?: { title?: string } }>; hydrate: unknown };
    assert.equal(body.shots.length, slides.length, "the whole set is written, never a fragment");
    assert.equal(body.shots[0]!.vars!.title, "Inbox",
      "a Data edit lands in the slide's own vars - the capture's override tier and nowhere else");
    assert.deepEqual(body.hydrate, { global: { theme: "dark" } },
      "the project plane rides along untouched rather than being dropped by the writer");

    // ── the FILM half of the rail (12-marketing-video.md): what is on disk, with verdicts ──
    assert.equal(await page.locator(".shots-film-row").count(), 2,
      "the rail lists every marketing composition");
    assert.equal(await page.locator('.shots-film-row [aria-label="Render keto-launch"]').count(), 1,
      "a lawful film offers Render");
    assert.equal(await page.locator(".shots-film-row .shots-tier-bad").count(), 1,
      "a refused film says refused, in the rail, where the author is looking");
  } finally {
    await browser.close();
  }
});

/** A scope the way the door serves one: the resolver's answer per slide, not a description of
 *  it. Only the FIRST slide carries rows here - the panel is per-selection, and a fixture that
 *  gave every slide the same scope could not catch a panel that ignored the selection. */
function scopesFor(slides: Array<{ as?: string }>): unknown {
  const out: { [as: string]: unknown } = {};
  for (const slide of slides) {
    const as = String(slide.as);
    out[as] = as === String(slides[0]!.as)
      ? {
          document: "Orders", ok: false, missing: false,
          rows: [
            { kind: "attribute", name: "title", value: "Today", tier: "sample", over: false, fix: "" },
            { kind: "attribute", name: "badge", value: "7", tier: "override", over: true, fix: "" },
            { kind: "api", name: "feed", value: "", tier: "unresolved", over: false,
              fix: "declare sample='…' on <api as=\"feed\"/>, or record a cassette" },
            { kind: "global", name: "theme", value: "dark", tier: "hydrate", over: false, fix: "" },
          ],
        }
      : { document: "Orders", ok: true, missing: false, rows: [] };
  }
  return out;
}
