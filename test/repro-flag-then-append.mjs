// Reproduce: a flag change on the inbox immediately followed by a new message.
// Usage: node test/repro-flag-then-append.mjs [gapMs]
import { ImapFlow } from "imapflow";

const gap = Number(process.argv[2] ?? 50);
const c = new ImapFlow({ host: "127.0.0.1", port: 993, secure: true, auth: { user: "alice", pass: "pass" }, tls: { rejectUnauthorized: false }, logger: false });
await c.connect();
const lock = await c.getMailboxLock("INBOX");
const stamp = Date.now();
try {
  await c.messageFlagsAdd("1", ["\\Flagged"], { uid: true });
  await c.messageFlagsRemove("1", ["\\Flagged"], { uid: true });
} finally {
  lock.release();
}
await new Promise((r) => setTimeout(r, gap));
await c.append("INBOX", [
  `From: "Repro" <repro@example.com>`, `To: alice@example.com`, `Subject: Repro ${stamp}`,
  `Date: ${new Date().toUTCString()}`, `Message-ID: <repro-${stamp}@example.com>`, `Content-Type: text/plain; charset=utf-8`, ``,
  `Flag change then append, gap ${gap} ms.`,
].join("\r\n"));
await c.logout();
console.log(`Repro ${stamp}`);
