// One SQLite file holds everything: accounts, folders, messages, threads, the
// append-only event log, the action journal, tokens and timers. The log is the
// truth; every delivery channel is a reader of it.
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import type {
  AccountConfig,
  AccountStatus,
  Address,
  Capabilities,
  Flags,
  Token,
  Trust,
} from "./schema.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  capabilities TEXT,
  last_sync TEXT,
  sync_state TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  UNIQUE(account, path)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  header_message_id TEXT,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  from_json TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date TEXT NOT NULL,
  flags TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'unverified',
  size INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_header ON messages(account, header_message_id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS message_folders (
  message_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (message_id, folder_id)
);
CREATE INDEX IF NOT EXISTS message_folders_ref ON message_folders(folder_id, ref);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  last_activity TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  account TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_account ON events(account, cursor);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  client_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  account TEXT,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  journal TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  fire_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by TEXT NOT NULL,
  account TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS timers_due ON timers(fired, fire_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED, subject, participants, snippet
);
`;

export type Store = ReturnType<typeof openStore>;

export interface MessageRow {
  id: string;
  account: string;
  thread_id: string;
  header_message_id: string | null;
  in_reply_to: string | null;
  refs: string[];
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: string;
  flags: Flags;
  trust: Trust;
  size: number;
  snippet: string;
  has_attachments: boolean;
}

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Engine message id: survives folder moves. Minted from the Message-ID header
// when present so one message seen in two folders collapses to one id.
// ponytail: falls back to account+uidvalidity+uid when the header is missing;
// a content hash of raw headers would be stricter, add when duplicates appear.
export function mintMessageId(account: string, headerMessageId: string | null, fallback: string) {
  const key = headerMessageId ? `${account}\n${headerMessageId.trim()}` : `${account}\n${fallback}`;
  return "msg_" + sha256(key).slice(0, 24);
}

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  const q = {
    insertEvent: db.prepare(
      `INSERT INTO events (type, account, occurred_at, observed_at, payload) VALUES (?, ?, ?, ?, ?)`,
    ),
    eventsAfter: db.prepare(
      `SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?`,
    ),
    lastCursor: db.prepare(`SELECT COALESCE(MAX(cursor), 0) AS c FROM events`),
    upsertAccount: db.prepare(
      `INSERT INTO accounts (id, address, config) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET config = excluded.config`,
    ),
    accountByAddress: db.prepare(`SELECT * FROM accounts WHERE address = ?`),
    accounts: db.prepare(`SELECT * FROM accounts`),
    setAccountStatus: db.prepare(
      `UPDATE accounts SET status = ?, capabilities = COALESCE(?, capabilities), last_sync = COALESCE(?, last_sync) WHERE id = ?`,
    ),
    upsertFolder: db.prepare(
      `INSERT INTO folders (id, account, path, name, role) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, path) DO UPDATE SET role = excluded.role, name = excluded.name
       RETURNING *`,
    ),
    folderByPath: db.prepare(`SELECT * FROM folders WHERE account = ? AND path = ?`),
    foldersForAccount: db.prepare(`SELECT * FROM folders WHERE account = ?`),
    getSyncState: db.prepare(`SELECT sync_state FROM accounts WHERE id = ?`),
    setSyncState: db.prepare(`UPDATE accounts SET sync_state = ? WHERE id = ?`),
    messageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    insertMessage: db.prepare(
      `INSERT OR IGNORE INTO messages
       (id, account, thread_id, header_message_id, in_reply_to, refs, subject, from_json, to_json, cc_json, date, flags, trust, size, snippet, has_attachments)
       VALUES (@id, @account, @thread_id, @header_message_id, @in_reply_to, @refs, @subject, @from_json, @to_json, @cc_json, @date, @flags, @trust, @size, @snippet, @has_attachments)`,
    ),
    insertFts: db.prepare(
      `INSERT INTO messages_fts (id, subject, participants, snippet) VALUES (?, ?, ?, ?)`,
    ),
    setFlags: db.prepare(`UPDATE messages SET flags = ? WHERE id = ?`),
    linkFolder: db.prepare(
      `INSERT OR REPLACE INTO message_folders (message_id, folder_id, ref) VALUES (?, ?, ?)`,
    ),
    unlinkFolder: db.prepare(`DELETE FROM message_folders WHERE message_id = ? AND folder_id = ?`),
    foldersOfMessage: db.prepare(`SELECT folder_id, ref FROM message_folders WHERE message_id = ?`),
    messageByFolderRef: db.prepare(
      `SELECT m.* FROM messages m JOIN message_folders mf ON mf.message_id = m.id WHERE mf.folder_id = ? AND mf.ref = ?`,
    ),
    messageByRef: db.prepare(
      `SELECT m.* FROM messages m JOIN message_folders mf ON mf.message_id = m.id WHERE m.account = ? AND mf.ref = ? LIMIT 1`,
    ),
    refsInFolder: db.prepare(`SELECT message_id, ref FROM message_folders WHERE folder_id = ?`),
    messageByHeaderId: db.prepare(
      `SELECT * FROM messages WHERE account = ? AND header_message_id = ? LIMIT 1`,
    ),
    upsertThread: db.prepare(
      `INSERT INTO threads (id, account, subject, last_activity) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_activity = MAX(last_activity, excluded.last_activity)`,
    ),
    threadMessages: db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY date`),
    search: db.prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.id WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
    ),
    setSnippet: db.prepare(`UPDATE messages SET snippet = ? WHERE id = ?`),
    setFtsSnippet: db.prepare(`UPDATE messages_fts SET snippet = ? WHERE id = ?`),
    threadBySubject: db.prepare(
      `SELECT id FROM threads WHERE account = ? AND subject = ? AND last_activity > ? ORDER BY last_activity DESC LIMIT 1`,
    ),
    // ponytail: LIKE over the JSON refs column; a refs join table when this shows up in a profile.
    messagesReferencing: db.prepare(`SELECT * FROM messages WHERE account = ? AND refs LIKE ?`),
    rethread: db.prepare(`UPDATE messages SET thread_id = ? WHERE thread_id = ?`),
    senderSeen: db.prepare(`SELECT 1 FROM messages WHERE account = ? AND from_json LIKE ? LIMIT 1`),
    insertAction: db.prepare(
      `INSERT INTO actions (id, client_key, type, account, params, status, requested_by, created_at, updated_at)
       VALUES (@id, @client_key, @type, @account, @params, @status, @requested_by, @created_at, @updated_at)`,
    ),
    actionById: db.prepare(`SELECT * FROM actions WHERE id = ?`),
    actionByKey: db.prepare(`SELECT * FROM actions WHERE client_key = ?`),
    updateAction: db.prepare(
      `UPDATE actions SET status = ?, journal = COALESCE(?, journal), result = COALESCE(?, result), error = ?, updated_at = ? WHERE id = ?`,
    ),
    insertTimer: db.prepare(
      `INSERT INTO timers (id, fire_at, event_type, payload, created_by, account) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    dueTimers: db.prepare(`SELECT * FROM timers WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at LIMIT 100`),
    markTimer: db.prepare(`UPDATE timers SET fired = ? WHERE id = ?`),
    insertToken: db.prepare(`INSERT INTO tokens (id, secret_hash, scope) VALUES (?, ?, ?)`),
    tokenByHash: db.prepare(`SELECT id, scope FROM tokens WHERE secret_hash = ?`),
    tokens: db.prepare(`SELECT id, scope FROM tokens`),
    deleteToken: db.prepare(`DELETE FROM tokens WHERE id = ?`),
  };

  const parseAction = (r: any) =>
    r
      ? {
          ...r,
          params: JSON.parse(r.params),
          journal: r.journal ? JSON.parse(r.journal) : null,
          result: r.result ? JSON.parse(r.result) : null,
        }
      : null;

  const rowToMessage = (r: any): MessageRow => ({
    id: r.id,
    account: r.account,
    thread_id: r.thread_id,
    header_message_id: r.header_message_id,
    in_reply_to: r.in_reply_to,
    refs: JSON.parse(r.refs),
    subject: r.subject,
    from: r.from_json ? JSON.parse(r.from_json) : null,
    to: JSON.parse(r.to_json),
    cc: JSON.parse(r.cc_json),
    date: r.date,
    flags: JSON.parse(r.flags),
    trust: r.trust,
    size: r.size,
    snippet: r.snippet,
    has_attachments: !!r.has_attachments,
  });

  return {
    db,

    // ----- event log -----
    appendEvent(type: string, account: string, occurredAt: string, payload: unknown): number {
      const r = q.insertEvent.run(type, account, occurredAt, now(), JSON.stringify(payload));
      return Number(r.lastInsertRowid);
    },
    eventsAfter(cursor: number, limit = 500) {
      return (q.eventsAfter.all(cursor, limit) as any[]).map((e) => ({
        ...e,
        payload: JSON.parse(e.payload),
      }));
    },
    lastCursor(): number {
      return (q.lastCursor.get() as any).c;
    },

    // ----- accounts -----
    upsertAccount(config: AccountConfig) {
      const existing = q.accountByAddress.get(config.address) as any;
      const id = existing?.id ?? newId("acc");
      q.upsertAccount.run(id, config.address, JSON.stringify(config));
      return id as string;
    },
    accounts() {
      return (q.accounts.all() as any[]).map((a) => ({
        ...a,
        config: JSON.parse(a.config) as AccountConfig,
        capabilities: a.capabilities ? (JSON.parse(a.capabilities) as Capabilities) : null,
      }));
    },
    setAccountStatus(id: string, status: AccountStatus, caps?: Capabilities, lastSync?: string) {
      q.setAccountStatus.run(status, caps ? JSON.stringify(caps) : null, lastSync ?? null, id);
    },

    // ----- folders -----
    upsertFolder(account: string, path: string, name: string, role: string) {
      const existing = q.folderByPath.get(account, path) as any;
      const id = existing?.id ?? newId("fld");
      return q.upsertFolder.get(id, account, path, name, role) as { id: string; account: string; path: string; name: string; role: string };
    },
    foldersForAccount(account: string) {
      return q.foldersForAccount.all(account) as any[];
    },
    getSyncState(account: string): Record<string, unknown> {
      const r = q.getSyncState.get(account) as any;
      return r ? JSON.parse(r.sync_state) : {};
    },
    setSyncState(account: string, state: Record<string, unknown>) {
      q.setSyncState.run(JSON.stringify(state), account);
    },

    // ----- messages -----
    messageById(id: string): MessageRow | null {
      const r = q.messageById.get(id);
      return r ? rowToMessage(r) : null;
    },
    messageByHeaderId(account: string, headerId: string): MessageRow | null {
      const r = q.messageByHeaderId.get(account, headerId);
      return r ? rowToMessage(r) : null;
    },
    messageByFolderRef(folderId: string, ref: string): MessageRow | null {
      const r = q.messageByFolderRef.get(folderId, ref);
      return r ? rowToMessage(r) : null;
    },
    messageByRef(account: string, ref: string): MessageRow | null {
      const r = q.messageByRef.get(account, ref);
      return r ? rowToMessage(r) : null;
    },
    insertMessage(m: MessageRow): boolean {
      const r = q.insertMessage.run({
        id: m.id,
        account: m.account,
        thread_id: m.thread_id,
        header_message_id: m.header_message_id,
        in_reply_to: m.in_reply_to,
        refs: JSON.stringify(m.refs),
        subject: m.subject,
        from_json: m.from ? JSON.stringify(m.from) : null,
        to_json: JSON.stringify(m.to),
        cc_json: JSON.stringify(m.cc),
        date: m.date,
        flags: JSON.stringify(m.flags),
        trust: m.trust,
        size: m.size,
        snippet: m.snippet,
        has_attachments: m.has_attachments ? 1 : 0,
      });
      if (r.changes === 0) return false;
      const people = [m.from, ...m.to, ...m.cc]
        .filter(Boolean)
        .map((a) => `${a!.name ?? ""} ${a!.address}`)
        .join(" ");
      q.insertFts.run(m.id, m.subject, people, m.snippet);
      return true;
    },
    setFlags(id: string, flags: Flags) {
      q.setFlags.run(JSON.stringify(flags), id);
    },
    linkFolder(messageId: string, folderId: string, ref: string) {
      q.linkFolder.run(messageId, folderId, ref);
    },
    unlinkFolder(messageId: string, folderId: string) {
      q.unlinkFolder.run(messageId, folderId);
    },
    foldersOfMessage(messageId: string) {
      return q.foldersOfMessage.all(messageId) as { folder_id: string; ref: string }[];
    },
    refsInFolder(folderId: string) {
      return q.refsInFolder.all(folderId) as { message_id: string; ref: string }[];
    },
    search(query: string, limit = 50): MessageRow[] {
      return (q.search.all(query, limit) as any[]).map(rowToMessage);
    },

    setSnippet(id: string, snippet: string) {
      q.setSnippet.run(snippet, id);
      q.setFtsSnippet.run(snippet, id);
    },
    senderSeen(account: string, address: string): boolean {
      return !!q.senderSeen.get(account, `%"address":${JSON.stringify(address)}%`);
    },

    // ----- threads -----
    upsertThread(id: string, account: string, subject: string, lastActivity: string) {
      q.upsertThread.run(id, account, subject, lastActivity);
    },
    threadMessages(threadId: string): MessageRow[] {
      return (q.threadMessages.all(threadId) as any[]).map(rowToMessage);
    },
    threadBySubject(account: string, baseSubject: string, since: string): string | null {
      return (q.threadBySubject.get(account, baseSubject, since) as any)?.id ?? null;
    },
    messagesReferencing(account: string, headerId: string): MessageRow[] {
      return (q.messagesReferencing.all(account, `%${JSON.stringify(headerId)}%`) as any[]).map(rowToMessage);
    },
    rethread(fromThread: string, intoThread: string) {
      q.rethread.run(intoThread, fromThread);
    },

    // ----- actions -----
    insertAction(a: { id: string; client_key: string; type: string; account: string | null; params: unknown; status: string; requested_by: string }) {
      const t = now();
      q.insertAction.run({ ...a, params: JSON.stringify(a.params), created_at: t, updated_at: t });
    },
    actionById(id: string) {
      return parseAction(q.actionById.get(id));
    },
    actionByKey(key: string) {
      return parseAction(q.actionByKey.get(key));
    },
    updateAction(id: string, status: string, patch: { journal?: unknown; result?: unknown; error?: string | null } = {}) {
      q.updateAction.run(
        status,
        patch.journal === undefined ? null : JSON.stringify(patch.journal),
        patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.error ?? null,
        now(),
        id,
      );
    },

    // ----- timers -----
    insertTimer(id: string, fireAt: string, eventType: string, payload: unknown, createdBy: string, account: string) {
      q.insertTimer.run(id, fireAt, eventType, JSON.stringify(payload), createdBy, account);
    },
    dueTimers() {
      return (q.dueTimers.all(now()) as any[]).map((t) => ({ ...t, payload: JSON.parse(t.payload) }));
    },
    markTimer(id: string, state: 1 | 2) {
      q.markTimer.run(state, id); // 1 = fired, 2 = cancelled
    },

    // ----- tokens -----
    insertToken(id: string, secretHash: string, scope: Omit<Token, "id">) {
      q.insertToken.run(id, secretHash, JSON.stringify(scope));
    },
    tokenByHash(hash: string): Token | null {
      const r = q.tokenByHash.get(hash) as any;
      return r ? { ...JSON.parse(r.scope), id: r.id } : null;
    },
    tokens(): Token[] {
      return (q.tokens.all() as any[]).map((r) => ({ ...JSON.parse(r.scope), id: r.id }));
    },
    deleteToken(id: string): boolean {
      return q.deleteToken.run(id).changes > 0;
    },
    accountById(id: string) {
      const a = (q.accounts.all() as any[]).find((a) => a.id === id);
      return a
        ? { ...a, config: JSON.parse(a.config) as AccountConfig, capabilities: a.capabilities ? (JSON.parse(a.capabilities) as Capabilities) : null }
        : null;
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    close() {
      db.close();
    },
  };
}
