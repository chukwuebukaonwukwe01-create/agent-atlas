// Build Atlas's published agent files for one origin.
//   node scripts/build.mjs https://agent-atlas.vercel.app
// Writes public/agent_atlas.hocon and public/agent-manifest.json from network/, then runs
// the agentify build, which writes agent_atlas.network.json, agent-mcp.json, links.json
// checks, .well-known/ discovery files and bridge/.
import { readFile, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = (process.argv[2] || process.env.ATLAS_ORIGIN || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  console.error("Usage: node scripts/build.mjs <origin>, e.g. https://agent-atlas.vercel.app");
  process.exit(1);
}
const fill = (s) => s.replaceAll("__ATLAS_ORIGIN__", origin);
const hocon = fill(await readFile(path.join(root, "network/agent_atlas.hocon.tpl"), "utf8"));
const manifest = JSON.parse(fill(await readFile(path.join(root, "network/agent-manifest.tpl.json"), "utf8")));
const samples = [...hocon.matchAll(/"sample_queries":\s*\[([\s\S]*?)\]/g)][0];
manifest.networks[0].sample_queries = JSON.parse(`[${samples[1]}]`);
await writeFile(path.join(root, "public/agent_atlas.hocon"), hocon);
await writeFile(path.join(root, "public/agent-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
try { await access(path.join(root, "public/links.json")); } catch {
  await writeFile(path.join(root, "public/links.json"), `${JSON.stringify({ version: 1, networks: { agent_atlas: {} } }, null, 2)}\n`);
}
const args = [path.join(root, "tools/agentify/scripts/build_network.mjs"), path.join(root, "public/agent_atlas.hocon"),
  "--manifest", path.join(root, "public/agent-manifest.json"), ...process.argv.slice(3)];
execFileSync(process.execPath, args, { stdio: "inherit" });
console.log(`Built for ${origin}`);
