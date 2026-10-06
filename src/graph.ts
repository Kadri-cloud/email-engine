// The only file that speaks Microsoft Graph mail. Folders are folders; sync is
// a delta query per folder; ids are immutable across moves (Prefer IdType).
// Push is polling until change notifications (webhooks) are configured.
import { OAuthClient } from "./oauth.js";
import { roleFromName, type Adapter, type RemoteFolder, type RemoteMessage, type SyncSink } from "./adapter.js";
import type { Address, Capabilities, Flags, FolderRole, GraphAccountConfig } from "./schema.js";

const WELL_KNOWN: Record<string, FolderRole> = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  junkemail: "spam",
  archive: "archive",
};
const SELECT = [
  "id", "conversationId", "parentFolderId", "isRead", "isDraft", "flag", "subject", "from", "toRecipients", "ccRecipients",
  "receivedDateTime", "sentDateTime", "bodyPreview", "hasAttachments", "internetMessageId", "internetMessageHeaders",
].join(",");
const PREFER = 'IdType="ImmutableId", odata.maxpagesize=100';

interface GraphState {
  folders?: Record<string, { deltaLink: string }>;
}

const addr = (a: { emailAddress?: { address?: string; name?: string } } | undefined): Address | null =>
  a?.emailAddress?.address ? { address: a.emailAddress.address.toLowerCase(), ...(a.emailAddress.name ? { name: a.emailAddress.name } : {}) } : null;
const addrs = (list: any[] | undefined): Address[] => (list ?? []).map(addr).filter((a): a is Address => !!a);
const header = (m: any, name: string): string | null => {
  const h = (m.internetMessageHeaders ?? []).find((x: any) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : null;
};

export function toRemoteMessage(m: any, folderPath: string): RemoteMessage {
  const refs = (header(m, "References") ?? "").match(/<[^<>\s]+>/g) ?? [];
  return {
    ref: m.id,
    folderPaths: [folderPath],
    flags: { seen: !!m.isRead, flagged: m.flag?.flagStatus === "flagged", answered: false, draft: !!m.isDraft },
    headerMessageId: m.internetMessageId ?? null,
    inReplyTo: header(m, "In-Reply-To"),
    references: refs,
    authResults: header(m, "Authentication-Results"),
    subject: m.subject ?? "",
    from: addr(m.from),
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    date: m.sentDateTime ?? m.receivedDateTime ?? new Date().toISOString(),
    size: 0,
    hasAttachments: !!m.hasAttachments,
    snippet: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    threadHint: m.conversationId ?? null,
  };
}

export class GraphAdapter implements Adapter {
  capabilities: Capabilities | null = null;
  private oauth: OAuthClient;
  private base: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private roles = new Map<string, FolderRole>(); // folder id -> role from well-known lookups

  constructor(private cfg: GraphAccountConfig) {
    const g = cfg.graph;
    this.base = (g.base_url ?? "https://graph.microsoft.com").replace(/\/$/, "") + "/v1.0/me";
    this.oauth = new OAuthClient({
      token_url: g.token_url ?? `https://login.microsoftonline.com/${g.tenant}/oauth2/v2.0/token`,
      client_id: g.client_id,
      client_secret: g.client_secret,
      refresh_token: g.refresh_token,
      scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access",
    });
  }

  private api<T = any>(pathOrUrl: string, init: RequestInit = {}, allow404 = false) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    return this.oauth.json<T>(url, { ...init, headers: { "content-type": "application/json", prefer: PREFER, ...(init.headers ?? {}) } }, allow404);
  }

  async connect(): Promise<Capabilities> {
    await this.api("/mailFolders/inbox?$select=id");
    this.capabilities = {
      folders: "folders",
      push: "none", // ponytail: delta polling every 30 s; change notifications need a public HTTPS endpoint
      incremental_sync: "delta",
      undo_send_seconds: 0,
      server_rules: "none",
      max_connections: 4,
      send_limit_per_day: null,
      threads: "hint",
      permanent_delete: true,
      sent_copy: "server",
    };
    return this.capabilities;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    this.roles.clear();
    for (const [name, role] of Object.entries(WELL_KNOWN)) {
      const f = await this.api<{ id: string }>(`/mailFolders/${name}?$select=id`, {}, true);
      if (f?.id) this.roles.set(f.id, role);
    }
    // ponytail: top-level folders only; child folders need a recursive childFolders walk.
    const out: RemoteFolder[] = [];
    let url: string | null = `/mailFolders?$top=250&$select=id,displayName`;
    while (url) {
      const page: any = await this.api(url);
      for (const f of page?.value ?? []) {
        const role: FolderRole = this.roles.get(f.id) ?? roleFromName(f.displayName) ?? "other";
        out.push({ path: f.id, name: f.displayName, role });
      }
      url = page?.["@odata.nextLink"] ?? null;
    }
    return out;
  }

  // ---------- sync: one delta query per folder ----------

  async sync(folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink) {
    const st = { ...(((state as GraphState).folders ?? {}) as Record<string, { deltaLink: string }>) };
    for (const f of folders) {
      let url: string | null = st[f.path]?.deltaLink ?? `${this.base}/mailFolders/${f.path}/messages/delta?$select=${SELECT}`;
      let deltaLink: string | null = null;
      while (url) {
        let page: any;
        try {
          page = await this.api(url);
        } catch (e: any) {
          if (e.status === 410 && st[f.path]) {
            // Delta token expired (Graph keeps them for a bounded time): start this folder over.
            url = `${this.base}/mailFolders/${f.path}/messages/delta?$select=${SELECT}`;
            delete st[f.path];
            continue;
          }
          throw e;
        }
        for (const m of page?.value ?? []) {
          if (m["@removed"]) sink.gone(f.path, m.id);
          else sink.seen(toRemoteMessage(m, f.path), false);
        }
        deltaLink = page?.["@odata.deltaLink"] ?? null;
        url = page?.["@odata.nextLink"] ?? null;
      }
      if (deltaLink) st[f.path] = { deltaLink };
    }
    return { folders: st };
  }

  // ---------- push: polling ----------

  async watch(_path: string, onWake: (kind: string) => void) {
    this.pollTimer = setInterval(() => onWake("poll"), this.cfg.graph.poll_seconds * 1000);
  }

  // ---------- actions ----------

  async setFlags(_path: string, ref: string, set: Partial<Flags>) {
    const patch: Record<string, unknown> = {};
    if (set.seen !== undefined) patch.isRead = set.seen;
    if (set.flagged !== undefined) patch.flag = { flagStatus: set.flagged ? "flagged" : "notFlagged" };
    if (Object.keys(patch).length) await this.api(`/messages/${ref}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  async move(_fromPath: string, ref: string, toPath: string): Promise<string | null> {
    const m = await this.api<{ id: string }>(`/messages/${ref}/move`, { method: "POST", body: JSON.stringify({ destinationId: toPath }) });
    return m?.id ?? ref; // immutable ids: the same id, but take the server's word for it
  }

  async copy(_fromPath: string, ref: string, toPath: string): Promise<string | null> {
    // A Graph copy is a new message with its own id; the engine merges it by Message-ID into one message with two links.
    const m = await this.api<{ id: string }>(`/messages/${ref}/copy`, { method: "POST", body: JSON.stringify({ destinationId: toPath }) });
    return m?.id ?? null;
  }

  async expunge(path: string, ref: string) {
    // Graph's DELETE moves a message to Deleted Items unless it is already there, where it is permanent.
    // Immutable ids survive the move, so: move into Deleted Items first, then delete.
    const trash = [...this.roles.entries()].find(([, role]) => role === "trash")?.[0];
    if (trash && path !== trash) await this.api(`/messages/${ref}/move`, { method: "POST", body: JSON.stringify({ destinationId: trash }) });
    await this.api(`/messages/${ref}`, { method: "DELETE" });
  }

  async append(path: string, raw: Buffer, flags: Partial<Flags>): Promise<string | null> {
    const m = await this.api<{ id: string }>(`/mailFolders/${path}/messages`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: raw.toString("base64"),
    });
    if (m?.id && (flags.seen || flags.flagged)) await this.setFlags(path, m.id, { seen: flags.seen, flagged: flags.flagged });
    return m?.id ?? null;
  }

  async source(_path: string, ref: string): Promise<Buffer | null> {
    const r = await this.oauth.fetch(`${this.base}/messages/${ref}/$value`, { headers: { prefer: PREFER } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET $value -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async send(raw: Buffer) {
    await this.api("/sendMail", { method: "POST", headers: { "content-type": "text/plain" }, body: raw.toString("base64") });
  }

  async close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
