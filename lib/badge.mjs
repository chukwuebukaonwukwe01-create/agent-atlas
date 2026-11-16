// A shields-style SVG badge sites can embed: ![Agent Atlas](https://<atlas>/api/badge?url=<site>)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const w = (s) => Math.round(String(s).length * 6.6 + 14);

export function badgeSvg(left, right, color) {
  const lw = w(left);
  const rw = w(right);
  const total = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">
<title>${esc(left)}: ${esc(right)}</title>
<clipPath id="r"><rect width="${total}" height="20" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#1e293b"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text></g></svg>`;
}
