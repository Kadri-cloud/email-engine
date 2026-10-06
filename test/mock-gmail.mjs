// Mock Gmail API for the conformance suite: labels, messages, history, drafts,
// send, plus /_mock/* side-channel endpoints. Usage: node test/mock-gmail.mjs [port]
import { flagPatch, parseMime, serve, threadFor } from "./mock-mail.mjs";

const port = Number(process.argv[2] ?? 18500);
const SYSTEM = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT"];
const FOLDERS = new Set(["INBOX", "SENT", "DRAFT", "TRASH", "SPAM"]);
let seq = 1000;
let historyId = 1;
const messages = new Map(); // id -> {id, threadId, labels:Set, raw, mime, internalDate, historyId}
const history = []; // {id, messagesAdded, messagesDeleted, labelsAdded, labelsRemoved}
const userLabels = new Map(); // id -> name

const record = (entry) => {
  historyId++;
  history.push({ id: String(historyId), ...entry });
};
const summary = (m) => ({ id: m.id, threadId: m.threadId, labelIds: [...m.labels] });
const toJson = (m, format) => {
  const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labels], snippet: m.mime.preview, sizeEstimate: m.raw.length, internalDate: String(m.internalDate), historyId: String(m.historyId) };
  if (format === "raw") return { ...base, raw: m.raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
  return { ...base, payload: { mimeType: "text/plain", headers: m.mime.headers } };
};
const addMessage = (raw, labels) => {
  const mime = parseMime(raw);
  const id = (seq++).toString(16);
  const m = { id, threadId: threadFor(mime, messages, id), labels: new Set(labels), raw, mime, internalDate: Date.parse(mime.get("Date") ?? "") || Date.now(), historyId: historyId + 1 };
  messages.set(id, m);
  record({ messagesAdded: [{ message: summary(m) }] });
  return m;
};
const modify = (m, add, remove) => {
  const added = add.filter((l) => !m.labels.has(l));
  const removed = remove.filter((l) => m.labels.has(l));
  for (const l of add) m.labels.add(l);
  for (const l of remove) m.labels.delete(l);
  if (added.length) record({ labelsAdded: [{ message: summary(m), labelIds: added }] });
  if (removed.length) record({ labelsRemoved: [{ message: summary(m), labelIds: removed }] });
  m.historyId = historyId;
};
const remove = (m) => {
  messages.delete(m.id);
  record({ messagesDeleted: [{ message: summary(m) }] });
};
const byMessageId = (mid) => [...messages.values()].find((m) => m.mime.get("Message-ID") === mid);
const labelIdFor = (name) => {
  if (name === "Archive") return null;
  const up = name.toUpperCase();
  if (SYSTEM.includes(up)) return up;
  for (const [id, n] of userLabels) if (n === name) return id;
  const id = `Label_${userLabels.size + 1}`;
  userLabels.set(id, name);
  return id;
};
const decodeRaw = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

serve(port, async ({ method, url, headers, body }) => {
  const p = url.pathname;
  const json = body.length && (headers["content-type"] ?? "").includes("json") ? JSON.parse(body.toString("utf8")) : {};

  // ----- side channel -----
  if (p === "/_mock/inject") return [200, summary(addMessage(Buffer.from(json.raw), ["INBOX", "UNREAD"]))];
  if (p === "/_mock/flag") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    const f = flagPatch(json.flags, json.add);
    const add = [], rem = [];
    if (f.seen !== undefined) (f.seen ? rem : add).push("UNREAD");
    if (f.flagged !== undefined) (f.flagged ? add : rem).push("STARRED");
    modify(m, add, rem);
    return [200, summary(m)];
  }
  if (p === "/_mock/flagMany") {
    const f = flagPatch(json.flags, true);
    for (const mid of json.messageIds) {
      const m = byMessageId(mid);
      if (m) modify(m, f.flagged ? ["STARRED"] : [], f.seen ? ["UNREAD"] : []);
    }
    return [200, { ok: true }];
  }
  if (p === "/_mock/flagAll") {
    const f = flagPatch(json.flags, true);
    for (const m of messages.values()) if (m.labels.has("INBOX")) modify(m, f.flagged ? ["STARRED"] : [], f.seen ? ["UNREAD"] : []);
    return [200, { ok: true }];
  }
  if (p === "/_mock/move") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    const to = labelIdFor(json.to);
    modify(m, to ? [to] : [], [...m.labels].filter((l) => FOLDERS.has(l) && l !== to));
    return [200, summary(m)];
  }
  if (p === "/_mock/expunge") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    remove(m);
    return [200, { ok: true }];
  }
  if (p === "/_mock/purge") {
    for (const m of [...messages.values()]) remove(m);
    labelIdFor("Projects"); // a user label, as real accounts have; "Archive" on Gmail is the absence of INBOX, not a label
    return [200, { ok: true }];
  }
  if (p === "/_mock/capabilities") return [200, []];

  // ----- OAuth -----
  if (p === "/token") return [200, { access_token: "mock-access", expires_in: 3600, token_type: "Bearer" }];

  // ----- Gmail API -----
  const g = /^\/gmail\/v1\/users\/me(\/.*)?$/.exec(p);
  if (!g) return null;
  const r = g[1] ?? "";
  if (r === "/profile") return [200, { emailAddress: "mock@gmail.test", messagesTotal: messages.size, historyId: String(historyId) }];
  if (r === "/labels") {
    const labels = [...SYSTEM.map((id) => ({ id, name: id, type: "system" })), ...[...userLabels].map(([id, name]) => ({ id, name, type: "user" }))];
    return [200, { labels }];
  }
  if (r === "/messages" && method === "GET") {
    const max = Number(url.searchParams.get("maxResults") ?? 100);
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const all = [...messages.values()].sort((a, b) => b.internalDate - a.internalDate);
    const page = all.slice(start, start + max);
    return [200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + max < all.length ? { nextPageToken: String(start + max) } : {}), resultSizeEstimate: all.length }];
  }
  if (r === "/messages" && method === "POST") {
    const m = addMessage(decodeRaw(json.raw), json.labelIds ?? []);
    return [200, toJson(m, "metadata")];
  }
  if (r === "/messages/send" && method === "POST") {
    const m = addMessage(decodeRaw(json.raw), ["SENT"]);
    return [200, toJson(m, "metadata")];
  }
  if (r === "/drafts" && method === "POST") {
    const m = addMessage(decodeRaw(json.message.raw), ["DRAFT"]);
    return [200, { id: `d-${m.id}`, message: toJson(m, "metadata") }];
  }
  if (r === "/history") {
    const since = Number(url.searchParams.get("startHistoryId"));
    if (!history.length || since < Number(history[0].id) - 1) return [404, { error: { code: 404, message: "startHistoryId too old" } }];
    const entries = history.filter((h) => Number(h.id) > since);
    return [200, { history: entries, historyId: String(historyId) }];
  }
  const mm = /^\/messages\/([^/]+)(\/modify)?$/.exec(r);
  if (mm) {
    const m = messages.get(mm[1]);
    if (!m) return [404, { error: { code: 404, message: "Not Found" } }];
    if (mm[2] === "/modify") {
      modify(m, json.addLabelIds ?? [], json.removeLabelIds ?? []);
      return [200, toJson(m, "metadata")];
    }
    if (method === "DELETE") {
      remove(m);
      return [204];
    }
    return [200, toJson(m, url.searchParams.get("format") ?? "full")];
  }
  return null;
});
