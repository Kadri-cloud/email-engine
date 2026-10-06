// HTTP surface: the event log by cursor, a live SSE stream, reads from the
// local index, tokens, and the action API. Every route runs under a scope:
// the admin token sees everything, a scoped token sees only what it names.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AccountConfig, ActionRequest, EventType, PublishRequest, TokenCreate } from "./schema.js";
import { ADMIN, allowsAccount, allowsAction, allowsFolders, hashSecret, mintSecret, redact, resolveScope, visibleEvent, type Scope } from "./scope.js";
import { newId } from "./store.js";
import { ScopeError, type Engine } from "./sync.js";

type Env = { Variables: { scope: Scope } };

export function createApi(engine: Engine, adminToken: string) {
  const app = new Hono<Env>();
  const { store } = engine;

  // Folder id -> role, per account, refreshed when a folder is unknown.
  const roleCache = new Map<string, Map<string, string>>();
  const rolesOf = (account: string, folderIds: string[]): string[] => {
    let m = roleCache.get(account);
    if (!m || folderIds.some((f) => !m!.has(f))) {
      m = new Map(store.foldersForAccount(account).map((f: any) => [f.id, f.role]));
      roleCache.set(account, m);
    }
    return folderIds.map((f) => m!.get(f)).filter((r): r is string => !!r);
  };
  const messageVisible = (s: Scope, m: { account: string; id: string }) =>
    allowsAccount(s, m.account) && allowsFolders(s, rolesOf(m.account, store.foldersOfMessage(m.id).map((f) => f.folder_id)));
  const asOf = (account: string) => store.accountById(account)?.last_sync ?? null;
  const forbidden = (c: any, why = "forbidden") => c.json({ error: why }, 403);

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const scope = resolveScope(store, c.req.header("authorization"), adminToken);
    if (!scope) return c.json({ error: "unauthorized" }, 401);
    c.set("scope", scope);
    return next();
  });
  const adminOnly = async (c: any, next: any) => (c.get("scope") === ADMIN ? next() : forbidden(c, "admin only"));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      cursor: store.lastCursor(),
      accounts: store.accounts().map((a) => ({ id: a.id, address: a.address, status: a.status, last_sync: a.last_sync })),
    }),
  );

  // ----- event log -----
  app.get("/events", (c) => {
    const s = c.get("scope");
    const after = Number(c.req.query("after") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 2000);
    const raw = store.eventsAfter(after, limit);
    const events = raw.map((e) => visibleEvent(s, e, rolesOf)).filter(Boolean);
    return c.json({ events, next: raw.at(-1)?.cursor ?? after });
  });

  app.get("/stream", (c) => {
    const s = c.get("scope");
    let cursor = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const batch = store.eventsAfter(cursor, 200);
        for (const e of batch) {
          const v = visibleEvent(s, e, rolesOf);
          if (v) await stream.writeSSE({ id: String(e.cursor), event: e.type, data: JSON.stringify(v) });
          cursor = e.cursor;
        }
        if (batch.length === 0) {
          await Promise.race([engine.waitForEvent(), stream.sleep(15000)]);
          if (open) await stream.writeSSE({ event: "ping", data: String(store.lastCursor()) });
        }
      }
    });
  });

  // Plug-ins append derived events to the same log.
  app.post("/events", async (c) => {
    const s = c.get("scope");
    if (!s.publish) return forbidden(c, "token may not publish");
    const parsed = PublishRequest.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { type, account, occurred_at, payload } = parsed.data;
    if (EventType.options.includes(type as any)) return c.json({ error: "core event types are reserved" }, 400);
    if (!allowsAccount(s, account)) return forbidden(c, "account not in token scope");
    const cursor = engine.emit(type, account, occurred_at ?? new Date().toISOString(), { ...(payload as object), published_by: s.name });
    return c.json({ cursor }, 201);
  });

  // ----- reads -----
  const present = (s: Scope, m: any) => ({ ...m, snippet: redact(m.snippet, s.redact), tags: store.tagsOf(m.id), as_of: asOf(m.account) });

  // Full-text search, a tag filter, or both.
  app.get("/search", (c) => {
    const s = c.get("scope");
    const q = (c.req.query("q") ?? "").trim();
    const tag = (c.req.query("tag") ?? "").trim();
    const limit = Number(c.req.query("limit") ?? 50);
    if (!q && !tag) return c.json({ results: [] });
    const rows = q && tag ? store.searchWithTag(q, tag, limit) : q ? store.search(q, limit) : store.messagesByTag(tag, limit);
    return c.json({ results: rows.filter((m) => messageVisible(s, m)).map((m) => present(s, m)) });
  });
  app.get("/tags", (c) => {
    const s = c.get("scope");
    const counts = s.accounts.length === 1 ? store.tagCounts(s.accounts[0]) : store.tagCounts();
    return c.json({ tags: counts });
  });
  app.get("/messages/:id", (c) => {
    const s = c.get("scope");
    const m = store.messageById(c.req.param("id"));
    if (!m || !messageVisible(s, m)) return c.json({ error: "not found" }, 404);
    return c.json({ ...present(s, m), folders: store.foldersOfMessage(m.id) });
  });
  app.get("/messages/:id/body", async (c) => {
    const s = c.get("scope");
    const m = store.messageById(c.req.param("id"));
    if (!m || !messageVisible(s, m)) return c.json({ error: "not found" }, 404);
    const body = await engine.fetchBody(m);
    if (!body) return c.json({ error: "body unavailable" }, 502);
    return c.json({
      ...body,
      text: redact(body.text, s.redact),
      html: body.html === null ? null : redact(body.html, s.redact),
      redacted: s.redact,
    });
  });
  // Attachments: list, then fetch one by index as bytes.
  app.get("/messages/:id/attachments", async (c) => {
    const s = c.get("scope");
    const m = store.messageById(c.req.param("id"));
    if (!m || !messageVisible(s, m)) return c.json({ error: "not found" }, 404);
    const body = await engine.fetchBody(m);
    return body ? c.json({ attachments: body.attachments }) : c.json({ error: "body unavailable" }, 502);
  });
  app.get("/messages/:id/attachments/:index", async (c) => {
    const s = c.get("scope");
    const m = store.messageById(c.req.param("id"));
    if (!m || !messageVisible(s, m)) return c.json({ error: "not found" }, 404);
    const a = await engine.fetchAttachment(m, Number(c.req.param("index")));
    if (!a) return c.json({ error: "no such attachment" }, 404);
    return new Response(new Uint8Array(a.content), {
      headers: {
        "content-type": a.contentType,
        "content-length": String(a.content.length),
        "content-disposition": `attachment; filename="${a.filename.replace(/["\r\n]/g, "")}"`,
      },
    });
  });
  app.get("/threads/:id", (c) => {
    const s = c.get("scope");
    const messages = store
      .threadMessages(c.req.param("id"))
      .filter((m) => messageVisible(s, m))
      .map((m) => present(s, m));
    return messages.length ? c.json({ messages, as_of: asOf(messages[0]!.account) }) : c.json({ error: "not found" }, 404);
  });

  // ----- accounts -----
  app.get("/accounts", (c) => {
    const s = c.get("scope");
    return c.json(
      store
        .accounts()
        .filter((a) => allowsAccount(s, a.id))
        .map(({ config, ...a }) => ({ ...a, provider: config.provider })),
    );
  });
  app.get("/accounts/:id/folders", (c) => {
    const id = c.req.param("id");
    if (!allowsAccount(c.get("scope"), id)) return c.json({ error: "not found" }, 404);
    return c.json(store.foldersForAccount(id));
  });
  app.post("/accounts", adminOnly, async (c) => {
    const parsed = AccountConfig.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const id = await engine.addAccount(parsed.data);
    return c.json({ id }, 201);
  });

  // ----- tokens (admin) -----
  app.get("/tokens", adminOnly, (c) => c.json(store.tokens()));
  app.post("/tokens", adminOnly, async (c) => {
    const parsed = TokenCreate.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const id = newId("tok");
    const secret = mintSecret();
    store.insertToken(id, hashSecret(secret), parsed.data);
    return c.json({ id, secret, ...parsed.data }, 201); // the secret is shown once
  });
  app.delete("/tokens/:id", adminOnly, (c) =>
    store.deleteToken(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  // ----- actions -----
  const scopedAction = (c: any, id: string, control: string) => {
    const s: Scope = c.get("scope");
    const a = engine.getAction(id);
    if (!a || !allowsAccount(s, a.account)) return { error: c.json({ error: "not found" }, 404) };
    if (!allowsAction(s, control)) return { error: forbidden(c, `token may not ${control}`) };
    return { a };
  };
  const handle = async (c: any, fn: () => Promise<unknown> | unknown) => {
    try {
      return c.json(await fn());
    } catch (e: any) {
      return c.json({ error: e.message }, e instanceof ScopeError ? 403 : 400);
    }
  };

  app.post("/actions", async (c) => {
    const s = c.get("scope");
    const parsed = ActionRequest.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!allowsAction(s, parsed.data.type)) return forbidden(c, `token may not ${parsed.data.type}`);
    const mode = s.mode === "propose_only" || c.req.query("mode") === "propose" ? "propose" : "direct";
    return handle(c, () => engine.submitAction(parsed.data, s.name, mode, s.accounts));
  });
  app.get("/actions/:id", (c) => {
    const r = scopedAction(c, c.req.param("id"), "get_action");
    return r.error ?? c.json(r.a);
  });
  app.post("/actions/:id/approve", (c) => {
    const r = scopedAction(c, c.req.param("id"), "approve");
    return r.error ?? handle(c, () => engine.approve(r.a!.id, c.get("scope").name));
  });
  app.post("/actions/:id/reject", (c) => {
    const r = scopedAction(c, c.req.param("id"), "reject");
    return r.error ?? handle(c, () => engine.reject(r.a!.id, c.get("scope").name));
  });
  app.post("/actions/:id/undo", (c) => {
    const r = scopedAction(c, c.req.param("id"), "undo");
    return r.error ?? handle(c, () => engine.undo(r.a!.id, c.get("scope").name));
  });

  return app;
}
