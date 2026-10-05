// The engine: one runner per account turns a mailbox into events in the log,
// and the action API turns requests into journaled, reversible changes.
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapAdapter, type RemoteMessage } from "./imap.js";
import {
  ActionParams,
  type AccountConfig,
  type ActionRequest,
  type Address,
  type Flags,
  type Trust,
  HIGH_RISK,
} from "./schema.js";
import { mintMessageId, newId, now, type MessageRow, type Store } from "./store.js";
import { normalizeMessageId, normalizeSubject } from "./threading.js";

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: now(), msg, ...extra }));
const debug = process.env.ENGINE_DEBUG ? log : () => {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

export class ScopeError extends Error {}

type Folder = ReturnType<Store["upsertFolder"]>;

/** DMARC result plus prior correspondence -> trust level. No model involved. */
export function trustFor(authResults: string | null, seenBefore: boolean): Trust {
  const a = (authResults ?? "").toLowerCase();
  if (/dmarc=fail/.test(a)) return "suspicious";
  if (/dmarc=pass/.test(a) || /dkim=pass/.test(a)) return seenBefore ? "verified" : "known";
  return "unverified";
}

class AccountRunner {
  adapter: ImapAdapter;
  folders = new Map<string, Folder>(); // path -> folder row
  private running = false;
  private wake: (() => void) | null = null;
  private dirty = new Set<string>();

  constructor(
    public id: string,
    public config: Extract<AccountConfig, { provider: "imap" }>,
    private engine: Engine,
  ) {
    this.adapter = new ImapAdapter(config);
  }

  get store() {
    return this.engine.store;
  }

  folderByRole(role: string): Folder | undefined {
    for (const f of this.folders.values()) if (f.role === role) return f;
    return undefined;
  }

  async start() {
    this.running = true;
    let attempt = 0;
    while (this.running) {
      try {
        await this.runOnce();
        attempt = 0;
      } catch (e: any) {
        attempt++;
        const authFailed = e?.authenticationFailed || /auth/i.test(e?.responseText ?? "");
        if (authFailed && attempt >= 3) {
          this.engine.status(this.id, "auth_expired", null, String(e?.responseText ?? e?.message));
          log("auth failed, stopping account", { account: this.id });
          return;
        }
        const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8)) * (0.5 + Math.random());
        this.engine.status(this.id, "disconnected", null, String(e?.message ?? e));
        log("account error, retrying", { account: this.id, attempt, delay: Math.round(delay), error: String(e?.message ?? e) });
        await this.adapter.close().catch(() => {});
        await sleep(delay);
      }
    }
  }

  async stop() {
    this.running = false;
    this.wake?.();
    await this.adapter.close().catch(() => {});
  }

  private async runOnce() {
    const caps = await this.adapter.connect();
    this.engine.status(this.id, "syncing", caps);

    for (const f of await this.adapter.listFolders()) {
      this.folders.set(f.path, this.store.upsertFolder(this.id, f.path, f.role));
    }
    for (const f of this.folders.values()) await this.syncFolder(f);
    this.engine.status(this.id, "connected", caps, now());

    const inbox = this.folderByRole("inbox");
    let idleClosed: Promise<void> | null = null;
    if (inbox) {
      idleClosed = new Promise<void>((resolve) => {
        this.adapter
          .watch(
            inbox.path,
            (kind) => {
              debug("idle wake", { account: this.id, kind, waiting: !!this.wake });
              this.dirty.add(inbox.path);
              this.wake?.();
            },
            (err) => {
              debug("idle closed", { account: this.id, error: err?.message });
              resolve();
            },
          )
          .catch((e) => {
            debug("idle failed to start", { account: this.id, error: String(e?.message ?? e) });
            resolve();
          });
      });
    }

    // Poll loop: inbox on wake or every 2 min as a safety net, other folders every 10 min.
    let lastFull = Date.now();
    while (this.running) {
      // A push that lands while we are mid-sync is kept in `dirty`; only wait when nothing is pending.
      let reason: "wake" | "tick" | "closed" = "wake";
      if (this.dirty.size === 0) {
        reason = await Promise.race([
          new Promise<"wake">((r) => (this.wake = () => r("wake"))),
          sleep(120_000).then(() => "tick" as const),
          idleClosed?.then(() => "closed" as const) ?? new Promise<never>(() => {}),
        ]);
        this.wake = null;
      }
      if (!this.running) return;
      if (reason === "closed") throw new Error("idle connection closed");

      const due = new Set(this.dirty);
      this.dirty.clear();
      if (inbox) due.add(inbox.path);
      debug("poll", { account: this.id, reason, due: [...due] });
      if (Date.now() - lastFull > 600_000) {
        for (const p of this.folders.keys()) due.add(p);
        lastFull = Date.now();
      }
      for (const p of due) {
        const f = this.folders.get(p);
        if (f) await this.syncFolder(f);
      }
      this.engine.touch(this.id);
    }
  }

  /** Bring one folder up to date and emit exactly the events that describe what changed. */
  async syncFolder(folder: Folder) {
    const snap = await this.adapter.snapshot(folder.path);

    if (folder.uidvalidity !== null && folder.uidvalidity !== snap.uidValidity) {
      // Server renumbered the folder. Forget uids, keep messages; the refetch
      // re-links by Message-ID so nothing is emitted twice.
      log("uidvalidity changed, full resync", { account: this.id, folder: folder.path });
      for (const { message_id } of this.store.uidsInFolder(folder.id)) this.store.unlinkFolder(message_id, folder.id);
      folder.uidnext = null;
      folder.modseq = null;
    }

    // New messages. The server decides what is new: an open-ended range from the last known uid.
    // Cached UIDNEXT/HIGHESTMODSEQ on a long-lived connection only refresh on SELECT, so they are never trusted here.
    const fromUid = folder.uidnext ?? 1;
    const isInitial = folder.uidnext === null;
    const maxUid =
      isInitial && snap.exists === 0
        ? null // nothing to fetch from an empty folder, and "1:*" on one is a BAD on some servers
        : await this.adapter.fetchFrom(folder.path, fromUid, async (batch) => {
            for (const m of batch) this.ingest(folder, m, snap.uidValidity);
          });
    let nextUid = maxUid !== null ? maxUid + 1 : (folder.uidnext ?? snap.uidNext);
    if (isInitial) nextUid = Math.max(nextUid, snap.uidNext);

    // Flag changes.
    let modseq: bigint | null = folder.modseq === null ? null : BigInt(folder.modseq);
    if (isInitial) {
      modseq = snap.highestModseq; // fresh from this connection's SELECT
    } else if (modseq !== null && snap.highestModseq !== null) {
      const { changes, maxModseq } = await this.adapter.fetchChangedFlags(folder.path, modseq);
      for (const ch of changes) this.applyRemoteFlags(folder, ch.uid, ch.flags);
      if (maxModseq !== null && maxModseq > modseq) modseq = maxModseq;
    } else if (snap.exists <= 5000) {
      // ponytail: full flag scan for small folders without CONDSTORE; large ones only learn flags on restart.
      for (const ch of await this.adapter.fetchAllFlags(folder.path)) this.applyRemoteFlags(folder, ch.uid, ch.flags);
    }

    // Expunges: compare uid sets.
    // ponytail: UID SEARCH ALL on every poll; QRESYNC VANISHED makes this free, wire it when the suite covers it.
    if (folder.uidnext !== null) {
      const known = this.store.uidsInFolder(folder.id);
      if (known.length) {
        const server = await this.adapter.allUids(folder.path);
        for (const k of known) if (!server.has(k.uid)) this.removeFromFolder(folder, k.message_id);
      }
    }

    this.store.setFolderState(folder.id, snap.uidValidity, nextUid, modseq === null ? null : Number(modseq));
    folder.uidvalidity = snap.uidValidity;
    folder.uidnext = nextUid;
    folder.modseq = modseq === null ? null : Number(modseq);
  }

  private ingest(folder: Folder, m: RemoteMessage, uidValidity: number) {
    const headerId = normalizeMessageId(m.headerMessageId);
    const id = mintMessageId(this.id, headerId, `${folder.id}:${uidValidity}:${m.uid}`);
    const existing = this.store.messageById(id);

    if (existing) {
      const before = this.store.foldersOfMessage(id).map((f) => f.folder_id);
      if (before.includes(folder.id)) return;
      this.store.linkFolder(id, folder.id, m.uid);
      this.engine.emit("message.updated", this.id, m.date, {
        message_id: id,
        thread_id: existing.thread_id,
        folder_ids: [...before, folder.id],
        changes: { folder_ids: { before, after: [...before, folder.id] } },
      });
      return;
    }

    const seenBefore = m.from ? this.store.senderSeen(this.id, m.from.address) : false;
    const refs = m.references.map(normalizeMessageId).filter((r): r is string => !!r);
    const inReplyTo = normalizeMessageId(m.inReplyTo);
    const row: MessageRow = {
      id,
      account: this.id,
      thread_id: this.resolveThread(id, headerId, [...refs, ...(inReplyTo ? [inReplyTo] : [])], m.subject, m.date),
      header_message_id: headerId,
      in_reply_to: inReplyTo,
      refs,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date,
      flags: m.flags,
      trust: trustFor(m.authResults, seenBefore),
      size: m.size,
      snippet: m.snippet,
      has_attachments: m.hasAttachments,
    };
    const cursor = this.store.transaction(() => {
      this.store.insertMessage(row);
      this.store.linkFolder(id, folder.id, m.uid);
      this.store.upsertThread(row.thread_id, this.id, normalizeSubject(m.subject).base, m.date);
      return this.engine.emit("message.received", this.id, m.date, {
        message_id: id,
        thread_id: row.thread_id,
        folder_ids: [folder.id],
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        flags: m.flags,
        trust: row.trust,
        has_attachments: m.hasAttachments,
        size: m.size,
      });
    });
    this.emitThread(row.thread_id, cursor);
  }

  /** Incremental threading: by reference, then by orphans that referenced us, then by reply subject. */
  private resolveThread(id: string, headerId: string | null, refs: string[], subject: string, date: string): string {
    for (const r of refs) {
      const parent = this.store.messageByHeaderId(this.id, r);
      if (parent) return parent.thread_id;
    }
    let thread: string | null = null;
    if (headerId) {
      const orphans = this.store.messagesReferencing(this.id, headerId);
      const threads = new Set(orphans.map((o) => o.thread_id));
      const first = [...threads][0];
      if (first) {
        thread = first;
        for (const t of threads) if (t !== first) this.store.rethread(t, first);
      }
    }
    if (!thread) {
      const { base, isReply } = normalizeSubject(subject);
      if (isReply && base) {
        thread = this.store.threadBySubject(this.id, base, new Date(Date.parse(date) - 30 * DAY).toISOString());
      }
    }
    return thread ?? `thr_${id.slice(4)}`;
  }

  private emitThread(threadId: string, causeCursor: number) {
    const msgs = this.store.threadMessages(threadId);
    const people = new Map<string, Address>();
    for (const m of msgs) for (const a of [m.from, ...m.to, ...m.cc]) if (a) people.set(a.address, a);
    this.engine.emit("thread.updated", this.id, msgs.at(-1)?.date ?? now(), {
      thread_id: threadId,
      message_count: msgs.length,
      participants: [...people.values()],
      last_activity: msgs.at(-1)?.date ?? now(),
      cause_cursor: causeCursor,
    });
  }

  private applyRemoteFlags(folder: Folder, uid: number, flags: Flags) {
    const m = this.store.messageByFolderUid(folder.id, uid);
    if (!m || JSON.stringify(m.flags) === JSON.stringify(flags)) return;
    this.store.setFlags(m.id, flags);
    const folderIds = this.store.foldersOfMessage(m.id).map((f) => f.folder_id);
    this.engine.emit("message.updated", this.id, now(), {
      message_id: m.id,
      thread_id: m.thread_id,
      folder_ids: folderIds,
      changes: { flags: { before: m.flags, after: flags } },
    });
  }

  private removeFromFolder(folder: Folder, messageId: string) {
    const m = this.store.messageById(messageId);
    if (!m) return;
    const before = this.store.foldersOfMessage(messageId).map((f) => f.folder_id);
    this.store.unlinkFolder(messageId, folder.id);
    const after = before.filter((f) => f !== folder.id);
    if (after.length === 0) {
      this.engine.emit("message.deleted", this.id, now(), { message_id: messageId, thread_id: m.thread_id, folder_ids: before });
    } else {
      this.engine.emit("message.updated", this.id, now(), {
        message_id: messageId,
        thread_id: m.thread_id,
        folder_ids: after,
        changes: { folder_ids: { before, after } },
      });
    }
  }

  /** Where a message lives right now: first folder link, with its uid. */
  locate(m: MessageRow): { folder: Folder; uid: number } {
    const link = this.store.foldersOfMessage(m.id)[0];
    const folder = link && [...this.folders.values()].find((f) => f.id === link.folder_id);
    if (!link || !folder) throw new Error(`message ${m.id} has no folder on the server`);
    return { folder, uid: link.uid };
  }
}

export class Engine {
  private runners = new Map<string, AccountRunner>();
  private waiters: (() => void)[] = [];
  private timerLoop: NodeJS.Timeout | null = null;

  constructor(
    public store: Store,
    private opts: { webhookUrl?: string | undefined; bodyCacheDir: string },
  ) {}

  // ----- event log -----
  emit(type: string, account: string, occurredAt: string, payload: unknown): number {
    const cursor = this.store.appendEvent(type, account, occurredAt, payload);
    for (const w of this.waiters.splice(0)) w();
    if (this.opts.webhookUrl) this.deliver({ cursor, type, account, occurred_at: occurredAt, observed_at: now(), payload });
    return cursor;
  }
  waitForEvent(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }
  private async deliver(event: unknown, attempt = 0): Promise<void> {
    // ponytail: one retry after 5 s; consumers replay by cursor, so a missed post is never lost.
    try {
      const r = await fetch(this.opts.webhookUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!r.ok) throw new Error(`webhook ${r.status}`);
    } catch (e: any) {
      if (attempt === 0) return sleep(5000).then(() => this.deliver(event, 1));
      log("webhook delivery failed", { error: String(e?.message ?? e) });
    }
  }
  /** Record a status change. Emits account.status only when the status or capabilities actually change. */
  status(account: string, status: string, caps: unknown, error?: string | null) {
    const before = this.store.accountById(account);
    const lastSync = status === "connected" ? now() : undefined;
    this.store.setAccountStatus(account, status as any, (caps as any) ?? undefined, lastSync);
    const capsChanged = caps && JSON.stringify(caps) !== JSON.stringify(before?.capabilities ?? null);
    if (before?.status === status && !capsChanged && !error) return;
    this.emit("account.status", account, now(), {
      account_id: account,
      status,
      capabilities: caps ?? before?.capabilities ?? null,
      last_sync: lastSync ?? before?.last_sync ?? null,
      ...(error ? { error } : {}),
    });
  }
  /** A successful sync pass: refresh last_sync without an event. Staleness is read from here. */
  touch(account: string) {
    this.store.setAccountStatus(account, "connected", undefined, now());
  }

  // ----- lifecycle -----
  async start() {
    for (const a of this.store.accounts()) this.launch(a.id, a.config);
    this.timerLoop = setInterval(() => this.fireTimers(), 5000);
  }
  async stop() {
    if (this.timerLoop) clearInterval(this.timerLoop);
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
  }
  private launch(id: string, config: AccountConfig) {
    const r = new AccountRunner(id, config, this);
    this.runners.set(id, r);
    r.start().catch((e) => log("runner crashed", { account: id, error: String(e) }));
  }
  async addAccount(config: AccountConfig) {
    const id = this.store.upsertAccount(config);
    await this.runners.get(id)?.stop();
    this.launch(id, config);
    return id;
  }
  private runner(account: string) {
    const r = this.runners.get(account);
    if (!r) throw new Error(`unknown account ${account}`);
    return r;
  }

  // ----- timers -----
  private fireTimers() {
    for (const t of this.store.dueTimers()) {
      this.store.markTimer(t.id, 1);
      this.emit("timer.fired", t.account, t.fire_at, {
        timer_id: t.id,
        event_type: t.event_type,
        payload: t.payload,
        created_by: t.created_by,
      });
    }
  }

  // ----- reads that need the server -----
  async fetchBody(m: MessageRow) {
    const r = this.runner(m.account);
    const { folder, uid } = r.locate(m);
    const raw = await r.adapter.source(folder.path, uid);
    if (!raw) return null;
    const p = await simpleParser(raw);
    const text = p.text ?? "";
    if (!m.snippet && text) this.store.setSnippet(m.id, text.replace(/\s+/g, " ").slice(0, 300));
    return {
      text,
      html: typeof p.html === "string" ? p.html : null,
      attachments: p.attachments.map((a) => ({ filename: a.filename ?? null, content_type: a.contentType, size: a.size })),
    };
  }

  // ----- actions -----
  getAction(id: string) {
    return this.store.actionById(id);
  }

  async submitAction(req: ActionRequest, requestedBy: string, mode: "direct" | "propose", allowedAccounts: string[] = []) {
    const existing = this.store.actionByKey(req.client_key);
    if (existing) return existing; // idempotent: same key, same answer
    const params = ActionParams[req.type].parse(req.params);
    const account = this.accountFor(req.type, params);
    if (allowedAccounts.length && !allowedAccounts.includes(account)) throw new ScopeError("account not in token scope");
    const id = newId("act");
    const status = mode === "propose" ? "proposed" : "approved";
    this.store.insertAction({ id, client_key: req.client_key, type: req.type, account, params, status, requested_by: requestedBy });
    this.actionEvent(id, account, null, status, requestedBy);
    if (status === "approved") await this.execute(id, requestedBy);
    return this.store.actionById(id);
  }

  async approve(id: string, by: string) {
    const a = this.store.actionById(id);
    if (!a) throw new Error("not found");
    if (a.status !== "proposed") throw new Error(`cannot approve an action that is ${a.status}`);
    this.store.updateAction(id, "approved");
    this.actionEvent(id, a.account, "proposed", "approved", by);
    await this.execute(id, by);
    return this.store.actionById(id);
  }

  reject(id: string, by: string) {
    const a = this.store.actionById(id);
    if (!a) throw new Error("not found");
    if (a.status !== "proposed") throw new Error(`cannot reject an action that is ${a.status}`);
    this.store.updateAction(id, "rejected");
    this.actionEvent(id, a.account, "proposed", "rejected", by);
    return this.store.actionById(id);
  }

  async undo(id: string, by: string) {
    const a = this.store.actionById(id);
    if (!a) throw new Error("not found");
    if (a.status !== "executed" || !a.journal) throw new Error(`nothing to undo for an action that is ${a.status}`);
    const r = this.runner(a.account);
    const j = a.journal;
    switch (a.type) {
      case "move":
      case "delete": {
        const m = this.store.messageById(a.params.message_id);
        if (!m) throw new Error("message no longer exists");
        const { folder: cur, uid } = r.locate(m);
        const back = [...r.folders.values()].find((f) => f.id === j.from_folder_id);
        if (!back) throw new Error("original folder no longer exists");
        await r.adapter.move(cur.path, uid, back.path);
        await r.syncFolder(cur);
        await r.syncFolder(back);
        break;
      }
      case "set_flags": {
        const m = this.store.messageById(a.params.message_id);
        if (!m) throw new Error("message no longer exists");
        const { folder, uid } = r.locate(m);
        await r.adapter.setFlags(folder.path, uid, j.before);
        await r.syncFolder(folder);
        break;
      }
      case "create_draft": {
        const drafts = [...r.folders.values()].find((f) => f.id === j.folder_id);
        if (drafts) {
          await r.adapter.expunge(drafts.path, j.uid);
          await r.syncFolder(drafts);
        }
        break;
      }
      case "schedule_timer":
        this.store.markTimer(j.timer_id, 2);
        break;
      default:
        throw new Error(`${a.type} cannot be undone`);
    }
    this.store.updateAction(id, "reverted");
    this.actionEvent(id, a.account, "executed", "reverted", by);
    return this.store.actionById(id);
  }

  private accountFor(type: string, params: any): string {
    if (params.account) return params.account;
    if (params.draft_id) return this.need(params.draft_id).account;
    if (params.message_id) return this.need(params.message_id).account;
    throw new Error(`${type} needs an account or message_id`);
  }
  private need(messageId: string): MessageRow {
    const m = this.store.messageById(messageId);
    if (!m) throw new Error(`unknown message ${messageId}`);
    return m;
  }

  private actionEvent(id: string, account: string, prev: string | null, status: string, by: string, extra: Record<string, unknown> = {}) {
    const a = this.store.actionById(id)!;
    this.emit("action.updated", account, now(), {
      action_id: id,
      client_key: a.client_key,
      type: a.type,
      previous_status: prev,
      status,
      requested_by: by,
      ...extra,
    });
  }

  private async execute(id: string, by: string) {
    const a = this.store.actionById(id)!;
    this.store.updateAction(id, "executing");
    this.actionEvent(id, a.account, "approved", "executing", by);
    try {
      const { journal, result } = await this.perform(a);
      this.store.updateAction(id, "executed", { journal, result });
      this.actionEvent(id, a.account, "executing", "executed", by, {
        result,
        ...(journal ? { undo_deadline: new Date(Date.now() + 7 * DAY).toISOString() } : {}),
      });
    } catch (e: any) {
      this.store.updateAction(id, "failed", { error: String(e?.message ?? e) });
      this.actionEvent(id, a.account, "executing", "failed", by, { error: String(e?.message ?? e) });
    }
  }

  private async perform(a: NonNullable<ReturnType<Store["actionById"]>>): Promise<{ journal: unknown; result: unknown }> {
    const r = this.runner(a.account);
    const p = a.params;
    switch (a.type as string) {
      case "move": {
        const m = this.need(p.message_id);
        const { folder, uid } = r.locate(m);
        const dest = [...r.folders.values()].find((f) => f.id === p.to_folder_id);
        if (!dest) throw new Error(`unknown folder ${p.to_folder_id}`);
        await r.adapter.move(folder.path, uid, dest.path);
        await r.syncFolder(folder);
        await r.syncFolder(dest);
        return { journal: { from_folder_id: folder.id, to_folder_id: dest.id }, result: { folder_id: dest.id } };
      }
      case "set_flags": {
        const m = this.need(p.message_id);
        const { folder, uid } = r.locate(m);
        await r.adapter.setFlags(folder.path, uid, p.set);
        await r.syncFolder(folder);
        return { journal: { before: m.flags }, result: { flags: this.store.messageById(m.id)?.flags } };
      }
      case "delete": {
        const m = this.need(p.message_id);
        const { folder, uid } = r.locate(m);
        if (p.permanent) {
          await r.adapter.expunge(folder.path, uid);
          await r.syncFolder(folder);
          return { journal: null, result: { permanent: true } };
        }
        const trash = r.folderByRole("trash");
        if (!trash) throw new Error("account has no trash folder; use permanent: true");
        await r.adapter.move(folder.path, uid, trash.path);
        await r.syncFolder(folder);
        await r.syncFolder(trash);
        return { journal: { from_folder_id: folder.id, to_folder_id: trash.id }, result: { folder_id: trash.id } };
      }
      case "create_draft": {
        const drafts = r.folderByRole("drafts");
        if (!drafts) throw new Error("account has no drafts folder");
        const { raw, messageId } = await this.compose(r, p);
        const uid = await r.adapter.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
        await r.syncFolder(drafts);
        const id = mintMessageId(a.account, messageId, "");
        return { journal: uid ? { folder_id: drafts.id, uid } : null, result: { message_id: id } };
      }
      case "send": {
        let raw: Buffer;
        let messageId: string;
        if (p.draft_id) {
          const d = this.need(p.draft_id);
          const { folder, uid } = r.locate(d);
          const src = await r.adapter.source(folder.path, uid);
          if (!src) throw new Error("draft source unavailable");
          raw = src;
          messageId = d.header_message_id ?? "";
          await r.adapter.send(raw);
          await r.adapter.expunge(folder.path, uid);
          await r.syncFolder(folder);
        } else {
          ({ raw, messageId } = await this.compose(r, p, true));
          await r.adapter.send(raw);
        }
        const sent = r.folderByRole("sent");
        if (sent) {
          await r.adapter.append(sent.path, raw, ["\\Seen"]);
          await r.syncFolder(sent);
        }
        return { journal: null, result: { message_id: mintMessageId(a.account, messageId, "") } };
      }
      case "schedule_timer": {
        const id = newId("tmr");
        this.store.insertTimer(id, p.fire_at, p.event_type, p.payload, a.requested_by, a.account);
        return { journal: { timer_id: id }, result: { timer_id: id } };
      }
      default:
        throw new Error(`unknown action ${a.type}`);
    }
  }

  private async compose(r: AccountRunner, p: any, agent = false): Promise<{ raw: Buffer; messageId: string }> {
    const messageId = `<${newId("m").slice(2)}@email-engine>`;
    const headers: Record<string, string> = { "Message-ID": messageId };
    if (agent) headers["Auto-Submitted"] = "auto-generated"; // RFC 3834: machine-sent
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (p.in_reply_to) {
      const parent = this.need(p.in_reply_to);
      if (parent.header_message_id) {
        inReplyTo = parent.header_message_id;
        references = [...parent.refs, parent.header_message_id].join(" ");
      }
    }
    const fmt = (a: Address) => (a.name ? `"${a.name.replace(/"/g, "")}" <${a.address}>` : a.address);
    const raw = await new MailComposer({
      from: r.config.address,
      to: p.to.map(fmt).join(", "),
      cc: p.cc?.length ? p.cc.map(fmt).join(", ") : undefined,
      subject: p.subject,
      text: p.text,
      inReplyTo,
      references,
      headers,
      messageId,
    })
      .compile()
      .build();
    return { raw, messageId };
  }
}

export { HIGH_RISK };
