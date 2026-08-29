//
//  review.test.ts — `despia review`, the design lint. Five objective rules, each pinned
//  positive AND negative, because a design check that fires on good screens gets ignored,
//  and one that never fires proves nothing. The last tests are the tethers: the Skills
//  example app clears its own bar strict, and the command is an MCP tool by construction.
//

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { reviewSource, commandReview, TYPE_SCALE } from "../src/review.ts";
import { toolsFromDocument } from "../src/mcp.ts";
import type { Io } from "../src/cli.ts";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Skills/examples");

function review(markup: string) {
  return reviewSource("Fixture.dsx", markup);
}

function capture(): Io & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
}

test("R1: an icon-only button with no accessible name is an error; a named one is not", () => {
  const bad = review(`<hstack>\n  <button icon="gearshape"/>\n</hstack>\n`);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.level, "error");
  assert.equal(bad[0]!.line, 2);
  assert.match(bad[0]!.message, /a11yLabel/);

  for (const named of [
    `<hstack><button icon="gearshape" a11yLabel="Settings"/></hstack>`,
    `<hstack><button icon="gearshape" aria-label="Settings"/></hstack>`,
    `<hstack><button icon="gearshape" label="Settings"/></hstack>`,
  ]) {
    assert.deepEqual(review(named), [], named);
  }
});

test("R2: a tappable under the 44pt floor warns; 44 itself, non-tappables and interpolated sizes do not", () => {
  const bad = review(`<vstack>\n  <pressable height="32"><text value="Row"/></pressable>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.level, "warning");
  assert.match(bad[0]!.message, /44pt floor/);

  assert.deepEqual(review(`<vstack><pressable height="44"><text value="Row"/></pressable></vstack>`), []);
  assert.deepEqual(review(`<vstack><vstack width="8" height="8"/></vstack>`), [], "decorative dots are not tappable");
  assert.deepEqual(review(`<vstack><pressable height="{{ dsx.variable.h }}"><text value="x"/></pressable></vstack>`), [], "interpolated sizes are unknowable");
  const viaOnTap = review(`<vstack>\n  <text value="tiny" height="20" on:tap="dsx.variable.x = 1"/>\n</vstack>`);
  assert.equal(viaOnTap.length, 1, "on:tap makes any element tappable");
});

test("R3: text off the type scale warns and names the nearest size; head styles are covered", () => {
  const bad = review(`<vstack>\n  <text value="x" fontSize="19"/>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /nearest is 20/);

  const styled = review(`<vstack>\n  <head>\n    <style as="odd" fontSize="14"/>\n  </head>\n  <text value="x" class="odd"/>\n</vstack>\n`);
  assert.equal(styled.length, 1, "a <style as=> declaration is the shared spelling of the same decision");

  for (const size of TYPE_SCALE) {
    assert.deepEqual(review(`<vstack><text value="x" fontSize="${size}"/></vstack>`), [], `on-scale size ${size}`);
  }
  assert.deepEqual(review(`<vstack><image icon="star" fontSize="40"/></vstack>`), [], "image fontSize is an icon size, not type");
});

test("R4: three distinct raw hex colors warn once; two do not; interpolated values are skipped", () => {
  // every pair here clears the contrast floor, so R4 is the only voice
  const bad = review(`<vstack background="#101012">\n  <text value="x" color="#F4F4F5"/>\n  <text value="y" color="#FFD60A"/>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.level, "warning");
  assert.match(bad[0]!.message, /3 distinct raw hex/);

  assert.deepEqual(review(`<vstack background="#101012"><text value="x" color="#F4F4F5"/></vstack>`), []);
  assert.deepEqual(
    review(`<vstack background="{{ dark ? '#000000' : '#ffffff' }}"><text value="x" color="#6C5CE7"/><text value="y" color="#101012"/></vstack>`),
    [], "interpolated colors are unknowable",
  );
});

test("R5: a data-bound screen with no conditional branch gets a notice, never a failure", () => {
  const bare = review(`<vstack>\n  <list bind="dsx.variable.rows" key="id">\n    <text value="{{ item.title }}"/>\n  </list>\n</vstack>\n`);
  assert.equal(bare.length, 1);
  assert.equal(bare[0]!.level, "notice");
  assert.match(bare[0]!.message, /loading, empty and error/);

  const branched = review(`<vstack>\n  <text value="Empty" visible-if="dsx.variable.rows.length == 0"/>\n  <list bind="dsx.variable.rows" key="id"><text value="{{ item.title }}"/></list>\n</vstack>\n`);
  assert.deepEqual(branched, []);
});

test("R6: hex ink on a hex ground below the WCAG floor warns; tokens, large type and unknown grounds do not", () => {
  // #777777 on #ffffff is 4.48:1 — just under the 4.5 body floor
  const bad = review(`<vstack background="#ffffff">\n  <text value="x" color="#777777"/>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /contrast 4\.4\d:1 is under the 4\.5:1 floor/);

  // the same pair passes as LARGE type (3:1 floor)
  assert.deepEqual(review(`<vstack background="#ffffff"><text value="x" color="#777777" fontSize="20"/></vstack>`), []);
  // a clearly passing pair
  assert.deepEqual(review(`<vstack background="#ffffff"><text value="x" color="#595959"/></vstack>`), []);
  // a token ground makes the pair unknowable — no guess
  assert.deepEqual(review(`<vstack background="fill"><text value="x" color="#777777"/></vstack>`), []);
  // a token ink is correct by construction
  assert.deepEqual(review(`<vstack background="#ffffff"><text value="x" color="secondary"/></vstack>`), []);
  // an intervening non-hex ground clears the inherited hex
  assert.deepEqual(
    review(`<vstack background="#ffffff"><vstack background="fill"><text value="x" color="#777777"/></vstack></vstack>`),
    [],
  );
});

test("R7: a tappable of several texts without a11yGroup warns; grouped, single-text and component subtrees do not", () => {
  const bad = review(`<vstack>\n  <pressable on:tap="dsx.variable.x = 1">\n    <hstack>\n      <text value="Title"/>\n      <text value="Subtitle"/>\n    </hstack>\n  </pressable>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /a11yGroup/);

  assert.deepEqual(review(`<vstack><pressable on:tap="x = 1"><hstack a11yGroup="true"><text value="a"/><text value="b"/></hstack></pressable></vstack>`), []);
  assert.deepEqual(review(`<vstack><pressable on:tap="x = 1"><text value="only one"/></pressable></vstack>`), []);
  // a component child means the subtree is not this file's to judge
  assert.deepEqual(review(`<vstack><pressable on:tap="x = 1"><TrailRow trail="{{ item }}"/></pressable></vstack>`), []);
  // aria spelling counts
  assert.deepEqual(review(`<vstack><hstack on:tap="x = 1" role="group"><text value="a"/><text value="b"/></hstack></vstack>`), []);
});

test("R8: on:drag without on:adjust warns; paired controls and drawing surfaces do not", () => {
  const bad = review(`<vstack>\n  <zstack on:drag="dsx.variable.pos = dsx.this.fraction"/>\n</vstack>\n`);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /on:adjust/);

  assert.deepEqual(review(`<vstack><zstack on:drag="pos = dsx.this.fraction" on:adjust="dsx.action.nudge()" a11yValue="{{ pos }}"/></vstack>`), []);
  assert.deepEqual(review(`<vstack><canvas on:drag="x = 1"/></vstack>`), [], "a drawing surface is not a value control");
});

test("a document review cannot parse is a notice saying so, never a crash", () => {
  const findings = review(`<vstack><text value="x"</vstack>`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.level, "notice");
  assert.match(findings[0]!.message, /not reviewed/);
});

test("DOGFOOD: the Skills example app clears the design bar strict", () => {
  const io = capture();
  const code = commandReview({ project: EXAMPLES, strict: true }, [], io);
  assert.equal(code, 0, `the example app failed its own bar:\n${io.lines.join("\n")}`);
});

test("review is an MCP tool by construction — one command table, three faces", () => {
  const tool = toolsFromDocument().find((t) => t.name === "despia_review");
  assert.ok(tool !== undefined, "despia_review missing from the generated tool table");
  assert.ok(tool!.inputSchema.properties["strict"] !== undefined);
  assert.ok(tool!.inputSchema.properties["files"] !== undefined);
});
