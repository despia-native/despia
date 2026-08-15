import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createScenePhysicsWorld,
  stepScenePhysicsWorld,
  type SceneNode,
  type ScenePhysicsBodySpec,
} from "@despia/kernel";
import { carryScenePhysicsState } from "../src/scene.ts";

const separator = String.fromCharCode(0);
const node = (id: string): SceneNode => ({ kind: "box", id, attrs: {}, children: [] });
const box = (id: string, kind: "static" | "dynamic", position: [number, number, number]): ScenePhysicsBodySpec => ({
  id,
  kind,
  shape: { kind: "box", half: [0.5, 0.5, 0.5] },
  position,
});

test("physics re-extraction preserves the complete retained timeline by node identity", () => {
  const aNode = node("a");
  const bNode = node("b");
  const removedNode = node("removed");
  const freshNode = node("fresh");
  const changedNode = node("changed");
  const previous = createScenePhysicsWorld([0, 0, 0], [
    box("old-a", "dynamic", [0, 0, 0]),
    box("old-b", "dynamic", [0.2, 0, 0]),
    box("old-removed", "dynamic", [4, 0, 0]),
    box("old-changed", "dynamic", [6, 0, 0]),
  ], true);
  const next = createScenePhysicsWorld([0, 0, 0], [
    box("new-b", "dynamic", [20, 0, 0]),
    box("new-a", "dynamic", [10, 0, 0]),
    box("new-fresh", "dynamic", [8, 0, 0]),
    box("new-changed", "static", [6, 0, 0]),
  ], true);
  const previousNodes = new Map<string, SceneNode>([
    ["old-a", aNode], ["old-b", bNode], ["old-removed", removedNode], ["old-changed", changedNode],
  ]);
  const nextNodes = new Map<string, SceneNode>([
    ["new-b", bNode], ["new-a", aNode], ["new-fresh", freshNode], ["new-changed", changedNode],
  ]);

  const priorA = previous.byId.get("old-a")!;
  priorA.position = [1, 2, 3];
  priorA.previous = [0.5, 1.5, 2.5];
  priorA.velocity = [4, 5, 6];
  priorA.rotation = [7, 8, 9];
  priorA.orientation = [0, 0, 0, 1];
  priorA.previousRotation = [6, 7, 8];
  priorA.angularVelocity = [0.1, 0.2, 0.3];
  priorA.torque = [1, 2, 3];
  priorA.grounded = true;
  priorA.sleeping = true;
  priorA.sleepCount = 60;
  priorA.zLock = 11;
  previous.tick = 47;
  previous.solidOverlap = new Set([
    `old-a${separator}old-b`,
    `old-a${separator}old-removed`,
    `old-a${separator}old-changed`,
  ]);
  previous.triggerOverlap = new Set([
    `old-b${separator}old-a`,
    `old-removed${separator}old-a`,
  ]);
  previous.triggerOrder = [
    `old-b${separator}old-a`,
    `old-removed${separator}old-a`,
  ];

  carryScenePhysicsState(previous, next, previousNodes, nextNodes);

  const carriedA = next.byId.get("new-a")!;
  assert.deepEqual(carriedA.position, [1, 2, 3]);
  assert.deepEqual(carriedA.previous, [0.5, 1.5, 2.5]);
  assert.deepEqual(carriedA.velocity, [4, 5, 6]);
  assert.deepEqual(carriedA.rotation, [7, 8, 9]);
  assert.deepEqual(carriedA.orientation, [0, 0, 0, 1]);
  assert.deepEqual(carriedA.previousRotation, [6, 7, 8]);
  assert.deepEqual(carriedA.angularVelocity, [0.1, 0.2, 0.3]);
  assert.deepEqual(carriedA.torque, [1, 2, 3]);
  assert.equal(carriedA.grounded, true);
  assert.equal(carriedA.sleeping, true);
  assert.equal(carriedA.sleepCount, 60);
  assert.equal(carriedA.zLock, 11);
  assert.equal(next.tick, 47);
  assert.deepEqual([...next.solidOverlap], [`new-b${separator}new-a`]);
  assert.deepEqual([...next.triggerOverlap], [`new-b${separator}new-a`]);
  assert.deepEqual(next.triggerOrder, [`new-b${separator}new-a`]);
  assert.deepEqual(next.byId.get("new-fresh")!.position, [8, 0, 0], "a new body keeps extraction state");
  assert.deepEqual(next.byId.get("new-changed")!.position, [6, 0, 0], "a changed physics kind is not retained");
});

test("a retained solid overlap does not emit a duplicate collision after rebuild", () => {
  const aNode = node("a");
  const bNode = node("b");
  const previous = createScenePhysicsWorld([0, 0, 0], [
    box("old-a", "dynamic", [0, 0, 0]),
    box("old-b", "dynamic", [0.2, 0, 0]),
  ]);
  const first = stepScenePhysicsWorld(previous);
  assert.equal(first.collisions.length, 2, "the initial overlap emits both directions");

  const next = createScenePhysicsWorld([0, 0, 0], [
    box("new-b", "dynamic", [9, 0, 0]),
    box("new-a", "dynamic", [9, 0, 0]),
  ]);
  carryScenePhysicsState(
    previous,
    next,
    new Map([["old-a", aNode], ["old-b", bNode]]),
    new Map([["new-b", bNode], ["new-a", aNode]]),
  );
  assert.deepEqual(stepScenePhysicsWorld(next).collisions, [], "re-extraction keeps contact enter state");
});
