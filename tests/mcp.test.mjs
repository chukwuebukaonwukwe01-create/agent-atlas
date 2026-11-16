import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcp, TOOLS } from "../lib/mcp.mjs";
import { parseCommunityList, searchDirectory } from "../lib/directory.mjs";
import { isPrivate } from "../lib/net.mjs";
import { badgeSvg } from "../lib/badge.mjs";

test("MCP initialize, tools/list, notifications and errors", async () => {
  const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "agent-atlas");
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  const bad = await handleMcp({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(bad.error.code, -32601);
  const unknownTool = await handleMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x", arguments: {} } });
  assert.equal(unknownTool.result.isError, true);
  const missingArg = await handleMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "check_site", arguments: {} } });
  assert.equal(missingArg.result.isError, true);
  const batch = await handleMcp([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(batch.length, 1);
});

test("parses the community list table", () => {
  const md = `| URL | Name | Description | DevPost Team | Agent URL |
|---|---|---|---|---|
|https://worldwideagenticweb.org/|The Open Agentic Web Challenge| Answers questions.| - | [Link](https://worldwideagenticweb.org/a/v1/widget.network.json) |
|https://pizza.example/|Pizza| Orders pizza | Team P | [Link](https://pizza.example/pizza_net) |`;
  const rows = parseCommunityList(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agentUrl, "https://worldwideagenticweb.org/a/v1/widget.network.json");
  assert.equal(rows[0].team, null);
  assert.equal(rows[1].team, "Team P");
});

test("search ranks by name and description", () => {
  const entries = [
    { name: "Harbor Tours", description: "Boat trips", url: "https://a", check: { verdict: "conformant" } },
    { name: "Pizza", description: "Order pizza for delivery", url: "https://b", check: {} },
  ];
  const hits = searchDirectory(entries, "pizza delivery");
  assert.equal(hits[0].entry.name, "Pizza");
  assert.equal(searchDirectory(entries, "boats")[0].entry.name, "Harbor Tours");
});

test("private address detection", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(isPrivate(ip), ip);
  for (const ip of ["8.8.8.8", "104.18.1.1", "2606:4700::1111"]) assert.ok(!isPrivate(ip), ip);
});

test("badge is valid SVG text", () => {
  assert.match(badgeSvg("agent atlas", "conformant", "#15803d"), /^<svg[\s\S]+conformant[\s\S]+<\/svg>$/);
});
