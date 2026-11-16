// The Atlas directory: the community list of agentic websites from the challenge repo
// (docs/agentic_websites.md), plus Atlas's own seed list, each checked by lib/checker.mjs.
import { readFile } from "node:fs/promises";
import { checkSite, originOf } from "./checker.mjs";

export const COMMUNITY_LIST_URL =
  "https://raw.githubusercontent.com/cognizant-ai-labs/agentic-web/main/docs/agentic_websites.md";
const SEEDS_PATH = new URL("../public/directory.json", import.meta.url);
const DIRECTORY_TTL_MS = 10 * 60 * 1000;
const CHECK_TTL_MS = 5 * 60 * 1000;

const checkCache = new Map(); // input -> {at, report}
let directoryCache = null; // {at, entries, sources}

/**
 * Parse the Markdown table in agentic_websites.md.
 *
 * :param md: The file's text.
 * :return: Entries with url, name, description, team and agentUrl.
 */
export function parseCommunityList(md) {
  const rows = [];
  for (const line of String(md).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|\s*-/.test(t) || /^\|\s*URL\s*\|/i.test(t)) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const [url, name, description, team, agentCell] = cells;
    const link = agentCell.match(/\((https?:\/\/[^)\s]+)\)/) || agentCell.match(/(https?:\/\/\S+)/);
    if (!/^https?:\/\//i.test(url) && !link) continue;
    rows.push({
      url: url.replace(/^<|>$/g, ""),
      name: stripMd(name),
      description: stripMd(description),
      team: team === "-" ? null : stripMd(team),
      agentUrl: link ? link[1] : url,
      source: "community",
    });
  }
  return rows;
}

function stripMd(s) {
  return String(s || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim();
}

async function loadSeeds(selfOrigin) {
  try {
    const raw = JSON.parse(await readFile(SEEDS_PATH, "utf8"));
    return (raw.sites || []).map((s) => ({
      ...s,
      url: s.url.replace("{self}", selfOrigin),
      agentUrl: (s.agentUrl || s.url).replace("{self}", selfOrigin),
      source: s.source || "atlas",
    }));
  } catch {
    return [];
  }
}

// Extra sites for local development, e.g. ATLAS_EXTRA_SITES="http://127.0.0.1:8080/net|Name|Desc,..."
function extraSites() {
  return String(process.env.ATLAS_EXTRA_SITES || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [url, name, description] = s.split("|");
    return { url, agentUrl: url, name: name || url, description: description || "", team: null, source: "local" };
  });
}

async function loadCommunity(fetchImpl) {
  try {
    const resp = await fetchImpl(COMMUNITY_LIST_URL, { headers: { "User-Agent": "AgentAtlas/1.0" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { entries: parseCommunityList(await resp.text()), ok: true };
  } catch (err) {
    return { entries: [], ok: false, error: err.message };
  }
}

/**
 * Check a URL, with a short in-memory cache.
 */
export async function cachedCheck(input, opts) {
  const key = String(input).trim();
  const hit = checkCache.get(key);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS && !opts?.fresh) return hit.report;
  const report = await checkSite(key, opts);
  checkCache.set(key, { at: Date.now(), report });
  if (checkCache.size > 500) checkCache.delete(checkCache.keys().next().value);
  return report;
}

/**
 * Return the directory with a compact check result per site.
 *
 * :param opts: {fetchImpl, origin, guard, selfOrigin, fresh}
 */
export async function getDirectory(opts = {}) {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS && !opts.fresh) return directoryCache;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const selfOrigin = opts.selfOrigin || "";
  const [community, seeds] = await Promise.all([loadCommunity(fetchImpl), loadSeeds(selfOrigin)]);
  const merged = [];
  const seen = new Set();
  for (const e of [...seeds, ...extraSites(), ...community.entries]) {
    const key = (e.agentUrl || e.url).replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  const entries = await mapLimit(merged, 4, async (e) => {
    const report = await cachedCheck(e.agentUrl || e.url, opts);
    return { ...e, check: compact(report) };
  });
  directoryCache = {
    at: Date.now(),
    updatedAt: new Date().toISOString(),
    sources: { community: { url: COMMUNITY_LIST_URL, ok: community.ok, error: community.error || null, count: community.entries.length }, seeds: seeds.length },
    entries,
  };
  return directoryCache;
}

export function compact(report) {
  return {
    verdict: report.summary?.verdict,
    score: report.summary?.score,
    trustLevel: report.summary?.trustLevel,
    counts: report.summary?.counts,
    networkUrl: report.target?.networkUrl || null,
    networkName: report.network?.name || null,
    networkDescription: report.network?.description || null,
    agents: (report.network?.agents || []).map((a) => ({ name: a.name, description: a.description, front: a.front })),
    sampleQueries: report.network?.sampleQueries || [],
    contacts: (report.trust?.externalOrigins || []).map((e) => e.origin),
    websiteActions: report.trust?.websiteActions || [],
    tags: (report.manifest?.networks || []).flatMap((n) => n.tags || []),
    checkedAt: report.checkedAt,
  };
}

/**
 * Keyword search over the directory.
 *
 * :param entries: Directory entries with check results.
 * :param query: Free text.
 * :return: Matches sorted by score, each with why it matched.
 */
export function searchDirectory(entries, query, limit = 5) {
  const terms = tokenize(query);
  if (!terms.length) return entries.slice(0, limit).map((e) => ({ entry: e, score: 0, matched: [] }));
  const results = [];
  for (const e of entries) {
    const fields = [
      [e.name, 3], [e.description, 2], [e.check?.networkDescription, 2], [e.check?.networkName, 2],
      [(e.check?.agents || []).map((a) => `${a.name} ${a.description}`).join(" "), 1],
      [(e.check?.sampleQueries || []).join(" "), 1], [(e.check?.tags || []).join(" "), 1],
      [(e.check?.websiteActions || []).join(" "), 1], [e.url, 1],
    ];
    let score = 0;
    const matched = new Set();
    for (const term of terms) {
      for (const [text, weight] of fields) {
        const toks = tokenize(text || "");
        if (toks.some((t) => t === term || (term.length > 3 && t.startsWith(term)) || (t.length > 3 && term.startsWith(t)))) {
          score += weight;
          matched.add(term);
        }
      }
    }
    if (score > 0) {
      if (e.check?.verdict === "conformant" || e.check?.verdict === "conformant-with-warnings") score += 0.5;
      results.push({ entry: e, score, matched: [...matched] });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

const STOP = new Set("a an and are can do does find for from get i in is it me my of on or site sites some that the to want what which who with you agent agents website websites".split(" "));
function tokenize(s) {
  return String(s).toLowerCase().replace(/[_/.-]+/g, " ").split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1"));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export { originOf };
