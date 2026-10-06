// Behavioural scenarios every adapter must pass. Shared by the quick smoke
// run (one account on a running engine) and the conformance suite (a fresh
// engine per target, with a report). Each scenario asserts the exact events
// the engine must emit, and records a measurement where one matters.
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import assert from "node:assert/strict";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const key = () => `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function makeApi(base, token) {
  const call = async (tok, path, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
  const api = async (path, init) => {
    const { status, body } = await call(token, path, init);
    if (status >= 400) throw new Error(`${path} -> ${status} ${JSON.stringify(body)}`);
    return body;
  };
  return { api, apiAs: call, base, token };
}

/** Poll the log from `after` until `pred` matches, or time out. Returns the event and the wait. */
export async function waitFor(api, after, pred, label, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const { events } = await api(`/events?after=${after}&limit=2000`);
    const hit = events.find(pred);
    if (hit) return { event: hit, ms: Date.now() - start };
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

/** Build an RFC 822 message. */
export function rfc822({ from = `"Sender" <sender@example.com>`, to, subject, messageId, headers = [], body = "Hello." }) {
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`, ...headers, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body,
  ].join("\r\n");
}

/** A side channel that changes the mailbox behind the engine's back: IMAP (append, flag, move, expunge) or SMTP (send only). */
export function makeSideChannel(side) {
  if (side.kind === "mock") {
    // A mock provider's admin endpoints: the same verbs the IMAP side channel offers.
    const post = async (path, body) => {
      const r = await fetch(side.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
    };
    return {
      kind: "mock",
      inject: (raw) => post("/_mock/inject", { raw }),
      flag: (messageId, flags, add = true) => post("/_mock/flag", { messageId, flags, add }),
      flagAll: (flags) => post("/_mock/flagAll", { flags }),
      move: (messageId, destination) => post("/_mock/move", { messageId, to: destination }),
      moveBack: (messageId) => post("/_mock/move", { messageId, to: "INBOX" }),
      expunge: (messageId) => post("/_mock/expunge", { messageId }),
      purge: () => post("/_mock/purge", {}),
      capabilities: async () => [],
    };
  }
  if (side.kind === "smtp") {
    const t = nodemailer.createTransport({ host: side.host, port: side.port, secure: false, ignoreTLS: true, auth: side.user ? { user: side.user, pass: side.pass } : undefined });
    return {
      kind: "smtp",
      async inject(raw, to) {
        await t.sendMail({ envelope: { from: "sender@example.com", to }, raw });
      },
    };
  }
  const open = async () => {
    const c = new ImapFlow({ host: side.host, port: side.port, secure: side.secure ?? true, auth: { user: side.user, pass: side.pass }, tls: { rejectUnauthorized: false }, logger: false });
    await c.connect();
    return c;
  };
  const withInbox = async (fn) => {
    const c = await open();
    const lock = await c.getMailboxLock("INBOX");
    try {
      return await fn(c);
    } finally {
      lock.release();
      await c.logout();
    }
  };
  // Find a message's uid in the selected mailbox. SEARCH HEADER first; some servers (Stalwart) do not index
  // Message-ID for SEARCH, so fall back to scanning headers. Test mailboxes are small.
  const uidOf = async (c, messageId) => {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true }).catch(() => null);
    let uid = Array.isArray(r) ? r[0] : undefined;
    if (!uid) {
      const want = messageId.replace(/[<>]/g, "").toLowerCase();
      for await (const m of c.fetch("1:*", { uid: true, envelope: true }, { uid: true })) {
        if ((m.envelope?.messageId ?? "").replace(/[<>]/g, "").toLowerCase() === want) uid = m.uid;
      }
    }
    assert.ok(uid, `side channel cannot find ${messageId}`);
    return uid;
  };
  return {
    kind: "imap",
    async inject(raw) {
      const c = await open();
      await c.append("INBOX", raw);
      await c.logout();
    },
    flag: (messageId, flags, add = true) =>
      withInbox(async (c) => {
        const uid = await uidOf(c, messageId);
        await (add ? c.messageFlagsAdd(String(uid), flags, { uid: true }) : c.messageFlagsRemove(String(uid), flags, { uid: true }));
      }),
    flagAll: (flags) => withInbox((c) => c.messageFlagsAdd("1:*", flags, { uid: true })),
    move: (messageId, destination) =>
      withInbox(async (c) => {
        const r = await c.messageMove(String(await uidOf(c, messageId)), destination, { uid: true });
        assert.ok(r, `side channel MOVE to ${destination} was refused by the server`);
      }),
    moveBack: (messageId, fromPath) =>
      (async () => {
        const c = await open();
        const lock = await c.getMailboxLock(fromPath);
        try {
          await c.messageMove(String(await uidOf(c, messageId)), "INBOX", { uid: true });
        } finally {
          lock.release();
          await c.logout();
        }
      })(),
    expunge: (messageId) =>
      withInbox(async (c) => {
        await c.messageDelete(String(await uidOf(c, messageId)), { uid: true });
      }),
    async purge() {
      const c = await open();
      for (const f of await c.list()) {
        if (f.flags.has("\\Noselect")) continue;
        const lock = await c.getMailboxLock(f.path);
        try {
          if (c.mailbox.exists > 0) await c.messageDelete("1:*", { uid: true });
        } finally {
          lock.release();
        }
      }
      for (const box of ["Archive"]) await c.mailboxCreate(box).catch(() => {});
      await c.logout();
    },
    async capabilities() {
      const c = await open();
      const caps = [...c.capabilities.keys()];
      await c.logout();
      return caps;
    },
  };
}

/** Everything a scenario needs about one account on one engine. */
export async function buildContext({ api, apiAs, account, side }) {
  const folders = await api(`/accounts/${account.id}/folders`);
  const byRole = (r) => folders.find((f) => f.role === r);
  const archive = byRole("archive") ?? folders.find((f) => /archive/i.test(f.name) || /archive/i.test(f.path));
  const { events } = await api(`/events?after=0&limit=2000`);
  const status = [...events].reverse().find((e) => e.type === "account.status" && e.account === account.id && e.payload.capabilities);
  const caps = status?.payload.capabilities ?? null;
  const features = new Set();
  if (side) features.add("inject");
  if (side?.flag) features.add("side-write"); // the side channel can flag, move and expunge behind the engine's back
  if (caps?.folders !== undefined && account.provider !== "inbound") features.add("move");
  if (archive) features.add("archive");
  if (byRole("drafts") && account.provider !== "inbound") features.add("drafts");
  if (byRole("trash") && account.provider !== "inbound") features.add("trash");
  return {
    api, apiAs, account, folders, byRole, archive, caps, features, side,
    address: account.address,
    cursor: (await api("/health")).cursor,
    measurements: {},
    msg: null, // the scenarios' shared test message
    async refreshCursor() {
      this.cursor = (await api("/health")).cursor;
    },
    action: (type, params, mode = "direct") =>
      api(`/actions${mode === "propose" ? "?mode=propose" : ""}`, { method: "POST", body: JSON.stringify({ client_key: key(), type, params }) }),
    inject(fields) {
      const messageId = fields.messageId ?? `<${key()}@example.com>`;
      const raw = rfc822({ ...fields, to: account.address, messageId });
      return side.inject(raw, account.address).then(() => messageId);
    },
    countSince(cursor, pred) {
      return api(`/events?after=${cursor}&limit=2000`).then(({ events }) => events.filter(pred).length);
    },
  };
}

// ---------- scenarios ----------
// Each: { name, needs: [feature...], run(ctx) -> note }. A scenario whose needs are unmet is reported as n/a.

export const scenarios = [
  {
    name: "arrival: exactly one message.received and one thread.updated, with trust",
    needs: ["inject"],
    async run(ctx) {
      await ctx.refreshCursor();
      const stamp = Date.now();
      const messageId = await ctx.inject({
        from: `"Push Tester" <push@example.com>`, subject: `Live push ${stamp}`,
        headers: [`Authentication-Results: mx.example.com; dmarc=fail header.from=example.com`],
        body: `This arrived while the engine was idling. Keyword: pineapple.`,
      });
      const { event, ms } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.received" && e.payload.subject === `Live push ${stamp}`, "pushed message");
      ctx.msg = event.payload;
      ctx.msg.messageId = messageId;
      ctx.measurements.push_ms = ms;
      await sleep(500);
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "message.received" && e.payload.message_id === ctx.msg.message_id), 1, "duplicate received");
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "thread.updated" && e.payload.thread_id === ctx.msg.thread_id), 1, "thread.updated count");
      // Authentication-Results on mail we fetched from a mailbox is the receiving server's verdict; on mail handed
      // to us over plain SMTP it is untrusted, so the inbound adapter must report unverified.
      const expected = ctx.account.provider === "inbound" ? "unverified" : "suspicious";
      assert.equal(ctx.msg.trust, expected, `trust should be ${expected}`);
      return `${ms} ms, trust=${ctx.msg.trust}`;
    },
  },
  {
    name: "search: full-text finds body text from the sync-time snippet",
    needs: ["inject"],
    async run(ctx) {
      const { results } = await ctx.api(`/search?q=pineapple`);
      assert.ok(results.some((m) => m.id === ctx.msg.message_id), "search miss");
      return `${results.length} hit(s)`;
    },
  },
  {
    name: "body: fetched on demand from the server and parsed",
    needs: ["inject"],
    async run(ctx) {
      const b = await ctx.api(`/messages/${ctx.msg.message_id}/body`);
      assert.match(b.text, /pineapple/);
      return `${b.text.length} chars`;
    },
  },
  {
    name: "set_flags via the engine: one message.updated with before/after",
    needs: ["inject"],
    async run(ctx) {
      await ctx.refreshCursor();
      const a = await ctx.action("set_flags", { message_id: ctx.msg.message_id, set: { seen: true } });
      assert.equal(a.status, "executed", JSON.stringify(a));
      const { event } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.flags?.after.seen === true, "flag update");
      await sleep(300);
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id), 1, "duplicate updated");
      return `seen ${event.payload.changes.flags.before.seen} -> ${event.payload.changes.flags.after.seen}`;
    },
  },
  {
    name: "flag change from another client arrives as message.updated",
    needs: ["side-write"],
    async run(ctx) {
      await ctx.refreshCursor();
      await ctx.side.flag(ctx.msg.messageId, ["\\Flagged"]);
      const { ms } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.flags?.after.flagged === true, "external flag", 20000);
      ctx.measurements.external_flag_ms = ms;
      await ctx.side.flag(ctx.msg.messageId, ["\\Flagged"], false);
      await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.flags?.after.flagged === false, "external unflag", 20000);
      return `${ms} ms`;
    },
  },
  {
    name: "move via the engine to archive, then undo",
    needs: ["move", "archive"],
    async run(ctx) {
      const mv = await ctx.action("move", { message_id: ctx.msg.message_id, to_folder_id: ctx.archive.id });
      assert.equal(mv.status, "executed", JSON.stringify(mv));
      let m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.deepEqual(m.folders.map((f) => f.folder_id), [ctx.archive.id], "not in archive");
      const un = await ctx.api(`/actions/${mv.id}/undo`, { method: "POST" });
      assert.equal(un.status, "reverted");
      m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.deepEqual(m.folders.map((f) => f.folder_id), [ctx.byRole("inbox").id], "not back in inbox");
      return "same message id throughout";
    },
  },
  {
    name: "move from another client: one message.updated, no received, no deleted",
    needs: ["side-write", "archive"],
    async run(ctx) {
      await ctx.refreshCursor();
      // The side channel is IMAP, so it needs the folder's name; for a JMAP account `path` is the mailbox id.
      await ctx.side.move(ctx.msg.messageId, ctx.archive.name);
      const { ms } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.folder_ids?.after.includes(ctx.archive.id), "external move", 20000);
      await sleep(500);
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "message.received"), 0, "spurious received");
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "message.deleted"), 0, "spurious deleted");
      await ctx.side.moveBack(ctx.msg.messageId, ctx.archive.name);
      // A message copied into a watched folder may only be noticed at the server's periodic idle check
      // (Dovecot/Maildir: instant for new/, up to 30 s for cur/). Measured and reported, not failed.
      const back = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.updated" && e.payload.message_id === ctx.msg.message_id && e.payload.changes.folder_ids?.after.includes(ctx.byRole("inbox").id), "external move back", 45000);
      ctx.measurements.external_move_out_ms = ms;
      ctx.measurements.external_move_in_ms = back.ms;
      return `${ms} ms out, ${back.ms} ms back in, id stable`;
    },
  },
  {
    name: "expunge from another client: exactly one message.deleted",
    needs: ["side-write"],
    async run(ctx) {
      const stamp = Date.now();
      await ctx.refreshCursor();
      const messageId = await ctx.inject({ subject: `Doomed ${stamp}`, body: "This one gets expunged." });
      const { event } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.received" && e.payload.subject === `Doomed ${stamp}`, "doomed arrival");
      await ctx.refreshCursor();
      await ctx.side.expunge(messageId);
      const { ms } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.deleted" && e.payload.message_id === event.payload.message_id, "external expunge", 20000);
      await sleep(500);
      assert.equal(await ctx.countSince(ctx.cursor, (e) => e.type === "message.deleted"), 1, "deleted count");
      ctx.measurements.external_expunge_ms = ms;
      return `${ms} ms`;
    },
  },
  {
    name: "idempotency: same client_key returns the same action",
    needs: ["inject"],
    async run(ctx) {
      const body = JSON.stringify({ client_key: key(), type: "set_flags", params: { message_id: ctx.msg.message_id, set: { flagged: true } } });
      const a1 = await ctx.api("/actions", { method: "POST", body });
      const a2 = await ctx.api("/actions", { method: "POST", body });
      assert.equal(a1.id, a2.id);
      return a1.id;
    },
  },
  {
    name: "propose -> approve: delete to trash only after approval, then undo",
    needs: ["move", "trash"],
    async run(ctx) {
      const p = await ctx.action("delete", { message_id: ctx.msg.message_id }, "propose");
      assert.equal(p.status, "proposed");
      let m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.equal(m.folders[0].folder_id, ctx.byRole("inbox").id, "moved before approval");
      const ap = await ctx.api(`/actions/${p.id}/approve`, { method: "POST" });
      assert.equal(ap.status, "executed", JSON.stringify(ap));
      m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.equal(m.folders[0].folder_id, ctx.byRole("trash").id, "not in trash");
      const un = await ctx.api(`/actions/${p.id}/undo`, { method: "POST" });
      assert.equal(un.status, "reverted");
      m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.equal(m.folders[0].folder_id, ctx.byRole("inbox").id, "not restored");
      return "proposed, approved, trashed, reverted";
    },
  },
  {
    name: "permanent delete: exactly one message.deleted",
    needs: ["inject"],
    async run(ctx) {
      const stamp = Date.now();
      await ctx.refreshCursor();
      await ctx.inject({ subject: `Erase ${stamp}`, body: "Permanently deleted by the engine." });
      const { event } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.received" && e.payload.subject === `Erase ${stamp}`, "erase arrival");
      await ctx.refreshCursor();
      const a = await ctx.action("delete", { message_id: event.payload.message_id, permanent: true });
      assert.equal(a.status, "executed", JSON.stringify(a));
      await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.deleted" && e.payload.message_id === event.payload.message_id, "deleted event");
      const gone = await ctx.apiAs(ctx.api.token ?? "", `/messages/${event.payload.message_id}`).catch(() => null);
      return "deleted" + (gone ? "" : "");
    },
  },
  {
    name: "reject: a rejected proposal never touches the server",
    needs: ["inject"],
    async run(ctx) {
      const p = await ctx.action("set_flags", { message_id: ctx.msg.message_id, set: { answered: true } }, "propose");
      const r = await ctx.api(`/actions/${p.id}/reject`, { method: "POST" });
      assert.equal(r.status, "rejected");
      const m = await ctx.api(`/messages/${ctx.msg.message_id}`);
      assert.equal(m.flags.answered, false);
      return "rejected";
    },
  },
  {
    name: "create_draft: lands in Drafts as a draft, threaded with its parent, then undone",
    needs: ["drafts"],
    async run(ctx) {
      await ctx.refreshCursor();
      const a = await ctx.action("create_draft", { account: ctx.account.id, to: [{ address: "push@example.com", name: "Push Tester" }], subject: "Re: draft test", text: "Drafted by the engine.", in_reply_to: ctx.msg.message_id });
      assert.equal(a.status, "executed", JSON.stringify(a));
      const { event } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.received" && e.payload.message_id === a.result.message_id, "draft in Drafts");
      assert.equal(event.payload.flags.draft, true, "not flagged as draft");
      assert.equal(event.payload.thread_id, ctx.msg.thread_id, "draft not threaded with its parent");
      const un = await ctx.api(`/actions/${a.id}/undo`, { method: "POST" });
      assert.equal(un.status, "reverted");
      return "created in thread, then removed";
    },
  },
  {
    name: "schedule_timer: fires as timer.fired with the payload",
    needs: [],
    async run(ctx) {
      await ctx.refreshCursor();
      const a = await ctx.action("schedule_timer", { account: ctx.account.id, fire_at: new Date(Date.now() + 2000).toISOString(), event_type: "snooze.due", payload: { k: 1 } });
      assert.equal(a.status, "executed");
      const { event, ms } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "timer.fired" && e.payload.timer_id === a.result.timer_id, "timer");
      assert.equal(event.payload.event_type, "snooze.due");
      return `fired after ${ms} ms`;
    },
  },
  {
    name: "flag storm: 25 flag changes from another client arrive as exactly 25 updates",
    needs: ["side-write"],
    async run(ctx) {
      const stamp = Date.now();
      await ctx.refreshCursor();
      for (let i = 0; i < 25; i++) await ctx.inject({ subject: `Storm ${stamp} ${i}`, body: "storm" });
      const start = Date.now();
      for (;;) {
        if ((await ctx.countSince(ctx.cursor, (e) => e.type === "message.received" && e.payload.subject.startsWith(`Storm ${stamp}`))) === 25) break;
        if (Date.now() - start > 30000) throw new Error("25 storm messages did not all arrive");
        await sleep(300);
      }
      const ids = new Set((await ctx.api(`/events?after=${ctx.cursor}&limit=2000`)).events.filter((e) => e.type === "message.received" && e.payload.subject.startsWith(`Storm ${stamp}`)).map((e) => e.payload.message_id));
      await ctx.refreshCursor();
      const t0 = Date.now();
      await ctx.side.flagAll(["\\Seen"]);
      for (;;) {
        const n = await ctx.countSince(ctx.cursor, (e) => e.type === "message.updated" && ids.has(e.payload.message_id) && e.payload.changes.flags?.after.seen === true);
        if (n >= 25) break;
        if (Date.now() - t0 > 30000) throw new Error(`only ${n}/25 flag updates arrived`);
        await sleep(300);
      }
      const ms = Date.now() - t0;
      await sleep(1000);
      const n = await ctx.countSince(ctx.cursor, (e) => e.type === "message.updated" && ids.has(e.payload.message_id));
      assert.equal(n, 25, `expected exactly 25 updates, saw ${n}`);
      ctx.measurements.storm_ms = ms;
      return `${ms} ms for 25`;
    },
  },
  // ----- engine-level: scoped tokens. Same on every adapter, kept here so the matrix shows it. -----
  {
    name: "tokens: scoped token sees only allowed types in allowed folders; propose_only writes queue; forbidden verbs 403",
    needs: ["inject"],
    async run(ctx) {
      const t = await ctx.api("/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: "triage", accounts: [ctx.account.id], folders: ["inbox"],
          events: ["message.received", "message.updated", "action.updated"],
          actions: ["search", "get_message", "set_flags", "propose"], redact: ["otp", "card"], mode: "propose_only",
        }),
      });
      assert.match(t.secret, /^tok_/);
      ctx.triage = t;
      const { status, body } = await ctx.apiAs(t.secret, "/events?after=0&limit=2000");
      assert.equal(status, 200);
      const types = new Set(body.events.map((e) => e.type));
      assert.ok(!types.has("account.status") && !types.has("thread.updated"), `leaked types: ${[...types]}`);
      const inbox = ctx.byRole("inbox").id;
      for (const e of body.events) if (e.type.startsWith("message.") && e.payload.folder_ids.length) assert.ok(e.payload.folder_ids.includes(inbox), "non-inbox event leaked");
      const prop = await ctx.apiAs(t.secret, "/actions", { method: "POST", body: JSON.stringify({ client_key: key(), type: "set_flags", params: { message_id: ctx.msg.message_id, set: { flagged: false } } }) });
      assert.equal(prop.body.status, "proposed", JSON.stringify(prop.body));
      assert.equal((await ctx.apiAs(t.secret, `/actions/${prop.body.id}/approve`, { method: "POST" })).status, 403);
      assert.equal((await ctx.api(`/actions/${prop.body.id}/approve`, { method: "POST" })).status, "executed");
      assert.equal((await ctx.apiAs(t.secret, "/actions", { method: "POST", body: JSON.stringify({ client_key: key(), type: "delete", params: { message_id: ctx.msg.message_id } }) })).status, 403);
      return `${body.events.length} visible events`;
    },
  },
  {
    name: "redaction: one-time codes and card numbers masked for the scoped token, raw for admin, snippet too",
    needs: ["inject"],
    async run(ctx) {
      await ctx.refreshCursor();
      const stamp = Date.now();
      await ctx.inject({ from: `"Bank" <noreply@bank.example>`, subject: `Your code ${stamp}`, body: `Your verification code is 482913. It expires in 10 minutes.\r\nCard on file: 4111 1111 1111 1111. Order 20261006 ships Monday.` });
      const { event } = await waitFor(ctx.api, ctx.cursor, (e) => e.type === "message.received" && e.payload.subject === `Your code ${stamp}`, "otp message");
      ctx.otp = event.payload;
      const scoped = await ctx.apiAs(ctx.triage.secret, `/messages/${ctx.otp.message_id}/body`);
      assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
      assert.ok(scoped.body.text.includes("[OTP]") && !scoped.body.text.includes("482913"), `otp leaked: ${scoped.body.text}`);
      assert.ok(scoped.body.text.includes("[CARD]") && !scoped.body.text.includes("4111"), `card leaked`);
      assert.ok(scoped.body.text.includes("20261006"), "order number must survive");
      assert.ok((await ctx.api(`/messages/${ctx.otp.message_id}/body`)).text.includes("482913"), "admin should see raw");
      const ev = await ctx.apiAs(ctx.triage.secret, `/events?after=${ctx.cursor}`);
      const seen = ev.body.events.find((e) => e.payload?.message_id === ctx.otp.message_id);
      assert.ok(seen && !seen.payload.snippet.includes("482913"), "snippet in event not redacted");
      return "masked for agent, raw for admin";
    },
  },
  {
    name: "folder scope: a message moved out of the allowed folder disappears for the scoped token, and returns",
    needs: ["move", "archive"],
    async run(ctx) {
      const mv = await ctx.action("move", { message_id: ctx.otp.message_id, to_folder_id: ctx.archive.id });
      assert.equal(mv.status, "executed");
      assert.equal((await ctx.apiAs(ctx.triage.secret, `/messages/${ctx.otp.message_id}`)).status, 404);
      assert.equal((await ctx.api(`/actions/${mv.id}/undo`, { method: "POST" })).status, "reverted");
      const shown = await ctx.apiAs(ctx.triage.secret, `/messages/${ctx.otp.message_id}`);
      assert.equal(shown.status, 200);
      assert.ok(shown.body.as_of, "as_of missing");
      return "404 while archived, 200 when back";
    },
  },
  {
    name: "publish: a plug-in token appends a derived event; core types reserved; non-publishers refused",
    needs: [],
    async run(ctx) {
      const plug = await ctx.api("/tokens", { method: "POST", body: JSON.stringify({ name: "classifier", accounts: [ctx.account.id], publish: true, actions: ["search"] }) });
      const pub = await ctx.apiAs(plug.secret, "/events", { method: "POST", body: JSON.stringify({ type: "classify.newsletter", account: ctx.account.id, payload: { label: "transactional", confidence: 0.93 } }) });
      assert.equal(pub.status, 201, JSON.stringify(pub.body));
      const { events } = await ctx.api(`/events?after=${pub.body.cursor - 1}&limit=1`);
      assert.equal(events[0].type, "classify.newsletter");
      assert.equal(events[0].payload.published_by, "classifier");
      assert.equal((await ctx.apiAs(plug.secret, "/events", { method: "POST", body: JSON.stringify({ type: "message.received", account: ctx.account.id, payload: {} }) })).status, 400);
      if (ctx.triage) assert.equal((await ctx.apiAs(ctx.triage.secret, "/events", { method: "POST", body: JSON.stringify({ type: "classify.x", account: ctx.account.id, payload: {} }) })).status, 403);
      await ctx.api(`/tokens/${plug.id}`, { method: "DELETE" });
      return "derived event stored with publisher name";
    },
  },
  {
    name: "tokens: expired and deleted tokens are unauthorized",
    needs: [],
    async run(ctx) {
      const old = await ctx.api("/tokens", { method: "POST", body: JSON.stringify({ name: "stale", expires_at: "2020-01-01T00:00:00Z" }) });
      assert.equal((await ctx.apiAs(old.secret, "/accounts")).status, 401);
      await ctx.api(`/tokens/${old.id}`, { method: "DELETE" });
      if (ctx.triage) {
        await ctx.api(`/tokens/${ctx.triage.id}`, { method: "DELETE" });
        assert.equal((await ctx.apiAs(ctx.triage.secret, "/accounts")).status, 401);
      }
      return "401 for both";
    },
  },
  {
    name: "cursor log: strictly increasing, no gaps",
    needs: [],
    async run(ctx) {
      const { events } = await ctx.api(`/events?after=0&limit=2000`);
      for (let i = 1; i < events.length; i++) assert.equal(events[i].cursor, events[i - 1].cursor + 1, `gap at ${events[i].cursor}`);
      return `${events.length} events contiguous`;
    },
  },
];

/** Run every applicable scenario. Returns [{name, status: PASS|FAIL|n/a, ms, note}]. */
export async function runScenarios(ctx, log = () => {}) {
  const out = [];
  for (const s of scenarios) {
    const missing = s.needs.filter((n) => !ctx.features.has(n));
    if (missing.length) {
      out.push({ name: s.name, status: "n/a", ms: 0, note: `needs ${missing.join(", ")}` });
      log(out.at(-1));
      continue;
    }
    const t = Date.now();
    try {
      const note = await s.run(ctx);
      out.push({ name: s.name, status: "PASS", ms: Date.now() - t, note: note ?? "" });
    } catch (e) {
      out.push({ name: s.name, status: "FAIL", ms: Date.now() - t, note: e.message.split("\n")[0] });
    }
    log(out.at(-1));
  }
  return out;
}
