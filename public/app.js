// Agent Atlas page script. App.page is the page object: the page's own buttons and the
// assistant's website_* tools (site-actions.js) call the same methods.
import { renderGraph } from "./graph.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const VERDICT = {
  conformant: { word: "Conformant", note: "Meets every check Atlas runs for MVP Profile 0.2.", tone: "pass" },
  "conformant-with-warnings": { word: "Conformant, with warnings", note: "No required check fails. Some recommendations are not met.", tone: "warn" },
  "not-conformant": { word: "Not conformant", note: "At least one required (MUST) check fails. Other sites may be unable to load or trust it.", tone: "fail" },
  unreachable: { word: "No agent site found", note: "Atlas could not find a usable agent-manifest.json at this address.", tone: "fail" },
};
const TRUST = {
  clean: "No trust warnings",
  review: "Worth a look",
  risky: "Risky to link",
  unknown: "Not assessed",
};
const STATUS_MARK = { pass: "✓", warn: "!", fail: "✕", info: "i" };

export class AtlasPage {
  constructor() {
    this.report = null;
    this.directory = null;
    this.filter = "";
    this.checking = false;
  }

  /** Read the page's current state for the assistant. */
  getState() {
    const r = this.report;
    return {
      lastCheckedUrl: r ? r.input : null,
      currentReport: r ? AtlasPage.reportDigest(r) : null,
      directory: {
        loaded: !!this.directory,
        total: this.directory?.entries.length || 0,
        filter: this.filter,
        shown: this.visibleEntries().map((e) => ({ name: e.name, networkUrl: e.check?.networkUrl || e.agentUrl, verdict: e.check?.verdict, trust: e.check?.trustLevel })),
      },
    };
  }

  /**
   * Check a site and show the report on this page.
   *
   * :param url: Site, network or manifest URL.
   * :return: A digest of the report, or {ok: false, reason}.
   */
  async checkSite(url) {
    const value = String(url || "").trim();
    if (!value) return { ok: false, reason: "Enter a site or network URL to check." };
    if (value.length > 500) return { ok: false, reason: "That URL is too long." };
    $("#check-url").value = value;
    this.setChecking(true, value);
    try {
      const resp = await fetch(`./api/check?url=${encodeURIComponent(value)}`);
      if (!resp.ok) throw new Error(`Atlas returned HTTP ${resp.status}`);
      const report = await resp.json();
      this.report = report;
      this.renderReport(report);
      history.replaceState(null, "", `?check=${encodeURIComponent(value)}#report`);
      return { ok: true, ...AtlasPage.reportDigest(report) };
    } catch (err) {
      $("#report").hidden = false;
      $("#report-body").innerHTML = `<p class="report-error">Atlas could not run this check: ${esc(err.message)}. Try again in a moment.</p>`;
      return { ok: false, reason: `The check could not run: ${err.message}` };
    } finally {
      this.setChecking(false);
    }
  }

  /**
   * Filter the directory list on this page.
   *
   * :param query: Words to match, or "" to show everything.
   */
  async filterDirectory(query) {
    this.filter = String(query || "").trim();
    $("#dir-search").value = this.filter;
    if (!this.directory) await this.loadDirectory();
    this.renderDirectory();
    const shown = this.visibleEntries();
    return { ok: true, filter: this.filter, count: shown.length, shown: shown.map((e) => e.name) };
  }

  async loadDirectory() {
    const list = $("#dir-list");
    try {
      const resp = await fetch("./api/directory");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.directory = await resp.json();
    } catch (err) {
      list.innerHTML = `<li class="dir-empty">The directory could not load (${esc(err.message)}). Reload the page to try again.</li>`;
      return;
    }
    this.renderDirectory();
  }

  visibleEntries() {
    const entries = this.directory?.entries || [];
    if (!this.filter) return entries;
    const terms = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      const hay = [e.name, e.description, e.url, e.team, e.check?.networkDescription, e.check?.networkName,
        ...(e.check?.sampleQueries || []), ...(e.check?.agents || []).map((a) => a.description)].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  // --- rendering -----------------------------------------------------------

  setChecking(on, url) {
    this.checking = on;
    const btn = $("#check-btn");
    btn.disabled = on;
    btn.textContent = on ? "Checking…" : "Check site";
    if (on) {
      $("#report").hidden = false;
      $("#report-body").innerHTML = `<p class="report-loading" role="status">Fetching the manifest, network and links for ${esc(url)}…</p>`;
    }
  }

  renderReport(r) {
    const v = VERDICT[r.summary.verdict] || VERDICT.unreachable;
    const c = r.summary.counts;
    const base = r.target?.base || r.input;
    const graph = renderGraph(r.graph);
    const groups = groupBy(r.checks, (x) => x.group);
    const badgeUrl = new URL(`./api/badge?url=${encodeURIComponent(r.target?.networkUrl || r.input)}`, location.href).href;
    const reportUrl = new URL(`./?check=${encodeURIComponent(r.input)}`, location.href).href;

    $("#report").hidden = false;
    $("#report-body").innerHTML = `
      <header class="verdict verdict-${v.tone}">
        <div class="verdict-main">
          <p class="verdict-site">${esc(r.manifest?.brand || hostOf(base))}</p>
          <h2 class="verdict-word" tabindex="-1">${esc(v.word)}</h2>
          <p class="verdict-note">${esc(v.note)}</p>
        </div>
        <dl class="verdict-facts">
          <div><dt>Score</dt><dd>${r.summary.score}<span>/100</span></dd></div>
          <div><dt>Checks</dt><dd class="counts"><span class="c-pass">${c.pass || 0} passed</span><span class="c-warn">${plural(c.warn || 0, "warning")}</span><span class="c-fail">${c.fail || 0} failed</span></dd></div>
          <div><dt>Trust</dt><dd class="trust trust-${r.summary.trustLevel}">${esc(TRUST[r.summary.trustLevel])}</dd></div>
          ${r.summary.linkable === null || r.summary.linkable === undefined ? "" : `<div><dt>Callable</dt><dd class="${r.summary.linkable ? "trust-clean" : "trust-risky"}">${r.summary.linkable ? "Other sites can call it" : "Other sites can't load it"}</dd></div>`}
        </dl>
      </header>
      ${r.target?.networkUrl ? `<p class="network-url">Network URL <code>${esc(r.target.networkUrl)}</code> <button type="button" class="copy" data-copy="${esc(r.target.networkUrl)}">Copy</button></p>` : ""}
      ${r.network?.description ? `<p class="network-desc">${esc(r.network.description)}</p>` : ""}
      <div class="report-grid">
        <section class="report-checks" aria-labelledby="h-checks">
          <h3 id="h-checks">Spec checks</h3>
          ${[...groups].map(([g, list]) => `
            <h4>${esc(g)}</h4>
            <ul class="checks">${list.map((x) => `
              <li class="check check-${x.status}">
                <span class="mark" aria-label="${x.status}">${STATUS_MARK[x.status]}</span>
                <div><p class="check-title">${esc(x.title)} ${x.level !== "INFO" ? `<span class="level">${x.level}</span>` : ""}</p>
                ${x.detail ? `<p class="check-detail">${esc(x.detail)}</p>` : ""}</div>
              </li>`).join("")}
            </ul>`).join("")}
        </section>
        <div class="report-side">
          ${graph.svg ? `<section class="report-chart" aria-labelledby="h-chart">
            <h3 id="h-chart">Chart of the network</h3>
            <div class="chart-wrap">${graph.svg}</div>
            <ul class="legend">
              <li><span class="lg lg-front"></span>Front agent</li><li><span class="lg lg-agent"></span>Agent</li>
              <li><span class="lg lg-remote"></span>Partner site</li><li><span class="lg lg-mcp"></span>MCP server</li>
              <li><span class="lg lg-action"></span>Site actions</li><li><span class="lg lg-missing"></span>Missing</li>
            </ul>
          </section>` : ""}
          ${r.trust ? this.trustHtml(r.trust) : ""}
          ${r.network ? `<section aria-labelledby="h-agents"><h3 id="h-agents">Agents</h3><ul class="agents">${r.network.agents.map((a) => `
            <li><p class="agent-name">${esc(a.name)}${a.front ? ' <span class="tag">front</span>' : ""}</p><p>${esc(a.description)}</p></li>`).join("")}</ul>
            ${r.network.sampleQueries?.length ? `<h4>It says it can answer</h4><ul class="samples">${r.network.sampleQueries.slice(0, 5).map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
          </section>` : ""}
          <section aria-labelledby="h-files"><h3 id="h-files">Files Atlas fetched</h3><ul class="files">${r.files.map((f) => `
            <li class="${f.ok ? "f-ok" : "f-missing"}"><a href="${esc(f.finalUrl || f.url)}" rel="noopener nofollow" target="_blank">${esc(f.label)}</a>
            <span>${f.ok ? `${fmtBytes(f.bytes)} · CORS ${esc(corsWord(f.cors))}` : esc(f.error || `HTTP ${f.status}`)}</span></li>`).join("")}</ul></section>
          <section aria-labelledby="h-share"><h3 id="h-share">Share this check</h3>
            <p><img src="${esc(badgeUrl)}" alt="Agent Atlas badge" height="20"></p>
            <label class="snippet-label" for="badge-md">Badge for a README</label>
            <input id="badge-md" class="snippet" readonly value="${esc(`[![Agent Atlas](${badgeUrl})](${reportUrl})`)}">
          </section>
        </div>
      </div>
      <p class="checked-at">Checked ${esc(new Date(r.checkedAt).toLocaleString())} with checker ${esc(r.checker.version)} against ${esc(r.checker.profile)}.</p>`;
    $("#report .verdict-word")?.focus({ preventScroll: true });
    $("#report").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  trustHtml(t) {
    const rows = [];
    rows.push(["Peer policy", t.peerPolicy === "open" ? "Open: may contact any origin after the visitor agrees" : "Closed: contacts only the origins it lists"]);
    rows.push(["Allowed origins", t.allowedPeers.length ? t.allowedPeers.join(", ") : "None"]);
    rows.push(["LLM router", t.router || "Not declared"]);
    rows.push(["Bring your own key", t.byok ? "Offered" : "Not offered"]);
    rows.push(["Site actions", t.websiteActions.length ? t.websiteActions.map((a) => `website_${a}`).join(", ") : "None"]);
    if (t.codedTools) rows.push(["Coded tools", "Yes: runs publisher code in a sandbox"]);
    return `<section class="report-trust" aria-labelledby="h-trust"><h3 id="h-trust">Before you link to it</h3>
      <dl class="facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${t.externalOrigins.length ? `<h4>Origins its agents contact</h4><ul class="origins">${t.externalOrigins.map((o) => `
        <li class="${o.allowed ? "o-ok" : "o-bad"}"><code>${esc(o.origin)}</code> ${esc(o.kinds.join(", "))}${o.allowed ? "" : " · not in allowed_peers, so calls are refused"}</li>`).join("")}</ul>` : "<p>Its agents contact no other origins.</p>"}
      ${t.injectionFlags.length ? `<h4>Instructions to read yourself</h4><ul class="flags">${t.injectionFlags.map((f) => `<li><strong>${esc(f.agent)}</strong> ${esc(f.why)}: “${esc(f.excerpt)}”</li>`).join("")}</ul>` : ""}
      ${t.secretFlags.length ? `<h4>Credentials published</h4><ul class="flags">${t.secretFlags.map((f) => `<li>${esc(f.kind)} in ${esc(f.file)}</li>`).join("")}</ul>` : ""}
    </section>`;
  }

  renderDirectory() {
    const list = $("#dir-list");
    const entries = this.visibleEntries();
    const meta = $("#dir-meta");
    if (this.directory) {
      const src = this.directory.sources?.community;
      meta.textContent = `${this.directory.entries.length} sites, ${src?.ok ? `${src.count} from the community list` : "community list unavailable right now"}. Checked at ${new Date(this.directory.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    }
    if (!entries.length) {
      list.innerHTML = `<li class="dir-empty">${this.filter ? `No site matches “${esc(this.filter)}”. Try fewer words, or <button type="button" class="link" data-clear>show every site</button>.` : "No sites yet. Publish one and add it to the community list."}</li>`;
      return;
    }
    list.innerHTML = entries.map((e) => {
      const c = e.check || {};
      const v = VERDICT[c.verdict] || VERDICT.unreachable;
      return `<li class="dir-row">
        <div class="dir-name"><p class="site-name">${esc(e.name)}</p><a href="${esc(e.url)}" rel="noopener nofollow" target="_blank">${esc(hostOf(e.url))}</a>${e.team ? `<span class="team">by ${esc(e.team)}</span>` : ""}</div>
        <p class="dir-desc">${esc(c.networkDescription || e.description || "")}</p>
        <p class="dir-verdict v-${v.tone}"><span class="mark" aria-hidden="true">${v.tone === "pass" ? "✓" : v.tone === "warn" ? "!" : "✕"}</span>${esc(v.word)}${c.score ? ` <span class="score">${c.score}</span>` : ""}<span class="dir-trust trust-${c.trustLevel || "unknown"}">${esc(TRUST[c.trustLevel || "unknown"])}${c.linkable === false ? " · other sites can't call it" : ""}</span></p>
        <button type="button" class="dir-check" data-check="${esc(e.agentUrl || e.url)}">Open report</button>
      </li>`;
    }).join("");
  }

  static reportDigest(r) {
    return {
      site: r.target?.base || r.input,
      networkUrl: r.target?.networkUrl || null,
      brand: r.manifest?.brand || null,
      verdict: r.summary.verdict,
      callableFromOtherSites: r.summary.linkable,
      score: r.summary.score,
      trustLevel: r.summary.trustLevel,
      counts: r.summary.counts,
      description: r.network?.description || null,
      agents: (r.network?.agents || []).map((a) => a.name),
      contacts: (r.trust?.externalOrigins || []).map((o) => `${o.origin}${o.allowed ? "" : " (not allowed)"}`),
      failed: r.checks.filter((x) => x.status === "fail").map((x) => `${x.title}: ${x.detail}`),
      warnings: r.checks.filter((x) => x.status === "warn").map((x) => `${x.title}: ${x.detail}`),
    };
  }
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
function plural(n, w) { return `${n} ${w}${n === 1 ? "" : "s"}`; }
function hostOf(u) { try { return new URL(u).host; } catch { return String(u); } }
function fmtBytes(n) { return n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }
function corsWord(c) { return c === "open" || c === "origin" ? "open" : c === "missing" ? "missing" : c; }

export const App = { page: new AtlasPage() };

// Wire the page's own controls. The assistant uses the same App.page methods.
if (typeof document !== "undefined") {
  const page = App.page;
  $("#check-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void page.checkSite($("#check-url").value);
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target.closest("[data-check],[data-copy],[data-clear],[data-example]");
    if (!target) return;
    if (target.dataset.check) void page.checkSite(target.dataset.check);
    if (target.dataset.example) void page.checkSite(target.dataset.example);
    if (target.dataset.clear !== undefined) void page.filterDirectory("");
    if (target.dataset.copy) {
      navigator.clipboard?.writeText(target.dataset.copy).then(() => { target.textContent = "Copied"; setTimeout(() => { target.textContent = "Copy"; }, 1500); });
    }
  });
  document.addEventListener("focusin", (ev) => { if (ev.target.classList?.contains("snippet")) ev.target.select(); });
  let t;
  $("#dir-search").addEventListener("input", (ev) => {
    clearTimeout(t);
    t = setTimeout(() => void page.filterDirectory(ev.target.value), 150);
  });
  const examples = document.querySelectorAll("[data-example-self]");
  for (const el of examples) el.dataset.example = new URL(`./${el.dataset.exampleSelf}`, location.href).href;
  void page.loadDirectory();
  const initial = new URLSearchParams(location.search).get("check");
  if (initial) void page.checkSite(initial);
}
