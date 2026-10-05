// Inject test mail into the Dovecot container with plain IMAP APPEND.
// Usage: node test/seed.mjs [user] [count]
import { ImapFlow } from "imapflow";

const user = process.argv[2] ?? "alice";
const count = Number(process.argv[3] ?? 3);

const client = new ImapFlow({
  host: "127.0.0.1",
  port: 993,
  secure: true,
  auth: { user, pass: "pass" },
  tls: { rejectUnauthorized: false },
  logger: false,
});

const msg = (i, { inReplyTo, references, subject } = {}) =>
  [
    `From: "Sender ${i}" <sender${i}@example.com>`,
    `To: ${user}@example.com`,
    `Subject: ${subject ?? `Test message ${i}`}`,
    `Date: ${new Date(Date.now() - (count - i) * 60_000).toUTCString()}`,
    `Message-ID: <seed-${i}@example.com>`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    `Authentication-Results: mx.example.com; dmarc=pass header.from=example.com`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hello from seed message ${i}. Invoice number INV-${1000 + i} attached in spirit.`,
  ]
    .filter((l) => l !== null)
    .join("\r\n");

await client.connect();
for (const box of ["Sent", "Drafts", "Trash", "Archive"]) {
  try { await client.mailboxCreate(box); } catch {}
}
for (let i = 1; i <= count; i++) {
  const reply = i > 1 && i % 2 === 0;
  await client.append(
    "INBOX",
    msg(i, reply ? { inReplyTo: `<seed-${i - 1}@example.com>`, references: `<seed-${i - 1}@example.com>`, subject: `Re: Test message ${i - 1}` } : {}),
  );
}
console.log(`appended ${count} messages to ${user}'s INBOX`);
await client.logout();
