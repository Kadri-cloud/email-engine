# email-engine

A self-hosted engine that turns any mailbox into one ordered event stream, with safe, reversible actions. Plug in IMAP today, JMAP and the Gmail and Microsoft APIs next, and every app or AI agent on the other side sees the same seven events and the same twelve actions. Think of it as USB for email.

**Status: 0.1.0 beta.** IMAP, JMAP and inbound SMTP adapters (Gmail API and Graph experimental, mock-tested only), a replayable event log, actions with a journal, undo and an approval queue, scoped tokens, engine-owned tags, attachments, and an MCP server. The same scenarios pass on every target in the [conformance report](conformance/REPORT.md), including sending through Stalwart's submission service and receiving at another mailbox. It has not yet run against a commercial provider or for longer than an hour; see [SECURITY.md](SECURITY.md) before exposing it.

## What it does

- **Syncs** any IMAP account with IDLE push, QRESYNC/CONDSTORE incremental sync (expunges arrive as VANISHED, no per-poll UID scans), reconnect with backoff, and folder-role detection.
- **Syncs** any JMAP account (Fastmail, Stalwart) with state-based delta sync, EventSource push, native threads and server-side filing of sent mail. Both adapters implement one interface; nothing above them knows which protocol is underneath.
- **Receives forwarded mail** on its own SMTP port for accounts where IMAP is switched off but forwarding is allowed. Read-only by nature, and it never trusts authentication headers handed to it over plain SMTP.
- **Speaks the Gmail API and Microsoft Graph** natively: labels as folders with a virtual Archive, `history.list` sync with Gmail; per-folder delta queries with immutable ids on Graph. Both poll until push (Pub/Sub, change notifications) is configured. Both are proven against mock servers in the conformance suite; live use needs your own OAuth client.
- **Mints stable message IDs** that survive folder moves: from the Message-ID header, or from a fingerprint of sender, recipients, subject and date when the header is missing. A reused or forged Message-ID is told apart by the same fingerprint. Threads are rebuilt with the JWZ algorithm.
- **Appends every change to a cursor-ordered log.** Consumers read it by polling, by Server-Sent Events, or by webhook, and replay from any cursor after being offline.
- **Executes actions idempotently** (client keys), journals each one, and can undo moves, flag changes, deletes, drafts and timers.
- **Proposes before it acts** when asked: a proposed action waits in a queue until approved or rejected.
- **Computes a trust level** per message from DMARC/DKIM results and prior correspondence. No model is ever involved.
- **Scopes every consumer** with a token that names its accounts, folder roles, event types and actions. A `propose_only` token's writes become proposals. A token can redact one-time codes, card numbers and IBANs from everything it reads.
- **Lets plug-ins publish** derived events (`classify.newsletter`, `extract.invoice`) onto the same log, under their own namespace.
- **Owns the clock**: schedule a timer, receive a `timer.fired` event. Snooze, follow-ups and scheduled send are built on it.
- **Indexes locally** in SQLite with full-text search. Bodies are fetched on demand.
- **Models folders as a set.** A message is in a set of folders, one on most servers, several on label providers or as copies. `set_folders` is the primitive and `move` is sugar for the one-to-one case.
- **Keeps engine-owned tags.** Labels that live in the engine and never on the mail server, such as `needs-reply` or `invoice.paid`, visible to every consumer that can see the message, searchable, journaled and undoable.

## Quick start

Requirements: Node 22+, and Docker if you want the local test mail server.

```bash
npm install
npm run build

# two real mail servers to test against
docker compose up -d                       # Dovecot (IMAP) and Stalwart (IMAP + JMAP)
node test/seed.mjs alice 6                 # Dovecot: any username, password "pass"
node test/stalwart-setup.mjs bob pass      # Stalwart: creates the domain and account
node test/seed.mjs bob 6 127.0.0.1 1993    # seed Stalwart over IMAP

# run the engine
ENGINE_TOKEN=test node dist/index.js
```

Connect the mailbox and read the log:

```bash
curl -X POST http://127.0.0.1:8080/accounts \
  -H "authorization: Bearer test" -H "content-type: application/json" \
  -d '{"provider":"imap","address":"alice@example.com",
       "imap":{"host":"127.0.0.1","port":993,"secure":true,"user":"alice","pass":"pass","insecure_tls":true}}'

node test/events.mjs 0        # pretty-print the event log
node test/smoke.mjs           # end-to-end check: push, actions, undo, proposals, timers, SSE, tokens
```

The same engine takes a JMAP account. Mail injected over IMAP shows up through JMAP, which is the point:

```bash
curl -X POST http://127.0.0.1:8080/accounts \
  -H "authorization: Bearer test" -H "content-type: application/json" \
  -d '{"provider":"jmap","address":"bob@example.com",
       "jmap":{"url":"http://127.0.0.1:8081/.well-known/jmap","user":"bob","pass":"pass"}}'

SMOKE_ACCOUNT=bob@example.com SMOKE_IMAP=127.0.0.1:1993:bob:pass node test/smoke.mjs
```

## HTTP API

All routes except `/health` need `Authorization: Bearer <token>`: either the admin token from `ENGINE_TOKEN`, or a scoped token created with `POST /tokens`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Cursor and account status |
| `GET /events?after=N&limit=500` | The log from a cursor, filtered to the token's scope |
| `GET /stream?after=N` | Server-Sent Events: replay from a cursor, then live |
| `POST /events` | Publish a derived event (tokens with `publish: true`) |
| `GET /search?q=&tag=` | Full-text search over the local index, a tag filter, or both |
| `GET /tags` | Engine-owned tags in use, with counts |
| `GET /messages/:id` | Message metadata and folder links |
| `GET /messages/:id/body` | Parsed body, fetched from the server on demand |
| `GET /threads/:id` | Messages in a thread, in order |
| `GET /accounts`, `POST /accounts` | List or connect mailboxes |
| `GET /accounts/:id/folders` | Folders with their roles |
| `GET /tokens`, `POST /tokens`, `DELETE /tokens/:id` | Scoped tokens (admin only). The secret is returned once |
| `POST /actions` | Execute an action. Add `?mode=propose` to queue it instead |
| `GET /actions/:id` | Action status, journal and result |
| `POST /actions/:id/approve`, `/reject`, `/undo` | Move an action through its lifecycle |

### Events

`message.received`, `message.updated`, `message.deleted`, `thread.updated`, `action.updated`, `account.status`, `timer.fired`. Every event carries `cursor`, `type`, `account`, `occurred_at`, `observed_at` and a typed `payload`. Schemas live in `src/schema.ts`.

### Actions

`set_folders`, `move`, `set_flags`, `tag`, `delete`, `create_draft`, `send`, `schedule_timer`, plus the controls `propose`, `approve`, `reject`, `undo`. Every mutating call carries a `client_key`; repeating a key returns the original action and does nothing.

`set_folders` takes the complete set of folder ids a message should be in. Label providers apply it in one call; on IMAP and Graph a second folder becomes a second copy, which the engine recognises as the same message with two links. `tag` adds or removes engine-owned tags; names are lowercase with dots, dashes or colons, and every change is one `message.updated` carrying `changes.tags`.

```bash
curl -X POST "http://127.0.0.1:8080/actions?mode=propose" \
  -H "authorization: Bearer test" -H "content-type: application/json" \
  -d '{"client_key":"my-key-1","type":"move","params":{"message_id":"msg_...","to_folder_id":"fld_..."}}'
```

### Scoped tokens

A token is the permission one agent holds. Empty lists mean "all".

```bash
curl -X POST http://127.0.0.1:8080/tokens -H "authorization: Bearer test" -H "content-type: application/json" -d '{
  "name": "newsletter-triage",
  "accounts": ["acc_..."], "folders": ["inbox"],
  "events": ["message.received", "message.updated", "action.updated"],
  "actions": ["search", "get_message", "move", "set_flags", "propose"],
  "redact": ["otp", "card"], "mode": "propose_only"
}'
```

With `mode: "propose_only"` every write the agent makes lands in the queue as a proposal, and only a token holding `approve` (or the admin) can execute it. Redaction classes: `otp`, `card`, `iban`, `email`, `phone`, or `re:<pattern>`. Every read response carries `as_of`, the account's last successful sync, so an agent knows how stale its view is.

## Plug into Claude Desktop or any MCP client

The MCP server is a thin consumer of the HTTP API that holds one scoped token. Whatever that token may see and do is exactly what the agent may see and do. Create a token (above), then add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "email-engine": {
      "command": "node",
      "args": ["C:/path/to/email-engine/dist/mcp.js"],
      "env": { "ENGINE_URL": "http://127.0.0.1:8080", "ENGINE_MCP_TOKEN": "tok_..." }
    }
  }
}
```

Tools: `search_mail` (text, tag or both), `get_message`, `get_thread`, `list_accounts_and_folders`, `list_events`, `list_tags`, `set_folders`, `move_message`, `set_flags`, `tag_message`, `delete_message`, `create_draft`, `send_mail`, `schedule_timer`, `get_action`, `approve_action`, `reject_action`, `undo_action`. With a `propose_only` token every write comes back as a proposal for a human to approve. `node test/mcp-smoke.mjs` drives the server as a client and checks all of this.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENGINE_TOKEN` | generated and printed | Admin bearer token |
| `ENGINE_PORT` | `8080` | HTTP port |
| `ENGINE_DATA` | `./data` | Directory for the SQLite file |
| `ENGINE_WEBHOOK` | unset | POST every event to this URL |
| `ENGINE_DEBUG` | unset | Log idle wake-ups and poll decisions |

### Inbound SMTP (forwarded mail)

```bash
curl -X POST http://127.0.0.1:8080/accounts \
  -H "authorization: Bearer test" -H "content-type: application/json" \
  -d '{"provider":"inbound","address":"inbox@engine.test","inbound":{"host":"0.0.0.0","port":2525}}'
```

Point a forwarding rule at that address and port. Set `inbound.user` and `inbound.pass` to require SMTP AUTH. Messages are stored under the data directory, flags and permanent delete work, moves and drafts refuse, and every message is `unverified` because headers on forwarded mail cannot be trusted.

### Gmail API and Microsoft Graph

Both need an OAuth client you create once. The helper runs the sign-in on your machine and prints the refresh token and the account config to post.

```bash
# Google Cloud: enable the Gmail API, create an OAuth client of type "Desktop app",
# add your address as a test user while the consent screen is in Testing mode.
node test/oauth.mjs google CLIENT_ID CLIENT_SECRET

# Entra: register an app, platform "Mobile and desktop applications", redirect http://localhost,
# allow public client flows, API permissions Mail.ReadWrite, Mail.Send, offline_access.
node test/oauth.mjs microsoft CLIENT_ID [TENANT]
```

What to expect: Gmail's labels appear as folders plus a virtual `ARCHIVE` meaning "in no system folder"; `has_attachments` is only known after a body fetch, because the metadata format carries no MIME structure. Graph lists top-level folders; a delete outside Deleted Items moves there first, so the adapter does that and then deletes. Both poll every `poll_seconds` (default 30). A public Gmail app needs Google's restricted-scope verification; a private one in Testing mode does not.

### Attachments

`GET /messages/:id/attachments` lists them with index, filename, type and size. `GET /messages/:id/attachments/:index` returns the bytes with the right content type and filename. The MCP tool `get_attachment` returns text-like files as text and others as a base64 blob, up to 5 MB. Nothing is cached yet: each download fetches and parses the message source.

### Credentials at rest

Account passwords and tokens are encrypted in the database with AES-256-GCM under a key derived from `ENGINE_SECRET`. If that variable is not set, a secret is generated once and kept as `engine.secret` beside the database, so a copied database file is useless on its own. Keep the secret with your backups.

## Conformance suite

The same behavioural scenarios run against every adapter on a fresh engine per target, with mail changed behind the engine's back over a side channel. Each run writes [conformance/REPORT.md](conformance/REPORT.md) and `conformance/report.json`: a scenario-by-target matrix, each server's capability descriptor and advertised extensions, measured latencies, and the quirks a developer targeting that server should know.

```bash
docker compose up -d && node test/stalwart-setup.mjs bob pass
node test/conformance.mjs                 # all targets in test/targets.json
node test/conformance.mjs dovecot-imap    # one target
```

Scenarios include exact event counts for arrival, external flag changes, moves and expunges, a 25-message flag storm, an offline catch-up (stop the engine, change the mailbox, restart, expect each change exactly once), and the token, redaction and proposal rules. Add a server by adding a target: an account config and a side channel.

### Run it against your own provider

Create a throwaway mailbox at your provider, never your real one, then describe it in `test/targets.local.json` (git-ignored):

```json
[
  {
    "name": "my-provider",
    "server": "Example Mail over IMAP",
    "account": { "provider": "imap", "address": "test@example.net",
      "imap": { "host": "imap.example.net", "port": 993, "secure": true, "user": "test@example.net", "pass": "app-password" },
      "smtp": { "host": "smtp.example.net", "port": 587, "secure": false, "user": "test@example.net", "pass": "app-password" } },
    "side": { "kind": "imap", "host": "imap.example.net", "port": 993, "user": "test@example.net", "pass": "app-password" }
  }
]
```

```bash
node test/conformance.mjs my-provider
```

Without `"destructive": true` the suite never purges and only touches the messages it injects itself, and it deletes the local database it built for that account when it finishes. Add a second throwaway mailbox under `send_to` to exercise sending. The report then records your provider's capabilities, extensions, latencies and quirks.

Six built-in targets: Dovecot and Stalwart over IMAP, Stalwart over JMAP, the inbound SMTP listener, and mock Gmail and Graph servers (`test/mock-gmail.mjs`, `test/mock-graph.mjs`) that implement the documented endpoints the adapters use, including history ids, delta tokens with removed entries, immutable ids and Graph's delete-to-Deleted-Items rule. Mocks prove the adapters' sync logic; they do not reproduce every provider quirk, which is what a live target with your credentials is for.

## Development

```bash
npm test                      # unit tests (threading)
node test/smoke.mjs           # the scenarios against a running engine, one account
node test/idle-probe.mjs      # how a server delivers IDLE notifications under a burst
```

Layout: `src/schema.ts` (the specification as zod schemas), `src/store.ts` (SQLite), `src/adapter.ts` (the adapter interface), `src/imap.ts` (the only file that speaks IMAP/SMTP), `src/jmap.ts` (JMAP), `src/gmail.ts` (Gmail API), `src/graph.ts` (Microsoft Graph), `src/inbound.ts` (inbound SMTP), `src/oauth.ts` (refresh-token client), `src/sync.ts` (runners, event log, actions, journal, timers), `src/scope.ts` (tokens and redaction), `src/api.ts` (HTTP and SSE), `src/mcp.ts` (MCP server), `src/threading.ts` (JWZ).

A third lesson from the JMAP work: a server behind Docker or a proxy advertises session URLs on a hostname only it can resolve, so the adapter rebases them onto the origin it actually reached, and it does so with plain string handling because a URL parser percent-encodes the `{accountId}` and `{blobId}` placeholders.

Two more from the conformance suite. An IMAP connection that keeps a mailbox selected between commands can be served a stale view: Dovecot answered a UID FETCH from the session's snapshot and returned 9 of 12 fresh messages. The work connection now re-selects for every call and deselects with a read-only EXAMINE plus CLOSE, inside the lock, because CLOSE on a read-write selection would expunge mail another client flagged as deleted. And a message that vanishes from a folder is not a deletion until the other folders have been checked; another client may have moved it.

Two lessons the smoke test taught, kept here so nobody relearns them: a push that arrives while a sync is running must be queued, not dropped (the poll loop checks its dirty set before waiting); and a long-lived IMAP connection's cached UIDNEXT only refreshes on SELECT, so new mail is always fetched with an open-ended `lastUid:*` range and the next UID is derived from what the server returns.

## Not yet

A body and attachment cache (every fetch re-reads the source today). Webhook signatures and retry queue. STARTTLS on the inbound listener. Gmail Pub/Sub push and Graph change notifications (both poll today). Graph child folders. Live runs against commercial providers, which need a throwaway mailbox you own. A soak run measured in days. Body cache on disk. Conformance suite and public quirks matrix. See the design specification for the roadmap.

## Licence

Apache-2.0. No contributor licence agreement: you keep your copyright and license your contribution under Apache-2.0 by submitting it.
