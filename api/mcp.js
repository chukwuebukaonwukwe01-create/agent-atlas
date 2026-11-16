import { handleMcp } from "../lib/mcp.mjs";
import { checkOpts, readJson, selfOrigin, send } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, null);
  if (req.method === "GET") {
    // No server-initiated stream: this server answers every request with plain JSON.
    return send(res, 405, { error: "Use POST with a JSON-RPC body. This MCP server does not open an SSE stream." }, { Allow: "POST, OPTIONS" });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" }, { Allow: "POST, OPTIONS" });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const out = await handleMcp(body, { checkOpts: checkOpts(req), selfOrigin: selfOrigin(req) });
  if (out === null) return send(res, 202, null);
  return send(res, 200, out);
}
