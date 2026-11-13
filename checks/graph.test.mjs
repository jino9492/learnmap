import test from "node:test";
import assert from "node:assert/strict";
import { edgeGeometry, layoutGraph } from "../apps/web/graph.js";

const concept = (x, y) => ({ x, y, width: 166, height: 76 });

test("mind map spreads branches around the subject and descendants outward", () => {
  const concepts = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}` }));
  const relations = Array.from({ length: 4 }, (_, index) => ({ source: `c${index}`, target: `c${index + 4}`, type: "PARENT_CHILD" }));
  const layout = layoutGraph(concepts, relations);
  const quadrants = new Set();
  for (const root of layout.roots) {
    const position = layout.positions.get(root.id);
    quadrants.add(`${Math.sign(position.x - layout.center.x)},${Math.sign(position.y - layout.center.y)}`);
    const child = layout.positions.get(relations.find((relation) => relation.source === root.id).target);
    assert.ok(Math.hypot(child.x - layout.center.x, child.y - layout.center.y) > Math.hypot(position.x - layout.center.x, position.y - layout.center.y));
  }
  assert.equal(quadrants.size, 4);
  assert.deepEqual(layout, layoutGraph(concepts, relations));
});

test("crowded mind map branches keep node cards apart and inside the canvas", () => {
  const concepts = Array.from({ length: 65 }, (_, index) => ({ id: `c${index}` }));
  const relations = concepts.slice(1).map(({ id }, index) => ({ source: index < 40 ? "c0" : "c1", target: id, type: "PARENT_CHILD" }));
  const layout = layoutGraph(concepts, relations);
  const positions = [layout.center, ...layout.positions.values()];
  for (const [index, position] of positions.entries()) {
    assert.ok(position.x >= 91 && position.x <= layout.width - 91);
    assert.ok(position.y >= 38 && position.y <= layout.height - 38);
    for (const other of positions.slice(index + 1)) {
      assert.ok(Math.abs(position.x - other.x) >= 182 || Math.abs(position.y - other.y) >= 76);
    }
  }
});

test("empty, cyclic, shared and disconnected graphs retain finite positions for every concept", () => {
  assert.equal(layoutGraph([], []).positions.size, 0);
  const concepts = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const relations = [
    { source: "a", target: "b", type: "PARENT_CHILD" },
    { source: "b", target: "a", type: "PREREQUISITE" },
    { source: "a", target: "c", type: "PARENT_CHILD" },
    { source: "b", target: "c", type: "PREREQUISITE" },
    { source: "d", target: "e", type: "RELATED" },
    { source: "missing", target: "f", type: "PARENT_CHILD" },
  ];
  const layout = layoutGraph(concepts, relations);
  assert.equal(layout.positions.size, concepts.length);
  assert.ok(layout.roots.some(({ id }) => id === "a"));
  for (const position of layout.positions.values()) assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
});

test("edges stay attached to node boundaries when nodes cross above, below, left and right", () => {
  const source = concept(300,300);
  const cases = [
    [concept(300,500), {x:300,y:338}, {x:300,y:462}],
    [concept(300,100), {x:300,y:262}, {x:300,y:138}],
    [concept(600,300), {x:383,y:300}, {x:517,y:300}],
    [concept(0,300), {x:217,y:300}, {x:83,y:300}],
  ];
  for (const [target,start,end] of cases) {
    const geometry = edgeGeometry(source,target);
    assert.deepEqual(geometry.start,start);
    assert.deepEqual(geometry.end,end);
    assert.ok(geometry.d.endsWith(`${end.x} ${end.y}`));
  }
});

test("root dimensions, diagonal placement and overlapping nodes produce finite connections", () => {
  const source = { x:100,y:100,width:182,height:56 };
  const downward = edgeGeometry(source,concept(100,300));
  assert.deepEqual(downward.start,{x:100,y:128});
  for (const target of [concept(500,150),concept(-100,-200),concept(100,100)]) {
    const geometry = edgeGeometry(source,target);
    assert.doesNotMatch(geometry.d,/NaN|Infinity/);
    assert.ok(Math.abs(geometry.start.x-source.x) === source.width/2 || Math.abs(geometry.start.y-source.y) === source.height/2);
    assert.ok(Math.abs(geometry.end.x-target.x) === target.width/2 || Math.abs(geometry.end.y-target.y) === target.height/2);
  }
});
