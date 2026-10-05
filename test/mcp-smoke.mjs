// Drive the MCP server as a client would: list tools, search, flag a message, read the log.
// Usage: node test/mcp-smoke.mjs   (engine on :8080 with ENGINE_TOKEN=test)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";
const ADMIN = process.env.ENGINE_TOKEN ?? "test";
const admin = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });
  return r.json();
};

// A propose-only triage token: the agent can look, and every write becomes a proposal.
const health = await admin("/health");
const account = health.accounts[0];
const token = await admin("/tokens", {
  method: "POST",
  body: JSON.stringify({ name: "mcp-agent", accounts: [account.id], actions: ["search", "get_message", "get_thread", "set_flags", "move", "propose", "get_action"], mode: "propose_only", redact: ["otp", "card"] }),
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp.js"],
  env: { ...process.env, ENGINE_URL: BASE, ENGINE_MCP_TOKEN: token.secret },
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const results = [];
const step = async (name, fn) => {
  try {
    results.push([name, "PASS", (await fn()) ?? ""]);
  } catch (e) {
    results.push([name, "FAIL", e.message]);
  }
};
const text = (r) => JSON.parse(r.content[0].text);

await step("tools are listed", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["search_mail", "get_message", "move_message", "set_flags", "list_events", "undo_action"]) assert.ok(names.includes(n), `missing ${n}`);
  return `${tools.length} tools`;
});

let msg;
await step("search_mail returns indexed messages with trust and as_of", async () => {
  const r = text(await client.callTool({ name: "search_mail", arguments: { query: "pineapple" } }));
  assert.ok(r.length > 0, "no results");
  msg = r[0];
  assert.ok(msg.trust && msg.as_of, "trust/as_of missing");
  return `${r.length} result(s), trust=${msg.trust}`;
});

await step("get_message returns body, redacted per token", async () => {
  const otp = text(await client.callTool({ name: "search_mail", arguments: { query: "verification" } }));
  assert.ok(otp.length, "no otp message indexed");
  const m = text(await client.callTool({ name: "get_message", arguments: { message_id: otp[0].id } }));
  assert.ok(m.body.text.includes("[OTP]") && !m.body.text.includes("482913"), "redaction missing");
  return "code masked";
});

let proposal;
await step("set_flags via a propose_only token comes back as a proposal", async () => {
  const a = text(await client.callTool({ name: "set_flags", arguments: { message_id: msg.id, flagged: true } }));
  assert.equal(a.status, "proposed", JSON.stringify(a));
  assert.equal(a.requested_by, "mcp-agent");
  proposal = a;
  return a.id;
});

await step("approve_action is refused for this token; admin approves; agent sees executed", async () => {
  const denied = await client.callTool({ name: "approve_action", arguments: { action_id: proposal.id } });
  assert.ok(denied.isError, "approve should fail for the agent");
  const ok = await admin(`/actions/${proposal.id}/approve`, { method: "POST" });
  assert.equal(ok.status, "executed");
  const seen = text(await client.callTool({ name: "get_action", arguments: { action_id: proposal.id } }));
  assert.equal(seen.status, "executed");
  const flagged = text(await client.callTool({ name: "get_message", arguments: { message_id: msg.id, include_body: false } }));
  assert.equal(flagged.flags.flagged, true);
  await admin(`/actions/${proposal.id}/undo`, { method: "POST" });
  return "403 for agent, executed by admin, visible to agent";
});

await step("list_events pages the log by cursor", async () => {
  const page = text(await client.callTool({ name: "list_events", arguments: { after: 0, limit: 5 } }));
  assert.ok(page.events.length <= 5 && page.next >= page.events.at(-1)?.cursor, "paging broken");
  const next = text(await client.callTool({ name: "list_events", arguments: { after: page.next, limit: 5 } }));
  assert.ok(next.events.every((e) => e.cursor > page.next), "cursor not respected");
  return `next=${page.next}`;
});

await step("events resource reads the same log", async () => {
  const r = await client.readResource({ uri: "email-engine://events/0" });
  const page = JSON.parse(r.contents[0].text);
  assert.ok(Array.isArray(page.events));
  return `${page.events.length} events`;
});

await client.close();
await admin(`/tokens/${token.id}`, { method: "DELETE" });

let failed = 0;
for (const [name, status, info] of results) {
  if (status === "FAIL") failed++;
  console.log(`${status}  ${name}${info ? `  (${info})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
