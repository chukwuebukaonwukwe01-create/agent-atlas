// Local server: static files from public/ (with CORS on the public agent files, like
// the hosted site) and the /api/* functions. Usage: node scripts/dev-server.mjs [--port 8090]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8090;
const routes = {
  "/api/check": () => import("../api/check.js"),
  "/api/directory": () => import("../api/directory.js"),
  "/api/mcp": () => import("../api/mcp.js"),
  "/api/badge": () => import("../api/badge.js"),
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".hocon": "text/plain; charset=utf-8" };
const PUBLIC_AGENT_FILE = /(agent-manifest\.json|\.network\.json|links\.json|agent-mcp\.json|\.well-known\/.*|bridge\/.*)$/;

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  try {
    if (routes[pathname]) return (await routes[pathname]()).default(req, res);
    let file = path.join(pub, decodeURIComponent(pathname));
    if (!file.startsWith(pub)) throw Object.assign(new Error("bad path"), { code: "ENOENT" });
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    if (PUBLIC_AGENT_FILE.test(pathname)) res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(body);
  } catch (err) {
    res.statusCode = err.code === "ENOENT" ? 404 : 500;
    res.end(err.code === "ENOENT" ? "Not found" : String(err));
  }
}).listen(port, "127.0.0.1", () => console.log(`Agent Atlas on http://127.0.0.1:${port}`));
