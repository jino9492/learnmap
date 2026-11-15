import { radialGraphLayout } from "./src/features/knowledge-graph/graph-view.ts";
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
  viewportScope?: string;
  preserveSelectedPosition?: boolean;
  concepts: (Pick<Concept, "id" | "name" | "description"> & {
    groupSize?: number;
    searchText?: string;
  })[];
  relations: Pick<Relation, "source" | "target" | "type">[];
  layoutRelations?: Pick<Relation, "source" | "target" | "type">[];
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
  type: Relation["type"] | "SUBJECT_LINK";
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
  return radialGraphLayout(concepts, relations);
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
  let currentViewportScope: string | undefined;
  let positions = new Map<string, GraphPosition>();
  const nodeElements = new Map<string, SVGGElement>();
  const connectedEdges = new Map<string, Set<GraphEdge>>();
  const edges: GraphEdge[] = [];
  let edgeLayer: SVGGElement | undefined;
  let selectedForFit: string | null = null;
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
    if (!visible.length) {
      full = { x: 0, y: 0, width: 846, height: 646 };
      return;
    }
    const left = Math.min(
      ...visible.map((item) => item.x - item.width / 2 - 60),
    );
    const top = Math.min(
      ...visible.map((item) => item.y - item.height / 2 - 60),
    );
    const right = Math.max(
      ...visible.map((item) => item.x + item.width / 2 + 60),
    );
    const bottom = Math.max(
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
  function fit(readable = false) {
    if (drag) return;
    updateBounds();
    const bounds = svg.getBoundingClientRect();
    const width = bounds.width || 846;
    const height = bounds.height || 646;
    const aspect = width / height;
    const fittedWidth = Math.max(full.width, full.height * aspect);
    const nextWidth = readable
      ? Math.min(fittedWidth, Math.max(420, width / 0.8))
      : fittedWidth;
    const focus =
      readable && selectedForFit ? positions.get(selectedForFit) : undefined;
    const centerX = focus?.x ?? full.x + full.width / 2;
    const centerY = focus?.y ?? full.y + full.height / 2;
    viewport = {
      x: centerX - nextWidth / 2,
      y: centerY - nextWidth / aspect / 2,
      width: nextWidth,
      height: nextWidth / aspect,
    };
    applyViewport();
  }
  function zoom(factor: number) {
    if (drag) return;
    const nextWidth = Math.max(
      Math.max(180, (svg.getBoundingClientRect().width || 846) * 0.25),
      Math.min(Math.max(full.width * 3, 2500), viewport.width * factor),
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
        if (edge.type === "SUBJECT_LINK") focus = "topic";
        else if (edge.type === "PARENT_CHILD")
          focus = incoming ? "parent" : "child";
        else if (edge.type === "PREREQUISITE")
          focus = incoming ? "prerequisite" : "dependent";
        else focus = "related";
        highlighted.push(edge.element);
      }
      edge.element.setAttribute(
        "data-focus",
        focus || (hasSelection ? "muted" : ""),
      );
      if (edge.type !== "RELATED" && edge.type !== "SUBJECT_LINK")
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
    viewportScope = graphId,
    preserveSelectedPosition = false,
    concepts,
    relations,
    layoutRelations = relations,
    progress,
    selectedId,
    path,
    query,
    filter,
  }: GraphRenderInput) {
    const previousAnchor =
      preserveSelectedPosition &&
      currentViewportScope === viewportScope &&
      selectedId &&
      nodeElements.has(selectedId)
        ? positions.get(selectedId)
        : undefined;
    const anchor = previousAnchor ? { ...previousAnchor } : undefined;
    currentViewportScope = viewportScope;
    const progressById = new Map(
      progress.map((item) => [item.conceptId, item]),
    );
    const visible = concepts.filter(
      (concept) =>
        (!query ||
          `${concept.name} ${concept.description} ${concept.searchText ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (filter === "ALL" ||
          (progressById.get(concept.id)?.status ?? "NOT_STARTED") === filter),
    );
    const visibleIds = new Set(visible.map((concept) => concept.id));
    const layout = layoutGraph(visible, layoutRelations);
    selectedForFit = selectedId;
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
      type: GraphEdge["type"],
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
      if (type === "SUBJECT_LINK")
        line.append(svgElement("title", {}, `${name}의 탐색 가지 연결`));
      edges.push(connection);
      for (const id of [source, target]) {
        if (!connectedEdges.has(id)) connectedEdges.set(id, new Set());
        mapValue(connectedEdges, id).add(connection);
      }
      layer.append(line);
    }
    // The layout's first-level branches connect to the topic without asserting a semantic hierarchy.
    for (const branch of layout.roots) edge(rootId, branch.id, "SUBJECT_LINK");
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
        "aria-label": concept.groupSize
          ? `${concept.name}, 개념 ${concept.groupSize}개`
          : `${concept.name}, ${statusLabels[status]}`,
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
      const label = svgElement("text", {
        y: concept.name.length > 11 ? -17 : -7,
      });
      if (concept.name.length > 11) {
        label.append(
          svgElement("tspan", { x: 0, dy: 0 }, concept.name.slice(0, 11)),
          svgElement(
            "tspan",
            { x: 0, dy: 15 },
            concept.name.length > 22
              ? `${concept.name.slice(11, 21)}…`
              : concept.name.slice(11),
          ),
        );
      } else label.textContent = concept.name;
      group.append(
        label,
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
          concept.groupSize
            ? `개념 ${concept.groupSize}개`
            : statusLabels[status],
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
      const nextAnchor = selectedId ? positions.get(selectedId) : undefined;
      if (anchor && nextAnchor && selectedId && visibleIds.has(selectedId)) {
        // Translate the camera with the anchor so its screen position and zoom stay fixed.
        viewport.x += nextAnchor.x - anchor.x;
        viewport.y += nextAnchor.y - anchor.y;
        applyViewport();
      } else fit(visible.length > 18);
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
