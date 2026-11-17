// Agent Atlas checker: fetches an agent site's public files and reports how well it
// follows the Worldwide Agentic Web MVP spec (profile 0.2), what its agents can reach,
// and the trust signals a caller should know before linking to it.
//
// The core is isomorphic: it only needs `fetch`. The server wrapper (lib/net.mjs) adds
// the public-address guard. The network is validated with the reference runtime's own
// validator and HOCON parser, so a site that passes here also loads in nsdeploy.

import { parseHocon } from "../public/runtime/hocon.js";
import { validate_network } from "../public/runtime/generated/validation.gen.mjs";
import { classify_tool, find_front_man } from "../public/runtime/generated/graph.gen.mjs";

export const CHECKER_VERSION = "1.0.0";
export const SPEC_PROFILE = "MVP Profile 0.2";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// Phrases in published instructions that try to steer a caller's model. A network's
// instructions run inside the visitor's model when another site calls it (spec 5,
// "Untrusted instructions"), so these are worth a human look. Heuristic, not proof.
const INJECTION_PATTERNS = [
  [/ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|messages)/i, "asks the model to ignore earlier instructions"],
  [/disregard (the |your |all )?(system|previous|prior|caller)/i, "asks the model to disregard the caller's rules"],
  [/(reveal|print|show|send|output|leak)[^.\n]{0,40}(api[ _-]?key|byok|credential|secret|password|token)/i, "asks for keys or credentials"],
  [/(system prompt|developer message|hidden instructions)/i, "mentions the caller's system prompt"],
  [/you are now (?!the |an? )/i, "tries to change the model's identity"],
  [/(do not|don't|never) (tell|inform|show) the (user|visitor)/i, "asks the model to hide things from the visitor"],
  [/(without|skip|bypass)[^.\n]{0,30}(confirm|consent|approval|asking)/i, "asks to skip confirmation or consent"],
  [/sly_data|private context/i, "refers to private context (sly_data)"],
];

// Credential shapes that must never appear in published files (spec 4, "Credential handling").
const SECRET_PATTERNS = [
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, "OpenAI/Anthropic-style API key"],
  [/\botk_[A-Za-z0-9]{16,}/, "Otari API key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgsk_[A-Za-z0-9]{30,}/, "Groq API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];

/**
 * Check one agent site or network.
 *
 * :param input: A site URL, a network URL (site base + network name), an
 *   agent-manifest.json URL or a network definition URL.
 * :param opts: {fetchImpl, origin, guard} — fetchImpl defaults to global fetch; origin is
 *   sent as the Origin header to probe CORS; guard(url) may throw to refuse an address.
 * :return: The report object (see README, "Report format").
 */
export async function checkSite(input, opts = {}) {
  const ctx = {
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    origin: opts.origin || "https://agent-atlas.example",
    guard: opts.guard || (async () => {}),
    files: [],
  };
  const report = {
    input: String(input || "").trim(),
    checkedAt: new Date().toISOString(),
    checker: { version: CHECKER_VERSION, profile: SPEC_PROFILE },
    target: null,
    files: ctx.files,
    manifest: null,
    network: null,
    graph: { nodes: [], edges: [] },
    trust: null,
    checks: [],
    summary: null,
  };
  const add = (check) => report.checks.push(check);

  let start;
  try {
    start = normalizeInput(report.input);
  } catch (err) {
    add(fail("input", "Publication", "MUST", "A valid http(s) URL", err.message));
    report.summary = summarize(report);
    return report;
  }

  // 1. Find the manifest.
  const located = await locateManifest(ctx, start);
  report.target = located.target;
  if (!located.manifest) {
    add(fail("manifest.found", "Publication", "MUST", "agent-manifest.json is published",
      located.reason || "No agent-manifest.json was found at the site base."));
    report.summary = summarize(report);
    return report;
  }
  const manifest = located.manifest;
  const manifestFile = located.file;
  add(pass("manifest.found", "Publication", "MUST", "agent-manifest.json is published", manifestFile.url));
  add(corsCheck("manifest.cors", "agent-manifest.json", manifestFile));
  add(httpsCheck(report.target.base));

  // 2. Manifest content (spec 3.3).
  const networks = Array.isArray(manifest.networks) ? manifest.networks : [];
  report.manifest = summarizeManifest(manifest);
  if (networks.length === 0) {
    add(fail("manifest.networks", "Publication", "MUST", "Manifest lists at least one network",
      "The manifest has no networks array, or it is empty."));
    report.summary = summarize(report);
    return report;
  }
  const badEntries = networks.filter((n) => !n || !n.name || !n.front_man || !n.hocon);
  add(badEntries.length
    ? fail("manifest.entries", "Publication", "MUST", "Each network has name, front_man and hocon",
      `${badEntries.length} network entr${badEntries.length === 1 ? "y is" : "ies are"} missing name, front_man or hocon.`)
    : pass("manifest.entries", "Publication", "MUST", "Each network has name, front_man and hocon",
      networks.map((n) => n.name).join(", ")));

  let entry = null;
  if (report.target.networkName) {
    entry = networks.find((n) => n && n.name === report.target.networkName) || null;
    add(entry
      ? pass("manifest.exact", "Publication", "MUST", "The requested network name matches exactly",
        `Found "${entry.name}".`)
      : fail("manifest.exact", "Publication", "MUST", "The requested network name matches exactly",
        `The manifest has no network named "${report.target.networkName}". Callers must fail rather than pick another (spec 3.2).`));
  }
  if (!entry && located.networkFileHint) {
    entry = networks.find((n) => n && n.hocon && sameUrl(resolveUrl(report.target.base, n.hocon), located.networkFileHint)) || null;
  }
  if (!entry && !report.target.networkName) entry = networks.find((n) => n && n.hocon) || null;
  if (!entry) {
    report.summary = summarize(report);
    return report;
  }
  report.target.networkName = entry.name;
  report.target.networkUrl = joinUrl(report.target.base, entry.name);

  add(manifest.llm_router && (manifest.llm_router.base_url || manifest.llm_router.byok_router)
    ? pass("manifest.router", "Inference", "MUST", "Manifest declares a top-site LLM router",
      manifest.llm_router.base_url || manifest.llm_router.byok_router)
    : fail("manifest.router", "Inference", "MUST", "Manifest declares a top-site LLM router",
      "No llm_router.base_url. Spec 3.3 lists top-site router metadata as required manifest content."));
  const policy = manifest.peer_policy || manifest.web_policy || null;
  add(policy && policy.mode
    ? pass("manifest.policy", "Trust", "MUST", "Manifest declares a peer policy", `mode: ${policy.mode}`)
    : fail("manifest.policy", "Trust", "MUST", "Manifest declares a peer policy",
      "No peer_policy. Without it a reference runtime treats the site as closed with no peers."));

  // 3. Network definition.
  const networkFileUrl = resolveUrl(report.target.base, entry.hocon);
  report.target.networkFileUrl = networkFileUrl;
  const netFile = await fetchFile(ctx, networkFileUrl, "network definition");
  if (!netFile.ok) {
    add(fail("network.fetch", "Network", "MUST", "The network definition is published",
      `${networkFileUrl} → ${netFile.error || `HTTP ${netFile.status}`}`));
    report.summary = summarize(report);
    return report;
  }
  add(pass("network.fetch", "Network", "MUST", "The network definition is published", networkFileUrl));
  add(corsCheck("network.cors", "network definition", netFile));

  let config;
  try {
    config = netFile.text.trim().startsWith("{") ? JSON.parse(netFile.text) : parseHocon(netFile.text);
    add(pass("network.parse", "Network", "MUST", "The definition parses as JSON/HOCON", "Parsed."));
  } catch (err) {
    try {
      config = parseHocon(netFile.text);
      add(warn("network.parse", "Network", "SHOULD", "The definition parses as JSON/HOCON",
        "Not strict JSON, but the runtime's HOCON parser accepts it. Browser loaders expect resolved JSON."));
    } catch (err2) {
      add(fail("network.parse", "Network", "MUST", "The definition parses as JSON/HOCON", err2.message));
      report.summary = summarize(report);
      return report;
    }
  }

  const unresolved = /\binclude\s+["(]|\$\{[^}]+\}/.test(netFile.text);
  add(unresolved
    ? fail("network.resolved", "Network", "MUST", "Includes and substitutions are resolved",
      "Found an include directive or ${...} substitution. Published networks must be data-only (spec 2).")
    : pass("network.resolved", "Network", "MUST", "Includes and substitutions are resolved", "No includes or ${...} substitutions."));

  const errors = safeValidate(config);
  add(errors.length
    ? fail("network.validate", "Network", "MUST", "Passes the reference runtime validator", errors.join(" "))
    : pass("network.validate", "Network", "MUST", "Passes the reference runtime validator",
      "No malformed agents, missing references or invalid front agent."));

  const agents = Array.isArray(config.tools) ? config.tools.filter((a) => a && typeof a === "object") : [];
  const detectedFront = safeFrontMan(config);
  add(entry.front_man && agents.some((a) => a.name === entry.front_man)
    ? pass("network.front", "Network", "MUST", "front_man names an agent in the network", entry.front_man)
    : fail("network.front", "Network", "MUST", "front_man names an agent in the network",
      `The manifest says "${entry.front_man}", which is not an agent in the network.`));
  if (detectedFront && entry.front_man && detectedFront !== entry.front_man) {
    add(warn("network.front_order", "Network", "SHOULD", "front_man is the runtime's detected entry agent",
      `The runtime would pick "${detectedFront}" as the entry agent when run without the manifest.`));
  }

  const description = config.metadata?.description || entry.description;
  add(description
    ? pass("network.description", "Network", "MUST", "The network has a short description", truncate(description, 160))
    : fail("network.description", "Network", "MUST", "The network has a short description",
      "No metadata.description and no manifest description (spec 2.1, identity and metadata)."));

  const noDesc = agents.filter((a) => !a.function?.description).map((a) => a.name);
  add(noDesc.length
    ? fail("agents.description", "Network", "MUST", "Every agent has a function description", `Missing on: ${noDesc.join(", ")}`)
    : pass("agents.description", "Network", "MUST", "Every agent has a function description", `${agents.length} agent(s).`));

  const llmAgents = agents.filter((a) => !a.class && !a.toolbox);
  const noInstr = llmAgents.filter((a) => !a.instructions).map((a) => a.name);
  add(noInstr.length
    ? fail("agents.instructions", "Network", "MUST", "LLM agents have instructions", `Missing on: ${noInstr.join(", ")}`)
    : pass("agents.instructions", "Network", "MUST", "LLM agents have instructions", `${llmAgents.length} LLM agent(s).`));

  const noSchema = agents.filter((a) => !isSchema(a.function?.parameters)).map((a) => a.name);
  add(noSchema.length
    ? warn("agents.schema", "Network", "SHOULD", "Agents expose JSON Schema inputs",
      `No function.parameters object schema on: ${noSchema.join(", ")}`)
    : pass("agents.schema", "Network", "SHOULD", "Agents expose JSON Schema inputs", "All agents declare parameters."));

  const toolsArrays = agents.filter((a) => !Array.isArray(a.tools)).map((a) => a.name);
  add(toolsArrays.length
    ? warn("agents.tools", "Network", "SHOULD", "Every agent declares a tools list",
      `No tools array on: ${toolsArrays.join(", ")}. An empty list states "no downstream references".`)
    : pass("agents.tools", "Network", "SHOULD", "Every agent declares a tools list", "All agents declare tools."));

  // 4. Graph and reach.
  const analysis = analyzeGraph(config, agents, entry, report.target.base, manifest);
  report.graph = analysis.graph;
  const coded = agents.filter((a) => a.class || a.toolbox).map((a) => a.name);
  add(coded.length
    ? warn("network.portable", "Network", "SHOULD", "Uses only the portable data profile",
      `Coded or toolbox agents: ${coded.join(", ")}. They need publisher code and are not part of the minimum profile.`)
    : pass("network.portable", "Network", "SHOULD", "Uses only the portable data profile", "Declarative agents only."));

  // 5. links.json (optional) and discovery.
  const linksFile = await fetchFile(ctx, resolveUrl(report.target.base, "links.json"), "links.json");
  if (linksFile.ok) {
    let links = null;
    try { links = JSON.parse(linksFile.text); } catch { /* reported below */ }
    add(links && typeof links.networks === "object"
      ? pass("links.valid", "Interop", "INFO", "links.json is valid", `version ${links.version ?? "?"}`)
      : warn("links.valid", "Interop", "SHOULD", "links.json is valid", "links.json is not a {version, networks} object."));
  } else {
    add(info("links.valid", "Interop", "links.json (optional)", "Not published. Only needed for named peer links."));
  }
  const wellKnown = await fetchFile(ctx, resolveUrl(report.target.base, ".well-known/nsdeploy.json"), "discovery");
  add(wellKnown.ok
    ? info("discovery", "Interop", "Optional discovery metadata", ".well-known/nsdeploy.json is published.")
    : info("discovery", "Interop", "Optional discovery metadata", "No .well-known/nsdeploy.json (optional)."));

  // 6. Trust signals.
  const trust = buildTrust({ manifest, policy, agents, analysis, files: ctx.files, base: report.target.base });
  report.trust = trust;
  add(trust.unlistedOrigins.length
    ? fail("trust.peers", "Trust", "MUST", "Every external origin is allowed by the peer policy",
      `Not in allowed_peers, so the runtime refuses them: ${trust.unlistedOrigins.join(", ")}`)
    : pass("trust.peers", "Trust", "MUST", "Every external origin is allowed by the peer policy",
      trust.externalOrigins.length ? `${trust.externalOrigins.length} external origin(s), all allowed.` : "Calls no external origins."));
  if (policy?.mode === "open") {
    add(warn("trust.open", "Trust", "INFO", "Peer policy is closed",
      "Peer policy is open: the network may contact any origin, still after the visitor agrees."));
  }
  add(trust.secretFlags.length
    ? fail("trust.secrets", "Trust", "MUST", "No credentials in published files",
      trust.secretFlags.map((s) => `${s.kind} in ${s.file}`).join("; "))
    : pass("trust.secrets", "Trust", "MUST", "No credentials in published files", "No key or token patterns found."));
  add(trust.injectionFlags.length
    ? warn("trust.instructions", "Trust", "SHOULD", "Instructions don't try to steer a caller's model",
      trust.injectionFlags.map((f) => `${f.agent}: ${f.why} ("${f.excerpt}")`).join("; "))
    : pass("trust.instructions", "Trust", "SHOULD", "Instructions don't try to steer a caller's model",
      "No prompt-injection phrases found (heuristic)."));
  if (trust.insecureRefs.length) {
    add(isLoopback(report.target.base)
      ? warn("trust.https", "Trust", "INFO", "External references use HTTPS",
        `Local references (${trust.insecureRefs.join(", ")}) are fine for development; replace them before hosting.`)
      : fail("trust.https", "Trust", "MUST", "External references use HTTPS",
        `Plain http or loopback references: ${trust.insecureRefs.join(", ")}. Only allowed during local development.`));
  }

  report.network = {
    name: entry.name,
    description,
    frontMan: entry.front_man,
    model: config.llm_config?.model_name || null,
    maxSteps: config.max_steps ?? null,
    sampleQueries: config.metadata?.sample_queries || entry.sample_queries || [],
    agents: analysis.agents,
  };
  report.summary = summarize(report);
  return report;
}

// --- input and discovery -----------------------------------------------------

export function normalizeInput(raw) {
  let text = String(raw || "").trim();
  if (!text) throw new Error("Enter a site or network URL.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(text) ? `http://${text}` : `https://${text}`;
  }
  let url;
  try { url = new URL(text); } catch { throw new Error(`"${raw}" is not a valid URL.`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs can be checked.");
  url.hash = "";
  url.search = "";
  return url;
}

async function locateManifest(ctx, url) {
  const path = url.pathname;
  const candidates = [];
  let networkFileHint = null;

  if (/\/agent-manifest\.json$/i.test(path)) {
    candidates.push({ base: dirOf(url), networkName: null });
  } else if (/\.json$/i.test(path) || /\.hocon$/i.test(path)) {
    networkFileHint = url.href;
    candidates.push({ base: dirOf(url), networkName: null });
  } else {
    const trimmed = url.href.replace(/\/+$/, "");
    const segs = url.pathname.split("/").filter(Boolean);
    // Treat the URL as a site base first, then as base + network name (spec 3.2).
    candidates.push({ base: trimmed, networkName: null });
    if (segs.length) {
      const parent = new URL(url.href);
      parent.pathname = `/${segs.slice(0, -1).join("/")}`;
      candidates.push({ base: parent.href.replace(/\/+$/, ""), networkName: decodeURIComponent(segs[segs.length - 1]) });
    }
  }

  let lastReason = null;
  for (const c of candidates) {
    const manifestUrl = `${c.base}/agent-manifest.json`;
    const file = await fetchFile(ctx, manifestUrl, "agent-manifest.json");
    if (!file.ok) {
      lastReason = `${manifestUrl} → ${file.error || `HTTP ${file.status}`}`;
      continue;
    }
    let manifest;
    try { manifest = JSON.parse(file.text); } catch (err) {
      lastReason = `${manifestUrl} is not valid JSON: ${err.message}`;
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      lastReason = `${manifestUrl} is not a JSON object.`;
      continue;
    }
    // A base-only match should not shadow an exact network URL one level up.
    if (!c.networkName && candidates.length > 1 && !Array.isArray(manifest.networks)) {
      lastReason = `${manifestUrl} has no networks array.`;
      continue;
    }
    // Drop the failed probes for other candidate bases: they were guesses, not errors.
    for (let i = ctx.files.length - 1; i >= 0; i--) {
      if (ctx.files[i] !== file && ctx.files[i].label === "agent-manifest.json" && !ctx.files[i].ok) ctx.files.splice(i, 1);
    }
    return {
      manifest,
      file,
      networkFileHint,
      target: { base: c.base, networkName: c.networkName, manifestUrl },
    };
  }
  return {
    manifest: null,
    reason: lastReason,
    target: { base: candidates[0]?.base || url.href, networkName: candidates[0]?.networkName || null },
  };
}

// --- graph -----------------------------------------------------------------

function analyzeGraph(config, agents, entry, base, manifest) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const addNode = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); } };
  const labels = config.link_labels || {};
  const agentInfo = [];

  for (const a of agents) {
    const isFront = a.name === entry.front_man;
    addNode({
      id: `agent:${a.name}`,
      label: a.name,
      kind: isFront ? "front" : (a.class || a.toolbox ? "coded" : "agent"),
      detail: truncate(a.function?.description || "", 140),
    });
  }

  const actionTools = Array.isArray(manifest.actions?.agentTools) ? manifest.actions.agentTools : [];
  for (const a of agents) {
    const refs = Array.isArray(a.tools) ? a.tools : [];
    const toolInfo = [];
    for (const ref of refs) {
      const kind = safeClassify(config, ref);
      const id = toolId(ref, kind);
      if (kind === "agent" || kind === "coded" || kind === "toolbox") {
        edges.push({ from: `agent:${a.name}`, to: `agent:${ref}`, kind: "delegates" });
        toolInfo.push({ ref, kind: "agent" });
      } else if (kind === "remote") {
        const abs = resolveRef(base, ref);
        addNode({ id, label: labels[ref] || shortUrl(abs), kind: "remote", detail: abs, origin: originOf(abs) });
        edges.push({ from: `agent:${a.name}`, to: id, kind: "calls site" });
        toolInfo.push({ ref: abs, kind: "remote", label: labels[ref] || null, origin: originOf(abs) });
      } else if (kind === "mcp") {
        const url = typeof ref === "string" ? ref : ref?.url;
        const abs = url ? resolveRef(base, url) : "(no url)";
        const allowed = typeof ref === "object" && Array.isArray(ref.tools) ? ref.tools : null;
        addNode({ id, label: `MCP · ${shortUrl(abs)}`, kind: "mcp", detail: allowed ? `tools: ${allowed.join(", ")}` : "all tools", origin: originOf(abs) });
        edges.push({ from: `agent:${a.name}`, to: id, kind: "uses MCP" });
        toolInfo.push({ ref: abs, kind: "mcp", tools: allowed, origin: originOf(abs) });
      } else {
        addNode({ id, label: String(ref), kind: "missing", detail: "Referenced but not defined" });
        edges.push({ from: `agent:${a.name}`, to: id, kind: "missing" });
        toolInfo.push({ ref: String(ref), kind: "missing" });
      }
    }
    agentInfo.push({
      name: a.name,
      front: a.name === entry.front_man,
      kind: a.class || a.toolbox ? "coded" : "llm",
      description: a.function?.description || "",
      parameters: Object.keys(a.function?.parameters?.properties || {}),
      instructionsLength: typeof a.instructions === "string" ? a.instructions.length : 0,
      tools: toolInfo,
    });
  }

  if (actionTools.length) {
    const front = entry.front_man;
    addNode({ id: "actions", label: `Site actions (${actionTools.length})`, kind: "action", detail: actionTools.map((t) => `website_${t}`).join(", ") });
    if (front) edges.push({ from: `agent:${front}`, to: "actions", kind: "site actions" });
  }
  return { graph: { nodes, edges }, agents: agentInfo };
}

function toolId(ref, kind) {
  const s = typeof ref === "string" ? ref : JSON.stringify(ref);
  return `${kind}:${s}`;
}

// --- trust -----------------------------------------------------------------

function buildTrust({ manifest, policy, agents, analysis, files, base }) {
  const allowed = (manifest.allowed_peers || []).map(normOrigin).filter(Boolean);
  const mode = policy?.mode || "closed";
  const denied = (policy?.deny_origins || policy?.denied_origins || []).map(normOrigin);
  const external = new Map();
  for (const n of analysis.graph.nodes) {
    if ((n.kind === "remote" || n.kind === "mcp") && n.origin) {
      const e = external.get(n.origin) || { origin: n.origin, kinds: new Set(), refs: [] };
      e.kinds.add(n.kind === "mcp" ? "MCP server" : "agent site");
      e.refs.push(n.detail);
      external.set(n.origin, e);
    }
  }
  const externalOrigins = [...external.values()].map((e) => ({
    origin: e.origin,
    kinds: [...e.kinds],
    allowed: mode === "open" ? !denied.includes(e.origin) : allowed.includes(e.origin),
  }));
  const unlistedOrigins = externalOrigins.filter((e) => !e.allowed).map((e) => e.origin);

  const insecureRefs = externalOrigins
    .map((e) => e.origin)
    .filter((o) => /^http:\/\//i.test(o) || /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(o));
  // The site's own scheme is reported by the "Served over HTTPS" check.

  const injectionFlags = [];
  for (const a of agents) {
    for (const s of collectStrings(a)) {
      for (const [re, why] of INJECTION_PATTERNS) {
        const m = s.match(re);
        if (m) injectionFlags.push({ agent: a.name, why, excerpt: excerpt(s, m.index, m[0].length) });
      }
    }
  }

  const secretFlags = [];
  for (const f of files) {
    if (!f.ok || !f.text) continue;
    for (const [re, kind] of SECRET_PATTERNS) {
      if (re.test(f.text)) secretFlags.push({ file: f.label, kind });
    }
  }

  const actionTools = Array.isArray(manifest.actions?.agentTools) ? manifest.actions.agentTools : [];
  const corsBlocked = files.filter((f) => f.ok && f.cors === "missing" && f.required).map((f) => f.label);

  return {
    peerPolicy: mode,
    policyNote: policy?.note || null,
    allowedPeers: allowed,
    deniedOrigins: denied,
    externalOrigins,
    unlistedOrigins: dedupe(unlistedOrigins),
    insecureRefs: dedupe(insecureRefs),
    websiteActions: actionTools,
    actionModule: manifest.actions?.module || null,
    actionBridge: manifest.actions?.bridge || null,
    codedTools: agents.some((a) => a.class || a.toolbox) || !!manifest.coded_tools,
    router: manifest.llm_router?.base_url || null,
    byok: !!(manifest.llm_router?.byok_router || manifest.deployment?.direct_byok),
    mcpFacade: manifest.agent_mcp?.available === true ? (manifest.agent_mcp.url || true) : false,
    injectionFlags: dedupeBy(injectionFlags, (f) => `${f.agent}|${f.why}`),
    secretFlags: dedupeBy(secretFlags, (f) => `${f.file}|${f.kind}`),
    corsBlocked,
  };
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

// --- summary ---------------------------------------------------------------

export function summarize(report) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  const linking = report.checks.filter((c) => c.group === "Linking" && c.status !== "info");
  const conformance = report.checks.filter((c) => c.group !== "Linking");
  for (const c of conformance) counts[c.status] = (counts[c.status] || 0) + 1;
  const linkable = !report.manifest ? null : linking.length === 0 ? (report.checks.some((c) => c.group === "Linking") ? true : null)
    : linking.every((c) => c.status === "pass");
  const mustFails = report.checks.filter((c) => c.status === "fail" && c.level === "MUST").length;
  let verdict;
  if (!report.manifest) verdict = "unreachable";
  else if (mustFails === 0 && counts.warn === 0) verdict = "conformant";
  else if (mustFails === 0) verdict = "conformant-with-warnings";
  else verdict = "not-conformant";
  const scored = counts.pass + counts.warn + counts.fail;
  const score = scored ? Math.round(((counts.pass + counts.warn * 0.5) / scored) * 100) : 0;
  const t = report.trust;
  let trustLevel = "unknown";
  if (t) {
    if (t.secretFlags.length || t.unlistedOrigins.length) trustLevel = "risky";
    else if (t.injectionFlags.length || t.peerPolicy === "open" || t.codedTools || t.insecureRefs.length) trustLevel = "review";
    else trustLevel = "clean";
  }
  return { verdict, score, counts, mustFails, trustLevel, linkable };
}

// --- fetching --------------------------------------------------------------

async function fetchFile(ctx, url, label) {
  const record = { label, url, status: 0, ok: false, cors: "unknown", bytes: 0, contentType: null, error: null, required: label !== "discovery" && label !== "links.json" };
  ctx.files.push(record);
  try {
    await ctx.guard(url);
  } catch (err) {
    record.error = err.message;
    return record;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Follow redirects by hand so the guard checks every hop: a public URL must not be
    // able to bounce Atlas to a private address.
    let current = url;
    let resp;
    for (let hop = 0; ; hop++) {
      resp = await ctx.fetchImpl(current, {
        headers: { Accept: "application/json, text/plain, */*", Origin: ctx.origin, "User-Agent": "AgentAtlas/1.0 (+https://github.com/agent-atlas)" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      current = new URL(location, current).href;
      await ctx.guard(current);
    }
    if (current !== url) record.finalUrl = current;
    record.status = resp.status;
    record.contentType = resp.headers.get("content-type");
    const acao = resp.headers.get("access-control-allow-origin");
    record.cors = acao === "*" ? "open" : acao && acao === ctx.origin ? "origin" : acao ? "other" : "missing";
    if (!resp.ok) {
      record.error = `HTTP ${resp.status}`;
      return record;
    }
    const text = await readLimited(resp, MAX_BYTES);
    record.bytes = text.length;
    record.text = text;
    record.ok = true;
    return record;
  } catch (err) {
    record.error = err.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000}s` : (err.message || String(err));
    return record;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(resp, limit) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const t = await resp.text();
    if (t.length > limit) throw new Error(`file is larger than ${limit / 1024 / 1024} MB`);
    return t;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`file is larger than ${limit / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

// --- check builders --------------------------------------------------------

function mk(status, id, group, level, title, detail) { return { id, group, level, status, title, detail }; }
const pass = (id, g, l, t, d) => mk("pass", id, g, l, t, d);
const warn = (id, g, l, t, d) => mk("warn", id, g, l, t, d);
const fail = (id, g, l, t, d) => mk("fail", id, g, l, t, d);
const info = (id, g, t, d) => mk("info", id, g, "INFO", t, d);

// CORS is reported separately from conformance: spec 3.4 says a same-origin deployment
// conforms, but no other site can load the files without it (3.3 "CORS enabled for
// callers"). So a missing header makes a site "not callable", not "not conformant".
function corsCheck(id, label, file) {
  const title = `Other sites can load the ${label} (CORS)`;
  if (file.cors === "open" || file.cors === "origin") {
    return pass(id, "Linking", "FOR CALLERS", title, `Access-Control-Allow-Origin: ${file.cors === "open" ? "*" : "matches caller"}`);
  }
  if (isLoopback(file.url)) {
    return info(id, "Linking", title, "Local address; CORS is only checked for public hosts.");
  }
  return fail(id, "Linking", "FOR CALLERS", title,
    file.cors === "other"
      ? "Access-Control-Allow-Origin names a different origin. The site works for its own visitors, but other agentic sites cannot load this file (spec 3.3, 3.4)."
      : "No Access-Control-Allow-Origin header. The site works for its own visitors, but browsers on other agentic sites cannot load this file, so they cannot call its network (spec 3.3, 3.4).");
}

function httpsCheck(base) {
  if (/^https:/i.test(base)) return pass("https", "Publication", "MUST", "Served over HTTPS", originOf(base));
  if (isLoopback(base)) return info("https", "Publication", "Served over HTTPS", "Loopback HTTP, allowed for local development.");
  return fail("https", "Publication", "MUST", "Served over HTTPS", "Production deployments must use HTTPS (spec 3.3).");
}

// --- helpers ---------------------------------------------------------------

function summarizeManifest(m) {
  return {
    brand: m.brand || null,
    networks: (Array.isArray(m.networks) ? m.networks : []).filter(Boolean).map((n) => ({
      name: n.name, front_man: n.front_man, hocon: n.hocon, description: n.description || null,
      tags: n.tags || [], sample_queries: n.sample_queries || [],
    })),
    llm_router: m.llm_router || null,
    peer_policy: m.peer_policy || m.web_policy || null,
    allowed_peers: m.allowed_peers || [],
    deployment: m.deployment || null,
    agent_mcp: m.agent_mcp || null,
    actions: m.actions ? { module: m.actions.module, bridge: m.actions.bridge, agentTools: m.actions.agentTools || [] } : null,
    theme: m.theme || null,
  };
}

function safeValidate(config) {
  try { return validate_network(config); } catch (err) { return [`Validator crashed: ${err.message}`]; }
}
function safeFrontMan(config) {
  try { return find_front_man(config); } catch { return null; }
}
function safeClassify(config, ref) {
  try { return classify_tool(config, ref); } catch { return typeof ref === "string" ? "missing" : "mcp"; }
}
function isSchema(p) { return !!p && typeof p === "object" && (p.type === "object" || typeof p.properties === "object"); }

export function resolveUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const b = base.endsWith("/") ? base : `${base}/`;
  return new URL(String(path).replace(/^\.\//, ""), b).href;
}
function resolveRef(base, ref) {
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith("/")) return new URL(ref, base).href;
  return resolveUrl(base, ref);
}
function joinUrl(base, name) { return `${base.replace(/\/+$/, "")}/${encodeURIComponent(name)}`; }
function dirOf(url) { const u = new URL(url.href); u.pathname = u.pathname.replace(/\/[^/]*$/, ""); return u.href.replace(/\/+$/, ""); }
export function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
function normOrigin(u) { try { return new URL(u).origin; } catch { return String(u || "").replace(/\/+$/, ""); } }
function sameUrl(a, b) { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } }
function shortUrl(u) { try { const x = new URL(u); return `${x.host}${x.pathname === "/" ? "" : x.pathname}`; } catch { return String(u); } }
function isLoopback(u) { try { const h = new URL(u).hostname; return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost"); } catch { return false; } }
function truncate(s, n) { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function excerpt(s, idx, len) { return truncate(s.slice(Math.max(0, idx - 20), idx + len + 20), 90); }
function dedupe(a) { return [...new Set(a)]; }
function dedupeBy(a, key) { const m = new Map(); for (const x of a) if (!m.has(key(x))) m.set(key(x), x); return [...m.values()]; }

/**
 * A compact, model-friendly summary of a report, used by the MCP tools.
 *
 * :param report: A checkSite report.
 * :return: Plain text under ~2,500 characters.
 */
export function reportToText(report) {
  const s = report.summary || {};
  const lines = [];
  lines.push(`Site: ${report.target?.base || report.input}`);
  if (report.network) lines.push(`Network URL: ${report.target.networkUrl} (front agent ${report.network.frontMan})`);
  lines.push(`Verdict: ${s.verdict} · score ${s.score}/100 · ${s.counts?.pass || 0} pass, ${s.counts?.warn || 0} warn, ${s.counts?.fail || 0} fail · trust: ${s.trustLevel}`);
  if (s.linkable !== null && s.linkable !== undefined) lines.push(`Callable from other sites: ${s.linkable ? "yes" : "no (its files send no CORS header, so other sites' browsers cannot load its network)"}`);
  if (report.network?.description) lines.push(`Description: ${truncate(report.network.description, 200)}`);
  if (report.network) {
    lines.push(`Agents: ${report.network.agents.map((a) => a.name + (a.front ? " (front)" : "")).join(", ")}`);
  }
  const t = report.trust;
  if (t) {
    lines.push(`Peer policy: ${t.peerPolicy}; allowed peers: ${t.allowedPeers.join(", ") || "none"}`);
    if (t.externalOrigins.length) lines.push(`Contacts: ${t.externalOrigins.map((e) => `${e.origin} (${e.kinds.join("/")}${e.allowed ? "" : ", NOT allowed"})`).join("; ")}`);
    if (t.websiteActions.length) lines.push(`Site actions: ${t.websiteActions.join(", ")}`);
    if (t.injectionFlags.length) lines.push(`Instruction warnings: ${t.injectionFlags.map((f) => `${f.agent}: ${f.why}`).join("; ")}`);
    if (t.secretFlags.length) lines.push(`Credential leaks: ${t.secretFlags.map((f) => `${f.kind} in ${f.file}`).join("; ")}`);
  }
  const problems = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
  if (problems.length) {
    lines.push("Issues:");
    for (const c of problems.slice(0, 10)) lines.push(`- [${c.status.toUpperCase()} ${c.level}] ${c.title}: ${truncate(c.detail || "", 180)}`);
  } else {
    lines.push("Issues: none.");
  }
  if (report.network?.sampleQueries?.length) lines.push(`Sample queries: ${report.network.sampleQueries.slice(0, 3).map((q) => `"${truncate(q, 80)}"`).join("; ")}`);
  return lines.join("\n");
}
