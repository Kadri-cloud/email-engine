# email-engine

A self-hosted engine that turns any mailbox into one ordered event stream, with safe, reversible actions. Plug in IMAP today, JMAP and the Gmail and Microsoft APIs next, and every app or AI agent on the other side sees the same seven events and the same twelve actions. Think of it as USB for email.

**Status: version 0.0.1, the IMAP wedge.** One real mailbox in, a replayable event log out, actions with a journal, undo and an approval queue. Tested end to end against Dovecot 2.4.

## What it does

- **Syncs** any IMAP account with IDLE push, QRESYNC/CONDSTORE incremental sync, reconnect with backoff, and folder-role detection.
- **Mints stable message IDs** that survive folder moves, and rebuilds threads with the JWZ algorithm.
- **Appends every change to a cursor-ordered log.** Consumers read it by polling, by Server-Sent Events, or by webhook, and replay from any cursor after being offline.
- **Executes actions idempotently** (client keys), journals each one, and can undo moves, flag changes, deletes, drafts and timers.
- **Proposes before it acts** when asked: a proposed action waits in a queue until approved or rejected.
- **Computes a trust level** per message from DMARC/DKIM results and prior correspondence. No model is ever involved.
- **Scopes every consumer** with a token that names its accounts, folder roles, event types and actions. A `propose_only` token's writes become proposals. A token can redact one-time codes, card numbers and IBANs from everything it reads.
- **Lets plug-ins publish** derived events (`classify.newsletter`, `extract.invoice`) onto the same log, under their own namespace.
- **Owns the clock**: schedule a timer, receive a `timer.fired` event. Snooze, follow-ups and scheduled send are built on it.
- **Indexes locally** in SQLite with full-text search. Bodies are fetched on demand.

## Quick start

Requirements: Node 22+, and Docker if you want the local test mail server.

```bash
npm install
npm run build

# a real Dovecot to test against: any username, password "pass"
docker compose up -d
node test/seed.mjs alice 6

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
node test/smoke.mjs           # end-to-end check: push, actions, undo, proposals, timers, SSE
```

## HTTP API

All routes except `/health` need `Authorization: Bearer <token>`: either the admin token from `ENGINE_TOKEN`, or a scoped token created with `POST /tokens`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Cursor and account status |
| `GET /events?after=N&limit=500` | The log from a cursor, filtered to the token's scope |
| `GET /stream?after=N` | Server-Sent Events: replay from a cursor, then live |
| `POST /events` | Publish a derived event (tokens with `publish: true`) |
| `GET /search?q=` | Full-text search over the local index |
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

`move`, `set_flags`, `delete`, `create_draft`, `send`, `schedule_timer`, plus the controls `propose`, `approve`, `reject`, `undo`. Every mutating call carries a `client_key`; repeating a key returns the original action and does nothing.

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

Tools: `search_mail`, `get_message`, `get_thread`, `list_accounts_and_folders`, `list_events`, `move_message`, `set_flags`, `delete_message`, `create_draft`, `send_mail`, `schedule_timer`, `get_action`, `approve_action`, `reject_action`, `undo_action`. With a `propose_only` token every write comes back as a proposal for a human to approve. `node test/mcp-smoke.mjs` drives the server as a client and checks all of this.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENGINE_TOKEN` | generated and printed | Admin bearer token |
| `ENGINE_PORT` | `8080` | HTTP port |
| `ENGINE_DATA` | `./data` | Directory for the SQLite file |
| `ENGINE_WEBHOOK` | unset | POST every event to this URL |
| `ENGINE_DEBUG` | unset | Log idle wake-ups and poll decisions |

## Development

```bash
npm test                      # unit tests (threading)
node test/smoke.mjs           # needs the engine and Dovecot running
```

Layout: `src/schema.ts` (the specification as zod schemas), `src/store.ts` (SQLite), `src/imap.ts` (the only file that speaks IMAP/SMTP), `src/sync.ts` (runners, event log, actions, journal, timers), `src/scope.ts` (tokens and redaction), `src/api.ts` (HTTP and SSE), `src/threading.ts` (JWZ).

Two lessons the smoke test taught, kept here so nobody relearns them: a push that arrives while a sync is running must be queued, not dropped (the poll loop checks its dirty set before waiting); and a long-lived IMAP connection's cached UIDNEXT only refreshes on SELECT, so new mail is always fetched with an open-ended `lastUid:*` range and the next UID is derived from what the server returns.

## Not yet

JMAP, Gmail API and Microsoft Graph adapters. MCP delivery. Webhook signatures and retry queue. QRESYNC `VANISHED` for expunge detection (currently a UID set comparison per poll). Body cache on disk. Conformance suite and public quirks matrix. See the design specification for the roadmap.

## Licence

Apache-2.0. No contributor licence agreement: you keep your copyright and license your contribution under Apache-2.0 by submitting it.
