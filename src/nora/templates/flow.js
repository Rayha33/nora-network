/* Flow view: the whole network as a left-to-right gas flow overview on dotted paper,
   drawn by vis-network from the nodes, edges and options pyvis produced. Positions come
   from layout.py; colours, widths and labels from App.pipeStyle / App.nodeStyle. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const ROUNDNESS = flowOptions.edges.smooth.roundness;
  let network = null, el = null, curves = null;

  // The paper: a dot grid in canvas units, so it pans and zooms with the drawing.
  function paper(ctx) {
    const t = App.palette(), scale = network.getScale();
    let step = 24;
    while (step * scale < 12) step *= 2;
    const a = network.DOMtoCanvas({ x: 0, y: 0 });
    const b = network.DOMtoCanvas({ x: el.clientWidth, y: el.clientHeight });
    const r = 1.1 / scale;
    ctx.save();
    ctx.fillStyle = t.dot;
    for (let x = Math.floor(a.x / step) * step; x <= b.x; x += step) {
      for (let y = Math.floor(a.y / step) * step; y <= b.y; y += step) {
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    ctx.restore();
  }

  // The same cubic Bézier vis-network draws for horizontal curves, sampled for the dots.
  function buildCurves() {
    const positions = network.getPositions(), out = {};
    edges.forEach((edge) => {
      const a = positions[edge.from], b = positions[edge.to];
      if (!a || !b) return;
      const dx = b.x - a.x;
      const c1 = [a.x + ROUNDNESS * dx, a.y], c2 = [b.x - ROUNDNESS * dx, b.y];
      const points = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        points.push([
          u * u * u * a.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.x,
          u * u * u * a.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.y,
        ]);
      }
      out[edge.id] = points;
    });
    return out;
  }

  view.mount = (container) => {
    el = container;
    network = new vis.Network(container, { nodes, edges }, flowOptions);
    view.network = network;
    if (App.embed) network.setOptions({ interaction: { zoomView: false } });
    network.on("beforeDrawing", paper);
    network.on("afterDrawing", (ctx) => {
      if (App.state.mode !== "live" || !App.live.playing || App.reduceMotion) return;
      if (!curves) curves = buildCurves();
      for (const id of App.pipeIds) if (curves[id]) App.drawDots(ctx, id, curves[id]);
    });
    network.on("click", (event) => App.select(event.nodes[0] || event.edges[0] || null));
    network.on("dragEnd", () => { curves = null; });
    view.ready = true;
    App.restyle();
    view.highlight(App.state.selected);
    view.fit(false);
  };

  view.restyle = () => {
    const t = App.palette();
    nodes.update(App.nodeIds.map((id) => {
      const style = App.nodeStyle(id);
      return {
        id,
        size: 16 * style.scale,
        label: `<b>${NORA.assets[id].name}</b>\n${style.sub}`,
        opacity: style.dim ? 0.45 : 1,
        borderWidth: style.ring ? 3 : 0,
        color: {
          border: style.ring || t.paper,
          background: t.paper,
          highlight: { border: t.pipe, background: t.paper },
          hover: { border: style.ring || t.paper, background: t.paper },
        },
        font: { color: t.ink2, bold: { color: t.ink } },
      };
    }));
    edges.update(App.pipeIds.map((id) => {
      const style = App.pipeStyle(id);
      return {
        id,
        label: style.label,
        width: style.width * 1.1,
        dashes: style.dashed ? [5, 5] : false,
        color: { color: style.color, highlight: style.color, hover: style.color, inherit: false, opacity: 1 },
        arrows: {
          to: { enabled: style.forward, scaleFactor: 0.4 },
          from: { enabled: style.backward, scaleFactor: 0.4 },
        },
        font: { color: t.ink2, background: t.paper },
      };
    }));
  };

  view.draw = () => network.redraw();

  view.highlight = (id) => {
    if (!id) network.unselectAll();
    else if (nodes.get(id)) network.selectNodes([id]);
    else network.selectEdges([id]);
  };

  view.focus = (id, animate) => {
    const animation = animate && !App.reduceMotion ? { duration: 500 } : false;
    const scale = Math.max(network.getScale(), 1.1);
    if (nodes.get(id)) {
      network.focus(id, { scale, animation });
    } else {
      const edge = edges.get(id), p = network.getPositions([edge.from, edge.to]);
      const position = { x: (p[edge.from].x + p[edge.to].x) / 2, y: (p[edge.from].y + p[edge.to].y) / 2 };
      network.moveTo({ position, scale, animation });
    }
  };

  // Fit the whole overview, leaving room for the controls along the top.
  view.fit = (animate = true) => {
    network.fit({ animation: false });
    const position = network.getViewPosition(), scale = network.getScale() * 0.92;
    network.moveTo({
      position: { x: position.x, y: position.y - 18 / scale },
      scale,
      animation: animate && !App.reduceMotion ? { duration: 400 } : false,
    });
  };

  view.resize = () => network.redraw();

  App.register("flow", view);
})();
