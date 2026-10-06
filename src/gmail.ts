// The only file that speaks the Gmail API. Labels are folders; "ARCHIVE" is a
// virtual folder meaning "no system folder label". Sync is history.list from a
// stored historyId; push is polling until Pub/Sub is configured.
import { OAuthClient } from "./oauth.js";
import { roleFromName, type Adapter, type RemoteFolder, type RemoteMessage, type SyncSink } from "./adapter.js";
import type { Address, Capabilities, Flags, FolderRole, GmailAccountConfig } from "./schema.js";

const SYSTEM: Record<string, FolderRole> = { INBOX: "inbox", SENT: "sent", DRAFT: "drafts", TRASH: "trash", SPAM: "spam" };
const FOLDER_LABELS = new Set(Object.keys(SYSTEM));
const ARCHIVE = "ARCHIVE"; // virtual: in no system folder
const NOT_FOLDERS = new Set(["UNREAD", "STARRED", "IMPORTANT", "CHAT"]);
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "Authentication-Results"];
const PAGE = 500;
const CONCURRENCY = 8;

interface GmailState {
  historyId?: string | null;
}

const header = (m: any, name: string): string | null => {
  const h = (m.payload?.headers ?? []).find((x: any) => x.name.toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : null;
};
const parseAddr = (s: string | null): Address | null => {
  if (!s) return null;
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s) ?? /^\s*([^\s@]+@[^\s@]+)\s*$/.exec(s);
  if (!m) return null;
  const address = (m[2] ?? m[1])!.trim().toLowerCase();
  const name = m[2] ? m[1]?.trim() : undefined;
  return { address, ...(name ? { name } : {}) };
};
const parseAddrs = (s: string | null): Address[] =>
  (s ?? "")
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((x) => parseAddr(x))
    .filter((a): a is Address => !!a);
const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function toRemoteMessage(m: any): RemoteMessage {
  const labels: string[] = m.labelIds ?? [];
  const folders = labels.filter((l) => !NOT_FOLDERS.has(l) && !l.startsWith("CATEGORY_"));
  if (!folders.some((l) => FOLDER_LABELS.has(l))) folders.push(ARCHIVE);
  const refs = (header(m, "References") ?? "").match(/<[^<>\s]+>/g) ?? [];
  const ms = Number(m.internalDate);
  return {
    ref: m.id,
    folderPaths: folders,
    flags: { seen: !labels.includes("UNREAD"), flagged: labels.includes("STARRED"), answered: false, draft: labels.includes("DRAFT") },
    headerMessageId: header(m, "Message-ID"),
    inReplyTo: header(m, "In-Reply-To"),
    references: refs,
    authResults: header(m, "Authentication-Results"),
    subject: header(m, "Subject") ?? "",
    from: parseAddr(header(m, "From")),
    to: parseAddrs(header(m, "To")),
    cc: parseAddrs(header(m, "Cc")),
    date: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString(),
    size: m.sizeEstimate ?? 0,
    // ponytail: format=metadata carries no MIME structure; attachments are known once a body is fetched.
    hasAttachments: false,
    snippet: (m.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    threadHint: m.threadId ?? null,
  };
}

export class GmailAdapter implements Adapter {
  capabilities: Capabilities | null = null;
  private oauth: OAuthClient;
  private base: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private labelNames = new Map<string, string>(); // id -> name

  constructor(private cfg: GmailAccountConfig) {
    const g = cfg.gmail;
    this.base = (g.base_url ?? "https://gmail.googleapis.com").replace(/\/$/, "") + "/gmail/v1/users/me";
    this.oauth = new OAuthClient({
      token_url: g.token_url ?? "https://oauth2.googleapis.com/token",
      client_id: g.client_id,
      client_secret: g.client_secret,
      refresh_token: g.refresh_token,
    });
  }

  private api<T = any>(path: string, init: RequestInit = {}, allow404 = false) {
    return this.oauth.json<T>(`${this.base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }, allow404);
  }

  async connect(): Promise<Capabilities> {
    await this.api("/profile");
    this.capabilities = {
      folders: "labels",
      push: "none", // ponytail: history polling every 30 s; Pub/Sub needs a topic and a public endpoint
      incremental_sync: "history",
      undo_send_seconds: 0,
      server_rules: "gmail_filters",
      max_connections: 15,
      send_limit_per_day: 500,
      threads: "native",
      permanent_delete: true,
      sent_copy: "server",
    };
    return this.capabilities;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const res = await this.api<{ labels: { id: string; name: string; type: string }[] }>("/labels");
    const out: RemoteFolder[] = [];
    this.labelNames.clear();
    for (const l of res?.labels ?? []) {
      this.labelNames.set(l.id, l.name);
      if (NOT_FOLDERS.has(l.id) || l.id.startsWith("CATEGORY_")) continue;
      const role: FolderRole = SYSTEM[l.id] ?? (l.type === "user" ? roleFromName(l.name) ?? "other" : "other");
      out.push({ path: l.id, name: l.name, role });
    }
    out.push({ path: ARCHIVE, name: "Archive", role: "archive" });
    return out;
  }

  // ---------- sync ----------

  async sync(_folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink) {
    const st = state as GmailState;
    if (!st.historyId) return { historyId: await this.fullSync(sink) };
    try {
      return { historyId: await this.deltaSync(st.historyId, sink) };
    } catch (e: any) {
      if (e.status !== 404) throw e; // 404: startHistoryId is older than Gmail keeps (about a week)
      return { historyId: await this.fullSync(sink) };
    }
  }

  private async getMany(ids: string[], sink: SyncSink) {
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]!;
        const m = await this.api(`/messages/${id}?format=metadata&${HEADERS.map((h) => `metadataHeaders=${h}`).join("&")}`, {}, true);
        if (m) sink.seen(toRemoteMessage(m), true);
        else sink.destroyed(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  }

  private async fullSync(sink: SyncSink): Promise<string> {
    const profile = await this.api<{ historyId: string }>("/profile");
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: String(PAGE), includeSpamTrash: "true", ...(pageToken ? { pageToken } : {}) });
      const page = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`);
      await this.getMany((page?.messages ?? []).map((m) => m.id), sink);
      pageToken = page?.nextPageToken;
    } while (pageToken);
    return profile!.historyId;
  }

  private async deltaSync(since: string, sink: SyncSink): Promise<string> {
    let pageToken: string | undefined;
    let newest = since;
    const touched = new Set<string>();
    const deleted = new Set<string>();
    do {
      const q = new URLSearchParams({ startHistoryId: since, maxResults: String(PAGE), ...(pageToken ? { pageToken } : {}) });
      for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) q.append("historyTypes", t);
      const page = await this.api<any>(`/history?${q}`);
      for (const h of page?.history ?? []) {
        for (const x of h.messagesAdded ?? []) touched.add(x.message.id);
        for (const x of h.labelsAdded ?? []) touched.add(x.message.id);
        for (const x of h.labelsRemoved ?? []) touched.add(x.message.id);
        for (const x of h.messagesDeleted ?? []) {
          deleted.add(x.message.id);
          touched.delete(x.message.id);
        }
      }
      if (page?.historyId) newest = page.historyId;
      pageToken = page?.nextPageToken;
    } while (pageToken);
    await this.getMany([...touched], sink);
    for (const id of deleted) sink.destroyed(id);
    return newest;
  }

  // ---------- push: polling ----------

  async watch(_path: string, onWake: (kind: string) => void) {
    this.pollTimer = setInterval(() => onWake("poll"), this.cfg.gmail.poll_seconds * 1000);
  }

  // ---------- actions ----------

  private modify(id: string, add: string[], remove: string[]) {
    return this.api(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });
  }

  async setFlags(_path: string, ref: string, set: Partial<Flags>) {
    const add: string[] = [];
    const remove: string[] = [];
    if (set.seen !== undefined) (set.seen ? remove : add).push("UNREAD");
    if (set.flagged !== undefined) (set.flagged ? add : remove).push("STARRED");
    if (add.length || remove.length) await this.modify(ref, add, remove);
  }

  async move(fromPath: string, ref: string, toPath: string): Promise<string | null> {
    await this.modify(ref, toPath === ARCHIVE ? [] : [toPath], fromPath === ARCHIVE ? [] : [fromPath]);
    return ref;
  }

  async expunge(_path: string, ref: string) {
    await this.api(`/messages/${ref}`, { method: "DELETE" });
  }

  async append(path: string, raw: Buffer, flags: Partial<Flags>): Promise<string | null> {
    if (path === "DRAFT" || flags.draft) {
      const d = await this.api<{ message: { id: string } }>("/drafts", { method: "POST", body: JSON.stringify({ message: { raw: b64url(raw) } }) });
      return d?.message?.id ?? null;
    }
    const labelIds = [...(path === ARCHIVE ? [] : [path]), ...(flags.seen ? [] : ["UNREAD"]), ...(flags.flagged ? ["STARRED"] : [])];
    const m = await this.api<{ id: string }>("/messages?internalDateSource=dateHeader", { method: "POST", body: JSON.stringify({ raw: b64url(raw), labelIds }) });
    return m?.id ?? null;
  }

  async source(_path: string, ref: string): Promise<Buffer | null> {
    const m = await this.api<{ raw: string }>(`/messages/${ref}?format=raw`, {}, true);
    return m?.raw ? fromB64url(m.raw) : null;
  }

  async send(raw: Buffer) {
    await this.api("/messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(raw) }) });
  }

  async close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
