// The only file that speaks IMAP and SMTP. Two connections per account: one
// parked in IDLE on the inbox, one working connection for syncs and actions.
// Everything above this file sees folders, messages, flags and refs only.
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type MessageStructureObject } from "imapflow";
import nodemailer from "nodemailer";
import { roleFromName, type Adapter, type RemoteFolder, type RemoteMessage, type SyncSink } from "./adapter.js";
import type { Address, Capabilities, Flags, FolderRole, ImapAccountConfig } from "./schema.js";

interface FolderState {
  uidvalidity: number;
  uidnext: number;
  modseq: string | null; // bigint as string, JSON-safe
}
interface Snapshot {
  uidValidity: number;
  uidNext: number;
  highestModseq: bigint | null;
  exists: number;
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
const SNIPPET_BYTES = 2048;
const QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  headers: HEADERS,
  bodyParts: [{ key: "1", start: 0, maxLength: SNIPPET_BYTES }],
};

export function toFlags(set: Set<string> | undefined): Flags {
  return {
    seen: !!set?.has("\\Seen"),
    flagged: !!set?.has("\\Flagged"),
    answered: !!set?.has("\\Answered"),
    draft: !!set?.has("\\Draft"),
  };
}
const flagList = (set: Partial<Flags>, value: boolean) =>
  (Object.keys(FLAG_NAMES) as (keyof Flags)[]).filter((k) => set[k] === value).map((k) => FLAG_NAMES[k]);

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

export function toRemoteMessage(m: FetchMessageObject, path: string): RemoteMessage {
  const h = parseHeaders(m.headers);
  const env = m.envelope ?? {};
  const refs = (h["references"] ?? "").match(/<[^<>\s]+>/g) ?? [];
  const date = env.date ? new Date(env.date) : m.internalDate ? new Date(m.internalDate) : new Date();
  return {
    ref: String(m.uid),
    folderPaths: [path],
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
    snippet: snippetFrom(m.bodyParts?.get("1"), m.bodyStructure),
    threadHint: m.threadId ?? null,
  };
}

const samePath = (a: string, b: string) => a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");

export class ImapAdapter implements Adapter {
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
      sent_copy: gmail ? "server" : "client", // Gmail files sent mail itself; everyone else needs an APPEND
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
      const role: FolderRole = (f.specialUse ? SPECIAL[f.specialUse] : undefined) ?? roleFromName(f.name) ?? "other";
      out.push({ path: f.path, name: f.name, role });
    }
    return out;
  }

  /**
   * Run `fn` with the folder selected and locked, then deselect it. Helpers inside take the client; they never re-lock.
   * The work connection never keeps a mailbox selected between calls: a long-lived selection can be served a
   * stale view (Dovecot answers UID FETCH from the session's snapshot until it chooses to sync), so every call
   * re-selects and sees the server's truth. Deselection is always via a read-only EXAMINE + CLOSE, because CLOSE
   * on a read-write selection would expunge messages another client flagged \Deleted.
   */
  private async withFolder<T>(path: string, fn: (c: ImapFlow, snap: Snapshot) => Promise<T>, readOnly = true): Promise<T> {
    const c = await this.client();
    const lock = await c.getMailboxLock(path, { readOnly });
    try {
      const mb = c.mailbox;
      if (!mb) throw new Error(`mailbox ${path} did not open`);
      return await fn(c, {
        uidValidity: Number(mb.uidValidity),
        uidNext: mb.uidNext,
        highestModseq: mb.highestModseq ?? null,
        exists: mb.exists,
      });
    } finally {
      // Deselect while still holding the lock, so no other caller can select and start fetching
      // between our release and our CLOSE. The lock is a client-side queue; open/close do not take it.
      try {
        if (!readOnly) await c.mailboxOpen(path, { readOnly: true });
        await c.mailboxClose();
      } catch {
        /* deselect is best effort; the next open re-selects anyway */
      }
      lock.release();
    }
  }

  // ---------- sync ----------

  async sync(folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink) {
    const st = { ...((state.folders as Record<string, FolderState> | undefined) ?? {}) };
    for (const f of folders) {
      st[f.path] = await this.syncFolder(f.path, st[f.path], sink);
    }
    return { folders: st };
  }

  private syncFolder(path: string, prev: FolderState | undefined, sink: SyncSink): Promise<FolderState> {
    return this.withFolder(path, async (c, snap) => {
      let fs = prev;
      if (fs && fs.uidvalidity !== snap.uidValidity) {
        // Server renumbered the folder. Forget refs silently; the refetch re-links by Message-ID.
        sink.resetFolder(path);
        fs = undefined;
      }
      const initial = !fs;
      const qresync = ((c as any).enabled as Set<string> | undefined)?.has("QRESYNC") ?? false;

      // New messages: the server decides what is new via an open-ended range from the last known uid.
      // Cached UIDNEXT on a long-lived connection only refreshes on SELECT, so it is never trusted here.
      const fromUid = fs?.uidnext ?? 1;
      const maxUid = initial && snap.exists === 0 ? null : await this.fetchFrom(c, path, fromUid, (m) => sink.seen(m, false));
      let uidnext = maxUid !== null ? maxUid + 1 : (fs?.uidnext ?? snap.uidNext);
      if (initial) uidnext = Math.max(uidnext, snap.uidNext);

      // Flag changes and, with QRESYNC, expunges: one CHANGEDSINCE fetch carries both.
      let modseq: bigint | null = fs?.modseq ? BigInt(fs.modseq) : null;
      let expungesCovered = false;
      if (initial) {
        modseq = snap.highestModseq; // fresh from this connection's SELECT
      } else if (modseq !== null && snap.highestModseq !== null) {
        const { changes, vanished, maxModseq } = await this.changedSince(c, path, modseq);
        for (const ch of changes) sink.flags(path, String(ch.uid), ch.flags);
        for (const uid of vanished) sink.gone(path, String(uid));
        expungesCovered = qresync;
        if (maxModseq !== null && maxModseq > modseq) modseq = maxModseq;
      } else if (snap.exists <= 5000) {
        // ponytail: full flag scan for small folders without CONDSTORE; large ones only learn flags on restart.
        for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) sink.flags(path, String(m.uid), toFlags(m.flags));
      }

      // Expunges without QRESYNC: compare uid sets.
      if (!initial && !expungesCovered) {
        const known = sink.knownRefs(path);
        if (known.length) {
          const r = await c.search({ all: true }, { uid: true });
          const server = new Set(Array.isArray(r) ? r : []);
          for (const k of known) if (!server.has(Number(k.ref))) sink.gone(path, k.ref);
        }
      }

      return { uidvalidity: snap.uidValidity, uidnext, modseq: modseq === null ? null : modseq.toString() };
    });
  }

  /** Every message with uid >= fromUid. Returns the highest uid seen, or null when nothing was new. */
  private async fetchFrom(c: ImapFlow, path: string, fromUid: number, onMessage: (m: RemoteMessage) => void): Promise<number | null> {
    let maxUid: number | null = null;
    for await (const m of c.fetch(`${Math.max(1, fromUid)}:*`, QUERY, { uid: true })) {
      if (m.uid < fromUid) continue; // "n:*" always returns at least the last message
      maxUid = Math.max(maxUid ?? 0, m.uid);
      onMessage(toRemoteMessage(m, path));
    }
    return maxUid;
  }

  /**
   * Flag changes since a modseq. With QRESYNC enabled the library adds VANISHED to the fetch,
   * and the server reports uids expunged since that modseq as expunge events, collected here.
   */
  private async changedSince(c: ImapFlow, path: string, since: bigint) {
    const changes: { uid: number; flags: Flags }[] = [];
    const vanished: number[] = [];
    let maxModseq: bigint | null = null;
    const onExpunge = (e: { path: string; uid?: number | undefined; vanished: boolean }) => {
      if (e.uid && samePath(e.path, path)) vanished.push(e.uid);
    };
    c.on("expunge", onExpunge);
    try {
      for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true, changedSince: since })) {
        changes.push({ uid: m.uid, flags: toFlags(m.flags) });
        if (m.modseq && (maxModseq === null || m.modseq > maxModseq)) maxModseq = m.modseq;
      }
    } finally {
      c.off("expunge", onExpunge);
    }
    return { changes, vanished, maxModseq };
  }

  // ---------- push ----------

  async watch(path: string, onWake: (kind: string) => void, onClose: (err?: Error) => void) {
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

  // ---------- actions ----------

  async setFlags(path: string, ref: string, set: Partial<Flags>) {
    await this.withFolder(
      path,
      async (c) => {
        const add = flagList(set, true);
        const remove = flagList(set, false);
        if (add.length) await c.messageFlagsAdd(ref, add, { uid: true });
        if (remove.length) await c.messageFlagsRemove(ref, remove, { uid: true });
      },
      false,
    );
  }

  async move(fromPath: string, ref: string, toPath: string): Promise<string | null> {
    return this.withFolder(
      fromPath,
      async (c) => {
        const r = await c.messageMove(ref, toPath, { uid: true });
        const uid = r ? r.uidMap?.get(Number(ref)) : undefined;
        return uid ? String(uid) : null;
      },
      false,
    );
  }

  async expunge(path: string, ref: string) {
    await this.withFolder(
      path,
      async (c) => {
        await c.messageDelete(ref, { uid: true });
      },
      false,
    );
  }

  async append(path: string, raw: Buffer, flags: Partial<Flags>): Promise<string | null> {
    const c = await this.client();
    const r = await c.append(path, raw, flagList(flags, true));
    return r && r.uid ? String(r.uid) : null;
  }

  async source(path: string, ref: string): Promise<Buffer | null> {
    return this.withFolder(path, async (c) => {
      const m = await c.fetchOne(ref, { source: true }, { uid: true });
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
