// Server-side guard: Atlas fetches URLs that visitors type, so it refuses private,
// loopback and link-local addresses (SSRF protection). ALLOW_PRIVATE=1 turns the guard
// off for local development against sites on 127.0.0.1.
import { lookup } from "node:dns/promises";
import net from "node:net";

export function allowPrivate() {
  return process.env.ALLOW_PRIVATE === "1";
}

export async function publicUrlGuard(url) {
  if (allowPrivate()) return;
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http and https URLs can be checked.");
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) throw new Error(`Port ${u.port} is not allowed.`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("Local addresses can't be checked from the public Atlas.");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  for (const { address } of addrs) {
    if (isPrivate(address)) throw new Error("That host resolves to a private address, which Atlas does not fetch.");
  }
}

export function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isPrivate(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9")
    || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}
