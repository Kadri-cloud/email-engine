// End-to-end smoke test against a running engine and the Dovecot container.
// Exercises live push, every action, undo, proposals, timers, search and SSE.
// Usage: node test/smoke.mjs   (engine on :8080 with ENGINE_TOKEN=test, account alice connected)
import { ImapFlow } from "imapflow";
import assert from "node:assert/strict";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";
const TOKEN = process.env.ENGINE_TOKEN ?? "test";
// Which engine account to test, and the IMAP side channel used to inject mail behind the engine's back.
// Defaults target alice on Dovecot. For the JMAP account on Stalwart:
//   SMOKE_ACCOUNT=bob@example.com SMOKE_IMAP=127.0.0.1:1993:bob:pass node test/smoke.mjs
const ACCOUNT_ADDRESS = process.env.SMOKE_ACCOUNT ?? "alice@example.com";
const [SC_HOST = "127.0.0.1", SC_PORT = "993", SC_USER = "alice", SC_PASS = "pass"] = (process.env.SMOKE_IMAP ?? "").split(":");
const sideChannel = () =>
  new ImapFlow({ host: SC_HOST, port: Number(SC_PORT), secure: true, auth: { user: SC_USER, pass: SC_PASS }, tls: { rejectUnauthorized: false }, logger: false });
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: H });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Poll the log from `after` until an event satisfies `pred`, or time out. */
async function waitFor(after, pred, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { events } = await api(`/events?after=${after}`);
    const hit = events.find(pred);
    if (hit) return { event: hit, ms: Date.now() - start };
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function action(type, params, mode = "direct") {
  const a = await api(`/actions${mode === "propose" ? "?mode=propose" : ""}`, {
    method: "POST",
    body: JSON.stringify({ client_key: key(), type, params }),
  });
  return a;
}
const results = [];
const step = async (name, fn) => {
  try {
    const info = await fn();
    results.push([name, "PASS", info ?? ""]);
  } catch (e) {
    results.push([name, "FAIL", e.message]);
  }
};

const health = await api("/health");
const account = health.accounts.find((a) => a.address === ACCOUNT_ADDRESS);
assert.ok(account, `account ${ACCOUNT_ADDRESS} not connected`);
console.log(`account ${account.address} (${account.id}) status=${account.status}`);
const folders = await api(`/accounts/${account.id}/folders`);
const byRole = (r) => folders.find((f) => f.role === r);
let cursor = health.cursor;
let msg; // the message we create and push around

await step("live push: APPEND arrives as message.received via push", async () => {
  const c = sideChannel();
  await c.connect();
  const stamp = Date.now();
  await c.append("INBOX", [
    `From: "Push Tester" <push@example.com>`, `To: ${ACCOUNT_ADDRESS}`, `Subject: Live push ${stamp}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <push-${stamp}@example.com>`,
    `Authentication-Results: mx.example.com; dmarc=fail header.from=example.com`,
    `Content-Type: text/plain; charset=utf-8`, ``, `This arrived while the engine was idling. Keyword: pineapple.`,
  ].join("\r\n"));
  await c.logout();
  const { event, ms } = await waitFor(cursor, (e) => e.type === "message.received" && e.payload.subject === `Live push ${stamp}`, "pushed message");
  msg = event.payload;
  assert.equal(msg.trust, "suspicious", "dmarc=fail should be suspicious");
  cursor = event.cursor;
  return `${ms} ms, trust=${msg.trust}`;
});

await step("search: FTS finds the new message", async () => {
  const { results: r } = await api(`/search?q=pineapple`);
  assert.ok(r.some((m) => m.id === msg.message_id), "search miss");
  return `${r.length} hit(s)`;
});

await step("body: fetched on demand and parsed", async () => {
  const b = await api(`/messages/${msg.message_id}/body`);
  assert.match(b.text, /pineapple/);
  return `${b.text.length} chars`;
});

await step("set_flags: mark seen, message.updated carries before/after", async () => {
  const a = await action("set_flags", { message_id: msg.message_id, set: { seen: true } });
  assert.equal(a.status, "executed", JSON.stringify(a));
  const { event } = await waitFor(cursor, (e) => e.type === "message.updated" && e.payload.message_id === msg.message_id && e.payload.changes.flags?.after.seen === true, "flag update");
  cursor = event.cursor;
  return `before.seen=${event.payload.changes.flags.before.seen} after.seen=${event.payload.changes.flags.after.seen}`;
});

let moveAction;
await step("move: inbox -> archive, then undo brings it back", async () => {
  const archive = byRole("archive") ?? folders.find((f) => /archive/i.test(f.path));
  assert.ok(archive, "no archive folder");
  moveAction = await action("move", { message_id: msg.message_id, to_folder_id: archive.id });
  assert.equal(moveAction.status, "executed", JSON.stringify(moveAction));
  let m = await api(`/messages/${msg.message_id}`);
  assert.deepEqual(m.folders.map((f) => f.folder_id), [archive.id], "not in archive");
  const undone = await api(`/actions/${moveAction.id}/undo`, { method: "POST" });
  assert.equal(undone.status, "reverted");
  m = await api(`/messages/${msg.message_id}`);
  assert.deepEqual(m.folders.map((f) => f.folder_id), [byRole("inbox").id], "not back in inbox");
  cursor = (await api("/health")).cursor;
  return "archived and reverted, same message id throughout";
});

await step("idempotency: same client_key returns the same action", async () => {
  const k = key();
  const body = JSON.stringify({ client_key: k, type: "set_flags", params: { message_id: msg.message_id, set: { flagged: true } } });
  const a1 = await api("/actions", { method: "POST", body });
  const a2 = await api("/actions", { method: "POST", body });
  assert.equal(a1.id, a2.id);
  return a1.id;
});

await step("propose -> approve: delete goes to trash only after approval, then undo", async () => {
  const p = await action("delete", { message_id: msg.message_id }, "propose");
  assert.equal(p.status, "proposed");
  let m = await api(`/messages/${msg.message_id}`);
  assert.equal(m.folders[0].folder_id, byRole("inbox").id, "moved before approval");
  const ap = await api(`/actions/${p.id}/approve`, { method: "POST" });
  assert.equal(ap.status, "executed", JSON.stringify(ap));
  m = await api(`/messages/${msg.message_id}`);
  assert.equal(m.folders[0].folder_id, byRole("trash").id, "not in trash");
  const un = await api(`/actions/${p.id}/undo`, { method: "POST" });
  assert.equal(un.status, "reverted");
  m = await api(`/messages/${msg.message_id}`);
  assert.equal(m.folders[0].folder_id, byRole("inbox").id, "not restored");
  return "proposed, approved, trashed, reverted";
});

await step("reject: a rejected proposal never touches the server", async () => {
  const p = await action("set_flags", { message_id: msg.message_id, set: { answered: true } }, "propose");
  const r = await api(`/actions/${p.id}/reject`, { method: "POST" });
  assert.equal(r.status, "rejected");
  const m = await api(`/messages/${msg.message_id}`);
  assert.equal(m.flags.answered, false);
  return "rejected";
});

await step("create_draft: appears in Drafts as a draft, reply headers set", async () => {
  cursor = (await api("/health")).cursor;
  const a = await action("create_draft", { account: account.id, to: [{ address: "push@example.com", name: "Push Tester" }], subject: "Re: draft test", text: "Drafted by the engine.", in_reply_to: msg.message_id });
  assert.equal(a.status, "executed", JSON.stringify(a));
  const { event } = await waitFor(cursor, (e) => e.type === "message.received" && e.payload.message_id === a.result.message_id, "draft in Drafts");
  assert.equal(event.payload.flags.draft, true);
  assert.equal(event.payload.thread_id, msg.thread_id, "draft not threaded with its parent");
  const un = await api(`/actions/${a.id}/undo`, { method: "POST" });
  assert.equal(un.status, "reverted");
  return `draft ${a.result.message_id.slice(0, 14)} created in thread, then removed`;
});

await step("schedule_timer: fires as timer.fired with the payload", async () => {
  cursor = (await api("/health")).cursor;
  const fireAt = new Date(Date.now() + 2000).toISOString();
  const a = await action("schedule_timer", { account: account.id, fire_at: fireAt, event_type: "snooze.due", payload: { message_id: msg.message_id } });
  assert.equal(a.status, "executed");
  const { event, ms } = await waitFor(cursor, (e) => e.type === "timer.fired" && e.payload.timer_id === a.result.timer_id, "timer");
  assert.equal(event.payload.event_type, "snooze.due");
  assert.equal(event.payload.payload.message_id, msg.message_id);
  return `fired after ${ms} ms`;
});

await step("SSE: /stream replays from a cursor then goes live", async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${BASE}/stream?after=0`, { headers: H, signal: ctrl.signal });
  const reader = r.body.getReader();
  const { value } = await reader.read();
  ctrl.abort();
  const text = new TextDecoder().decode(value);
  assert.match(text, /^id: 1\n/m);
  assert.match(text, /event: account.status/);
  return "first frame is cursor 1";
});

await step("cursor log: strictly increasing, no gaps", async () => {
  const { events } = await api(`/events?after=0&limit=2000`);
  for (let i = 1; i < events.length; i++) assert.equal(events[i].cursor, events[i - 1].cursor + 1, `gap at ${events[i].cursor}`);
  return `${events.length} events contiguous`;
});

// ---------- scoped tokens ----------
const apiAs = async (secret, path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let triage; // propose-only token limited to the inbox, redacting one-time codes and cards
let otpMsg;

await step("tokens: admin creates a scoped token, secret shown once", async () => {
  const t = await api("/tokens", {
    method: "POST",
    body: JSON.stringify({
      name: "newsletter-triage", accounts: [account.id], folders: ["inbox"],
      events: ["message.received", "message.updated", "action.updated"],
      actions: ["search", "get_message", "move", "set_flags", "propose"],
      redact: ["otp", "card"], mode: "propose_only",
    }),
  });
  assert.match(t.secret, /^tok_/);
  triage = t;
  const list = await api("/tokens");
  assert.ok(list.some((x) => x.id === t.id) && !list.some((x) => x.secret), "secret must not be listed");
  return t.id;
});

await step("scope: filtered log shows only allowed types in allowed folders", async () => {
  const { status, body } = await apiAs(triage.secret, "/events?after=0&limit=2000");
  assert.equal(status, 200);
  assert.ok(body.events.length > 0, "no events visible");
  const types = new Set(body.events.map((e) => e.type));
  assert.ok(!types.has("account.status") && !types.has("thread.updated"), `leaked types: ${[...types]}`);
  const inbox = byRole("inbox").id;
  for (const e of body.events) if (e.type.startsWith("message.")) assert.ok(e.payload.folder_ids.includes(inbox), `non-inbox event leaked: ${JSON.stringify(e.payload.folder_ids)}`);
  return `${body.events.length} visible, next=${body.next}`;
});

await step("scope: propose_only token's direct call becomes a proposal; it cannot approve, admin can", async () => {
  const { status, body: a } = await apiAs(triage.secret, "/actions", { method: "POST", body: JSON.stringify({ client_key: key(), type: "set_flags", params: { message_id: msg.message_id, set: { flagged: false } } }) });
  assert.equal(status, 200, JSON.stringify(a));
  assert.equal(a.status, "proposed");
  assert.equal(a.requested_by, "newsletter-triage");
  const denied = await apiAs(triage.secret, `/actions/${a.id}/approve`, { method: "POST" });
  assert.equal(denied.status, 403);
  const ok = await api(`/actions/${a.id}/approve`, { method: "POST" });
  assert.equal(ok.status, "executed");
  return "proposal by agent, approval by admin";
});

await step("scope: action outside the allowed list is refused", async () => {
  const { status } = await apiAs(triage.secret, "/actions", { method: "POST", body: JSON.stringify({ client_key: key(), type: "delete", params: { message_id: msg.message_id } }) });
  assert.equal(status, 403);
  return "delete refused with 403";
});

await step("redaction: codes and card numbers are masked for the scoped token only", async () => {
  cursor = (await api("/health")).cursor;
  const c = sideChannel();
  await c.connect();
  const stamp = Date.now();
  await c.append("INBOX", [
    `From: "Bank" <noreply@bank.example>`, `To: ${ACCOUNT_ADDRESS}`, `Subject: Your code ${stamp}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <otp-${stamp}@bank.example>`, `Content-Type: text/plain; charset=utf-8`, ``,
    `Your verification code is 482913. It expires in 10 minutes.`, `Card on file: 4111 1111 1111 1111. Order 20261006 ships Monday.`,
  ].join("\r\n"));
  await c.logout();
  const { event } = await waitFor(cursor, (e) => e.type === "message.received" && e.payload.subject === `Your code ${stamp}`, "otp message");
  otpMsg = event.payload;
  const scoped = await apiAs(triage.secret, `/messages/${otpMsg.message_id}/body`);
  assert.equal(scoped.status, 200);
  assert.ok(scoped.body.text.includes("[OTP]") && !scoped.body.text.includes("482913"), `otp leaked: ${scoped.body.text}`);
  assert.ok(scoped.body.text.includes("[CARD]") && !scoped.body.text.includes("4111"), `card leaked: ${scoped.body.text}`);
  assert.ok(scoped.body.text.includes("20261006"), "order number must survive");
  const admin = await api(`/messages/${otpMsg.message_id}/body`);
  assert.ok(admin.text.includes("482913"), "admin should see the raw body");
  const ev = await apiAs(triage.secret, `/events?after=${cursor}`);
  const seen = ev.body.events.find((e) => e.payload?.message_id === otpMsg.message_id);
  assert.ok(seen && !seen.payload.snippet.includes("482913"), "snippet in event not redacted");
  return "body and snippet masked for agent, raw for admin";
});

await step("scope: a message moved out of the allowed folder disappears, and returns", async () => {
  const archive = byRole("archive") ?? folders.find((f) => /archive/i.test(f.path) || /archive/i.test(f.name));
  assert.ok(archive, "no archive folder");
  const mv = await action("move", { message_id: otpMsg.message_id, to_folder_id: archive.id });
  assert.equal(mv.status, "executed");
  const hidden = await apiAs(triage.secret, `/messages/${otpMsg.message_id}`);
  assert.equal(hidden.status, 404);
  const back = await api(`/actions/${mv.id}/undo`, { method: "POST" });
  assert.equal(back.status, "reverted");
  const shown = await apiAs(triage.secret, `/messages/${otpMsg.message_id}`);
  assert.equal(shown.status, 200);
  assert.ok(shown.body.as_of, "as_of missing");
  return "404 while archived, 200 when back, as_of present";
});

await step("publish: a plug-in token appends a derived event; a non-publisher cannot", async () => {
  const plug = await api("/tokens", { method: "POST", body: JSON.stringify({ name: "classifier", accounts: [account.id], publish: true, actions: ["search"] }) });
  const pub = await apiAs(plug.secret, "/events", { method: "POST", body: JSON.stringify({ type: "classify.newsletter", account: account.id, payload: { message_id: otpMsg.message_id, label: "transactional", confidence: 0.93 } }) });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const { events } = await api(`/events?after=${pub.body.cursor - 1}&limit=1`);
  assert.equal(events[0].type, "classify.newsletter");
  assert.equal(events[0].payload.published_by, "classifier");
  const reserved = await apiAs(plug.secret, "/events", { method: "POST", body: JSON.stringify({ type: "message.received", account: account.id, payload: {} }) });
  assert.equal(reserved.status, 400);
  const denied = await apiAs(triage.secret, "/events", { method: "POST", body: JSON.stringify({ type: "classify.x", account: account.id, payload: {} }) });
  assert.equal(denied.status, 403);
  await api(`/tokens/${plug.id}`, { method: "DELETE" });
  return "derived event stored with publisher name; core types reserved";
});

await step("tokens: expired token is unauthorized; deleted token is unauthorized", async () => {
  const old = await api("/tokens", { method: "POST", body: JSON.stringify({ name: "stale", expires_at: "2020-01-01T00:00:00Z" }) });
  assert.equal((await apiAs(old.secret, "/accounts")).status, 401);
  await api(`/tokens/${old.id}`, { method: "DELETE" });
  await api(`/tokens/${triage.id}`, { method: "DELETE" });
  assert.equal((await apiAs(triage.secret, "/accounts")).status, 401);
  return "both 401";
});

let failed = 0;
for (const [name, status, info] of results) {
  if (status === "FAIL") failed++;
  console.log(`${status}  ${name}${info ? `  (${info})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
