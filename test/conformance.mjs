// Conformance suite: a fresh engine per target, the shared scenarios, an
// offline catch-up test, and a report of what each server does.
// Usage: node test/conformance.mjs [targetName ...]   (default: all in test/targets.json)
// Writes conformance/report.json and conformance/REPORT.md.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildContext, makeApi, makeSideChannel, rfc822, runScenarios, sleep, waitFor, key } from "./scenarios.mjs";

// Built-in targets plus your own in test/targets.local.json (git-ignored; holds credentials).
// A target runs destructively (purge, seed, exact initial-sync count) only when it says "destructive": true.
// Everything else is non-destructive: the suite only ever touches messages it injected itself.
const builtIn = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
const localFile = new URL("./targets.local.json", import.meta.url);
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : [];
const all = [...builtIn, ...local];
const wanted = process.argv.slice(2);
const targets = wanted.length ? all.filter((t) => wanted.includes(t.name)) : all;
if (wanted.length && !targets.length) {
  console.error(`no such target; known: ${all.map((t) => t.name).join(", ")}`);
  process.exit(1);
}
const TOKEN = "conformance";
const report = { generated_at: new Date().toISOString(), engine_version: JSON.parse(readFileSync("package.json", "utf8")).version, targets: [] };

async function startEngine(port, dataDir) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, ENGINE_PORT: String(port), ENGINE_TOKEN: TOKEN, ENGINE_DATA: dataDir, ENGINE_DEBUG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const sink = (d) => {
    logs += d;
    appendFileSync(`${dataDir}/engine.log`, d);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  const { api } = makeApi(`http://127.0.0.1:${port}`, TOKEN);
  for (let i = 0; i < 60; i++) {
    try {
      await api("/health");
      break;
    } catch {
      await sleep(250);
    }
  }
  return {
    child,
    logs: () => logs,
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) return r();
        child.once("exit", r);
        child.kill();
      }),
  };
}

async function waitConnected(api, accountId, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const h = await api("/health");
    const a = h.accounts.find((x) => x.id === accountId);
    if (a?.status === "connected") return a;
    if (Date.now() - start > timeoutMs) throw new Error(`account did not connect: ${JSON.stringify(a)}`);
    await sleep(300);
  }
}

for (const [i, target] of targets.entries()) {
  const port = 18080 + i;
  const dataDir = `data/conformance/${target.name}`;
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  console.log(`\n=== ${target.name}: ${target.server} ===`);
  const side = makeSideChannel(target.side);
  const result = { name: target.name, server: target.server, provider: target.account.provider, scenarios: [], quirks: [], measurements: {} };
  let mock = null;
  if (target.mock) {
    mock = spawn(process.execPath, [target.mock.script, String(target.mock.port)], { stdio: ["ignore", "pipe", "pipe"] });
    mock.stderr.on("data", (d) => appendFileSync(`${dataDir}/mock.log`, d));
    mock.stdout.on("data", (d) => appendFileSync(`${dataDir}/mock.log`, d));
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`${target.side.url}/_mock/capabilities`, { method: "POST", body: "{}" });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
  let engine = await startEngine(port, dataDir);
  const { api, apiAs } = makeApi(`http://127.0.0.1:${port}`, TOKEN);
  try {
    // Baseline: an empty mailbox with three seeded messages, one of them a reply. Destructive targets only.
    if (!target.destructive) console.log("live target: not purging, initial-sync count skipped, only injected messages are touched");
    if (side.capabilities && !target.destructive) result.extensions = await side.capabilities();
    if (side.purge && target.destructive) {
      await side.purge();
      const stamp = Date.now();
      await side.inject(rfc822({ to: target.account.address, subject: `Seed ${stamp} A`, messageId: `<seed-a-${stamp}@example.com>`, body: "seed a" }));
      await side.inject(rfc822({ to: target.account.address, subject: `Re: Seed ${stamp} A`, messageId: `<seed-b-${stamp}@example.com>`, headers: [`In-Reply-To: <seed-a-${stamp}@example.com>`], body: "seed b" }));
      await side.inject(rfc822({ to: target.account.address, subject: `Seed ${stamp} C`, messageId: `<seed-c-${stamp}@example.com>`, body: "seed c" }));
      result.extensions = side.capabilities ? await side.capabilities() : [];
    }

    const { id } = await api("/accounts", { method: "POST", body: JSON.stringify(target.account) });
    const account = await waitConnected(api, id);
    account.provider = target.account.provider;
    await sleep(1500);

    // Initial sync must emit exactly the seeded messages, with the reply threaded.
    if (side.purge && target.destructive) {
      const { events } = await api("/events?after=0&limit=2000");
      const received = events.filter((e) => e.type === "message.received");
      const threads = new Set(received.map((e) => e.payload.thread_id));
      const ok = received.length === 3 && threads.size === 2;
      result.scenarios.push({ name: "initial sync: exactly the 3 seeded messages, reply threaded (2 threads)", status: ok ? "PASS" : "FAIL", ms: 0, note: `${received.length} received, ${threads.size} threads` });
      console.log(`${result.scenarios.at(-1).status}  ${result.scenarios.at(-1).name}  (${result.scenarios.at(-1).note})`);
    }

    const sendTo = target.send_to ? { address: target.send_to.address, side: makeSideChannel(target.send_to.side) } : null;
    const ctx = await buildContext({ api, apiAs, account, side, sendTo });
    result.capabilities = ctx.caps;
    result.folders = ctx.folders.map((f) => ({ name: f.name, role: f.role }));
    result.scenarios.push(...(await runScenarios(ctx, (r) => console.log(`${r.status.padEnd(4)}  ${r.name}  ${r.note ? `(${r.note})` : ""}`))));
    Object.assign(result.measurements, ctx.measurements);

    // Offline catch-up: stop the engine, change the mailbox, restart, expect exactly the right events once.
    if (side.flag && ctx.msg) {
      const t = Date.now();
      try {
        const before = (await api("/health")).cursor;
        await engine.stop();
        const stamp = Date.now();
        const newId = `<offline-${stamp}@example.com>`;
        await side.inject(rfc822({ to: account.address, subject: `Offline ${stamp}`, messageId: newId, body: "arrived while the engine was down" }));
        await side.flag(ctx.msg.messageId, ["\\Flagged"]); // every provider has a flagged/starred flag; not all have answered
        const victimStamp = Date.now();
        await side.inject(rfc822({ to: account.address, subject: `Victim ${victimStamp}`, messageId: `<victim-${victimStamp}@example.com>`, body: "will be expunged while down" }));
        // The victim never existed for the engine, so expunging it must produce nothing at all.
        await side.expunge(`<victim-${victimStamp}@example.com>`);
        engine = await startEngine(port, dataDir);
        await waitConnected(api, id);
        await waitFor(api, before, (e) => e.type === "message.received" && e.payload.subject === `Offline ${stamp}`, "offline arrival", 30000);
        await waitFor(api, before, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.flags?.after.flagged === true, "offline flag", 30000);
        await sleep(2000);
        const { events } = await api(`/events?after=${before}&limit=2000`);
        const received = events.filter((e) => e.type === "message.received");
        const deleted = events.filter((e) => e.type === "message.deleted");
        assert.equal(received.length, 1, `expected 1 received after restart, saw ${received.length}`);
        assert.equal(deleted.length, 0, `expected 0 deleted after restart, saw ${deleted.length}`);
        const dupUpdates = events.filter((e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id).length;
        assert.equal(dupUpdates, 1, `expected 1 update for the flagged message, saw ${dupUpdates}`);
        result.scenarios.push({ name: "offline catch-up: changes made while the engine was down arrive exactly once after restart", status: "PASS", ms: Date.now() - t, note: "1 received, 1 updated, 0 deleted, no duplicates" });
      } catch (e) {
        result.scenarios.push({ name: "offline catch-up: changes made while the engine was down arrive exactly once after restart", status: "FAIL", ms: Date.now() - t, note: e.message.split("\n")[0] });
      }
      console.log(`${result.scenarios.at(-1).status}  ${result.scenarios.at(-1).name}  (${result.scenarios.at(-1).note})`);
    }

    // Quirks: what a developer targeting this server should know.
    const caps = result.capabilities ?? {};
    result.quirks.push(`Push: ${caps.push}${result.measurements.push_ms ? `, ${result.measurements.push_ms} ms to message.received` : ""}`);
    if (result.measurements.external_move_in_ms > 5000) result.quirks.push(`A message moved into the inbox by another client took ${result.measurements.external_move_in_ms} ms to be noticed (server notifies late for mail copied into an already-seen state)`);
    if (result.measurements.storm_ms) result.quirks.push(`25 external flag changes delivered in ${result.measurements.storm_ms} ms`);
    result.quirks.push(`Incremental sync: ${caps.incremental_sync}; expunge detection: ${caps.incremental_sync === "qresync" ? "VANISHED" : caps.incremental_sync === "delta" ? "Email/changes" : caps.incremental_sync === "none" ? "n/a" : "UID set comparison"}`);
    result.quirks.push(`Folder model: ${caps.folders}; roles: ${result.folders.filter((f) => f.role !== "other").map((f) => `${f.role}=${f.name}`).join(", ") || "none"}`);
    if (result.folders.length && !result.folders.some((f) => f.role === "archive")) result.quirks.push("No archive folder by default");
    if (caps.threads) result.quirks.push(`Threads: ${caps.threads}`);
    if (caps.sent_copy) result.quirks.push(`Sent copy filed by: ${caps.sent_copy}`);
  } catch (e) {
    result.error = e.message;
    console.log("TARGET ERROR", e.message);
  } finally {
    await engine.stop().catch(() => {});
    if (mock) mock.kill();
    const logs = engine.logs();
    const errors = logs.split("\n").filter((l) => /error|crash/i.test(l));
    if (errors.length) result.engine_errors = errors.slice(0, 10);
    // A live mailbox's metadata and credentials do not belong on disk after the run; keep only the logs.
    if (!target.destructive) for (const f of ["engine.db", "engine.db-wal", "engine.db-shm", "engine.secret"]) rmSync(`${dataDir}/${f}`, { force: true });
  }
  report.targets.push(result);
}

// ---------- write the report ----------
mkdirSync("conformance", { recursive: true });
writeFileSync("conformance/report.json", JSON.stringify(report, null, 2));

const names = [...new Set(report.targets.flatMap((t) => t.scenarios.map((s) => s.name)))];
const cell = (t, n) => {
  const s = t.scenarios.find((x) => x.name === n);
  if (!s) return "";
  if (s.status === "n/a") return "n/a";
  return s.status === "PASS" ? `✓${s.note && /^\d+ ms/.test(s.note) ? ` ${s.note.split(",")[0]}` : ""}` : `✗ ${s.note}`;
};
let md = `# Conformance report\n\nGenerated ${report.generated_at} by email-engine ${report.engine_version}. One fresh engine per target; the same scenarios for every adapter. ✓ passed, ✗ failed, n/a = the capability does not exist on that target.\n\n`;
md += `| Scenario | ${report.targets.map((t) => t.name).join(" | ")} |\n| --- | ${report.targets.map(() => "---").join(" | ")} |\n`;
for (const n of names) md += `| ${n} | ${report.targets.map((t) => cell(t, n)).join(" | ")} |\n`;
md += `\n## Targets\n\n`;
for (const t of report.targets) {
  md += `### ${t.name}\n\n${t.server}\n\n`;
  if (t.error) md += `**Target error:** ${t.error}\n\n`;
  if (t.capabilities) md += "Capability descriptor:\n\n```json\n" + JSON.stringify(t.capabilities) + "\n```\n\n";
  if (t.extensions?.length) md += `IMAP extensions advertised: ${t.extensions.join(" ")}\n\n`;
  if (t.quirks.length) md += t.quirks.map((q) => `- ${q}`).join("\n") + "\n\n";
  if (Object.keys(t.measurements).length) md += `Measurements: ${Object.entries(t.measurements).map(([k, v]) => `${k}=${v}`).join(", ")}\n\n`;
  if (t.engine_errors) md += `Engine log errors:\n\n` + t.engine_errors.map((e) => `    ${e}`).join("\n") + "\n\n";
}
writeFileSync("conformance/REPORT.md", md);

const totals = report.targets.map((t) => `${t.name}: ${t.scenarios.filter((s) => s.status === "PASS").length} pass, ${t.scenarios.filter((s) => s.status === "FAIL").length} fail, ${t.scenarios.filter((s) => s.status === "n/a").length} n/a`);
console.log("\n" + totals.join("\n"));
console.log("\nwrote conformance/report.json and conformance/REPORT.md");
process.exit(report.targets.some((t) => t.error || t.scenarios.some((s) => s.status === "FAIL")) ? 1 : 0);
