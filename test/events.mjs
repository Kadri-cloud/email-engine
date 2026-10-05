// Pretty-print the event log. Usage: node test/events.mjs [after] [base] [token]
const after = process.argv[2] ?? "0";
const base = process.argv[3] ?? "http://127.0.0.1:8080";
const token = process.argv[4] ?? process.env.ENGINE_TOKEN ?? "test";

const r = await fetch(`${base}/events?after=${after}`, { headers: { authorization: `Bearer ${token}` } });
const { events, next } = await r.json();
const short = (s) => (s ? String(s).slice(0, 14) : "-");
for (const e of events) {
  const p = e.payload ?? {};
  let line;
  if (e.type.startsWith("message.")) {
    line = `${short(p.message_id)} thr=${short(p.thread_id)} "${p.subject ?? ""}" trust=${p.trust ?? ""} ${p.flags ? JSON.stringify(p.flags) : ""} ${p.changes ? "changes=" + JSON.stringify(p.changes) : ""} folders=${(p.folder_ids ?? []).map(short).join(",")}`;
  } else if (e.type === "thread.updated") {
    line = `thr=${short(p.thread_id)} n=${p.message_count} people=${p.participants.length}`;
  } else if (e.type === "account.status") {
    line = `${p.status} ${p.capabilities ? "caps=" + JSON.stringify(p.capabilities) : ""} ${p.error ?? ""}`;
  } else if (e.type === "action.updated") {
    line = `${short(p.action_id)} ${p.type} ${p.previous_status} -> ${p.status} ${p.result ? JSON.stringify(p.result) : ""} ${p.error ?? ""}`;
  } else {
    line = JSON.stringify(p).slice(0, 160);
  }
  console.log(String(e.cursor).padStart(4), e.type.padEnd(16), line);
}
console.log(`next cursor: ${next}`);
