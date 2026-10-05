import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openStore } from "./store.js";
import { Engine } from "./sync.js";
import { createApi } from "./api.js";

const DATA = process.env.ENGINE_DATA ?? "./data";
const PORT = Number(process.env.ENGINE_PORT ?? 8080);
const WEBHOOK = process.env.ENGINE_WEBHOOK; // optional: POST every event here
mkdirSync(DATA, { recursive: true });

const token = process.env.ENGINE_TOKEN ?? randomBytes(16).toString("hex");
if (!process.env.ENGINE_TOKEN) console.log(JSON.stringify({ msg: "generated admin token", token }));

const store = openStore(`${DATA}/engine.db`);
const engine = new Engine(store, { webhookUrl: WEBHOOK, bodyCacheDir: `${DATA}/bodies` });
const app = createApi(engine, token);

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(JSON.stringify({ msg: "listening", port: PORT, cursor: store.lastCursor() })),
);
engine.start().catch((e) => console.error(JSON.stringify({ msg: "engine failed", error: String(e) })));

const stop = async () => {
  await engine.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
