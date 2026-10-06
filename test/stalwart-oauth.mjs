// Mint an OAuth refresh token for a Stalwart account and print an IMAP account config that signs in with it.
// The conformance target `stalwart-imap-oauth` runs this before each run, so XOAUTH2/OAUTHBEARER is proven
// against a real server, not a mock. Stalwart's /api/oauth endpoint lets the user's own credentials stand in
// for the browser consent page, which is what makes this non-interactive.
// Usage: node test/stalwart-oauth.mjs [user] [password] [address]
// Env:   STALWART_URL (http://127.0.0.1:8081), STALWART_IMAP (127.0.0.1:1993), STALWART_SMTP (127.0.0.1:1587)
const [user = "carol", pass = "pass", address = `${user}@example.com`] = process.argv.slice(2);
const base = process.env.STALWART_URL ?? "http://127.0.0.1:8081";
const client_id = "email-engine";
const redirect_uri = "https://localhost/callback"; // Stalwart insists on https; the code comes back in the API response, so it is never followed

const post = async (path, headers, body) => {
  const r = await fetch(base + path, { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
};
const basic = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const approved = await post("/api/oauth", { authorization: basic, "content-type": "application/json" }, JSON.stringify({ type: "code", client_id, redirect_uri, nonce: "n" }));
if (!approved.data?.code) throw new Error(`no authorization code: ${JSON.stringify(approved).slice(0, 200)}`);
const tok = await post("/auth/token", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ grant_type: "authorization_code", client_id, code: approved.data.code, redirect_uri }));
if (!tok.refresh_token) throw new Error(`no refresh token: ${JSON.stringify(tok).slice(0, 200)}`);

const [imapHost, imapPort] = (process.env.STALWART_IMAP ?? "127.0.0.1:1993").split(":");
const [smtpHost, smtpPort] = (process.env.STALWART_SMTP ?? "127.0.0.1:1587").split(":");
console.log(
  JSON.stringify(
    {
      provider: "imap",
      address,
      imap: { host: imapHost, port: Number(imapPort), secure: true, user, insecure_tls: true, oauth: { token_url: `${base}/auth/token`, client_id, refresh_token: tok.refresh_token } },
      smtp: { host: smtpHost, port: Number(smtpPort), secure: false, user },
    },
    null,
    2,
  ),
);
