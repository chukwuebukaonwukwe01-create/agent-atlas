// Small helpers shared by the Vercel functions (api/*.mjs) and the local dev server.
import { publicUrlGuard } from "./net.mjs";

export function selfOrigin(req) {
  if (process.env.ATLAS_ORIGIN) return process.env.ATLAS_ORIGIN.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const host = req?.headers?.host || "localhost:8090";
  const proto = req?.headers?.["x-forwarded-proto"] || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export function checkOpts(req) {
  return { origin: selfOrigin(req), guard: publicUrlGuard };
}

export function query(req) {
  return new URL(req.url, "http://x").searchParams;
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error("Request body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function send(res, status, body, headers = {}) {
  const isString = typeof body === "string";
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...headers })) res.setHeader(k, v);
  if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", isString ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
  res.end(body === null || body === undefined ? "" : isString ? body : JSON.stringify(body));
}

/** Drop fetched file bodies from a report before returning it. */
export function publicReport(report) {
  return { ...report, files: report.files.map(({ text, ...f }) => f) };
}
