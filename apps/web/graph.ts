import type { Concept, Relation } from "../api/src/ai/core/contracts.ts";
import type { Status } from "./src/utils/api.ts";

interface Point {
  x: number;
  y: number;
}
interface Viewport extends Point {
  width: number;
  height: number;
}
export interface GraphPosition extends Viewport {}
export type GraphArrangements = Map<string, Map<string, GraphPosition>>;
interface GraphRenderInput {
  name: string;
  graphId?: string;
  concepts: Pick<Concept, "id" | "name" | "description">[];
  relations: Pick<Relation, "source" | "target" | "type">[];
  progress: { conceptId: string; status: Status }[];
  selectedId: string | null;
  path?: { steps: { conceptId: string }[] } | null;
  query: string;
  filter: string;
}
export interface GraphController {
  render: (input: GraphRenderInput) => number;
  fit: () => void;
  zoom: (factor: number) => void;
  destroy: () => void;
}
interface GraphEdge {
  element: SVGPathElement;
  source: string;
  target: string;
  type: Relation["type"];
  recommended: boolean;
}
interface DragState {
  id?: string;
  pointerId: number;
  x: number;
  y: number;
  point: DOMPoint;
  position: GraphPosition | null;
  viewport: Viewport;
  moved: boolean;
}
interface Sector {
  start: number;
  span: number;
  angle: number;
}

// Layout traversal creates these entries before reading them. Fail explicitly if that invariant breaks.
const mapValue = <K, V>(map: Map<K, V>, key: K): V => {
  const value = map.get(key);
  if (value === undefined) throw new Error("Missing graph layout entry.");
  return value;
};
const eventNodeId = (event: Event, selector: string, attribute: string) =>
  event.target instanceof Element
    ? (event.target.closest(selector)?.getAttribute(attribute) ?? undefined)
    : undefined;

const SVG_NS = "http://www.w3.org/2000/svg";
export const statusLabels: Record<Status, string> = {
  NOT_STARTED: "미학습",
  MASTERED: "이해",
  REVIEW_REQUIRED: "복습 필요",
  WEAK: "이해 부족",
};
export const statusColors: Record<Status, string> = {
  NOT_STARTED: "neutral",
  MASTERED: "green",
  REVIEW_REQUIRED: "amber",
  WEAK: "red",
};

export function layoutGraph(
  concepts: Pick<Concept, "id">[],
  relations: Pick<Relation, "source" | "target" | "type">[],
) {
  const ids = new Set(concepts.map((concept) => concept.id));
  const links = relations.filter(
    (relation) =>
      relation.type !== "RELATED" &&
      ids.has(relation.source) &&
      ids.has(relation.target),
  );
  const incoming = new Map(concepts.map((concept) => [concept.id, 0]));
  const children = new Map<string, string[]>(
    concepts.map((concept) => [concept.id, []]),
  );
  for (const link of links) {
    incoming.set(link.target, mapValue(incoming, link.target) + 1);
    mapValue(children, link.source).push(link.target);
  }
  const roots = concepts.filter((concept) => incoming.get(concept.id) === 0);
  const queue = roots.map((concept) => concept.id);
  const levels = new Map(queue.map((id) => [id, 1]));
  const branches = new Map<string, string[]>(
    concepts.map((concept) => [concept.id, []]),
  );
  let cursor = 0;
  // A spanning forest gives shared descendants one position and handles cycles safely.
  for (const concept of [...roots, ...concepts]) {
    if (cursor === queue.length && !levels.has(concept.id)) {
      roots.push(concept);
      queue.push(concept.id);
      levels.set(concept.id, 1);
    }
    while (cursor < queue.length) {
      const id = queue[cursor++];
      for (const child of mapValue(children, id)) {
        if (levels.has(child)) continue;
        levels.set(child, mapValue(levels, id) + 1);
        mapValue(branches, id).push(child);
        queue.push(child);
      }
    }
  }
  const weights = new Map<string, number>();
  for (const id of [...queue].reverse())
    weights.set(
      id,
      Math.max(
        1,
        mapValue(branches, id).reduce(
          (sum, child) => sum + mapValue(weights, child),
          0,
        ),
      ),
    );
  const sectors = new Map<string, Sector>();
  function divideSector(ids: string[], start: number, span: number) {
    const total = ids.reduce((sum, id) => sum + mapValue(weights, id), 0);
    for (const id of ids) {
      const portion = (span * mapValue(weights, id)) / total;
      sectors.set(id, { start, span: portion, angle: start + portion / 2 });
      start += portion;
    }
  }
  divideSector(
    roots.map((concept) => concept.id),
    -Math.PI,
    2 * Math.PI,
  );
  const layers = new Map<number, string[]>();
  for (const id of queue) {
    const sector = mapValue(sectors, id);
    divideSector(mapValue(branches, id), sector.start, sector.span);
    const level = mapValue(levels, id);
    if (!layers.has(level)) layers.set(level, []);
    mapValue(layers, level).push(id);
  }
  const positions = new Map<string, Point>();
  const nodeSpacing = 210;
  const ringSpacing = 240;
  let radius = 0;
  for (const layer of layers.values()) {
    radius += ringSpacing;
    const angles = layer
      .map((id) => mapValue(sectors, id).angle)
      .sort((a, b) => a - b);
    // Keep rectangular cards apart even in crowded or unevenly sized branches.
    if (angles.length > 1) {
      const gaps = angles.map((angle, index) =>
        index
          ? angle - angles[index - 1]
          : angle + 2 * Math.PI - (angles.at(-1) ?? angle),
      );
      radius = Math.max(
        radius,
        nodeSpacing / (2 * Math.sin(Math.min(...gaps) / 2)),
      );
    }
    for (const id of layer) {
      const angle = mapValue(sectors, id).angle;
      positions.set(id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }
  }
  const width = Math.max(
    846,
    ...[...positions.values()].map(({ x }) => 2 * (Math.abs(x) + 150)),
  );
  const height = Math.max(
    646,
    ...[...positions.values()].map(({ y }) => 2 * (Math.abs(y) + 100)),
  );
  const center = { x: width / 2, y: height / 2 };
  for (const position of positions.values()) {
    position.x += center.x;
    position.y += center.y;
  }
  return { positions, roots, width, height, center };
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean>,
  value?: string,
) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, attribute] of Object.entries(attrs))
    element.setAttribute(key, String(attribute));
  if (value !== undefined) element.textContent = value;
  return element;
}

export function edgeGeometry(source: GraphPosition, target: GraphPosition) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const horizontal =
    Math.abs(dx) / ((source.width + target.width) / 2) >
    Math.abs(dy) / ((source.height + target.height) / 2);
  const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const start = horizontal
    ? { x: source.x + (direction * source.width) / 2, y: source.y }
    : { x: source.x, y: source.y + (direction * source.height) / 2 };
  const end = horizontal
    ? { x: target.x - (direction * target.width) / 2, y: target.y }
    : { x: target.x, y: target.y - (direction * target.height) / 2 };
  const offset = Math.max(
    40,
    Math.abs(horizontal ? end.x - start.x : end.y - start.y) / 2,
  );
  const first = horizontal
    ? { x: start.x + direction * offset, y: start.y }
    : { x: start.x, y: start.y + direction * offset };
  const second = horizontal
    ? { x: end.x - direction * offset, y: end.y }
    : { x: end.x, y: end.y - direction * offset };
  return {
    start,
    end,
    d: `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`,
  };
}

export function createGraph(
  svg: SVGSVGElement,
  onSelect: (id: string) => void,
  arrangements: GraphArrangements = new Map(),
): GraphController {
  const world = (() => {
    const group = svg.querySelector("g");
    if (!group) throw new Error("Graph SVG must contain a group element.");
    return group;
  })();
  const listeners: (() => void)[] = [];
  const listen = <K extends keyof SVGSVGElementEventMap>(
    name: K,
    handler: (event: SVGSVGElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    svg.addEventListener(name, handler, options);
    listeners.push(() => svg.removeEventListener(name, handler, options));
  };
  let full = { x: 0, y: 0, width: 846, height: 646 };
  let viewport = { ...full };
  let signature = "";
  let dataSignature = "";
  let positions = new Map<string, GraphPosition>();
  const nodeElements = new Map<string, SVGGElement>();
  const connectedEdges = new Map<string, Set<GraphEdge>>();
  const edges: GraphEdge[] = [];
  let edgeLayer: SVGGElement | undefined;
  let layoutSize = { width: 846, height: 646 };
  const rootId = "__subject__";
  let drag: DragState | undefined;
  function graphPoint(event: PointerEvent) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  }
  function updateBounds() {
    const visible = [...nodeElements.keys()].map((id) =>
      mapValue(positions, id),
    );
    const left = Math.min(
      0,
      ...visible.map((item) => item.x - item.width / 2 - 60),
    );
    const top = Math.min(
      20,
      ...visible.map((item) => item.y - item.height / 2 - 60),
    );
    const right = Math.max(
      layoutSize.width,
      ...visible.map((item) => item.x + item.width / 2 + 60),
    );
    const bottom = Math.max(
      layoutSize.height,
      ...visible.map((item) => item.y + item.height / 2 + 60),
    );
    full = { x: left, y: top, width: right - left, height: bottom - top };
  }
  function moveNode(id: string, x: number, y: number) {
    const position = positions.get(id);
    if (!position || !Number.isFinite(x) || !Number.isFinite(y)) return;
    position.x = x;
    position.y = y;
    nodeElements.get(id)?.setAttribute("transform", `translate(${x},${y})`);
    for (const edge of connectedEdges.get(id) ?? [])
      edge.element.setAttribute(
        "d",
        edgeGeometry(
          mapValue(positions, edge.source),
          mapValue(positions, edge.target),
        ).d,
      );
  }
  function applyViewport() {
    svg.setAttribute(
      "viewBox",
      `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`,
    );
  }
  function fit() {
    if (drag) return;
    updateBounds();
    viewport = { ...full };
    applyViewport();
  }
  function zoom(factor: number) {
    if (drag) return;
    const nextWidth = Math.max(
      full.width * 0.2,
      Math.min(full.width * 3, viewport.width * factor),
    );
    const scale = nextWidth / viewport.width;
    viewport = {
      x: viewport.x + (viewport.width - nextWidth) / 2,
      y: viewport.y + (viewport.height * (1 - scale)) / 2,
      width: nextWidth,
      height: viewport.height * scale,
    };
    applyViewport();
  }
  listen(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false },
  );
  listen("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    const point = graphPoint(event);
    if (!point) return;
    const id = eventNodeId(event, "[data-node-key]", "data-node-key");
    const position = id ? positions.get(id) : undefined;
    drag = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      point,
      position: position ? { ...position } : null,
      viewport: { ...viewport },
      moved: false,
    };
    svg.setPointerCapture(event.pointerId);
  });
  listen("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const point = graphPoint(event);
    if (!point) return;
    if (drag.position && drag.id) {
      nodeElements.get(drag.id)?.classList.add("dragging");
      moveNode(
        drag.id,
        drag.position.x + point.x - drag.point.x,
        drag.position.y + point.y - drag.point.y,
      );
    } else {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      viewport.x = drag.viewport.x - dx / matrix.a;
      viewport.y = drag.viewport.y - dy / matrix.d;
      applyViewport();
    }
  });
  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag;
    drag = undefined;
    if (previous.moved && previous.position) updateBounds();
    if (previous.id)
      nodeElements.get(previous.id)?.classList.remove("dragging");
    if (svg.hasPointerCapture(event.pointerId))
      svg.releasePointerCapture(event.pointerId);
    if (
      event.type === "pointerup" &&
      !previous.moved &&
      previous.id &&
      previous.id !== rootId
    )
      onSelect(previous.id);
  }
  listen("pointerup", endDrag);
  listen("pointercancel", endDrag);
  listen("lostpointercapture", endDrag);
  listen("click", (event) => {
    const id = eventNodeId(event, "[data-concept]", "data-concept");
    if (id && event.detail === 0) onSelect(id);
  });
  listen("keydown", (event) => {
    const id = eventNodeId(event, "[data-concept]", "data-concept");
    if (id && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      onSelect(id);
    } else if (event.key === "+" || event.key === "=") zoom(1 / 1.2);
    else if (event.key === "-") zoom(1.2);
    else if (event.key === "0") fit();
    else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      const dx =
        event.key === "ArrowLeft" ? -40 : event.key === "ArrowRight" ? 40 : 0;
      const dy =
        event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0;
      const nodeId = eventNodeId(event, "[data-node-key]", "data-node-key");
      if (event.shiftKey && nodeId && positions.has(nodeId)) {
        const position = mapValue(positions, nodeId);
        moveNode(nodeId, position.x + dx, position.y + dy);
        updateBounds();
        return;
      }
      viewport.x += dx;
      viewport.y += dy;
      applyViewport();
    }
  });
  function updateSelection(selectedId: string | null) {
    const hasSelection = selectedId !== null && nodeElements.has(selectedId);
    for (const [id, group] of nodeElements) {
      if (id === rootId) continue;
      const active = id === selectedId;
      group.classList.toggle("selected", active);
      group.setAttribute("aria-pressed", String(active));
    }
    const highlighted = [];
    for (const edge of edges) {
      const incoming = edge.target === selectedId;
      const outgoing = edge.source === selectedId;
      let focus = "";
      if (hasSelection && (incoming || outgoing)) {
        if (edge.type === "PARENT_CHILD") focus = incoming ? "parent" : "child";
        else if (edge.type === "PREREQUISITE")
          focus = incoming ? "prerequisite" : "dependent";
        else focus = "related";
        highlighted.push(edge.element);
      }
      edge.element.setAttribute(
        "data-focus",
        focus || (hasSelection ? "muted" : ""),
      );
      if (edge.type !== "RELATED")
        edge.element.setAttribute(
          "marker-end",
          `url(#arrow-${focus || (edge.recommended ? "recommended" : "default")})`,
        );
    }
    // Draw focused connections last within the edge layer, keeping nodes above them.
    for (const element of highlighted) edgeLayer?.append(element);
  }
  function render({
    name,
    graphId = name,
    concepts,
    relations,
    progress,
    selectedId,
    path,
    query,
    filter,
  }: GraphRenderInput) {
    const progressById = new Map(
      progress.map((item) => [item.conceptId, item]),
    );
    const visible = concepts.filter(
      (concept) =>
        (!query ||
          `${concept.name} ${concept.description}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (filter === "ALL" ||
          (progressById.get(concept.id)?.status ?? "NOT_STARTED") === filter),
    );
    const visibleIds = new Set(visible.map((concept) => concept.id));
    const layout = layoutGraph(concepts, relations);
    layoutSize = layout;
    if (!arrangements.has(graphId)) arrangements.set(graphId, new Map());
    positions = mapValue(arrangements, graphId);
    const validIds = new Set([
      rootId,
      ...concepts.map((concept) => concept.id),
    ]);
    for (const id of positions.keys())
      if (!validIds.has(id)) positions.delete(id);
    if (!positions.has(rootId))
      positions.set(rootId, { ...layout.center, width: 182, height: 56 });
    for (const [id, position] of layout.positions)
      if (!positions.has(id))
        positions.set(id, { ...position, width: 166, height: 76 });
    const pathIds = path?.steps.map((step) => step.conceptId) ?? [];
    const nextDataSignature = JSON.stringify([
      graphId,
      name,
      visible,
      relations,
      progress,
      pathIds,
    ]);
    if (nextDataSignature === dataSignature) {
      updateSelection(selectedId);
      return visible.length;
    }
    dataSignature = nextDataSignature;
    world.replaceChildren();
    nodeElements.clear();
    connectedEdges.clear();
    edges.length = 0;
    const defs = svgElement("defs", {});
    for (const kind of [
      "default",
      "recommended",
      "parent",
      "child",
      "prerequisite",
      "dependent",
      "related",
    ]) {
      const marker = svgElement("marker", {
        id: `arrow-${kind}`,
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 5,
        markerHeight: 5,
        orient: "auto-start-reverse",
      });
      marker.append(
        svgElement("path", {
          d: "M 0 0 L 10 5 L 0 10 z",
          class: `edge-arrow ${kind}`,
        }),
      );
      defs.append(marker);
    }
    const layer = svgElement("g", { class: "graph-edges" });
    edgeLayer = layer;
    world.append(defs, layer);
    function edge(
      source: string,
      target: string,
      type: Relation["type"],
      recommended = false,
    ) {
      const line = svgElement("path", {
        d: edgeGeometry(
          mapValue(positions, source),
          mapValue(positions, target),
        ).d,
        class: `graph-edge ${type}${recommended ? " recommended" : ""}`,
        "data-source": source,
        "data-target": target,
      });
      const connection = { element: line, source, target, type, recommended };
      edges.push(connection);
      for (const id of [source, target]) {
        if (!connectedEdges.has(id)) connectedEdges.set(id, new Set());
        mapValue(connectedEdges, id).add(connection);
      }
      layer.append(line);
    }
    for (const root of layout.roots)
      if (visibleIds.has(root.id)) edge(rootId, root.id, "PARENT_CHILD");
    for (const relation of relations)
      if (visibleIds.has(relation.source) && visibleIds.has(relation.target)) {
        const index = pathIds.indexOf(relation.source);
        edge(
          relation.source,
          relation.target,
          relation.type,
          index >= 0 && pathIds[index + 1] === relation.target,
        );
      }
    const rootPosition = mapValue(positions, rootId);
    const root = svgElement("g", {
      class: "graph-node root",
      transform: `translate(${rootPosition.x},${rootPosition.y})`,
      "data-node-key": rootId,
      tabindex: 0,
      "aria-label": `${name}, 과목 노드`,
      "aria-keyshortcuts":
        "Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight",
    });
    nodeElements.set(rootId, root);
    root.append(
      svgElement("rect", { x: -91, y: -28, width: 182, height: 56, rx: 14 }),
      svgElement(
        "text",
        { y: 6 },
        name.length > 15 ? `${name.slice(0, 14)}…` : name,
      ),
    );
    world.append(root);
    for (const concept of visible) {
      const position = mapValue(positions, concept.id);
      const status = progressById.get(concept.id)?.status ?? "NOT_STARTED";
      const group = svgElement("g", {
        class: `graph-node ${status}${selectedId === concept.id ? " selected" : ""}${pathIds.includes(concept.id) ? " recommended" : ""}`,
        transform: `translate(${position.x},${position.y})`,
        "data-concept": concept.id,
        role: "button",
        tabindex: 0,
        "aria-label": `${concept.name}, ${statusLabels[status]}`,
        "aria-pressed": selectedId === concept.id,
      });
      group.dataset.nodeKey = concept.id;
      group.setAttribute(
        "aria-keyshortcuts",
        "Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight",
      );
      nodeElements.set(concept.id, group);
      group.append(
        svgElement("title", {}, concept.name),
        svgElement("rect", { x: -83, y: -38, width: 166, height: 76, rx: 14 }),
      );
      const title =
        concept.name.length > 11
          ? `${concept.name.slice(0, 10)}…`
          : concept.name;
      group.append(
        svgElement("text", { y: -7 }, title),
        svgElement("rect", {
          x: -38,
          y: 6,
          width: 76,
          height: 24,
          rx: 12,
          class: "node-badge",
        }),
        svgElement(
          "text",
          { y: 22, class: "node-status" },
          statusLabels[status],
        ),
      );
      world.append(group);
    }
    updateSelection(selectedId);
    const nextSignature = JSON.stringify([
      graphId,
      visible.map((concept) => concept.id),
    ]);
    updateBounds();
    if (signature !== nextSignature) {
      signature = nextSignature;
      fit();
    }
    return visible.length;
  }
  return {
    render,
    fit,
    zoom,
    destroy: () => {
      listeners.forEach((remove) => remove());
      world.replaceChildren();
    },
  };
}
