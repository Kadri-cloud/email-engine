// Quick check against a running engine: the shared scenarios for one account.
// Usage: node test/smoke.mjs
//   SMOKE_ACCOUNT=bob@example.com SMOKE_IMAP=127.0.0.1:1993:bob:pass node test/smoke.mjs
// The conformance suite (test/conformance.mjs) runs the same scenarios on a fresh engine per target.
import { buildContext, makeApi, makeSideChannel, runScenarios } from "./scenarios.mjs";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";
const TOKEN = process.env.ENGINE_TOKEN ?? "test";
const ADDRESS = process.env.SMOKE_ACCOUNT ?? "alice@example.com";
const [host = "127.0.0.1", port = "993", user = "alice", pass = "pass"] = (process.env.SMOKE_IMAP ?? "").split(":");

const { api, apiAs } = makeApi(BASE, TOKEN);
const health = await api("/health");
const account = health.accounts.find((a) => a.address === ADDRESS);
if (!account) throw new Error(`account ${ADDRESS} not connected`);
account.provider = (await api("/accounts")).find((a) => a.id === account.id)?.provider ?? "imap";
console.log(`account ${account.address} (${account.id}) status=${account.status}`);

const side = makeSideChannel({ kind: "imap", host, port: Number(port), user, pass });
const ctx = await buildContext({ api, apiAs, account, side });
const results = await runScenarios(ctx, (r) => console.log(`${r.status.padEnd(4)}  ${r.name}  ${r.note ? `(${r.note})` : ""}`));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.filter((r) => r.status === "PASS").length}/${results.filter((r) => r.status !== "n/a").length} passed, ${results.filter((r) => r.status === "n/a").length} n/a`);
process.exit(failed ? 1 : 0);
