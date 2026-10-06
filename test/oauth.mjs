// Get a refresh token for a Gmail or Microsoft account on your own machine (loopback redirect) and print
// the account config(s) to post to /accounts.
// Usage:
//   node test/oauth.mjs google         CLIENT_ID [CLIENT_SECRET]   -> Gmail API config and IMAP config (one scope covers both)
//   node test/oauth.mjs microsoft      CLIENT_ID [TENANT]          -> Microsoft Graph config
//   node test/oauth.mjs microsoft-imap CLIENT_ID [TENANT]          -> IMAP config for Exchange Online (XOAUTH2)
// Google: create an OAuth client of type "Desktop app" in Google Cloud, enable the Gmail API, add yourself
//         as a test user while the consent screen is in Testing mode. Scope: https://mail.google.com/
// Microsoft: register an app in Entra, platform "Mobile and desktop applications", redirect
//         http://localhost, allow public client flows. API permissions: Graph Mail.ReadWrite, Mail.Send,
//         offline_access; for IMAP, "Office 365 Exchange Online" IMAP.AccessAsUser.All and SMTP.Send.
//         Sending over SMTP also needs SMTP AUTH enabled on the mailbox.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const [provider, clientId, third] = process.argv.slice(2);
const providers = ["google", "microsoft", "microsoft-imap"];
if (!providers.includes(provider) || !clientId) {
  console.error(`usage: node test/oauth.mjs ${providers.join("|")} CLIENT_ID [CLIENT_SECRET|TENANT]`);
  process.exit(1);
}
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(8).toString("hex");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirect = `http://localhost:${server.address().port}/callback`;

const MS_IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access";
const MS_GRAPH_SCOPE = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";
let authUrl, tokenUrl, tokenBody, scope;
if (provider === "google") {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "https://mail.google.com/", access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" });
  authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  tokenUrl = "https://oauth2.googleapis.com/token";
  tokenBody = (code) => ({ client_id: clientId, ...(third ? { client_secret: third } : {}), code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect });
} else {
  const tenant = third ?? "common";
  scope = provider === "microsoft-imap" ? MS_IMAP_SCOPE : MS_GRAPH_SCOPE;
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

const show = (label, cfg) => console.log(`\n${label}:\n${JSON.stringify(cfg, null, 2)}`);
const oauth = { token_url: tokenUrl, client_id: clientId, ...(provider === "google" && third ? { client_secret: third } : {}), refresh_token: j.refresh_token, ...(scope ? { scope } : {}) };
if (provider === "google") {
  show("Gmail API account config", { provider: "gmail", address: "you@gmail.com", gmail: { client_id: clientId, ...(third ? { client_secret: third } : {}), refresh_token: j.refresh_token } });
  show("IMAP account config (same token)", { provider: "imap", address: "you@gmail.com", imap: { host: "imap.gmail.com", port: 993, secure: true, user: "you@gmail.com", oauth }, smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "you@gmail.com" } });
} else if (provider === "microsoft") {
  show("Microsoft Graph account config", { provider: "graph", address: "you@outlook.com", graph: { tenant: third ?? "common", client_id: clientId, refresh_token: j.refresh_token } });
} else {
  show("IMAP account config", { provider: "imap", address: "you@outlook.com", imap: { host: "outlook.office365.com", port: 993, secure: true, user: "you@outlook.com", oauth }, smtp: { host: "smtp.office365.com", port: 587, secure: false, user: "you@outlook.com" } });
}
