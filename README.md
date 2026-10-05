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

All routes except `/health` need `Authorization: Bearer $ENGINE_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Cursor and account status |
| `GET /events?after=N&limit=500` | The log from a cursor |
| `GET /stream?after=N` | Server-Sent Events: replay from a cursor, then live |
| `GET /search?q=` | Full-text search over the local index |
| `GET /messages/:id` | Message metadata and folder links |
| `GET /messages/:id/body` | Parsed body, fetched from the server on demand |
| `GET /threads/:id` | Messages in a thread, in order |
| `GET /accounts`, `POST /accounts` | List or connect mailboxes |
| `GET /accounts/:id/folders` | Folders with their roles |
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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENGINE_TOKEN` | generated and printed | Admin bearer token |
| `ENGINE_PORT` | `8080` | HTTP port |
| `ENGINE_DATA` | `./data` | Directory for the SQLite file |
| `ENGINE_WEBHOOK` | unset | POST every event to this URL |

## Development

```bash
npm test                      # unit tests (threading)
node test/smoke.mjs           # needs the engine and Dovecot running
```

Layout: `src/schema.ts` (the specification as zod schemas), `src/store.ts` (SQLite), `src/imap.ts` (the only file that speaks IMAP/SMTP), `src/sync.ts` (runners, event log, actions, journal, timers), `src/api.ts` (HTTP and SSE), `src/threading.ts` (JWZ).

## Not yet

JMAP, Gmail API and Microsoft Graph adapters. Scoped per-agent tokens. Redaction on read. Webhook signatures and retry queue. QRESYNC `VANISHED` for expunge detection (currently a UID set comparison per poll). Body cache on disk. Conformance suite and public quirks matrix. See the design specification for the roadmap.

## Licence

Apache-2.0. No contributor licence agreement: you keep your copyright and license your contribution under Apache-2.0 by submitting it.
