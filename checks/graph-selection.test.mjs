import test from "node:test";
import assert from "node:assert/strict";
import { createGraph } from "../apps/web/graph.js";

// Only the SVG operations used by rendering are needed for selection regression checks.
class SvgElement {
  attributes = new Map();
  children = [];
  dataset = {};
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  classList = { toggle: (name, active) => {
    const classes = new Set((this.getAttribute("class") ?? "").split(" "));
    if (active) classes.add(name); else classes.delete(name);
    this.setAttribute("class", [...classes].join(" "));
  } };
  append(...elements) {
    for (const element of elements) {
      if (element.parent) element.parent.children = element.parent.children.filter((child) => child !== element);
      element.parent = this;
      this.children.push(element);
    }
  }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  querySelector() { return this.children[0]; }
}

test("selection recolors edges by relation and direction without rebuilding or resetting the viewport", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElementNS: () => new SvgElement() } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  const svg = new SvgElement();
  const world = new SvgElement();
  svg.append(world);
  const graph = createGraph(svg, () => {});
  const data = {
    name: "Subject", filter: "ALL", query: "", progress: [], selectedId: "selected",
    concepts: ["parent", "selected", "child", "prerequisite", "dependent", "related", "other"].map((id) => ({ id, name: id, description: "" })),
    relations: [
      { source: "parent", target: "selected", type: "PARENT_CHILD" },
      { source: "selected", target: "child", type: "PARENT_CHILD" },
      { source: "prerequisite", target: "selected", type: "PREREQUISITE" },
      { source: "selected", target: "dependent", type: "PREREQUISITE" },
      { source: "related", target: "selected", type: "RELATED" },
      { source: "parent", target: "other", type: "PARENT_CHILD" },
    ],
    path: { steps: [{ conceptId: "selected" }, { conceptId: "child" }] },
  };
  graph.render(data);
  const layer = world.children.find((element) => element.getAttribute("class") === "graph-edges");
  const edge = (source, target) => layer.children.find((element) => element.getAttribute("data-source") === source && element.getAttribute("data-target") === target);
  for (const [source, target, focus] of [
    ["parent", "selected", "parent"], ["selected", "child", "child"],
    ["prerequisite", "selected", "prerequisite"], ["selected", "dependent", "dependent"],
    ["related", "selected", "related"], ["parent", "other", "muted"],
  ]) {
    assert.equal(edge(source, target).getAttribute("data-focus"), focus);
    if (focus !== "related" && focus !== "muted") assert.equal(edge(source, target).getAttribute("marker-end"), `url(#arrow-${focus})`);
  }
  assert.equal(edge("related", "selected").getAttribute("marker-end"), undefined);
  const connection = edge("selected", "child");
  graph.zoom(.8);
  const viewport = svg.getAttribute("viewBox");
  graph.render({ ...data, selectedId: "child" });
  assert.equal(edge("selected", "child"), connection);
  assert.equal(connection.getAttribute("data-focus"), "parent");
  assert.equal(connection.getAttribute("marker-end"), "url(#arrow-parent)");
  assert.equal(edge("parent", "selected").getAttribute("data-focus"), "muted");
  assert.equal(layer.children.at(-1), connection);
  assert.equal(svg.getAttribute("viewBox"), viewport);

  graph.render({ ...data, selectedId: "parent" });
  assert.equal(edge("__subject__", "parent").getAttribute("data-focus"), "parent");
  graph.render({ ...data, selectedId: null });
  assert.ok(layer.children.every((element) => element.getAttribute("data-focus") === ""));
  assert.equal(connection.getAttribute("marker-end"), "url(#arrow-recommended)");

  graph.render({ ...data, query: "child" });
  const filteredLayer = world.children.find((element) => element.getAttribute("class") === "graph-edges");
  assert.ok(filteredLayer.children.every((element) => element.getAttribute("data-focus") === ""));
});
