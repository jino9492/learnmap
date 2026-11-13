const SVG_NS = "http://www.w3.org/2000/svg";
export const statusLabels = { NOT_STARTED: "미학습", MASTERED: "이해", REVIEW_REQUIRED: "복습 필요", WEAK: "이해 부족" };
export const statusColors = { NOT_STARTED: "neutral", MASTERED: "green", REVIEW_REQUIRED: "amber", WEAK: "red" };

export function layoutGraph(concepts, relations) {
  const ids = new Set(concepts.map((concept) => concept.id));
  const links = relations.filter((relation) => relation.type !== "RELATED" && ids.has(relation.source) && ids.has(relation.target));
  const incoming = new Map(concepts.map((concept) => [concept.id, 0]));
  const children = new Map(concepts.map((concept) => [concept.id, []]));
  for (const link of links) { incoming.set(link.target, incoming.get(link.target) + 1); children.get(link.source).push(link.target); }
  const roots = concepts.filter((concept) => incoming.get(concept.id) === 0);
  const queue = roots.map((concept) => concept.id);
  const levels = new Map(queue.map((id) => [id, 1]));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const child of children.get(id)) {
      levels.set(child, Math.max(levels.get(child) ?? 1, levels.get(id) + 1));
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const layers = new Map();
  for (const concept of concepts) {
    const level = levels.get(concept.id) ?? 1;
    if (!layers.has(level)) layers.set(level, []);
    layers.get(level).push(concept);
  }
  const width = Math.max(846, ...[...layers.values()].map((layer) => layer.length * 190 + 100));
  const height = Math.max(646, (Math.max(0, ...layers.keys()) + 1) * 125 + 70);
  const positions = new Map();
  for (const [level, layer] of layers) for (const [index, concept] of layer.entries()) positions.set(concept.id, { x: width / 2 + (index - (layer.length - 1) / 2) * 190, y: 115 + level * 125 });
  return { positions, roots, width, height };
}

function svgElement(tag, attrs, value) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, attribute] of Object.entries(attrs)) element.setAttribute(key, String(attribute));
  if (value !== undefined) element.textContent = value;
  return element;
}

export function edgeGeometry(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const horizontal = Math.abs(dx) / ((source.width + target.width) / 2) > Math.abs(dy) / ((source.height + target.height) / 2);
  const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const start = horizontal ? { x: source.x + direction * source.width / 2, y: source.y } : { x: source.x, y: source.y + direction * source.height / 2 };
  const end = horizontal ? { x: target.x - direction * target.width / 2, y: target.y } : { x: target.x, y: target.y - direction * target.height / 2 };
  const offset = Math.max(40, Math.abs(horizontal ? end.x - start.x : end.y - start.y) / 2);
  const first = horizontal ? { x: start.x + direction * offset, y: start.y } : { x: start.x, y: start.y + direction * offset };
  const second = horizontal ? { x: end.x - direction * offset, y: end.y } : { x: end.x, y: end.y - direction * offset };
  return { start, end, d: `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}` };
}

export function createGraph(svg, onSelect) {
  const world = svg.querySelector("g");
  let full = { x: 0, y: 0, width: 846, height: 646 };
  let viewport = { ...full };
  let signature = "";
  let dataSignature = "";
  const arrangements = new Map();
  let positions = new Map();
  const nodeElements = new Map();
  const connectedEdges = new Map();
  let layoutSize = { width: 846, height: 646 };
  const rootId = "__subject__";
  let drag;
  function graphPoint(event) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  }
  function updateBounds() {
    const visible = [...nodeElements.keys()].map((id) => positions.get(id));
    const left = Math.min(0, ...visible.map((item) => item.x - item.width / 2 - 60));
    const top = Math.min(20, ...visible.map((item) => item.y - item.height / 2 - 60));
    const right = Math.max(layoutSize.width, ...visible.map((item) => item.x + item.width / 2 + 60));
    const bottom = Math.max(layoutSize.height, ...visible.map((item) => item.y + item.height / 2 + 60));
    full = { x: left, y: top, width: right - left, height: bottom - top };
  }
  function moveNode(id, x, y) {
    const position = positions.get(id);
    if (!position || !Number.isFinite(x) || !Number.isFinite(y)) return;
    position.x = x; position.y = y;
    nodeElements.get(id)?.setAttribute("transform", `translate(${x},${y})`);
    for (const edge of connectedEdges.get(id) ?? []) edge.element.setAttribute("d", edgeGeometry(positions.get(edge.source), positions.get(edge.target)).d);
  }
  function applyViewport() { svg.setAttribute("viewBox", `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`); }
  function fit() { if (drag) return; updateBounds(); viewport = { ...full }; applyViewport(); }
  function zoom(factor) {
    if (drag) return;
    const nextWidth = Math.max(full.width * .2, Math.min(full.width * 3, viewport.width * factor));
    const scale = nextWidth / viewport.width;
    viewport = { x: viewport.x + (viewport.width - nextWidth) / 2, y: viewport.y + viewport.height * (1 - scale) / 2, width: nextWidth, height: viewport.height * scale };
    applyViewport();
  }
  svg.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    const point = graphPoint(event);
    if (!point) return;
    const id = event.target.closest("[data-node-key]")?.dataset.nodeKey;
    const position = positions.get(id);
    drag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, point, position: position ? { ...position } : null, viewport: { ...viewport }, moved: false };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const point = graphPoint(event);
    if (!point) return;
    if (drag.position) {
      nodeElements.get(drag.id)?.classList.add("dragging");
      moveNode(drag.id, drag.position.x + point.x - drag.point.x, drag.position.y + point.y - drag.point.y);
    } else {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      viewport.x = drag.viewport.x - dx / matrix.a;
      viewport.y = drag.viewport.y - dy / matrix.d;
      applyViewport();
    }
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag;
    drag = undefined;
    if (previous.moved && previous.position) updateBounds();
    nodeElements.get(previous.id)?.classList.remove("dragging");
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (event.type === "pointerup" && !previous.moved && previous.id && previous.id !== rootId) onSelect(previous.id);
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("lostpointercapture", endDrag);
  svg.addEventListener("click", (event) => { const id = event.target.closest("[data-concept]")?.dataset.concept; if (id && event.detail === 0) onSelect(id); });
  svg.addEventListener("keydown", (event) => {
    const id = event.target.closest("[data-concept]")?.dataset.concept;
    if (id && ["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(id); }
    else if (event.key === "+" || event.key === "=") zoom(1 / 1.2);
    else if (event.key === "-") zoom(1.2);
    else if (event.key === "0") fit();
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const dx = event.key === "ArrowLeft" ? -40 : event.key === "ArrowRight" ? 40 : 0;
      const dy = event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0;
      const nodeId = event.target.closest("[data-node-key]")?.dataset.nodeKey;
      if (event.shiftKey && positions.has(nodeId)) { const position = positions.get(nodeId); moveNode(nodeId, position.x + dx, position.y + dy); updateBounds(); return; }
      viewport.x += dx; viewport.y += dy;
      applyViewport();
    }
  });
  function render({ name, graphId = name, concepts, relations, progress, selectedId, path, query, filter }) {
    const progressById = new Map(progress.map((item) => [item.conceptId, item]));
    const visible = concepts.filter((concept) => (!query || `${concept.name} ${concept.description}`.toLowerCase().includes(query.toLowerCase())) && (filter === "ALL" || (progressById.get(concept.id)?.status ?? "NOT_STARTED") === filter));
    const visibleIds = new Set(visible.map((concept) => concept.id));
    const layout = layoutGraph(concepts, relations);
    layoutSize = layout;
    if (!arrangements.has(graphId)) arrangements.set(graphId, new Map());
    positions = arrangements.get(graphId);
    const validIds = new Set([rootId, ...concepts.map((concept) => concept.id)]);
    for (const id of positions.keys()) if (!validIds.has(id)) positions.delete(id);
    if (!positions.has(rootId)) positions.set(rootId, { x: layout.width / 2, y: 115, width: 182, height: 56 });
    for (const [id, position] of layout.positions) if (!positions.has(id)) positions.set(id, { ...position, width: 166, height: 76 });
    const pathIds = path?.steps.map((step) => step.conceptId) ?? [];
    const nextDataSignature = JSON.stringify([graphId, name, visible, relations, progress, pathIds]);
    if (nextDataSignature === dataSignature) {
      for (const group of world.querySelectorAll("[data-concept]")) {
        const active = group.dataset.concept === selectedId;
        group.classList.toggle("selected", active);
        group.setAttribute("aria-pressed", String(active));
      }
      return visible.length;
    }
    dataSignature = nextDataSignature;
    world.replaceChildren();
    nodeElements.clear(); connectedEdges.clear();
    const defs = svgElement("defs", {});
    const marker = svgElement("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
    marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "edge-arrow" }));
    defs.append(marker); world.append(defs);
    function edge(source, target, type, recommended = false) {
      const line = svgElement("path", { d: edgeGeometry(positions.get(source), positions.get(target)).d, class: `graph-edge ${type}${recommended ? " recommended" : ""}`, "data-source": source, "data-target": target });
      if (type === "PREREQUISITE") line.setAttribute("marker-end", "url(#arrow)");
      const connection = { element: line, source, target };
      for (const id of [source, target]) { if (!connectedEdges.has(id)) connectedEdges.set(id, new Set()); connectedEdges.get(id).add(connection); }
      world.append(line);
    }
    for (const root of layout.roots) if (visibleIds.has(root.id)) edge(rootId, root.id, "PARENT_CHILD");
    for (const relation of relations) if (visibleIds.has(relation.source) && visibleIds.has(relation.target)) {
      const index = pathIds.indexOf(relation.source);
      edge(relation.source, relation.target, relation.type, index >= 0 && pathIds[index + 1] === relation.target);
    }
    const rootPosition = positions.get(rootId);
    const root = svgElement("g", { class: "graph-node root", transform: `translate(${rootPosition.x},${rootPosition.y})`, "data-node-key": rootId, tabindex: 0, "aria-label": `${name}, 과목 노드`, "aria-keyshortcuts": "Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" });
    nodeElements.set(rootId, root);
    root.append(svgElement("rect", { x: -91, y: -28, width: 182, height: 56, rx: 14 }), svgElement("text", { y: 6 }, name.length > 15 ? `${name.slice(0,14)}…` : name)); world.append(root);
    for (const concept of visible) {
      const position = positions.get(concept.id);
      const status = progressById.get(concept.id)?.status ?? "NOT_STARTED";
      const group = svgElement("g", { class: `graph-node ${status}${selectedId === concept.id ? " selected" : ""}${pathIds.includes(concept.id) ? " recommended" : ""}`, transform: `translate(${position.x},${position.y})`, "data-concept": concept.id, role: "button", tabindex: 0, "aria-label": `${concept.name}, ${statusLabels[status]}`, "aria-pressed": selectedId === concept.id });
      group.dataset.nodeKey = concept.id;
      group.setAttribute("aria-keyshortcuts", "Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight");
      nodeElements.set(concept.id, group);
      group.append(svgElement("title", {}, concept.name), svgElement("rect", { x: -83, y: -38, width: 166, height: 76, rx: 14 }));
      const title = concept.name.length > 11 ? `${concept.name.slice(0,10)}…` : concept.name;
      group.append(svgElement("text", { y: -7 }, title), svgElement("rect", { x: -38, y: 6, width: 76, height: 24, rx: 12, class: "node-badge" }), svgElement("text", { y: 22, class: "node-status" }, statusLabels[status]));
      world.append(group);
    }
    const nextSignature = JSON.stringify([graphId, visible.map((concept) => concept.id)]);
    updateBounds();
    if (signature !== nextSignature) { signature = nextSignature; fit(); }
    return visible.length;
  }
  return { render, fit, zoom };
}
