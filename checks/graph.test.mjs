import test from "node:test";
import assert from "node:assert/strict";
import { edgeGeometry } from "../apps/web/graph.js";

const concept = (x, y) => ({ x, y, width: 166, height: 76 });

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
