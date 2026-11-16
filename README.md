# Agent Atlas

**Find agentic websites. Check them before you link.**

Agent Atlas is a directory and trust checker for the [open agentic web](https://worldwideagenticweb.org). Paste any agentic website's URL and Atlas:

- **tests it against the [Worldwide Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md)** (Profile 0.2): manifest content, CORS on the public files, HTTPS, exact network-name resolution, data-only definitions, and the reference runtime's own validator;
- **charts its agent network**: the front agent, internal agents, partner sites, MCP servers and site actions;
- **reports trust signals** a caller needs before linking: peer policy, every origin the agents contact (and whether `allowed_peers` permits it), leaked credentials, and instructions that try to steer a caller's model (prompt injection, spec section 5).

The **directory** lists every site from the challenge's [community list](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/agentic_websites.md), checked live.

Atlas is itself an open agentic website, usable three ways:

| Use | How |
| --- | --- |
| **Ask Atlas** on the page | A BYOK browser assistant (`agent_atlas` network) that searches the directory, checks sites and opens reports on the page. |
| **Call Atlas's network** from your site | Put `https://<atlas>/agent_atlas` in an agent's `tools` and Atlas's origin in your `allowed_peers`. After your visitor agrees, Atlas's agent runs in their browser on their key and uses Atlas's MCP server. |
| **Use the MCP server** directly | `https://<atlas>/api/mcp` (Streamable HTTP, plain JSON, CORS open). Tools: `search_directory`, `check_site`, `list_sites`. All read-only. |

Plus a JSON API (`/api/check?url=`, `/api/directory?q=`) and an embeddable badge (`/api/badge?url=`).

## How it works

```
Browser (any agentic site)                Atlas origin (static files + 4 serverless functions)
┌──────────────────────────┐   consent   ┌──────────────────────────────────────────────┐
│ caller runtime ──────────┼────────────►│ agent-manifest.json, agent_atlas.network.json │
│   runs Atlas's network   │             │ links.json, .well-known/, bridge/            │
│   on the visitor's key   │  JSON-RPC   │                                              │
│   mcp_search_directory ──┼────────────►│ /api/mcp ─► lib/mcp.mjs ─► lib/directory.mjs │
└──────────────────────────┘             │                         └► lib/checker.mjs   │
                                         │ /api/check, /api/directory, /api/badge       │
                                         └──────────────────────────┬───────────────────┘
                                                                    │ fetch (public hosts only)
                                                   other sites' agent-manifest.json, network, links.json
```

- `lib/checker.mjs` is the checker. It validates networks with the reference runtime's `validate_network`, `classify_tool` and HOCON parser (from `public/runtime/`), so a site that passes here also loads in nsdeploy.
- `lib/net.mjs` refuses private, loopback and link-local addresses (SSRF protection). Set `ALLOW_PRIVATE=1` only for local development.
- The page's assistant uses the challenge's browser runtime unchanged. Its tools are Atlas's MCP server plus three page actions (`get_page_state`, `show_report`, `filter_directory`), none of them irreversible.
- No server-side AI. Visitors bring their own key; Atlas never sees it.

## Run it locally

Node.js 22 or newer.

```bash
npm test                                   # checker, MCP, directory, badge tests
node scripts/build.mjs http://127.0.0.1:8090   # build the network for a local origin
npm run dev                                # http://127.0.0.1:8090
```

To list local test sites in the directory, add `ATLAS_EXTRA_SITES="http://127.0.0.1:8080/my_net|My site|What it does"`.

## Deploy (Vercel)

1. Import the repository in Vercel (framework: Other). `vercel.json` serves `public/` and the functions in `api/`.
2. Rebuild the published network for the production origin and push:
   ```bash
   node scripts/build.mjs https://<your-project>.vercel.app
   ```
   The build writes the origin into `agent_atlas.network.json` (the MCP tool URL) and `agent-manifest.json` (`allowed_peers`, `agent_mcp.url`).
3. Optional: set `ATLAS_ORIGIN` in Vercel to the same origin.

## Limits

- Checks are static: Atlas reads public files and does not run a site's agents or call its MCP servers.
- Prompt-injection and credential detection are pattern-based heuristics. A clean report is not a guarantee.
- The directory and checks are cached in memory for a few minutes per serverless instance.
- Cross-site action transport and coded-tool sandboxing are reported but not exercised.

## License

Apache 2.0. See `NOTICE` for the challenge runtime and agentify tools included under the same license.
