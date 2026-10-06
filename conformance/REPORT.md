# Conformance report

Generated 2026-10-06T07:17:34.983Z by email-engine 0.0.1. One fresh engine per target; the same scenarios for every adapter. ✓ passed, ✗ failed, n/a = the capability does not exist on that target.

| Scenario | dovecot-imap | stalwart-jmap | gmail-mock |
| --- | --- | --- | --- |
| initial sync: exactly the 3 seeded messages, reply threaded (2 threads) | ✓ | ✓ | ✓ |
| arrival: exactly one message.received and one thread.updated, with trust | ✓ 620 ms | ✓ 206 ms | ✓ 210 ms |
| search: full-text finds body text from the sync-time snippet | ✓ | ✓ | ✓ |
| body: fetched on demand from the server and parsed | ✓ | ✓ | ✓ |
| set_flags via the engine: one message.updated with before/after | ✓ | ✓ | ✓ |
| flag change from another client arrives as message.updated | ✓ 220 ms | ✓ 1058 ms | ✓ 1295 ms |
| move via the engine to archive, then undo | ✓ | ✓ | ✓ |
| move from another client: one message.updated, no received, no deleted | ✓ 419 ms out | ✓ 1038 ms out | ✓ 2088 ms out |
| expunge from another client: exactly one message.deleted | ✓ 613 ms | ✓ 833 ms | ✓ 2118 ms |
| idempotency: same client_key returns the same action | ✓ | ✓ | ✓ |
| propose -> approve: delete to trash only after approval, then undo | ✓ | ✓ | ✓ |
| permanent delete: exactly one message.deleted | ✓ | ✓ | ✓ |
| reject: a rejected proposal never touches the server | ✓ | ✓ | ✓ |
| create_draft: lands in Drafts as a draft, threaded with its parent, then undone | ✓ | ✓ | ✓ |
| schedule_timer: fires as timer.fired with the payload | ✓ | ✓ | ✓ |
| flag storm: 25 flag changes from another client arrive as exactly 25 updates | ✓ 652 ms for 25 | ✓ 948 ms for 25 | ✓ 2175 ms for 25 |
| tokens: scoped token sees only allowed types in allowed folders; propose_only writes queue; forbidden verbs 403 | ✓ | ✓ | ✓ |
| redaction: one-time codes and card numbers masked for the scoped token, raw for admin, snippet too | ✓ | ✓ | ✓ |
| folder scope: a message moved out of the allowed folder disappears for the scoped token, and returns | ✓ | ✓ | ✓ |
| publish: a plug-in token appends a derived event; core types reserved; non-publishers refused | ✓ | ✓ | ✓ |
| tokens: expired and deleted tokens are unauthorized | ✓ | ✓ | ✓ |
| cursor log: strictly increasing, no gaps | ✓ | ✓ | ✓ |
| offline catch-up: changes made while the engine was down arrive exactly once after restart | ✓ | ✓ | ✓ |

## Targets

### dovecot-imap

Dovecot 2.4 (docker dovecot/dovecot:latest)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev1 IMAP4rev2 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS THREAD=ORDEREDSUBJECT MULTIAPPEND URL-PARTIAL CATENATE UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED I18NLEVEL=1 CONDSTORE QRESYNC ESEARCH ESORT SEARCHRES WITHIN CONTEXT=SEARCH LIST-STATUS BINARY MOVE REPLACE SNIPPET=FUZZY PREVIEW=FUZZY PREVIEW SPECIAL-USE STATUS=SIZE SAVEDATE COMPRESS=DEFLATE INPROGRESS NOTIFY LITERAL+ UTF8=ACCEPT FILTER=SIEVE

- Push: idle, 620 ms to message.received
- A message moved into the inbox by another client took 29508 ms to be noticed (server notifies late for mail copied into an already-seen state)
- 25 external flag changes delivered in 652 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, drafts=Drafts, inbox=INBOX, spam=Junk, sent=Sent, trash=Trash
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=620, external_flag_ms=220, external_move_out_ms=419, external_move_in_ms=29508, external_expunge_ms=613, storm_ms=652

### stalwart-jmap

Stalwart 0.13.3 over JMAP (docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"labels","push":"jmap","incremental_sync":"delta","undo_send_seconds":0,"server_rules":"sieve","max_connections":10,"send_limit_per_day":null,"threads":"native","permanent_delete":true,"sent_copy":"server"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: jmap, 206 ms to message.received
- 25 external flag changes delivered in 948 ms
- Incremental sync: delta; expunge detection: Email/changes
- Folder model: labels; roles: inbox=Inbox, trash=Deleted Items, spam=Junk Mail, drafts=Drafts, sent=Sent Items, sent=Sent, trash=Trash, archive=Archive
- Threads: native
- Sent copy filed by: server

Measurements: push_ms=206, external_flag_ms=1058, external_move_out_ms=1038, external_move_in_ms=424, external_expunge_ms=833, storm_ms=948

### gmail-mock

Mock Gmail API (test/mock-gmail.mjs): labels, history.list, drafts, send. Documented shapes, not Google's quirks

Capability descriptor:

```json
{"folders":"labels","push":"none","incremental_sync":"history","undo_send_seconds":0,"server_rules":"gmail_filters","max_connections":15,"send_limit_per_day":500,"threads":"native","permanent_delete":true,"sent_copy":"server"}
```

- Push: none, 210 ms to message.received
- 25 external flag changes delivered in 2175 ms
- Incremental sync: history; expunge detection: UID set comparison
- Folder model: labels; roles: archive=Archive, drafts=DRAFT, inbox=INBOX, sent=SENT, spam=SPAM, trash=TRASH
- Threads: native
- Sent copy filed by: server

Measurements: push_ms=210, external_flag_ms=1295, external_move_out_ms=2088, external_move_in_ms=1490, external_expunge_ms=2118, storm_ms=2175

