// Mock Microsoft Graph mail API for the conformance suite: well-known folders,
// per-folder delta queries with removed entries, PATCH/move/delete, MIME create,
// sendMail, plus /_mock/* side-channel endpoints. Usage: node test/mock-graph.mjs [port]
import { flagPatch, parseAddr, parseAddrs, parseMime, serve, threadFor } from "./mock-mail.mjs";

const port = Number(process.argv[2] ?? 18510);
const folders = new Map(); // id -> {id, displayName, wellKnown}
const WELL_KNOWN = { inbox: "Inbox", sentitems: "Sent Items", drafts: "Drafts", deleteditems: "Deleted Items", junkemail: "Junk Email", archive: "Archive" };
let fseq = 1;
for (const [wk, name] of Object.entries(WELL_KNOWN)) {
  const id = `F${fseq++}`;
  folders.set(id, { id, displayName: name, wellKnown: wk });
}
const folderId = (wkOrId) => (folders.has(wkOrId) ? wkOrId : [...folders.values()].find((f) => f.wellKnown === wkOrId)?.id);
const folderByName = (name) => [...folders.values()].find((f) => f.displayName === name) ?? [...folders.values()].find((f) => f.wellKnown === "archive");

let seq = 1;
let mseq = 1;
const messages = new Map(); // id -> message model
const changes = []; // {seq, folderId, id, removed}
const touch = (m, fid = m.folderId, removed = false) => changes.push({ seq: ++seq, folderId: fid, id: m.id, removed });

const toJson = (m) => ({
  id: m.id,
  conversationId: m.conversationId,
  parentFolderId: m.folderId,
  isRead: m.isRead,
  isDraft: m.isDraft,
  flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
  subject: m.mime.get("Subject") ?? "",
  from: m.from ? { emailAddress: m.from } : null,
  toRecipients: m.to.map((a) => ({ emailAddress: a })),
  ccRecipients: m.cc.map((a) => ({ emailAddress: a })),
  receivedDateTime: m.received,
  sentDateTime: m.received,
  bodyPreview: m.mime.preview,
  hasAttachments: false,
  internetMessageId: m.mime.get("Message-ID"),
  internetMessageHeaders: m.mime.headers,
});
const addMessage = (raw, fid, extra = {}) => {
  const mime = parseMime(raw);
  const id = `M${mseq++}`;
  const m = {
    id, folderId: fid, mime, raw, isRead: false, flagged: false, isDraft: false,
    from: parseAddr(mime.get("From")), to: parseAddrs(mime.get("To")), cc: parseAddrs(mime.get("Cc")),
    received: new Date(Date.parse(mime.get("Date") ?? "") || Date.now()).toISOString(),
    conversationId: threadFor(mime, messages, `C${id}`),
    ...extra,
  };
  messages.set(id, m);
  touch(m);
  return m;
};
const byMessageId = (mid) => [...messages.values()].find((m) => m.mime.get("Message-ID") === mid);
const moveTo = (m, fid) => {
  if (m.folderId === fid) return;
  touch(m, m.folderId, true);
  m.folderId = fid;
  touch(m);
};
const remove = (m) => {
  messages.delete(m.id);
  touch(m, m.folderId, true);
};

serve(port, async ({ method, url, headers, body }) => {
  const p = url.pathname;
  const isJson = (headers["content-type"] ?? "").includes("json");
  const json = body.length && isJson ? JSON.parse(body.toString("utf8")) : {};

  // ----- side channel -----
  if (p === "/_mock/inject") return [200, { id: addMessage(Buffer.from(json.raw), folderId("inbox")).id }];
  if (p === "/_mock/flag") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    const f = flagPatch(json.flags, json.add);
    if (f.seen !== undefined) m.isRead = f.seen;
    if (f.flagged !== undefined) m.flagged = f.flagged;
    touch(m);
    return [200, { ok: true }];
  }
  if (p === "/_mock/flagAll") {
    const f = flagPatch(json.flags, true);
    for (const m of messages.values()) {
      if (m.folderId !== folderId("inbox")) continue;
      if (f.seen) m.isRead = true;
      if (f.flagged) m.flagged = true;
      touch(m);
    }
    return [200, { ok: true }];
  }
  if (p === "/_mock/move") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    const f = json.to === "INBOX" ? folders.get(folderId("inbox")) : folderByName(json.to);
    moveTo(m, f.id);
    return [200, { ok: true }];
  }
  if (p === "/_mock/expunge") {
    const m = byMessageId(json.messageId);
    if (!m) return [404, { error: "no such message" }];
    remove(m);
    return [200, { ok: true }];
  }
  if (p === "/_mock/purge") {
    for (const m of [...messages.values()]) remove(m);
    return [200, { ok: true }];
  }
  if (p === "/_mock/capabilities") return [200, []];

  // ----- OAuth -----
  if (/\/oauth2\/v2\.0\/token$/.test(p)) return [200, { access_token: "mock-access", expires_in: 3600, token_type: "Bearer" }];

  // ----- Graph -----
  const g = /^\/v1\.0\/me(\/.*)$/.exec(p);
  if (!g) return null;
  const r = g[1];
  if (r === "/mailFolders" && method === "GET") return [200, { value: [...folders.values()].map((f) => ({ id: f.id, displayName: f.displayName, parentFolderId: null })) }];
  const fm = /^\/mailFolders\/([^/]+)(\/messages(?:\/delta)?)?$/.exec(r);
  if (fm) {
    const fid = folderId(fm[1]);
    if (!fid) return [404, { error: { code: "ErrorItemNotFound", message: "folder not found" } }];
    const f = folders.get(fid);
    if (!fm[2]) return [200, { id: f.id, displayName: f.displayName, parentFolderId: null }];
    if (fm[2] === "/messages" && method === "POST") {
      // MIME create: body is base64 text
      const m = addMessage(Buffer.from(body.toString("utf8"), "base64"), fid, { isDraft: true });
      return [201, toJson(m)];
    }
    if (fm[2] === "/messages/delta") {
      const token = url.searchParams.get("$deltatoken");
      const sinceSeq = token ? Number(token) : null;
      let value;
      if (sinceSeq === null) {
        value = [...messages.values()].filter((m) => m.folderId === fid).map(toJson);
      } else {
        const latest = new Map();
        for (const c of changes) if (c.seq > sinceSeq && c.folderId === fid) latest.set(c.id, c);
        value = [...latest.values()].map((c) => {
          const m = messages.get(c.id);
          return c.removed || !m || m.folderId !== fid ? { id: c.id, "@removed": { reason: "deleted" } } : toJson(m);
        });
      }
      return [200, { value, "@odata.deltaLink": `http://127.0.0.1:${port}/v1.0/me/mailFolders/${fid}/messages/delta?$deltatoken=${seq}` }];
    }
  }
  if (r === "/sendMail" && method === "POST") {
    addMessage(Buffer.from(body.toString("utf8"), "base64"), folderId("sentitems"), { isRead: true });
    return [202];
  }
  const mm = /^\/messages\/([^/]+)(\/move|\/copy|\/\$value)?$/.exec(r);
  if (mm) {
    const m = messages.get(mm[1]);
    if (!m) return [404, { error: { code: "ErrorItemNotFound", message: "message not found" } }];
    if (mm[2] === "/$value") return [200, m.raw, "message/rfc822"];
    if (mm[2] === "/copy") {
      // Graph copies are new messages with their own ids and the same headers.
      const dest = folderId(json.destinationId);
      if (!dest) return [404, { error: { code: "ErrorItemNotFound", message: "destination not found" } }];
      const c = addMessage(m.raw, dest, { isRead: m.isRead, flagged: m.flagged });
      return [201, toJson(c)];
    }
    if (mm[2] === "/move") {
      const dest = folderId(json.destinationId);
      if (!dest) return [404, { error: { code: "ErrorItemNotFound", message: "destination not found" } }];
      moveTo(m, dest);
      return [201, toJson(m)];
    }
    if (method === "PATCH") {
      if (json.isRead !== undefined) m.isRead = json.isRead;
      if (json.flag) m.flagged = json.flag.flagStatus === "flagged";
      touch(m);
      return [200, toJson(m)];
    }
    if (method === "DELETE") {
      const trash = folderId("deleteditems");
      if (m.folderId === trash) remove(m);
      else moveTo(m, trash);
      return [204];
    }
    return [200, toJson(m)];
  }
  return null;
});
