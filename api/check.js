import { cachedCheck } from "../lib/directory.mjs";
import { checkOpts, publicReport, query, send } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const url = query(req).get("url");
  if (!url) return send(res, 400, { error: "Add ?url=<site or network URL>." });
  const report = await cachedCheck(url, { ...checkOpts(req), fresh: query(req).get("fresh") === "1" });
  return send(res, 200, publicReport(report), { "Cache-Control": "public, max-age=60" });
}
