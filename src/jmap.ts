// The only file that speaks JMAP (RFC 8620 core, RFC 8621 mail). JSON over
// HTTP with state strings for sync and an EventSource for push. Dependency-free.
import { roleFromName, type Adapter, type RemoteFolder, type RemoteMessage, type SyncSink } from "./adapter.js";
import type { Address, Capabilities, Flags, FolderRole, JmapAccountConfig } from "./schema.js";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";

const ROLES: Record<string, FolderRole> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  archive: "archive",
  all: "archive",
  junk: "spam",
  trash: "trash",
};
const KEYWORDS: Record<keyof Flags, string> = { seen: "$seen", flagged: "$flagged", answered: "$answered", draft: "$draft" };
const PROPS = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "sentAt", "subject",
  "from", "to", "cc", "messageId", "inReplyTo", "references", "hasAttachment", "preview",
  "header:Authentication-Results:asText",
];

interface Session {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string | null;
  accountId: string;
  capabilities: Record<string, unknown>;
}
interface JmapState {
  emailState?: string | null;
}

const bracket = (s: string | null | undefined) => (s ? (s.startsWith("<") ? s : `<${s}>`) : null);
const addr = (a: { email?: string; name?: string | null } | undefined): Address | null =>
  a?.email ? { address: a.email.toLowerCase(), ...(a.name ? { name: a.name } : {}) } : null;
const addrs = (list: { email?: string; name?: string | null }[] | null | undefined): Address[] =>
  (list ?? []).map(addr).filter((a): a is Address => !!a);

export function toRemoteMessage(e: any): RemoteMessage {
  const kw = e.keywords ?? {};
  return {
    ref: e.id,
    folderPaths: Object.keys(e.mailboxIds ?? {}).filter((k) => e.mailboxIds[k]),
    flags: { seen: !!kw.$seen, flagged: !!kw.$flagged, answered: !!kw.$answered, draft: !!kw.$draft },
    headerMessageId: bracket(e.messageId?.[0]),
    inReplyTo: bracket(e.inReplyTo?.[0]),
    references: (e.references ?? []).map((r: string) => bracket(r)!).filter(Boolean),
    authResults: e["header:Authentication-Results:asText"] ?? null,
    subject: e.subject ?? "",
    from: addr(e.from?.[0]),
    to: addrs(e.to),
    cc: addrs(e.cc),
    date: e.sentAt ?? e.receivedAt ?? new Date().toISOString(),
    size: e.size ?? 0,
    hasAttachments: !!e.hasAttachment,
    snippet: (e.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    threadHint: e.threadId ?? null,
  };
}

export class JmapAdapter implements Adapter {
  capabilities: Capabilities | null = null;
  private session: Session | null = null;
  private mailboxes = new Map<string, { id: string; name: string; role: FolderRole }>();
  private watcher: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: JmapAccountConfig) {}

  private get authHeader(): string {
    const j = this.cfg.jmap;
    if (j.token) return `Bearer ${j.token}`;
    return "Basic " + Buffer.from(`${j.user ?? this.cfg.address}:${j.pass ?? ""}`).toString("base64");
  }

  private async http(url: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(url, { ...init, headers: { authorization: this.authHeader, ...(init.headers ?? {}) } });
    if (r.status === 401) {
      const e: any = new Error(`JMAP authentication failed (${r.status})`);
      e.authenticationFailed = true;
      throw e;
    }
    if (!r.ok) throw new Error(`JMAP ${init.method ?? "GET"} ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  /** One JMAP request. Returns method responses in order; throws on the first error response. */
  private async call(calls: [string, Record<string, unknown>, string][], using = [CORE, MAIL]): Promise<any[]> {
    const s = this.session!;
    const r = await this.http(s.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ using, methodCalls: calls.map(([name, args, id]) => [name, { accountId: s.accountId, ...args }, id]) }),
    });
    const body = (await r.json()) as { methodResponses: [string, any, string][] };
    return body.methodResponses.map(([name, resp]) => {
      if (name === "error") throw Object.assign(new Error(`JMAP error ${resp.type}: ${resp.description ?? ""}`), { jmapType: resp.type });
      return resp;
    });
  }

  async connect(): Promise<Capabilities> {
    const r = await this.http(this.cfg.jmap.url, { redirect: "follow" });
    const j: any = await r.json();
    const accountId = j.primaryAccounts?.[MAIL] ?? Object.keys(j.accounts ?? {})[0];
    if (!accountId) throw new Error("JMAP session has no mail account");
    // A server behind Docker or a proxy may advertise URLs on a hostname only it can resolve.
    // When the advertised host differs from the one we reached, keep our origin and its paths.
    // Plain string handling: a URL parser would percent-encode the {accountId}/{blobId} placeholders.
    const origin = new URL(this.cfg.jmap.url).origin;
    const rebase = (u: string | null | undefined): string | null => {
      if (!u) return null;
      const m = /^(https?:\/\/[^/]+)(.*)$/.exec(u);
      if (!m) return origin + (u.startsWith("/") ? "" : "/") + u; // relative
      return m[1]!.toLowerCase() === origin.toLowerCase() ? u : origin + m[2];
    };
    this.session = {
      apiUrl: rebase(j.apiUrl)!,
      downloadUrl: rebase(j.downloadUrl)!,
      uploadUrl: rebase(j.uploadUrl)!,
      eventSourceUrl: rebase(j.eventSourceUrl),
      accountId,
      capabilities: j.capabilities ?? {},
    };
    this.capabilities = {
      folders: "labels",
      push: this.session.eventSourceUrl ? "jmap" : "none",
      incremental_sync: "delta",
      undo_send_seconds: 0,
      server_rules: "urn:ietf:params:jmap:sieve" in this.session.capabilities ? "sieve" : "none",
      max_connections: 10,
      send_limit_per_day: null,
      threads: "native",
      permanent_delete: true,
      sent_copy: "server",
    };
    return this.capabilities;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const [res] = await this.call([["Mailbox/get", { ids: null, properties: ["id", "name", "role"] }, "m"]]);
    this.mailboxes.clear();
    const out: RemoteFolder[] = [];
    for (const mb of res.list as { id: string; name: string; role: string | null }[]) {
      const role: FolderRole = (mb.role ? ROLES[mb.role] : undefined) ?? roleFromName(mb.name) ?? "other";
      this.mailboxes.set(mb.id, { id: mb.id, name: mb.name, role });
      out.push({ path: mb.id, name: mb.name, role });
    }
    return out;
  }

  private byRole(role: FolderRole): string | undefined {
    for (const m of this.mailboxes.values()) if (m.role === role) return m.id;
    return undefined;
  }

  // ---------- sync (account-wide; the folder subset is irrelevant for JMAP) ----------

  async sync(_folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink) {
    const st = state as JmapState;
    if (!st.emailState) return { emailState: await this.fullSync(sink) };
    try {
      return { emailState: await this.deltaSync(st.emailState, sink) };
    } catch (e: any) {
      if (e.jmapType !== "cannotCalculateChanges") throw e;
      // ponytail: a full pass re-links and re-flags everything, but a destroy we missed stays until a restart.
      return { emailState: await this.fullSync(sink) };
    }
  }

  private async fullSync(sink: SyncSink): Promise<string> {
    let position = 0;
    let state: string | null = null;
    for (;;) {
      const [q, g] = await this.call([
        ["Email/query", { sort: [{ property: "receivedAt", isAscending: true }], position, limit: 200 }, "q"],
        ["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: PROPS }, "g"],
      ]);
      state ??= g.state;
      for (const e of g.list) sink.seen(toRemoteMessage(e), true);
      if (q.ids.length < 200) break;
      position += q.ids.length;
    }
    return state!;
  }

  private async deltaSync(since: string, sink: SyncSink): Promise<string> {
    let state = since;
    for (;;) {
      const [ch] = await this.call([["Email/changes", { sinceState: state, maxChanges: 500 }, "c"]]);
      const ids = [...new Set([...(ch.created as string[]), ...(ch.updated as string[])])];
      for (let i = 0; i < ids.length; i += 200) {
        const [g] = await this.call([["Email/get", { ids: ids.slice(i, i + 200), properties: PROPS }, "g"]]);
        for (const e of g.list) sink.seen(toRemoteMessage(e), true);
        for (const id of g.notFound ?? []) sink.destroyed(id);
      }
      for (const id of ch.destroyed as string[]) sink.destroyed(id);
      state = ch.newState;
      if (!ch.hasMoreChanges) return state;
    }
  }

  // ---------- push ----------

  async watch(_path: string, onWake: (kind: string) => void, onClose: (err?: Error) => void) {
    const url = this.session?.eventSourceUrl;
    if (url) {
      const ok = await this.eventSource(url, onWake, onClose);
      if (ok) return;
    }
    // No usable EventSource: poll. The runner also ticks every 2 minutes regardless.
    this.pollTimer = setInterval(() => onWake("poll"), 20_000);
  }

  /** Minimal SSE reader over fetch. Resolves true once the stream is open, false when it cannot be opened. */
  private async eventSource(template: string, onWake: (kind: string) => void, onClose: (err?: Error) => void): Promise<boolean> {
    const url = template.replace("{types}", "Email,Mailbox").replace("{closeafter}", "no").replace("{ping}", "30");
    const ctrl = new AbortController();
    this.watcher = ctrl;
    let r: Response;
    try {
      r = await fetch(url, { headers: { authorization: this.authHeader, accept: "text/event-stream" }, signal: ctrl.signal });
      if (!r.ok || !r.body) return false;
    } catch {
      return false;
    }
    (async () => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^event:\s*state/m.test(frame)) onWake("state");
          }
        }
        if (!ctrl.signal.aborted) onClose();
      } catch (e: any) {
        if (!ctrl.signal.aborted) onClose(e);
      }
    })();
    return true;
  }

  // ---------- actions ----------

  async setFlags(_path: string, ref: string, set: Partial<Flags>) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) if (v !== undefined) patch[`keywords/${KEYWORDS[k as keyof Flags]}`] = v ? true : null;
    await this.set({ [ref]: patch });
  }

  async move(fromPath: string, ref: string, toPath: string): Promise<string | null> {
    await this.set({ [ref]: { [`mailboxIds/${toPath}`]: true, [`mailboxIds/${fromPath}`]: null } });
    return ref; // JMAP ids are account-wide, a move keeps the id
  }

  async setFolders(ref: string, folderPaths: string[], currentPaths: string[]) {
    const patch: Record<string, unknown> = {};
    for (const p of folderPaths) if (!currentPaths.includes(p)) patch[`mailboxIds/${p}`] = true;
    for (const p of currentPaths) if (!folderPaths.includes(p)) patch[`mailboxIds/${p}`] = null;
    if (Object.keys(patch).length) await this.set({ [ref]: patch });
  }

  async expunge(_path: string, ref: string) {
    const [res] = await this.call([["Email/set", { destroy: [ref] }, "s"]]);
    if (res.notDestroyed?.[ref]) throw new Error(`JMAP destroy failed: ${res.notDestroyed[ref].type}`);
  }

  private async set(update: Record<string, unknown>) {
    const [res] = await this.call([["Email/set", { update }, "s"]]);
    const failed = Object.entries(res.notUpdated ?? {})[0];
    if (failed) throw new Error(`JMAP update failed for ${failed[0]}: ${(failed[1] as any).type}`);
  }

  private async upload(raw: Buffer): Promise<string> {
    const s = this.session!;
    const r = await this.http(s.uploadUrl.replace("{accountId}", s.accountId), {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: new Uint8Array(raw),
    });
    return ((await r.json()) as { blobId: string }).blobId;
  }

  async append(path: string, raw: Buffer, flags: Partial<Flags>): Promise<string | null> {
    const blobId = await this.upload(raw);
    const keywords: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(flags)) if (v) keywords[KEYWORDS[k as keyof Flags]] = true;
    const [res] = await this.call([["Email/import", { emails: { e: { blobId, mailboxIds: { [path]: true }, keywords } } }, "i"]]);
    if (res.notCreated?.e) throw new Error(`JMAP import failed: ${res.notCreated.e.type}`);
    return res.created?.e?.id ?? null;
  }

  async source(_path: string, ref: string): Promise<Buffer | null> {
    const [g] = await this.call([["Email/get", { ids: [ref], properties: ["blobId"] }, "g"]]);
    const blobId = g.list?.[0]?.blobId;
    if (!blobId) return null;
    const s = this.session!;
    const url = s.downloadUrl
      .replace("{accountId}", s.accountId)
      .replace("{blobId}", blobId)
      .replace("{name}", "message.eml")
      .replace("{type}", encodeURIComponent("message/rfc822"));
    const r = await this.http(url);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Import into Drafts, submit, and let the server file it in Sent (sent_copy: server). */
  async send(raw: Buffer) {
    const drafts = this.byRole("drafts");
    const sent = this.byRole("sent");
    if (!drafts || !sent) throw new Error("JMAP account has no drafts or sent mailbox");
    const emailId = await this.append(drafts, raw, { draft: true, seen: true });
    if (!emailId) throw new Error("JMAP import for send returned no id");
    const [ids] = await this.call([["Identity/get", { ids: null }, "i"]], [CORE, MAIL, SUBMISSION]);
    const identity =
      (ids.list as { id: string; email: string }[]).find((i) => i.email.toLowerCase() === this.cfg.address.toLowerCase()) ?? ids.list[0];
    if (!identity) throw new Error("JMAP account has no sending identity");
    const [res] = await this.call(
      [[
        "EmailSubmission/set",
        {
          create: { s: { identityId: identity.id, emailId } },
          onSuccessUpdateEmail: { "#s": { [`mailboxIds/${sent}`]: true, [`mailboxIds/${drafts}`]: null, "keywords/$draft": null } },
        },
        "sub",
      ]],
      [CORE, MAIL, SUBMISSION],
    );
    if (res.notCreated?.s) throw new Error(`JMAP submission failed: ${res.notCreated.s.type} ${res.notCreated.s.description ?? ""}`);
  }

  async close() {
    this.watcher?.abort();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
