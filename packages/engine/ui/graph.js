/**
 * The import graph, drawn on a canvas.
 *
 * A Fruchterman–Reingold layout, run in animation-frame slices so a few
 * hundred nodes settle visibly instead of freezing the window. No library:
 * the whole thing is one force loop and one draw call, which is less code
 * than wiring up a graph toolkit and keeps the page self-contained.
 */

(function attachGraph(global) {
  const LANG_VAR = {
    typescript: "--info",
    javascript: "--warn",
    python: "--ok",
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function createGraph(canvas, options = {}) {
    const ctx = canvas.getContext("2d");
    const onSelect = options.onSelect ?? (() => {});

    let nodes = [];
    let edges = [];
    let byPath = new Map();
    /** Neighbours, for highlighting what a hovered node touches. */
    let adjacency = new Map();

    let view = { x: 0, y: 0, scale: 1 };
    let hovered = null;
    let selected = null;
    let dragging = null;
    let panning = null;
    let frame = null;
    let ticksLeft = 0;
    let temperature = 0;
    /** Set by anything that changes the picture; drives one more frame. */
    let redrawWanted = false;

    // --- layout ------------------------------------------------------------

    function seed() {
      const { width, height } = size();
      // A ring start converges faster and more evenly than pure random.
      const radius = Math.min(width, height) * 0.36;
      nodes.forEach((node, index) => {
        const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
        const jitter = 0.6 + ((index * 2654435761) % 1000) / 2500;
        node.x = width / 2 + Math.cos(angle) * radius * jitter;
        node.y = height / 2 + Math.sin(angle) * radius * jitter;
        node.vx = 0;
        node.vy = 0;
      });
    }

    function tick() {
      const { width, height } = size();
      const count = nodes.length || 1;
      // Ideal edge length. Bigger spreads dense clusters apart — below about
      // 1.0 the middle of a real import graph collapses into an unreadable ball.
      const k = Math.sqrt((width * height) / count) * 1.15;

      for (const node of nodes) {
        node.vx = 0;
        node.vy = 0;
      }

      // Repulsion. O(n²), but only while the layout is settling, and the node
      // count is capped well below where that starts to hurt.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.01) {
            dx = (i % 7) - 3;
            dy = (j % 7) - 3;
            distance = Math.hypot(dx, dy) || 1;
          }
          const force = (k * k) / distance;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Attraction along edges.
      for (const edge of edges) {
        const a = byPath.get(edge.from);
        const b = byPath.get(edge.to);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const force = (distance * distance) / k;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }

      // Gravity, so disconnected components do not drift off screen. Nodes
      // with no edges feel it more strongly — nothing else holds them in, and
      // letting them fly to the margins wastes most of the canvas.
      const cx = width / 2;
      const cy = height / 2;
      for (const node of nodes) {
        const pull = node.degree === 0 ? 0.14 : 0.01;
        node.vx += (cx - node.x) * pull;
        node.vy += (cy - node.y) * pull;
      }

      for (const node of nodes) {
        if (node === dragging) continue;
        const speed = Math.hypot(node.vx, node.vy) || 1;
        const limit = Math.min(speed, temperature);
        node.x += (node.vx / speed) * limit;
        node.y += (node.vy / speed) * limit;
      }

      temperature *= 0.94;
    }

    /**
     * Frame the graph on where the mass actually is.
     *
     * Fitting the full bounding box lets two stragglers shrink the cluster
     * everyone came to look at, so the box is trimmed to the middle of the
     * distribution and outliers are allowed to sit near the edges.
     */
    function fit() {
      if (nodes.length === 0) return;
      const { width, height } = size();

      // Gravity already keeps unconnected files near the cluster, so the full
      // extent frames well; trimming it any further clipped nodes at the edges.
      const xs = nodes.map((node) => node.x);
      const ys = nodes.map((node) => node.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = 56;
      const scale = Math.min(
        (width - pad * 2) / Math.max(maxX - minX, 1),
        (height - pad * 2) / Math.max(maxY - minY, 1),
        1.6,
      );
      view.scale = scale;
      view.x = width / 2 - ((minX + maxX) / 2) * scale;
      view.y = height / 2 - ((minY + maxY) / 2) * scale;
    }

    // --- drawing -----------------------------------------------------------

    function size() {
      return { width: canvas.clientWidth, height: canvas.clientHeight };
    }

    function radiusOf(node) {
      return 3.4 + Math.sqrt(node.importers) * 2.1;
    }

    function toScreen(node) {
      return { x: node.x * view.scale + view.x, y: node.y * view.scale + view.y };
    }

    function draw() {
      const ratio = global.devicePixelRatio || 1;
      const { width, height } = size();
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const border = cssVar("--border");
      const faint = cssVar("--faint");
      const text = cssVar("--text");
      const accent = cssVar("--accent");

      const focus = hovered ?? selected;
      const near = focus ? adjacency.get(focus.path) : null;

      // Edges.
      ctx.lineWidth = 1;
      for (const edge of edges) {
        const a = byPath.get(edge.from);
        const b = byPath.get(edge.to);
        if (!a || !b) continue;
        const related = focus && (edge.from === focus.path || edge.to === focus.path);
        ctx.strokeStyle = related ? accent : border;
        ctx.globalAlpha = focus ? (related ? 0.85 : 0.16) : 0.5;
        const from = toScreen(a);
        const to = toScreen(b);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Nodes.
      for (const node of nodes) {
        const point = toScreen(node);
        const radius = radiusOf(node) * Math.max(view.scale, 0.55);
        const dim = focus && node !== focus && !near?.has(node.path);

        // Enough contrast to pick out the selection, not so much that choosing
        // an unconnected file erases the rest of the picture.
        ctx.globalAlpha = dim ? 0.4 : 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = cssVar(LANG_VAR[node.lang] ?? "--faint");
        ctx.fill();

        if (node.isTest) {
          ctx.strokeStyle = cssVar("--bg");
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // A file with open findings gets a ring, so problems are visible
        // without switching tabs.
        if (node.findings > 0) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius + 2.5, 0, Math.PI * 2);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        if (node === selected) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
          ctx.strokeStyle = text;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Labels. Drawn most-important-first, and a label that would land on one
      // already placed is dropped — an unreadable pile of overlapping names is
      // worse than showing fewer of them.
      ctx.font = "11px ui-sans-serif, -apple-system, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";

      const placed = [];
      const collides = (box) =>
        placed.some(
          (other) =>
            box.x < other.x + other.w &&
            box.x + box.w > other.x &&
            box.y < other.y + other.h &&
            box.y + box.h > other.y,
        );

      const ordered = [...nodes].sort((a, b) => b.importers - a.importers);
      const labelFloor = nodes.length > 160 ? 4 : 2;
      for (const node of ordered) {
        const isFocus = node === focus || node === selected;
        // While something is focused, label it and what it touches. The most
        // depended-on files keep their labels either way, so the map stays
        // readable instead of going blank around the selection.
        if (focus && !isFocus && !near?.has(node.path) && node.importers < labelFloor) continue;

        const point = toScreen(node);
        const radius = radiusOf(node) * Math.max(view.scale, 0.55);
        const width = ctx.measureText(node.label).width;
        const box = { x: point.x - width / 2, y: point.y + radius + 2, w: width, h: 13 };

        // The focused node always gets its label, even over a neighbour's.
        if (!isFocus && collides(box)) continue;
        placed.push(box);

        ctx.fillStyle = isFocus ? text : faint;
        ctx.fillText(node.label, point.x, box.y);
      }
    }

    /**
     * The loop stops once the layout has settled.
     *
     * A settled graph is a still picture, and animating a still picture forever
     * costs a core for nothing. Anything that changes what is on screen calls
     * wake() instead.
     */
    function loop() {
      const simulating = ticksLeft > 0;
      if (simulating) {
        // Several passes per frame: the layout settles in about a second
        // rather than crawling for ten.
        for (let i = 0; i < 3 && ticksLeft > 0; i++) {
          tick();
          ticksLeft--;
        }
        if (ticksLeft === 0) fit();
      }

      draw();

      if (simulating || redrawWanted) {
        redrawWanted = false;
        frame = requestAnimationFrame(loop);
      } else {
        frame = null;
      }
    }

    function wake() {
      redrawWanted = true;
      if (frame === null) frame = requestAnimationFrame(loop);
    }

    // --- interaction -------------------------------------------------------

    function graphPoint(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left - view.x) / view.scale,
        y: (event.clientY - rect.top - view.y) / view.scale,
      };
    }

    function nodeAt(event) {
      const point = graphPoint(event);
      let best = null;
      let bestDistance = Infinity;
      for (const node of nodes) {
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        const reach = radiusOf(node) + 6 / view.scale;
        if (distance < reach && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    }

    function onMove(event) {
      if (panning) {
        view.x = panning.viewX + (event.clientX - panning.x);
        view.y = panning.viewY + (event.clientY - panning.y);
        wake();
        return;
      }
      if (dragging) {
        const point = graphPoint(event);
        dragging.x = point.x;
        dragging.y = point.y;
        wake();
        return;
      }
      const found = nodeAt(event);
      if (found !== hovered) {
        hovered = found;
        canvas.style.cursor = found ? "pointer" : "grab";
        wake();
      }
    }

    function onDown(event) {
      const found = nodeAt(event);
      if (found) {
        dragging = found;
        // Nudge the layout so neighbours follow the node being moved.
        temperature = Math.max(temperature, 4);
        ticksLeft = Math.max(ticksLeft, 60);
      } else {
        panning = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
        canvas.classList.add("dragging");
      }
    }

    function onUp(event) {
      const wasDragging = dragging;
      const wasPanning = panning;
      dragging = null;
      panning = null;
      canvas.classList.remove("dragging");

      // A click is a press that did not move far.
      if (wasPanning && Math.hypot(event.clientX - wasPanning.x, event.clientY - wasPanning.y) < 4) {
        selected = null;
        onSelect(null);
      } else if (wasDragging) {
        selected = wasDragging;
        onSelect(wasDragging);
      }
      wake();
    }

    function onWheel(event) {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = Math.min(Math.max(view.scale * factor, 0.15), 6);
      // Keep the point under the cursor fixed while zooming.
      view.x = px - ((px - view.x) / view.scale) * next;
      view.y = py - ((py - view.y) / view.scale) * next;
      view.scale = next;
      wake();
    }

    function onLeave() {
      hovered = null;
      wake();
    }

    // A resized canvas needs a redraw at the new backing-store size.
    const observer = new ResizeObserver(() => wake());
    observer.observe(canvas);

    // A hidden window runs no animation frames at all, so a graph set up while
    // the window was behind something has never drawn. Redraw when it returns.
    function onVisibility() {
      if (!document.hidden) wake();
    }
    document.addEventListener("visibilitychange", onVisibility);

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    global.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mouseleave", onLeave);

    return {
      setData(graph) {
        nodes = graph.nodes.map((node) => ({ ...node, x: 0, y: 0, vx: 0, vy: 0 }));
        edges = graph.edges;
        byPath = new Map(nodes.map((node) => [node.path, node]));

        adjacency = new Map(nodes.map((node) => [node.path, new Set()]));
        for (const edge of edges) {
          adjacency.get(edge.from)?.add(edge.to);
          adjacency.get(edge.to)?.add(edge.from);
        }
        // Degree within this slice of the graph, not overall: it decides how
        // hard gravity holds a node that nothing here connects to.
        for (const node of nodes) node.degree = adjacency.get(node.path)?.size ?? 0;

        hovered = null;
        selected = null;
        seed();
        temperature = Math.min(size().width, size().height) / 8;
        ticksLeft = 320;
        wake();
      },
      select(path) {
        selected = byPath.get(path) ?? null;
        wake();
      },
      reset() {
        seed();
        temperature = Math.min(size().width, size().height) / 8;
        ticksLeft = 320;
        wake();
      },
      destroy() {
        if (frame !== null) cancelAnimationFrame(frame);
        observer.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mousedown", onDown);
        global.removeEventListener("mouseup", onUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("mouseleave", onLeave);
      },
    };
  }

  global.SDLCGraph = { createGraph, LANG_VAR };
})(window);
