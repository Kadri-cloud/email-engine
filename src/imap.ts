// The only file that speaks IMAP and SMTP. Two connections per account: one
// parked in IDLE on the inbox, one working connection for syncs and actions.
// Everything above this file sees folders, messages, flags and uids only.
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import nodemailer from "nodemailer";
import type { Address, Capabilities, Flags, FolderRole, ImapAccountConfig } from "./schema.js";

export interface RemoteFolder {
  path: string;
  role: FolderRole;
}
export interface FolderSnapshot {
  uidValidity: number;
  uidNext: number;
  highestModseq: bigint | null;
  exists: number;
}
export interface RemoteMessage {
  snippet: string;
  uid: number;
  modseq: bigint | null;
  flags: Flags;
  headerMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  authResults: string | null;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: string;
  size: number;
  hasAttachments: boolean;
}

const SPECIAL: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Archive": "archive",
  "\\All": "archive",
  "\\Junk": "spam",
  "\\Trash": "trash",
};
const FLAG_NAMES: Record<keyof Flags, string> = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
};
const HEADERS = ["message-id", "in-reply-to", "references", "authentication-results"];

export function toFlags(set: Set<string> | undefined): Flags {
  return {
    seen: !!set?.has("\\Seen"),
    flagged: !!set?.has("\\Flagged"),
    answered: !!set?.has("\\Answered"),
    draft: !!set?.has("\\Draft"),
  };
}

/** Parse a raw header block (CRLF, folded lines) into lowercase name -> value. */
export function parseHeaders(buf: Buffer | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!buf) return out;
  const lines = buf.toString("utf8").replace(/\r\n[ \t]+/g, " ").split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    out[name] = out[name] ? `${out[name]} ${value}` : value;
  }
  return out;
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  const n = node as any;
  if (n.disposition === "attachment") return true;
  const type: string = n.type ?? "";
  if (n.childNodes?.length) return (n.childNodes as MessageStructureObject[]).some(hasAttachment);
  return !type.startsWith("text/") && !type.startsWith("multipart/");
}

const addr = (a: { name?: string; address?: string } | undefined): Address | null =>
  a?.address ? { address: a.address.toLowerCase(), ...(a.name ? { name: a.name } : {}) } : null;
const addrs = (list: { name?: string; address?: string }[] | undefined): Address[] =>
  (list ?? []).map(addr).filter((a): a is Address => !!a);

const SNIPPET_BYTES = 2048;

function decodeQP(s: string) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** First ~300 characters of readable text from a partial fetch of body part 1. */
export function snippetFrom(raw: Buffer | undefined, structure: MessageStructureObject | undefined): string {
  if (!raw?.length) return "";
  const node = (structure?.childNodes?.[0] ?? structure) as any;
  const enc = String(node?.encoding ?? "").toLowerCase();
  const charset = String(node?.parameters?.charset ?? "utf-8").toLowerCase();
  let text: string;
  if (enc === "base64") {
    const s = raw.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, "");
    text = Buffer.from(s.slice(0, s.length - (s.length % 4)), "base64").toString("utf8");
  } else {
    const latin = raw.toString("latin1");
    const decoded = enc === "quoted-printable" ? decodeQP(latin) : latin;
    text = charset.startsWith("utf") ? Buffer.from(decoded, "latin1").toString("utf8") : decoded;
  }
  if (String(node?.type ?? "").toLowerCase() === "text/html") {
    text = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function toRemoteMessage(m: FetchMessageObject): RemoteMessage {
  const h = parseHeaders(m.headers);
  const env = m.envelope ?? {};
  const refs = (h["references"] ?? "").match(/<[^<>\s]+>/g) ?? [];
  const date = env.date ? new Date(env.date) : m.internalDate ? new Date(m.internalDate) : new Date();
  return {
    snippet: snippetFrom(m.bodyParts?.get("1"), m.bodyStructure),
    uid: m.uid,
    modseq: m.modseq ?? null,
    flags: toFlags(m.flags),
    headerMessageId: h["message-id"] ?? env.messageId ?? null,
    inReplyTo: h["in-reply-to"] ?? env.inReplyTo ?? null,
    references: refs,
    authResults: h["authentication-results"] ?? null,
    subject: env.subject ?? "",
    from: addr(env.from?.[0]),
    to: addrs(env.to),
    cc: addrs(env.cc),
    date: (isNaN(date.getTime()) ? new Date() : date).toISOString(),
    size: m.size ?? 0,
    hasAttachments: hasAttachment(m.bodyStructure),
  };
}

export class ImapAdapter {
  private work: ImapFlow | null = null;
  private idle: ImapFlow | null = null;
  capabilities: Capabilities | null = null;

  constructor(private cfg: ImapAccountConfig) {}

  private makeClient() {
    const c = this.cfg.imap;
    return new ImapFlow({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: { user: c.user, pass: c.pass },
      qresync: true,
      autoIdleDelay: 1000, // enter IDLE a second after the last command, so pushes arrive fast
      logger: false,
      tls: c.insecure_tls ? { rejectUnauthorized: false } : undefined,
      clientInfo: { name: "email-engine", version: "0.0.1" },
    });
  }

  /** Working connection, connected lazily and replaced after any failure. */
  private async client(): Promise<ImapFlow> {
    if (this.work?.usable) return this.work;
    const c = this.makeClient();
    c.on("error", () => {
      if (this.work === c) this.work = null;
    });
    c.on("close", () => {
      if (this.work === c) this.work = null;
    });
    await c.connect();
    this.work = c;
    this.capabilities = this.describe(c);
    return c;
  }

  private describe(c: ImapFlow): Capabilities {
    const caps = c.capabilities as Map<string, boolean | number>;
    const has = (k: string) => caps.has(k);
    const gmail = has("X-GM-EXT-1");
    return {
      folders: gmail ? "labels" : "folders",
      push: has("IDLE") ? "idle" : "none",
      incremental_sync: has("QRESYNC") ? "qresync" : has("CONDSTORE") ? "condstore" : "uidnext",
      undo_send_seconds: 0,
      server_rules: "none",
      max_connections: gmail ? 15 : 5,
      send_limit_per_day: gmail ? 500 : null,
      threads: gmail ? "hint" : "none",
      permanent_delete: true,
    };
  }

  async connect() {
    await this.client();
    return this.capabilities!;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const c = await this.client();
    const out: RemoteFolder[] = [];
    for (const f of await c.list()) {
      if (f.flags.has("\\Noselect") || f.flags.has("\\NonExistent")) continue;
      const role = f.specialUse ? SPECIAL[f.specialUse] ?? "other" : f.path.toUpperCase() === "INBOX" ? "inbox" : "other";
      out.push({ path: f.path, role });
    }
    return out;
  }

  private async withFolder<T>(path: string, fn: (c: ImapFlow, snap: FolderSnapshot) => Promise<T>): Promise<T> {
    const c = await this.client();
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      if (!mb) throw new Error(`mailbox ${path} did not open`);
      const snap: FolderSnapshot = {
        uidValidity: Number(mb.uidValidity),
        uidNext: mb.uidNext,
        highestModseq: mb.highestModseq ?? null,
        exists: mb.exists,
      };
      return await fn(c, snap);
    } finally {
      lock.release();
    }
  }

  snapshot(path: string) {
    return this.withFolder(path, async (_c, snap) => snap);
  }

  /**
   * Headers and flags for every message with uid >= fromUid, delivered in batches.
   * Uses an open-ended UID range so the server, not a cached UIDNEXT, decides what is new.
   * Returns the highest uid seen, or null when nothing was new.
   */
  async fetchFrom(path: string, fromUid: number, onBatch: (msgs: RemoteMessage[]) => Promise<void>, batchSize = 200): Promise<number | null> {
    return this.withFolder(path, async (c) => {
      let maxUid: number | null = null;
      let batch: RemoteMessage[] = [];
      for await (const m of c.fetch(
        `${Math.max(1, fromUid)}:*`,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          size: true,
          headers: HEADERS,
          bodyParts: [{ key: "1", start: 0, maxLength: SNIPPET_BYTES }],
        },
        { uid: true },
      )) {
        if (m.uid < fromUid) continue; // "n:*" always returns at least the last message
        maxUid = Math.max(maxUid ?? 0, m.uid);
        batch.push(toRemoteMessage(m));
        if (batch.length >= batchSize) {
          await onBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await onBatch(batch);
      return maxUid;
    });
  }

  /** Flag changes since a modseq (CONDSTORE/QRESYNC), with the highest modseq seen. */
  async fetchChangedFlags(path: string, sinceModseq: bigint): Promise<{ changes: { uid: number; flags: Flags }[]; maxModseq: bigint | null }> {
    return this.withFolder(path, async (c) => {
      const changes: { uid: number; flags: Flags }[] = [];
      let maxModseq: bigint | null = null;
      for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true, changedSince: sinceModseq })) {
        changes.push({ uid: m.uid, flags: toFlags(m.flags) });
        if (m.modseq && (maxModseq === null || m.modseq > maxModseq)) maxModseq = m.modseq;
      }
      return { changes, maxModseq };
    });
  }

  /** Every flag in the folder. Only for small folders without CONDSTORE. */
  async fetchAllFlags(path: string) {
    return this.withFolder(path, async (c) => {
      const out: { uid: number; flags: Flags }[] = [];
      for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
        out.push({ uid: m.uid, flags: toFlags(m.flags) });
      }
      return out;
    });
  }

  /** All uids present on the server. Used to detect expunges. */
  async allUids(path: string): Promise<Set<number>> {
    return this.withFolder(path, async (c) => {
      const r = await c.search({ all: true }, { uid: true });
      return new Set(Array.isArray(r) ? r : []);
    });
  }

  /** Park a second connection in IDLE on `path`; call onWake when anything happens. */
  async watch(path: string, onWake: (kind: "exists" | "expunge" | "flags") => void, onClose: (err?: Error) => void) {
    const c = this.makeClient();
    c.on("exists", () => onWake("exists"));
    c.on("expunge", () => onWake("expunge"));
    c.on("flags", () => onWake("flags"));
    c.on("error", (e) => onClose(e));
    c.on("close", () => onClose());
    await c.connect();
    await c.mailboxOpen(path, { readOnly: true });
    this.idle = c; // imapflow auto-idles while the connection is otherwise quiet
  }

  async setFlags(path: string, uid: number, set: Partial<Flags>) {
    await this.withFolder(path, async (c) => {
      const add = Object.entries(set).filter(([, v]) => v === true).map(([k]) => FLAG_NAMES[k as keyof Flags]);
      const remove = Object.entries(set).filter(([, v]) => v === false).map(([k]) => FLAG_NAMES[k as keyof Flags]);
      if (add.length) await c.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(String(uid), remove, { uid: true });
    });
  }

  /** Returns the uid in the destination, when the server reports it. */
  async move(path: string, uid: number, destination: string): Promise<number | null> {
    return this.withFolder(path, async (c) => {
      const r = await c.messageMove(String(uid), destination, { uid: true });
      return r ? (r.uidMap?.get(uid) ?? null) : null;
    });
  }

  async expunge(path: string, uid: number) {
    await this.withFolder(path, async (c) => {
      await c.messageDelete(String(uid), { uid: true });
    });
  }

  async append(path: string, raw: Buffer, flags: string[]): Promise<number | null> {
    const c = await this.client();
    const r = await c.append(path, raw, flags);
    return r ? (r.uid ?? null) : null;
  }

  async source(path: string, uid: number): Promise<Buffer | null> {
    return this.withFolder(path, async (c) => {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      return m ? (m.source ?? null) : null;
    });
  }

  async send(raw: Buffer) {
    const s = this.cfg.smtp;
    if (!s) throw new Error("account has no SMTP configuration");
    const t = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.pass },
      tls: this.cfg.imap.insecure_tls ? { rejectUnauthorized: false } : undefined,
    });
    await t.sendMail({ raw, envelope: undefined });
  }

  async close() {
    for (const c of [this.idle, this.work]) {
      if (!c) continue;
      try {
        await c.logout();
      } catch {
        c.close();
      }
    }
    this.idle = this.work = null;
  }
}
