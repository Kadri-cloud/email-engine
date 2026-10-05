// HTTP surface: the event log by cursor, a live SSE stream, reads from the
// local index, and the action API. Every delivery channel is a reader of the
// log; this file is two of them (polling and SSE). Webhooks live in sync.ts.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ActionRequest, AccountConfig } from "./schema.js";
import type { Engine } from "./sync.js";

export function createApi(engine: Engine, adminToken: string) {
  const app = new Hono();
  const { store } = engine;

  // ponytail: one admin bearer token. Scoped per-agent tokens (tokens table)
  // land with the actions-and-safety phase.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${adminToken}`) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      cursor: store.lastCursor(),
      accounts: store.accounts().map((a) => ({ id: a.id, address: a.address, status: a.status, last_sync: a.last_sync })),
    }),
  );

  // ----- event log -----
  app.get("/events", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 2000);
    const events = store.eventsAfter(after, limit);
    return c.json({ events, next: events.at(-1)?.cursor ?? after });
  });

  app.get("/stream", (c) => {
    let cursor = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const batch = store.eventsAfter(cursor, 200);
        for (const e of batch) {
          await stream.writeSSE({ id: String(e.cursor), event: e.type, data: JSON.stringify(e) });
          cursor = e.cursor;
        }
        if (batch.length === 0) {
          await Promise.race([engine.waitForEvent(), stream.sleep(15000)]);
          if (open) await stream.writeSSE({ event: "ping", data: String(store.lastCursor()) });
        }
      }
    });
  });

  // ----- reads -----
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    return c.json({ results: store.search(q, Number(c.req.query("limit") ?? 50)) });
  });
  app.get("/messages/:id", (c) => {
    const m = store.messageById(c.req.param("id"));
    return m ? c.json({ ...m, folders: store.foldersOfMessage(m.id) }) : c.json({ error: "not found" }, 404);
  });
  app.get("/messages/:id/body", async (c) => {
    const m = store.messageById(c.req.param("id"));
    if (!m) return c.json({ error: "not found" }, 404);
    const body = await engine.fetchBody(m);
    return body ? c.json(body) : c.json({ error: "body unavailable" }, 502);
  });
  app.get("/threads/:id", (c) => c.json({ messages: store.threadMessages(c.req.param("id")) }));

  // ----- accounts -----
  app.get("/accounts", (c) =>
    c.json(store.accounts().map(({ config, ...a }) => ({ ...a, provider: config.provider }))),
  );
  app.get("/accounts/:id/folders", (c) => c.json(store.foldersForAccount(c.req.param("id"))));
  app.post("/accounts", async (c) => {
    const parsed = AccountConfig.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const id = await engine.addAccount(parsed.data);
    return c.json({ id }, 201);
  });

  // ----- actions -----
  app.post("/actions", async (c) => {
    const parsed = ActionRequest.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const mode = c.req.query("mode") === "propose" ? "propose" : "direct";
    try {
      return c.json(await engine.submitAction(parsed.data, "admin", mode));
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });
  app.get("/actions/:id", (c) => {
    const a = engine.getAction(c.req.param("id"));
    return a ? c.json(a) : c.json({ error: "not found" }, 404);
  });
  app.post("/actions/:id/approve", async (c) => c.json(await engine.approve(c.req.param("id"), "admin")));
  app.post("/actions/:id/reject", (c) => c.json(engine.reject(c.req.param("id"), "admin")));
  app.post("/actions/:id/undo", async (c) => c.json(await engine.undo(c.req.param("id"), "admin")));

  return app;
}
