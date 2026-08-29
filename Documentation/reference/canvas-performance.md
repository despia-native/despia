# What the Studio's canvases cost, and what they do when things go wrong

Two questions about the node canvases had never been asked, and both of them block shipping the
Studio to anyone who is not us.

**What does a canvas cost a real browser?** `exprflow.test.ts` proves the projection is fast -
1000 nodes in 188 ms - but it proves it in Node, with no document. The surface an author uses has
to turn that projection into DOM, style it, lay it out, paint it, and stay responsive while a hand
is dragging a value. None of that is in the 188 ms.

**What does the canvas do when something fails?** A half-typed expression, a body the reader
cannot address, a dev server that died in another terminal, a write that lost a race, a laptop
screen. An editor is judged on this path, not the happy one: a canvas that draws a perfect graph
and silently drops an edit is worse than one that draws nothing, because the author does not find
out until later.

Two oracles answer them, and both are gates:

| oracle | what it holds | invocation |
|---|---|---|
| `packages/dom/oracle/canvas-perf-browser.ts` | the budgets below, plus a recorded baseline per fixture | `SHOTS=<dir> DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-perf-browser.ts` |
| `packages/dom/oracle/canvas-degraded-browser.ts` | one judgement per failure state | `SHOTS=<dir> DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-degraded-browser.ts` |

Both boot the REAL Studio (`startEditServer`), walk the route an author walks (map card, **Open in
editor**, **Logic view**, a body, its first argument row, **Diagram**), print one line per check
and exit non-zero on failure. A check that is already red the day the gate lands reports
`PENDING` with the handoff item that fixes it rather than failing, because a gate that is red on
arrival gets disabled by the next person who sees it.

---

## 1. The instruments, and why each one

A wall clock around a gesture measures the test harness as much as the browser. Every number here
comes from an instrument the engine keeps for itself.

| what | instrument | why this one |
|---|---|---|
| style recalculations, layouts, and their durations | CDP `Performance.getMetrics` - `RecalcStyleCount` · `RecalcStyleDuration` · `LayoutCount` · `LayoutDuration` | counters, so a delta across a gesture is exact and cheap. This is what settles the pan question: a pan that increments `LayoutCount` is a relayout, whatever it feels like on a fast box |
| paint | CDP `Tracing`, categories `devtools.timeline` + `disabled-by-default-devtools.timeline`, filtered to `UpdateLayoutTree` · `Layout` · `PrePaint` · `Paint` · `Commit` | `getMetrics` has no paint counter. `Commit` also counts the frames the compositor actually took, which is what turns a total into a per-frame cost |
| interaction latency | the **Event Timing API** (`PerformanceObserver`, `type: "event"`, `durationThreshold: 0`) | the platform's own input-to-next-paint, and the number a field study of real authors would report. Quantized to 8 ms |
| the same, for gestures that await a fetch | a capture-phase `event.timeStamp`, then a double `requestAnimationFrame` once the DOM reaches a stated ready condition | Event Timing stops at the first paint after the handler returns; for **Diagram** that paint is the fade-in, not the graph. This one waits for the graph. Its floor is about two frames, so it is a ceiling on the same quantity rather than a second opinion |
| the server's share | Resource Timing on `/edit/api/expr/` | separates the projection from the rendering, so the browser's half is measured alone |
| memory | CDP `Memory.getDOMCounters().nodes` and `Performance.getMetrics().JSHeapUsedSize`, after a forced `HeapProfiler.collectGarbage` | **the engine will not give an honest whole-renderer figure here**: `performance.measureUserAgentSpecificMemory()` is not exposed, because the page is not cross-origin isolated. Live DOM node count and JS heap are what it will give, and they are what is reported |

**Statistics.** Every duration is a **median of `RUNS` passes** (default 3), never one sample.
Counts are exact and are treated as censuses in the discipline of `check_editor_scale.rb`: a count
that moves when nobody meant to move it is the whole value of writing it down.

**Machine speed.** The oracle first times a fixed DOM workload on a scratch page and compares it
to the reference recorded in `BASELINE.cal`. Timing budgets are multiplied by that ratio, clamped
at 1: a slower CI box does not red the lane, and a fast box does not silently tighten a budget
nobody agreed to. It does not correct for a box under concurrent load, which is the one source of
noise left; that is what the 2x baseline tolerance is for.

---

## 2. The fixtures

A formula has two ways of being big, and they cost different things.

- **`sumN`** grows the operand count under one node. The projection folds a run past 24 arms into
  one card, so this grows the page's bytes without growing its card count - exactly the case a
  card-count budget would miss.
- **`deepN`** grows the card count, one card per level of nesting, which is what the canvas has to
  build, style and lay out.

Both ladders run past the worst thing the corpus contains. The four named corpus cases
(`chain12`, `record30`, `matrix`, and `deep30` itself) sit between them. The fixtures are declared
in the oracle rather than imported from `expression-canvas-browser.ts`, because that module is a
script with a top-level `page.goto`: importing its list would boot a second Studio as a side
effect of reading it.

---

## 3. The budgets, and why each number is that number

None of these is invented, and none is "the number we measured, rounded up". Three are the
thresholds any interactive surface is held to; the rest fall out of them or out of the
mechanism.

| budget | value | the reasoning |
|---|---|---|
| `panFrameMs` | **16 ms** | one frame at 60 Hz, main thread included. A pan holds a pointer, so every frame it misses is a frame the author's hand has already moved past. There is no softer version of this number |
| `panLayoutCount` | **0** | not "fast enough" - zero. The canvas transforms one world layer, and the compositor can carry that without the main thread entering layout at all. A single layout during a drag means the mechanism is not the one the surface was built around |
| `panStyleRecalcs` | **4** over a 20-step drag | one element's transform changes, so the style work should be bounded to it. Four is slack for the zoom readout and the shell's own idle heartbeat, which is measured separately and subtracted |
| `panDomWrites` | **30** over a 20-step drag | one attribute write per drag frame, plus slack. This is the diagnostic budget: when it is missed, its own line names which elements were rewritten, which is the difference between "a pan is slow" and a fix |
| `openMs` | **500 ms** | a one-off gesture, not a frame. RAIL puts "still one action" at 1 s and "feels immediate" at 100 ms; the canvas opens behind a fade, so the honest target is between them. 500 ms is a transition a person reads as a transition rather than as a stall |
| `interactionMs` | **200 ms** to fail, **100 ms** as the target | 100 ms is where a response stops feeling caused by the gesture; 200 ms is the platform's own "good INP" line. Both are printed, so a drift between them is visible before it crosses |
| `leakNodesPerCycle` | **2** | the measured noise floor of the Studio's own idle re-rendering. A leak is orders above it, so this does not need to be tight to be useful |
| `nodeCeiling` | see below | derived from the ladder, not chosen |

---

## 4. The degraded states

`canvas-degraded-browser.ts` puts the surface into nine states a real author reaches on an
ordinary afternoon and judges what it does. Every row was measured against the landed Studio.

| state | what happens today | verdict |
|---|---|---|
| the expression does not parse (`return (subtotal + shipping`) | the canvas draws the text as an unnamed node - 2 cards, the bar carries the NEW source, no stale graph, and the server reports `exact=true`, so a splice through it replaces exactly those bytes | **acceptable.** The reader is total by design; the drawing is a picture of the text rather than a guess at its structure, and the write door stays byte-safe. The oracle holds the invariant that matters - writable implies exact |
| a half-written call (`items.map(i => i.price *`) | 4 cards, the bar carries the new source | **acceptable** |
| the document is read-only (a body whose projection is not byte-exact) | the field is `disabled`, **Save** is not rendered, **Wrap in** is `disabled`, and the warning names the reason | **acceptable.** The affordances are off, not refused later, which is the right order |
| a write with a correct revision | **400 `bad_request`, and the file is unchanged** | **defect - DEG-3.** The payload spells the operation key `kind`; `parseFlowOp` reads `op`. Every write from this canvas has always been refused. **Save** and **Wrap in** have never worked |
| a write refused as stale | the server refuses correctly (`409 stale_revision` when the request reaches the check) and **the file is never corrupted**, but the panel stays open with the typed value in it and nothing on screen says so | **defect - DEG-4.** `<api>` fires `on:error` and publishes `.error{status,message}`; `exprWrite` declares neither |
| the body is empty (`<action as="blank">`) | the action is **not listed in the Logic view at all** | **defect - DEG-1.** `logicBodies` skips any body whose text is blank. `parseDsx` records a span for it and `projectFlow("")` draws start + End exactly, so the guard is the only thing in the way |
| the body does not exist (a bad `at`/`to`) | `at=99999&to=100000` -> `400 bad_request`; `at=8&to=4` -> `400 bad_request`; `at=0&to=999999` -> `200`, clamped to the body | **acceptable.** An address the file cannot contain is refused; an over-long range is clamped, which is the deliberate reading of "to the end" |
| 1280x800 and 1024x768 | the canvas pane is 876x744 and 620x712, the page does not scroll sideways, and no node ink is under the floating chrome | **acceptable**, and worth keeping: 620px of working width at 1024 is tight but honest, and the fit contract handles it by scrolling rather than by shrinking type |
| `prefers-reduced-motion: reduce` | 0 elements on the surface carry a transition, 0 carry an animation | **acceptable.** `Editor.css` spells every duration with `--dsx-duration-fast`, which aliases the kernel's `--dsx-dur-fast`, which the kernel zeroes under the query (`packages/dom/src/theme.ts`) |
| offline between a read and a write | the canvas **keeps drawing the previous formula**, titled with the new one, and says nothing | **defect - DEG-2** |
| the dev server dies mid-session | identical: the last graph stays up, no banner, and **Save** is still offered | **defect - DEG-2** |

The two silence defects are one cause. `<api>` keeps stale data across a failed refetch on
purpose, and publishes `.error` and `.loading` beside it so the consumer can say what happened.
`EditorExpression.dsx` reads `.data` and nothing else, so a network failure, a dead server and a
formula that did not change all render the same picture.

---

## 5. The one number

If one number goes on a dashboard for this surface, it is:

> **the 95th percentile of style + layout + paint per committed frame during a pan, in
> milliseconds, against the 16 ms line.**

Not the open time, and not the keystroke latency. Both of those are one-off gestures with
comfortable ceilings, and neither moves when the surface gets structurally worse. The pan frame
does. It rises when a fixture gets bigger, when a rule is added to the sheet, when a computed
gains a dependent, when the fit or zoom contract changes, and when the reactive fan-out widens -
which is to say it is the only number that is downstream of every decision anyone makes on this
surface. It is also the one measured under continuous input, which is the hardest thing the
canvas is ever asked to do, and it maps to something a person can feel without being told what to
look for: whether the drawing keeps up with their hand.

The oracle prints it as the `pan.frame` line.

---

## 6. Running them, and keeping them honest

```bash
cd OpenSource/Web
export DSX_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

SHOTS=/tmp/perf node packages/dom/oracle/canvas-perf-browser.ts        # the budgets
SHOTS=/tmp/deg  node packages/dom/oracle/canvas-degraded-browser.ts    # the failure states

RUNS=5 CASE=sum40,matrix node packages/dom/oracle/canvas-perf-browser.ts   # a narrower, quieter read
RECORD=1 node packages/dom/oracle/canvas-perf-browser.ts                   # print a fresh BASELINE block
```

`SHOTS` is optional in both. `CASE` and `RUNS` are perf only.

**How the two gates differ, deliberately.** The perf oracle's `PENDING` map is advisory for
timings and hard for counts: a timing that comes good prints `FIXED` and does not fail the run,
because a noisy improvement on a busy box should not red a lane. The degraded oracle's `KNOWN`
map is hard in both directions - its states are discrete, so a case that starts passing is a fact
somebody should be made to write down, and it fails with the instruction to delete its row.

**Re-recording.** Re-record only on a quiet machine, and say in the commit why. The recorded
`cal` makes the comparison machine-independent for SPEED but not for CONTENTION: a box running
three other browser oracles produces honest structural results (counts, DOM writes, layout
counts, the leak) and inflated durations. If a timing baseline needs raising, the question to
answer first is whether the surface got slower or the box got busier.

**Related gates.** `expression-canvas-browser.ts` holds the drawing's geometry, and
`studio-surfaces-browser.ts` holds every surface's design census. Neither of them looks at cost
or at failure, and this pair does not look at either of theirs. All four boot the same Studio the
same way.
