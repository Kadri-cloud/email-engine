// The engine: one runner per account turns a mailbox into events in the log,
// and the action API turns requests into journaled, reversible changes.
// Runners are protocol-neutral; adapters report through the SyncSink.
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Adapter, RemoteFolder, RemoteMessage, SyncSink } from "./adapter.js";
import { GmailAdapter } from "./gmail.js";
import { GraphAdapter } from "./graph.js";
import { ImapAdapter } from "./imap.js";
import { InboundAdapter } from "./inbound.js";
import { JmapAdapter } from "./jmap.js";
import { ActionParams, type AccountConfig, type ActionRequest, type Address, type Flags, type Trust, HIGH_RISK } from "./schema.js";
import { fingerprintOf, mintMessageId, newId, now, type MessageRow, type Store } from "./store.js";
import { normalizeMessageId, normalizeSubject } from "./threading.js";

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: now(), msg, ...extra }));
const debug = process.env.ENGINE_DEBUG ? log : () => {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

export class ScopeError extends Error {}

type Folder = ReturnType<Store["upsertFolder"]>;

export function makeAdapter(config: AccountConfig, ctx: { dataDir: string }): Adapter {
  switch (config.provider) {
    case "imap":
      return new ImapAdapter(config);
    case "jmap":
      return new JmapAdapter(config);
    case "inbound":
      return new InboundAdapter(config, ctx.dataDir);
    case "gmail":
      return new GmailAdapter(config);
    case "graph":
      return new GraphAdapter(config);
  }
}

/** DMARC result plus prior correspondence -> trust level. No model involved. */
export function trustFor(authResults: string | null, seenBefore: boolean): Trust {
  const a = (authResults ?? "").toLowerCase();
  if (/dmarc=fail/.test(a)) return "suspicious";
  if (/dmarc=pass/.test(a) || /dkim=pass/.test(a)) return seenBefore ? "verified" : "known";
  return "unverified";
}

const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

class AccountRunner implements SyncSink {
  adapter: Adapter;
  folders = new Map<string, Folder>(); // provider path -> folder row
  private running = false;
  private wake: (() => void) | null = null;
  private dirty = new Set<string>();
  /** Messages that vanished from their last known folder: maybe moved, maybe deleted. Decided after the other folders are checked. */
  private lost = new Map<string, string[]>();

  constructor(
    public id: string,
    public config: AccountConfig,
    private engine: Engine,
  ) {
    this.adapter = makeAdapter(config, { dataDir: engine.opts.dataDir });
  }

  get store() {
    return this.engine.store;
  }

  folderByRole(role: string): Folder | undefined {
    for (const f of this.folders.values()) if (f.role === role) return f;
    return undefined;
  }
  folderById(id: string): Folder | undefined {
    for (const f of this.folders.values()) if (f.id === id) return f;
    return undefined;
  }

  // ---------- lifecycle ----------

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
        const detail = [e?.command, e?.responseText, e?.serverResponseCode, e?.code].filter(Boolean).join(" | ");
        this.engine.status(this.id, "disconnected", null, String(e?.message ?? e));
        log("account error, retrying", { account: this.id, attempt, delay: Math.round(delay), error: String(e?.message ?? e), detail, stack: String(e?.stack ?? "").split("\n").slice(1, 4).join(" <- ").trim() });
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
      this.folders.set(f.path, this.store.upsertFolder(this.id, f.path, f.name, f.role));
    }
    await this.syncPaths([...this.folders.keys()]);
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

    // Poll loop: inbox on wake or on a safety tick, every folder every 10 min. IMAP IDLE servers can
    // miss or delay notifications (Dovecot only notices mail copied into cur/ at its periodic check),
    // so the tick is 30 s there; push channels that are reliable get 2 min.
    const tickMs = caps.push === "idle" ? 30_000 : 120_000;
    let lastFull = Date.now();
    while (this.running) {
      // A push that lands while we are mid-sync is kept in `dirty`; only wait when nothing is pending.
      let reason: "wake" | "tick" | "closed" = "wake";
      if (this.dirty.size === 0) {
        reason = await Promise.race([
          new Promise<"wake">((r) => (this.wake = () => r("wake"))),
          sleep(tickMs).then(() => "tick" as const),
          idleClosed?.then(() => "closed" as const) ?? new Promise<never>(() => {}),
        ]);
        this.wake = null;
      }
      if (!this.running) return;
      if (reason === "closed") throw new Error("idle connection closed");

      const due = new Set(this.dirty);
      this.dirty.clear();
      if (inbox) due.add(inbox.path);
      if (Date.now() - lastFull > 600_000) {
        for (const p of this.folders.keys()) due.add(p);
        lastFull = Date.now();
      }
      debug("poll", { account: this.id, reason, due: [...due] });
      await this.syncPaths([...due]);
      this.engine.touch(this.id);
    }
  }

  /** Sync a set of folders through the adapter, persisting its state. Serialised per account. */
  private syncing: Promise<void> = Promise.resolve();
  syncPaths(paths: string[]): Promise<void> {
    const run = async () => {
      const folders: RemoteFolder[] = paths
        .map((p) => this.folders.get(p))
        .filter((f): f is Folder => !!f)
        .map((f) => ({ path: f.path, name: f.name, role: f.role as RemoteFolder["role"] }));
      if (!folders.length) return;
      const next = await this.adapter.sync(folders, this.store.getSyncState(this.id), this);
      this.store.setSyncState(this.id, next);
      if (this.lost.size) {
        // Something vanished from a folder we synced. Look in the folders we did not, then decide: moved or deleted.
        const rest = [...this.folders.values()]
          .filter((f) => !paths.includes(f.path))
          .map((f) => ({ path: f.path, name: f.name, role: f.role as RemoteFolder["role"] }));
        if (rest.length) this.store.setSyncState(this.id, await this.adapter.sync(rest, this.store.getSyncState(this.id), this));
        for (const [id, before] of this.lost) {
          const m = this.store.messageById(id);
          if (m) this.engine.emit("message.deleted", this.id, now(), { message_id: id, thread_id: m.thread_id, folder_ids: before });
        }
        this.lost.clear();
      }
    };
    this.syncing = this.syncing.then(run, run);
    return this.syncing;
  }

  // ---------- SyncSink ----------

  knownRefs(folderPath: string) {
    const f = this.folders.get(folderPath);
    return f ? this.store.refsInFolder(f.id) : [];
  }

  resetFolder(folderPath: string) {
    const f = this.folders.get(folderPath);
    if (!f) return;
    log("folder renumbered, forgetting refs", { account: this.id, folder: folderPath });
    for (const { message_id } of this.store.refsInFolder(f.id)) this.store.unlinkFolder(message_id, f.id);
  }

  seen(m: RemoteMessage, complete: boolean) {
    const headerId = normalizeMessageId(m.headerMessageId);
    const fingerprint = fingerprintOf(m);
    let id = mintMessageId(this.id, headerId, fingerprint);
    const folderIds = m.folderPaths.map((p) => this.folders.get(p)?.id).filter((x): x is string => !!x);
    let existing = this.store.messageById(id);

    if (existing && headerId && existing.fingerprint && existing.fingerprint !== fingerprint) {
      // Same Message-ID, different message: a reused or forged header. Mint this one from both.
      id = mintMessageId(this.id, `${headerId}\n${fingerprint}`, fingerprint);
      existing = this.store.messageById(id);
    }
    if (existing && !existing.fingerprint) this.store.setFingerprint(id, fingerprint);

    if (existing) {
      const links = this.store.foldersOfMessage(id);
      const known = links.map((l) => l.folder_id);
      const lostBefore = this.lost.get(id);
      if (lostBefore) this.lost.delete(id); // it moved here rather than being deleted
      const before = lostBefore ?? known;
      let after = [...known];
      for (const fid of folderIds) {
        const link = links.find((l) => l.folder_id === fid);
        if (!link) {
          this.store.linkFolder(id, fid, m.ref);
          after.push(fid);
        } else if (link.ref !== m.ref) {
          this.store.linkFolder(id, fid, m.ref); // same folder, new ref (e.g. after a move back)
        }
      }
      if (complete) {
        for (const fid of known) {
          if (!folderIds.includes(fid)) {
            this.store.unlinkFolder(id, fid);
            after = after.filter((x) => x !== fid);
          }
        }
      }
      const flagsChanged = JSON.stringify(existing.flags) !== JSON.stringify(m.flags);
      if (flagsChanged) this.store.setFlags(id, m.flags);
      const foldersChanged = !sameSet(before, after);
      if (known.length === 0 && !lostBefore && !flagsChanged) return; // silent relink after a renumbering
      if (!foldersChanged && !flagsChanged) return;
      this.engine.emit("message.updated", this.id, now(), {
        message_id: id,
        thread_id: existing.thread_id,
        folder_ids: after,
        changes: {
          ...(flagsChanged ? { flags: { before: existing.flags, after: m.flags } } : {}),
          ...(foldersChanged ? { folder_ids: { before, after } } : {}),
        },
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
      fingerprint,
    };
    const cursor = this.store.transaction(() => {
      this.store.insertMessage(row);
      for (const fid of folderIds) this.store.linkFolder(id, fid, m.ref);
      this.store.upsertThread(row.thread_id, this.id, normalizeSubject(m.subject).base, m.date);
      return this.engine.emit("message.received", this.id, m.date, {
        message_id: id,
        thread_id: row.thread_id,
        folder_ids: folderIds,
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

  flags(folderPath: string, ref: string, flags: Flags) {
    const f = this.folders.get(folderPath);
    const m = f && this.store.messageByFolderRef(f.id, ref);
    if (!m || JSON.stringify(m.flags) === JSON.stringify(flags)) return;
    this.store.setFlags(m.id, flags);
    this.engine.emit("message.updated", this.id, now(), {
      message_id: m.id,
      thread_id: m.thread_id,
      folder_ids: this.store.foldersOfMessage(m.id).map((l) => l.folder_id),
      changes: { flags: { before: m.flags, after: flags } },
    });
  }

  gone(folderPath: string, ref: string) {
    const f = this.folders.get(folderPath);
    const m = f && this.store.messageByFolderRef(f.id, ref);
    if (!f || !m) return;
    const before = this.store.foldersOfMessage(m.id).map((l) => l.folder_id);
    this.store.unlinkFolder(m.id, f.id);
    const after = before.filter((x) => x !== f.id);
    if (after.length) {
      this.engine.emit("message.updated", this.id, now(), {
        message_id: m.id,
        thread_id: m.thread_id,
        folder_ids: after,
        changes: { folder_ids: { before, after } },
      });
      return;
    }
    // Nowhere else we know of. It may have been moved by another client; syncPaths decides once the other folders are checked.
    this.lost.set(m.id, before);
  }

  destroyed(ref: string) {
    const m = this.store.messageByRef(this.id, ref);
    if (!m) return;
    this.lost.delete(m.id);
    this.removeFromFolders(m, this.store.foldersOfMessage(m.id).map((l) => l.folder_id));
  }

  private removeFromFolders(m: MessageRow, folderIds: string[]) {
    const before = this.store.foldersOfMessage(m.id).map((l) => l.folder_id);
    for (const fid of folderIds) this.store.unlinkFolder(m.id, fid);
    const after = before.filter((f) => !folderIds.includes(f));
    if (after.length === 0) {
      this.engine.emit("message.deleted", this.id, now(), { message_id: m.id, thread_id: m.thread_id, folder_ids: before });
    } else {
      this.engine.emit("message.updated", this.id, now(), {
        message_id: m.id,
        thread_id: m.thread_id,
        folder_ids: after,
        changes: { folder_ids: { before, after } },
      });
    }
  }

  // ---------- threading ----------

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

  /** Where a message lives right now: first folder link, with its provider ref. */
  locate(m: MessageRow): { folder: Folder; ref: string } {
    const link = this.store.foldersOfMessage(m.id)[0];
    const folder = link && this.folderById(link.folder_id);
    if (!link || !folder) throw new Error(`message ${m.id} has no folder on the server`);
    return { folder, ref: link.ref };
  }
}

export class Engine {
  private runners = new Map<string, AccountRunner>();
  private waiters: (() => void)[] = [];
  private timerLoop: NodeJS.Timeout | null = null;

  constructor(
    public store: Store,
    public opts: { webhookUrl?: string | undefined; dataDir: string },
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
  // ponytail: the source is fetched and parsed on every call; an on-disk cache lands with the body-cache item.
  private async fetchParsed(m: MessageRow) {
    const r = this.runner(m.account);
    const { folder, ref } = r.locate(m);
    const raw = await r.adapter.source(folder.path, ref);
    return raw ? simpleParser(raw) : null;
  }

  async fetchBody(m: MessageRow) {
    const p = await this.fetchParsed(m);
    if (!p) return null;
    const text = p.text ?? "";
    if (!m.snippet && text) this.store.setSnippet(m.id, text.replace(/\s+/g, " ").slice(0, 300));
    return {
      text,
      html: typeof p.html === "string" ? p.html : null,
      attachments: p.attachments.map((a, index) => ({ index, filename: a.filename ?? null, content_type: a.contentType, size: a.size })),
    };
  }

  async fetchAttachment(m: MessageRow, index: number) {
    const p = await this.fetchParsed(m);
    const a = p?.attachments[index];
    if (!a) return null;
    return { filename: a.filename ?? `attachment-${index}`, contentType: a.contentType || "application/octet-stream", content: a.content };
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
        const { folder: cur, ref } = r.locate(m);
        const back = r.folderById(j.from_folder_id);
        if (!back) throw new Error("original folder no longer exists");
        await r.adapter.move(cur.path, ref, back.path);
        await r.syncPaths([cur.path, back.path]);
        break;
      }
      case "set_flags": {
        const m = this.store.messageById(a.params.message_id);
        if (!m) throw new Error("message no longer exists");
        const { folder, ref } = r.locate(m);
        await r.adapter.setFlags(folder.path, ref, j.before);
        await r.syncPaths([folder.path]);
        break;
      }
      case "set_folders": {
        const m = this.store.messageById(a.params.message_id);
        if (!m) throw new Error("message no longer exists");
        await this.applyFolders(r, m, j.before);
        break;
      }
      case "tag": {
        const m = this.store.messageById(a.params.message_id);
        if (!m) throw new Error("message no longer exists");
        const current = this.store.tagsOf(m.id);
        this.applyTags(m, j.before.filter((t: string) => !current.includes(t)), current.filter((t) => !j.before.includes(t)), by);
        break;
      }
      case "create_draft": {
        const drafts = r.folderById(j.folder_id);
        if (drafts && j.ref) {
          await r.adapter.expunge(drafts.path, j.ref);
          await r.syncPaths([drafts.path]);
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
        const { folder, ref } = r.locate(m);
        const dest = r.folderById(p.to_folder_id);
        if (!dest) throw new Error(`unknown folder ${p.to_folder_id}`);
        await r.adapter.move(folder.path, ref, dest.path);
        await r.syncPaths([folder.path, dest.path]);
        return { journal: { from_folder_id: folder.id, to_folder_id: dest.id }, result: { folder_id: dest.id } };
      }
      case "set_flags": {
        const m = this.need(p.message_id);
        const { folder, ref } = r.locate(m);
        await r.adapter.setFlags(folder.path, ref, p.set);
        await r.syncPaths([folder.path]);
        return { journal: { before: m.flags }, result: { flags: this.store.messageById(m.id)?.flags } };
      }
      case "set_folders": {
        const m = this.need(p.message_id);
        const before = this.store.foldersOfMessage(m.id).map((l) => l.folder_id);
        await this.applyFolders(r, m, p.folder_ids);
        const after = this.store.foldersOfMessage(m.id).map((l) => l.folder_id);
        return { journal: { before }, result: { folder_ids: after } };
      }
      case "tag": {
        const m = this.need(p.message_id);
        const { before, after } = this.applyTags(m, p.add, p.remove, a.requested_by);
        return { journal: { before }, result: { tags: after } };
      }
      case "delete": {
        const m = this.need(p.message_id);
        const { folder, ref } = r.locate(m);
        if (p.permanent) {
          await r.adapter.expunge(folder.path, ref);
          await r.syncPaths([folder.path]);
          return { journal: null, result: { permanent: true } };
        }
        const trash = r.folderByRole("trash");
        if (!trash) throw new Error("account has no trash folder; use permanent: true");
        await r.adapter.move(folder.path, ref, trash.path);
        await r.syncPaths([folder.path, trash.path]);
        return { journal: { from_folder_id: folder.id, to_folder_id: trash.id }, result: { folder_id: trash.id } };
      }
      case "create_draft": {
        const drafts = r.folderByRole("drafts");
        if (!drafts) throw new Error("account has no drafts folder");
        const { raw, messageId } = await this.compose(r, p);
        const ref = await r.adapter.append(drafts.path, raw, { draft: true, seen: true });
        await r.syncPaths([drafts.path]);
        const id = mintMessageId(a.account, messageId, "");
        return { journal: ref ? { folder_id: drafts.id, ref } : null, result: { message_id: id } };
      }
      case "send": {
        let raw: Buffer;
        let messageId: string;
        if (p.draft_id) {
          const d = this.need(p.draft_id);
          const { folder, ref } = r.locate(d);
          const src = await r.adapter.source(folder.path, ref);
          if (!src) throw new Error("draft source unavailable");
          raw = src;
          messageId = d.header_message_id ?? "";
          await r.adapter.send(raw);
          await r.adapter.expunge(folder.path, ref);
          await r.syncPaths([folder.path]);
        } else {
          ({ raw, messageId } = await this.compose(r, p, true));
          await r.adapter.send(raw);
        }
        const sent = r.folderByRole("sent");
        if (sent && r.adapter.capabilities?.sent_copy !== "server") {
          await r.adapter.append(sent.path, raw, { seen: true });
        }
        if (sent) await r.syncPaths([sent.path]);
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

  /**
   * Put a message in exactly these folders. Label providers do it in one call; folder providers get
   * a move when one folder replaces one, otherwise copies into the new folders and removal from the old.
   */
  private async applyFolders(r: AccountRunner, m: MessageRow, folderIds: string[]) {
    const links = this.store.foldersOfMessage(m.id);
    const current = links.map((l) => l.folder_id);
    const target = [...new Set(folderIds)];
    const toFolder = (id: string) => {
      const f = r.folderById(id);
      if (!f) throw new Error(`unknown folder ${id}`);
      return f;
    };
    const add = target.filter((id) => !current.includes(id)).map(toFolder);
    const remove = links.filter((l) => !target.includes(l.folder_id)).map((l) => ({ ...toFolder(l.folder_id), ref: l.ref }));
    if (!add.length && !remove.length) return;
    const anyLink = links[0];
    if (!anyLink) throw new Error(`message ${m.id} has no folder on the server`);

    if (r.adapter.setFolders) {
      await r.adapter.setFolders(anyLink.ref, target.map((id) => toFolder(id).path), current.map((id) => toFolder(id).path));
    } else if (add.length === 1 && remove.length === 1 && target.length === 1) {
      await r.adapter.move(remove[0]!.path, remove[0]!.ref, add[0]!.path);
    } else {
      if (add.length && !r.adapter.copy) throw new Error("this provider keeps a message in one folder; use move");
      for (const f of add) await r.adapter.copy!(toFolder(anyLink.folder_id).path, anyLink.ref, f.path);
      for (const f of remove) await r.adapter.expunge(f.path, f.ref);
    }
    await r.syncPaths([...new Set([...current, ...target].map((id) => toFolder(id).path))]);
  }

  /** Engine-owned tags: stored here, never on the server. Emits one message.updated with the tag change. */
  private applyTags(m: MessageRow, add: string[], remove: string[], by: string) {
    const change = this.store.setTags(m.id, add, remove, by);
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      this.emit("message.updated", m.account, now(), {
        message_id: m.id,
        thread_id: m.thread_id,
        folder_ids: this.store.foldersOfMessage(m.id).map((l) => l.folder_id),
        changes: { tags: change },
      });
    }
    return change;
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
