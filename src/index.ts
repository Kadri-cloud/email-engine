import { serve } from "@hono/node-server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The secret that encrypts account credentials at rest. From the environment, or generated once
// and kept beside the database, so a copied database file is useless without it.
let secret = process.env.ENGINE_SECRET;
if (!secret) {
  const file = `${DATA}/engine.secret`;
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    console.log(JSON.stringify({ msg: "generated engine secret", file }));
  }
  secret = readFileSync(file, "utf8").trim();
}

const store = openStore(`${DATA}/engine.db`, secret);
const engine = new Engine(store, { webhookUrl: WEBHOOK, dataDir: DATA });
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
