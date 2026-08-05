/**
 * The call graph as flow.
 *
 * Drawn as SVG rather than canvas: the nodes are text and click targets, and
 * getting crisp labels and hit-testing for free is worth more here than the
 * raw draw speed a canvas would give. The layer count is bounded anyway.
 *
 * Left to right by depth from an entry point. Shared utilities sit in their own
 * lane along the bottom, because a logger called from forty places otherwise
 * drags edges through every column and turns flow back into a hairball.
 */

(function attachFlow(global) {
  const COL_WIDTH = 250;
  const NODE_H = 40;
  const NODE_W = 200;
  const GAP_Y = 14;
  const PAD = 28;

  function shorten(path) {
    const parts = path.split("/");
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  /**
   * Positions every node, then renders.
   *
   * Layers arrive already ordered by the engine's barycenter pass, so this only
   * has to turn indices into coordinates.
   */
  function layout(view) {
    const positions = new Map();
    const byId = new Map(view.nodes.map((node) => [node.id, node]));

    const tallest = view.layers.reduce((max, layer) => Math.max(max, layer.length), 1);
    const flowHeight = tallest * (NODE_H + GAP_Y);

    view.layers.forEach((layer, depth) => {
      // Centre each column vertically so short layers do not sit at the top.
      const offset = (flowHeight - layer.length * (NODE_H + GAP_Y)) / 2;
      layer.forEach((id, index) => {
        positions.set(id, {
          x: PAD + depth * COL_WIDTH,
          y: PAD + offset + index * (NODE_H + GAP_Y),
        });
      });
    });

    // Commons lane, below everything, laid out in rows.
    const perRow = Math.max(1, Math.floor((view.layers.length * COL_WIDTH) / (NODE_W + 16)));
    view.commons.forEach((id, index) => {
      positions.set(id, {
        x: PAD + (index % perRow) * (NODE_W + 16),
        y: PAD + flowHeight + 64 + Math.floor(index / perRow) * (NODE_H + GAP_Y),
        commons: true,
      });
    });

    const commonsRows = Math.ceil(view.commons.length / perRow);
    return {
      positions,
      byId,
      width: PAD * 2 + Math.max(view.layers.length, 1) * COL_WIDTH,
      height:
        PAD * 2 + flowHeight + (view.commons.length ? 64 + commonsRows * (NODE_H + GAP_Y) : 0),
      flowHeight,
    };
  }

  function edgePath(from, to) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }

  function render(container, view, handlers) {
    if (view.nodes.length === 0) {
      container.innerHTML = `<div class="empty big">
        <p>No call flow to show.</p>
        <p class="sub">Entry points are found from the call graph, which needs an index with
        references. Try re-indexing.</p>
      </div>`;
      return;
    }

    const { positions, byId, width, height, flowHeight } = layout(view);
    const entries = new Set(view.entries);

    const edges = view.edges
      .map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return "";
        return `<path class="flow-edge ${edge.toCommons ? "to-commons" : ""}"
                      d="${edgePath(from, to)}" />`;
      })
      .join("");

    const nodes = view.nodes
      .map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return "";
        const classes = [
          "flow-node",
          entries.has(node.id) ? "entry" : "",
          node.commons ? "commons" : "",
          node.findings > 0 ? "has-findings" : "",
          node.expandable ? "expandable" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return `
          <g class="${classes}" data-id="${esc(node.id)}" data-symbol="${esc(node.symbol)}"
             data-path="${esc(node.path)}" transform="translate(${pos.x},${pos.y})">
            <rect width="${NODE_W}" height="${NODE_H}" rx="7" />
            <text class="flow-name" x="10" y="17">${esc(truncate(node.symbol, 26))}</text>
            <text class="flow-path" x="10" y="31">${esc(truncate(shorten(node.path), 30))}</text>
            ${
              node.expandable
                ? `<text class="flow-more" x="${NODE_W - 10}" y="24" text-anchor="end">+${node.callees}</text>`
                : ""
            }
          </g>`;
      })
      .join("");

    const laneLabel = view.commons.length
      ? `<text class="flow-lane" x="${PAD}" y="${PAD + flowHeight + 44}">SHARED — called from many places, drawn apart to keep the flow readable</text>`
      : "";

    // The svg fills the stage and the viewBox scales the graph to fit; the
    // inner group carries zoom and pan on top of that, so "fit" is always a
    // known state to return to.
    container.innerHTML = `
      <svg class="flow-svg" viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="xMidYMid meet">
        <g class="flow-viewport">
          <g class="flow-edges">${edges}</g>
          ${laneLabel}
          <g class="flow-nodes">${nodes}</g>
        </g>
      </svg>
      <div class="flow-zoom">
        <button data-zoom="out" title="Zoom out">−</button>
        <button data-zoom="fit" title="Fit">⤢</button>
        <button data-zoom="in" title="Zoom in">+</button>
      </div>`;

    const svg = container.querySelector("svg");
    const viewport = svg.querySelector(".flow-viewport");

    const view3 = { k: 1, x: 0, y: 0 };
    const apply = () => {
      viewport.setAttribute(
        "transform",
        `translate(${view3.x} ${view3.y}) scale(${view3.k})`,
      );
    };

    /** Screen pixels to svg user units, which the viewBox has already scaled. */
    const toUser = (event) => {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = svg.getScreenCTM();
      return ctm ? point.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
    };

    const zoomAt = (factor, at) => {
      const next = Math.min(Math.max(view3.k * factor, 0.2), 8);
      // Keep whatever is under the pointer under the pointer.
      view3.x = at.x - ((at.x - view3.x) / view3.k) * next;
      view3.y = at.y - ((at.y - view3.y) / view3.k) * next;
      view3.k = next;
      apply();
    };

    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        // Trackpad pinch arrives as ctrl+wheel; both mean zoom here.
        zoomAt(Math.exp(-event.deltaY * 0.0018), toUser(event));
      },
      { passive: false },
    );

    let panning = null;
    svg.addEventListener("mousedown", (event) => {
      if (event.target.closest(".flow-node")) return;
      const at = toUser(event);
      panning = { x: at.x - view3.x, y: at.y - view3.y };
      svg.classList.add("panning");
    });
    global.addEventListener("mousemove", (event) => {
      if (!panning) return;
      const at = toUser(event);
      view3.x = at.x - panning.x;
      view3.y = at.y - panning.y;
      apply();
    });
    global.addEventListener("mouseup", () => {
      panning = null;
      svg.classList.remove("panning");
    });

    const fit = () => {
      view3.k = 1;
      view3.x = 0;
      view3.y = 0;
      apply();
    };

    for (const button of container.querySelectorAll("[data-zoom]")) {
      button.addEventListener("click", () => {
        const centre = { x: width / 2, y: height / 2 };
        if (button.dataset.zoom === "in") zoomAt(1.3, centre);
        else if (button.dataset.zoom === "out") zoomAt(1 / 1.3, centre);
        else fit();
      });
    }

    for (const group of svg.querySelectorAll(".flow-node")) {
      group.addEventListener("click", () => {
        handlers.onSelect?.({
          id: group.dataset.id,
          symbol: group.dataset.symbol,
          path: group.dataset.path,
          node: byId.get(group.dataset.id),
        });
      });
      group.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        handlers.onExpand?.({ symbol: group.dataset.symbol, path: group.dataset.path });
      });
    }

    return { fit };
  }

  global.SDLCFlow = { render };
})(window);
