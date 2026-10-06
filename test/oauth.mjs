// Get a refresh token for a Gmail or Microsoft account on your own machine (loopback redirect).
// Usage:
//   node test/oauth.mjs google    CLIENT_ID [CLIENT_SECRET]
//   node test/oauth.mjs microsoft CLIENT_ID [TENANT]
// Google: create an OAuth client of type "Desktop app" in Google Cloud, enable the Gmail API, add yourself
//         as a test user while the consent screen is in Testing mode. Scope: https://mail.google.com/
// Microsoft: register an app in Entra, platform "Mobile and desktop applications", redirect
//         http://localhost, allow public client flows. Scopes: Mail.ReadWrite Mail.Send offline_access
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const [provider, clientId, third] = process.argv.slice(2);
if (!provider || !clientId) {
  console.error("usage: node test/oauth.mjs google|microsoft CLIENT_ID [CLIENT_SECRET|TENANT]");
  process.exit(1);
}
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(8).toString("hex");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirect = `http://localhost:${server.address().port}/callback`;

let authUrl, tokenUrl, tokenBody;
if (provider === "google") {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "https://mail.google.com/", access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" });
  authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  tokenUrl = "https://oauth2.googleapis.com/token";
  tokenBody = (code) => ({ client_id: clientId, ...(third ? { client_secret: third } : {}), code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect });
} else {
  const tenant = third ?? "common";
  const scope = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, state, code_challenge: challenge, code_challenge_method: "S256" });
  authUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${q}`;
  tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  tokenBody = (code) => ({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect, scope });
}

console.log("\nOpen this URL in your browser and sign in:\n\n" + authUrl + "\n");
const code = await new Promise((resolve) => {
  server.on("request", (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== "/callback") return res.writeHead(404).end();
    if (u.searchParams.get("state") !== state) return res.writeHead(400).end("state mismatch");
    res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this tab.");
    resolve(u.searchParams.get("code"));
  });
});
server.close();

const r = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(tokenBody(code)) });
const j = await r.json();
if (!j.refresh_token) {
  console.error("no refresh token in response:", JSON.stringify(j, null, 2));
  process.exit(1);
}
console.log("\nRefresh token (store it in the account config, never commit it):\n");
console.log(j.refresh_token);
console.log(
  provider === "google"
    ? `\nAccount config:\n${JSON.stringify({ provider: "gmail", address: "you@gmail.com", gmail: { client_id: clientId, ...(third ? { client_secret: third } : {}), refresh_token: j.refresh_token } }, null, 2)}`
    : `\nAccount config:\n${JSON.stringify({ provider: "graph", address: "you@outlook.com", graph: { tenant: third ?? "common", client_id: clientId, refresh_token: j.refresh_token } }, null, 2)}`,
);
