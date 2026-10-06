// Create a test domain and account on the Stalwart container (v0.13).
// Usage: node test/stalwart-setup.mjs [user] [password]
// The admin password is read from the container log unless STALWART_ADMIN_PASSWORD is set.
import { execSync } from "node:child_process";

const user = process.argv[2] ?? "bob";
const pass = process.argv[3] ?? "pass";
const base = process.env.STALWART_URL ?? "http://127.0.0.1:8081";

let adminPass = process.env.STALWART_ADMIN_PASSWORD;
if (!adminPass) {
  const log = execSync("docker compose logs stalwart", { encoding: "utf8" });
  adminPass = log.match(/password '([^']+)'/)?.[1];
  if (!adminPass) throw new Error("admin password not found in the stalwart log; pass STALWART_ADMIN_PASSWORD");
}
const auth = "Basic " + Buffer.from(`admin:${adminPass}`).toString("base64");
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 300) };
};

console.log("domain:", JSON.stringify(await api("POST", "/api/principal", { type: "domain", name: "example.com" })));
// The named user plus `carol`, so the conformance suite can test Stalwart over IMAP and JMAP on separate mailboxes.
for (const u of [...new Set([user, "carol"])]) {
  console.log(`account ${u}:`, JSON.stringify(await api("POST", "/api/principal", {
    type: "individual", name: u, description: `${u} test`, secrets: [pass], emails: [`${u}@example.com`], roles: ["user"],
  })));
}

// Probe the JMAP session as the new user.
const userAuth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const s = await fetch(`${base}/.well-known/jmap`, { headers: { authorization: userAuth }, redirect: "manual" });
console.log("jmap session:", s.status, s.headers.get("location") ?? "");
if (s.status === 200) {
  const session = await s.json();
  console.log("  apiUrl:", session.apiUrl, "| accounts:", Object.keys(session.accounts), "| mail account:", session.primaryAccounts?.["urn:ietf:params:jmap:mail"]);
  console.log("  capabilities:", Object.keys(session.capabilities).join(" "));
}
