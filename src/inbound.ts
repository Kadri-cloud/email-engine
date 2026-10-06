// Inbound SMTP adapter: the engine listens on a port, mail forwarded to it
// becomes message.received like any other adapter's. Read-only by nature:
// there is no remote mailbox to move things in, so move/append/send refuse.
// Useful where IMAP is switched off but forwarding is allowed.
import { simpleParser } from "mailparser";
import { mkdirSync, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { Adapter, RemoteFolder, RemoteMessage, SyncSink } from "./adapter.js";
import type { Address, Capabilities, Flags, InboundAccountConfig } from "./schema.js";

const INBOX: RemoteFolder = { path: "INBOX", name: "Inbox", role: "inbox" };
const NO_FLAGS: Flags = { seen: false, flagged: false, answered: false, draft: false };

interface Meta {
  flags: Flags;
  received_at: string;
  from_ip: string | null;
  authenticated: boolean;
}

const addr = (a: { address?: string; name?: string } | undefined): Address | null =>
  a?.address ? { address: a.address.toLowerCase(), ...(a.name ? { name: a.name } : {}) } : null;

export class InboundAdapter implements Adapter {
  capabilities: Capabilities | null = null;
  private server: SMTPServer | null = null;
  private dir: string;
  private wake: ((kind: string) => void) | null = null;
  private arrived: string[] = [];
  private flagged: string[] = [];
  private removed: string[] = [];

  constructor(
    private cfg: InboundAccountConfig,
    dataDir: string,
  ) {
    this.dir = `${dataDir}/inbound/${cfg.address.replace(/[^a-z0-9@._-]/gi, "_")}`;
    mkdirSync(this.dir, { recursive: true });
  }

  async connect(): Promise<Capabilities> {
    const c = this.cfg.inbound;
    const requireAuth = !!(c.user && c.pass);
    this.server = new SMTPServer({
      // ponytail: plaintext SMTP; STARTTLS needs a certificate, add when someone exposes this to the internet.
      disabledCommands: ["STARTTLS"],
      authOptional: !requireAuth,
      allowInsecureAuth: true,
      size: 50 * 1024 * 1024,
      onAuth: (auth, _session, cb) => {
        if (requireAuth && auth.username === c.user && auth.password === c.pass) return cb(null, { user: auth.username });
        cb(new Error("invalid credentials"));
      },
      onRcptTo: (rcpt, _session, cb) => {
        if (c.accept_any_recipient || rcpt.address.toLowerCase() === this.cfg.address.toLowerCase()) return cb();
        cb(Object.assign(new Error(`mailbox ${rcpt.address} not served here`), { responseCode: 550 }));
      },
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.on("end", () => {
          if ((stream as any).sizeExceeded) return cb(Object.assign(new Error("message too large"), { responseCode: 552 }));
          this.accept(Buffer.concat(chunks), session).then(() => cb(), cb);
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(c.port, c.host, () => resolve());
    });
    this.capabilities = {
      folders: "folders",
      push: "smtp",
      incremental_sync: "none",
      undo_send_seconds: 0,
      server_rules: "none",
      max_connections: 1,
      send_limit_per_day: null,
      threads: "none",
      permanent_delete: true,
      sent_copy: "client",
    };
    return this.capabilities;
  }

  private async accept(raw: Buffer, session: SMTPServerSession) {
    const ref = randomBytes(12).toString("hex");
    const meta: Meta = {
      flags: NO_FLAGS,
      received_at: new Date().toISOString(),
      from_ip: session.remoteAddress ?? null,
      authenticated: !!session.user,
    };
    await fs.writeFile(`${this.dir}/${ref}.eml`, raw);
    await fs.writeFile(`${this.dir}/${ref}.json`, JSON.stringify(meta));
    this.arrived.push(ref);
    this.wake?.("smtp");
  }

  async listFolders(): Promise<RemoteFolder[]> {
    return [INBOX];
  }

  private async meta(ref: string): Promise<Meta> {
    return JSON.parse(await fs.readFile(`${this.dir}/${ref}.json`, "utf8"));
  }

  private async toRemote(ref: string): Promise<RemoteMessage> {
    const raw = await fs.readFile(`${this.dir}/${ref}.eml`);
    const meta = await this.meta(ref);
    const p = await simpleParser(raw);
    const list = (v: any): { address?: string; name?: string }[] => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x: any) => x.value ?? []);
    const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
    return {
      ref,
      folderPaths: [INBOX.path],
      flags: meta.flags,
      headerMessageId: p.messageId ?? null,
      inReplyTo: p.inReplyTo ?? null,
      references: refs,
      // Never trust authentication headers on mail handed to us over plain SMTP: anyone can write them.
      authResults: null,
      subject: p.subject ?? "",
      from: addr(list(p.from)[0]),
      to: list(p.to).map(addr).filter((a): a is Address => !!a),
      cc: list(p.cc).map(addr).filter((a): a is Address => !!a),
      date: (p.date ?? new Date(meta.received_at)).toISOString(),
      size: raw.length,
      hasAttachments: p.attachments.length > 0,
      snippet: (p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      threadHint: null,
    };
  }

  async sync(_folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink) {
    let refs: string[];
    if (!state.initialized) {
      refs = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".eml")).map((f) => f.slice(0, -4));
      this.arrived = [];
    } else {
      refs = this.arrived.splice(0);
    }
    for (const ref of refs) sink.seen(await this.toRemote(ref), true);
    for (const ref of this.flagged.splice(0)) sink.flags(INBOX.path, ref, (await this.meta(ref)).flags);
    for (const ref of this.removed.splice(0)) sink.gone(INBOX.path, ref);
    return { initialized: true };
  }

  async watch(_path: string, onWake: (kind: string) => void, onClose: (err?: Error) => void) {
    this.wake = onWake;
    this.server?.once("close", () => onClose());
  }

  async setFlags(_path: string, ref: string, set: Partial<Flags>) {
    const meta = await this.meta(ref);
    meta.flags = { ...meta.flags, ...Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)) } as Flags;
    await fs.writeFile(`${this.dir}/${ref}.json`, JSON.stringify(meta));
    this.flagged.push(ref);
  }

  async move(): Promise<string | null> {
    throw new Error("inbound adapter is read-only: there are no folders to move between");
  }

  async expunge(_path: string, ref: string) {
    await fs.rm(`${this.dir}/${ref}.eml`, { force: true });
    await fs.rm(`${this.dir}/${ref}.json`, { force: true });
    this.removed.push(ref);
  }

  async append(): Promise<string | null> {
    throw new Error("inbound adapter is read-only: it cannot store drafts");
  }

  async source(_path: string, ref: string): Promise<Buffer | null> {
    return fs.readFile(`${this.dir}/${ref}.eml`).catch(() => null);
  }

  async send(): Promise<void> {
    throw new Error("inbound adapter is read-only: it cannot send");
  }

  async close() {
    this.wake = null;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
