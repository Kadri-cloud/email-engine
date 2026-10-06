// Probe how a server + imapflow deliver IDLE notifications under a burst, with a second
// "work" connection that fetches on every notification the way the engine does.
// Connection A idles on INBOX and logs events; connection B appends N messages `gap` ms apart;
// connection W reacts to each A event by fetching new mail, and either keeps INBOX selected or closes it.
// Usage: node test/idle-probe.mjs [host] [port] [user] [pass] [count] [gapMs] [work: none|keep|close]
import { ImapFlow } from "imapflow";

const [host = "127.0.0.1", port = "993", user = "alice", pass = "pass", count = "12", gap = "150", work = "none"] = process.argv.slice(2);
const mk = (extra = {}) =>
  new ImapFlow({ host, port: Number(port), secure: true, auth: { user, pass }, tls: { rejectUnauthorized: false }, logger: false, qresync: true, autoIdleDelay: 1000, ...extra });

const t0 = Date.now();
const stamp = (kind, extra = "") => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${kind} ${extra}`);

const a = mk();
const w = work === "none" ? null : mk();
let lastUid = 0;
let fetched = 0;
let chain = Promise.resolve();
const workFetch = () =>
  (chain = chain.then(async () => {
    if (!w) return;
    const lock = await w.getMailboxLock("INBOX");
    try {
      if (!lastUid) lastUid = w.mailbox.uidNext - 1;
      for await (const m of w.fetch(`${lastUid + 1}:*`, { uid: true, flags: true, envelope: true }, { uid: true })) {
        if (m.uid > lastUid) {
          lastUid = m.uid;
          fetched++;
        }
      }
    } finally {
      lock.release();
      if (work === "close") await w.mailboxClose().catch(() => {});
    }
    stamp("work fetched so far", String(fetched));
  }));

a.on("exists", (e) => {
  stamp("exists", `count=${e.count} prev=${e.prevCount}`);
  workFetch();
});
await a.connect();
await a.mailboxOpen("INBOX", { readOnly: true });
if (w) {
  await w.connect();
  await workFetch(); // baseline
}
stamp("idle connection ready", `work=${work}`);
await new Promise((r) => setTimeout(r, 1500));

const b = mk();
await b.connect();
for (let i = 0; i < Number(count); i++) {
  await b.append("INBOX", `From: probe@example.com\r\nTo: ${user}@example.com\r\nSubject: probe ${i}\r\nMessage-ID: <probe-${t0}-${i}@example.com>\r\n\r\nprobe ${i}`);
  await new Promise((r) => setTimeout(r, Number(gap)));
}
await b.logout();
stamp("appends done", `${count} appended; waiting 10 s for stragglers`);
await new Promise((r) => setTimeout(r, 10000));
stamp("result", `work connection fetched ${fetched}/${count}`);
await a.logout();
if (w) await w.logout();
