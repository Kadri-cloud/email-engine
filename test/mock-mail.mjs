// Shared pieces for the mock Gmail and Graph servers: a tiny MIME header parser,
// a mailbox model with threading, and the /_mock/* side-channel endpoints the
// conformance suite drives. The mocks implement the documented API shapes; they
// do not reproduce every provider quirk. Live validation needs real credentials.
import { createServer } from "node:http";

export function parseMime(raw) {
  const text = raw.toString("utf8");
  const sep = text.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const i = text.indexOf(sep);
  const head = (i >= 0 ? text.slice(0, i) : text).replace(/\r?\n[ \t]+/g, " ");
  const body = i >= 0 ? text.slice(i + sep.length) : "";
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    const j = line.indexOf(":");
    if (j > 0) headers.push({ name: line.slice(0, j).trim(), value: line.slice(j + 1).trim() });
  }
  const get = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
  return { headers, get, body, preview: body.replace(/\s+/g, " ").trim().slice(0, 255) };
}

export const parseAddr = (s) => {
  if (!s) return null;
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s) ?? /^\s*([^\s@]+@[^\s@]+)\s*$/.exec(s);
  if (!m) return null;
  return { address: (m[2] ?? m[1]).trim(), name: m[2] ? (m[1] ?? "").trim() : "" };
};
export const parseAddrs = (s) => (s ?? "").split(",").map(parseAddr).filter(Boolean);

/** Thread id for a new message: the parent's thread when In-Reply-To/References point at a known message. */
export function threadFor(mime, all, own) {
  const refs = [...((mime.get("References") ?? "").match(/<[^<>\s]+>/g) ?? []), mime.get("In-Reply-To")].filter(Boolean);
  for (const r of refs) {
    const parent = [...all.values()].find((m) => m.mime.get("Message-ID") === r);
    if (parent) return parent.threadId;
  }
  return own;
}

export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Start an HTTP server whose handler returns [status, body] or a Response-like object. */
export function serve(port, handler) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const body = await readBody(req);
      const out = await handler({ method: req.method, url, headers: req.headers, body });
      if (!out) return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 404, message: `no route ${req.method} ${url.pathname}` } }));
      const [status, payload, type = "application/json"] = out;
      res.writeHead(status, { "content-type": type });
      res.end(payload === undefined ? "" : typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: e.message } }));
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
  return server;
}

/** IMAP flag names used by the conformance side channel -> a neutral {seen, flagged, answered} patch. */
export function flagPatch(flags, add) {
  const p = {};
  for (const f of flags) {
    if (f === "\\Seen") p.seen = add;
    if (f === "\\Flagged") p.flagged = add;
    if (f === "\\Answered") p.answered = add;
  }
  return p;
}
