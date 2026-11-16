import { cachedCheck } from "../lib/directory.mjs";
import { checkOpts, query, send } from "../lib/http.mjs";
import { badgeSvg } from "../lib/badge.mjs";

export default async function handler(req, res) {
  const url = query(req).get("url");
  if (!url) return send(res, 400, badgeSvg("agent atlas", "add ?url=", "#64748b"), { "Content-Type": "image/svg+xml" });
  const r = await cachedCheck(url, checkOpts(req));
  const v = r.summary.verdict;
  const [label, color] = v === "conformant" ? ["conformant", "#15803d"]
    : v === "conformant-with-warnings" ? ["conformant · warnings", "#b45309"]
    : v === "unreachable" ? ["unreachable", "#64748b"] : ["issues found", "#b91c1c"];
  return send(res, 200, badgeSvg("agent atlas", label, color), { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" });
}
