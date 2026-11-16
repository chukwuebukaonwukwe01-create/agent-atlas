import { getDirectory, searchDirectory } from "../lib/directory.mjs";
import { checkOpts, query, selfOrigin, send } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const q = query(req);
  const dir = await getDirectory({ ...checkOpts(req), selfOrigin: selfOrigin(req), fresh: q.get("fresh") === "1" });
  if (q.get("q")) {
    const hits = searchDirectory(dir.entries, q.get("q"), Number(q.get("limit")) || 10);
    return send(res, 200, { query: q.get("q"), results: hits.map((h) => ({ ...h.entry, matched: h.matched, score: h.score })) });
  }
  return send(res, 200, dir, { "Cache-Control": "public, max-age=120" });
}
