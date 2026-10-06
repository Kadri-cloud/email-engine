// Publish the specification as JSON Schema: the event envelope and payloads, the actions,
// the token scope, the capability descriptor and the account configs, straight from src/schema.ts.
// Usage: npm run build && node scripts/export-schema.mjs   -> spec/*.json
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as S from "../dist/schema.js";

mkdirSync("spec", { recursive: true });
const write = (name, schema, description) => {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  json.$id = `https://email-engine.dev/spec/${name}.json`;
  json.title = name;
  if (description) json.description = description;
  writeFileSync(`spec/${name}.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`spec/${name}.json`);
};

write("event", S.Event, "The envelope every event carries. `payload` is typed by `type`; see event-payloads.json.");
write("event-payloads", z.object(S.EventPayloads), "Payload schema per core event type. Derived events from plug-ins use namespaced types and their own payloads.");
write("action-request", S.ActionRequest, "A mutating action submitted to POST /actions. `params` is typed by `type`; see action-params.json.");
write("action-params", z.object(S.ActionParams), "Parameters per mutating action type.");
write("token", S.Token, "A scoped token: what one consumer may see and do. Empty lists mean all.");
write("capabilities", S.Capabilities, "The capability descriptor an account exposes after connecting: what its provider can do.");
write("account-config", S.AccountConfig, "Account configuration accepted by POST /accounts, one shape per provider.");
write("publish-request", S.PublishRequest, "A derived event published by a plug-in to POST /events.");
