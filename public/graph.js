// Draws a site's agent network as a small nautical-style chart: the front agent is the
// harbour, internal agents are buoys, partner sites are islands, MCP servers are beacons,
// site actions are a quay and missing references are hazards. Returns an SVG string.

const COL_W = 210;
const ROW_H = 74;
const PAD_X = 120;
const PAD_Y = 46;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * :param graph: {nodes: [{id, label, kind, detail}], edges: [{from, to, kind}]}
 * :return: {svg, width, height}
 */
export function renderGraph(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (!nodes.length) return { svg: "", width: 0, height: 0 };

  // Columns: 0 = front agent, then internal agents by delegation depth, last = outside.
  const depth = new Map();
  const front = nodes.find((n) => n.kind === "front") || nodes[0];
  depth.set(front.id, 0);
  const queue = [front.id];
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges) {
      if (e.from !== id) continue;
      const target = nodes.find((n) => n.id === e.to);
      if (!target || depth.has(target.id)) continue;
      if (target.kind === "agent" || target.kind === "coded") {
        depth.set(target.id, depth.get(id) + 1);
        queue.push(target.id);
      }
    }
  }
  let maxAgentDepth = 0;
  for (const n of nodes) {
    if ((n.kind === "agent" || n.kind === "coded") && !depth.has(n.id)) depth.set(n.id, 1); // unreachable agents
    if (depth.has(n.id)) maxAgentDepth = Math.max(maxAgentDepth, depth.get(n.id));
  }
  const outsideCol = maxAgentDepth + 1;
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, outsideCol);

  const cols = new Map();
  for (const n of nodes) {
    const c = depth.get(n.id);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(n);
  }
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const width = PAD_X * 2 + COL_W * Math.max(1, cols.size - 1) + 60;
  const height = PAD_Y * 2 + ROW_H * Math.max(1, maxRows - 1) + 30;
  const pos = new Map();
  for (const [c, list] of cols) {
    const colH = ROW_H * (list.length - 1);
    const top = (height - colH) / 2;
    list.forEach((n, i) => pos.set(n.id, { x: PAD_X + c * COL_W, y: top + i * ROW_H }));
  }

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="chart" viewBox="0 0 ${width} ${height}" style="min-width:${Math.round(width * 0.75)}px" role="img" aria-labelledby="chart-title chart-desc">`);
  parts.push(`<title id="chart-title">Agent network chart</title>`);
  parts.push(`<desc id="chart-desc">${esc(describe(nodes, edges))}</desc>`);
  parts.push(`<defs><pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" class="chart-grid"/></pattern>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" class="chart-arrow"/></marker></defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="url(#grid)"/>`);
  // Depth contours around the harbour.
  const fp = pos.get(front.id);
  for (const r of [60, 120, 190]) parts.push(`<circle cx="${fp.x}" cy="${fp.y}" r="${r}" class="chart-contour"/>`);

  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const midX = (a.x + b.x) / 2;
    const cls = e.kind === "missing" ? "edge edge-hazard" : e.kind === "delegates" ? "edge edge-internal" : "edge edge-external";
    parts.push(`<path d="M${a.x + 18} ${a.y} C${midX} ${a.y}, ${midX} ${b.y}, ${b.x - 22} ${b.y}" class="${cls}" marker-end="url(#arrow)"><title>${esc(e.kind)}</title></path>`);
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    parts.push(`<g class="node node-${n.kind}" transform="translate(${p.x} ${p.y})"><title>${esc(`${n.label}${n.detail ? ` — ${n.detail}` : ""}`)}</title>${symbol(n.kind)}`);
    const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
    parts.push(`<text class="node-label" y="34" text-anchor="middle">${esc(label)}</text>`);
    parts.push(`<text class="node-kind" y="48" text-anchor="middle">${esc(KIND_LABEL[n.kind] || n.kind)}</text></g>`);
  }
  parts.push("</svg>");
  return { svg: parts.join(""), width, height };
}

const KIND_LABEL = {
  front: "front agent",
  agent: "agent",
  coded: "coded tool",
  remote: "partner site",
  mcp: "MCP server",
  action: "on this page",
  missing: "missing",
};

function symbol(kind) {
  switch (kind) {
    case "front": // harbour: double ring with a cross
      return `<circle r="17" class="sym sym-front"/><circle r="11" class="sym-ring"/><path d="M-6 0H6M0 -6V6" class="sym-cross"/>`;
    case "agent":
    case "coded": // buoy
      return `<circle r="12" class="sym sym-agent"/><circle r="3.5" class="sym-dot"/>`;
    case "remote": // island
      return `<path d="M-20 4C-20 -8 -8 -14 2 -12C12 -16 22 -6 19 4C22 12 8 15 -2 13C-12 16 -21 12 -20 4Z" class="sym sym-remote"/>`;
    case "mcp": // beacon
      return `<rect x="-11" y="-11" width="22" height="22" rx="3" class="sym sym-mcp"/><path d="M-5 0H5M0 -5V5" class="sym-cross"/>`;
    case "action": // quay
      return `<path d="M0 -14L14 0L0 14L-14 0Z" class="sym sym-action"/>`;
    default: // hazard
      return `<circle r="13" class="sym sym-missing"/><path d="M-6 -6L6 6M6 -6L-6 6" class="sym-cross"/>`;
  }
}

function describe(nodes, edges) {
  const front = nodes.find((n) => n.kind === "front");
  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return `${front ? `Front agent ${front.label}. ` : ""}${counts.agent || 0} other agents, ${counts.remote || 0} partner sites, ${counts.mcp || 0} MCP servers, ${counts.missing || 0} missing references, ${edges.length} connections.`;
}
