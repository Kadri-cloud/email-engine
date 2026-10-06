# Conformance report

Generated 2026-10-06T00:16:52.790Z by email-engine 0.0.1. One fresh engine per target; the same scenarios for every adapter. ✓ passed, ✗ failed, n/a = the capability does not exist on that target.

| Scenario | dovecot-imap | stalwart-imap | stalwart-jmap | inbound-smtp |
| --- | --- | --- | --- | --- |
| initial sync: exactly the 3 seeded messages, reply threaded (2 threads) | ✓ | ✓ | ✓ |  |
| arrival: exactly one message.received and one thread.updated, with trust | ✓ 668 ms | ✓ 205 ms | ✓ 212 ms | ✓ 206 ms |
| search: full-text finds body text from the sync-time snippet | ✓ | ✓ | ✓ | ✓ |
| body: fetched on demand from the server and parsed | ✓ | ✓ | ✓ | ✓ |
| set_flags via the engine: one message.updated with before/after | ✓ | ✓ | ✓ | ✓ |
| flag change from another client arrives as message.updated | ✓ 206 ms | ✓ 217 ms | ✓ 1035 ms | n/a |
| move via the engine to archive, then undo | ✓ | ✓ | ✓ | n/a |
| move from another client: one message.updated, no received, no deleted | ✓ 415 ms out | ✓ 208 ms out | ✓ 810 ms out | n/a |
| expunge from another client: exactly one message.deleted | ✓ 638 ms | ✓ 207 ms | ✓ 1035 ms | n/a |
| idempotency: same client_key returns the same action | ✓ | ✓ | ✓ | ✓ |
| propose -> approve: delete to trash only after approval, then undo | ✓ | ✓ | ✓ | n/a |
| permanent delete: exactly one message.deleted | ✓ | ✓ | ✓ | ✓ |
| reject: a rejected proposal never touches the server | ✓ | ✓ | ✓ | ✓ |
| create_draft: lands in Drafts as a draft, threaded with its parent, then undone | ✓ | ✓ | ✓ | n/a |
| schedule_timer: fires as timer.fired with the payload | ✓ | ✓ | ✓ | ✓ |
| flag storm: 25 flag changes from another client arrive as exactly 25 updates | ✓ 650 ms for 25 | ✓ 339 ms for 25 | ✓ 960 ms for 25 | n/a |
| tokens: scoped token sees only allowed types in allowed folders; propose_only writes queue; forbidden verbs 403 | ✓ | ✓ | ✓ | ✓ |
| redaction: one-time codes and card numbers masked for the scoped token, raw for admin, snippet too | ✓ | ✓ | ✓ | ✓ |
| folder scope: a message moved out of the allowed folder disappears for the scoped token, and returns | ✓ | ✓ | ✓ | n/a |
| publish: a plug-in token appends a derived event; core types reserved; non-publishers refused | ✓ | ✓ | ✓ | ✓ |
| tokens: expired and deleted tokens are unauthorized | ✓ | ✓ | ✓ | ✓ |
| cursor log: strictly increasing, no gaps | ✓ | ✓ | ✓ | ✓ |
| offline catch-up: changes made while the engine was down arrive exactly once after restart | ✓ | ✓ | ✓ |  |

## Targets

### dovecot-imap

Dovecot 2.4 (docker dovecot/dovecot:latest)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev1 IMAP4rev2 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS THREAD=ORDEREDSUBJECT MULTIAPPEND URL-PARTIAL CATENATE UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED I18NLEVEL=1 CONDSTORE QRESYNC ESEARCH ESORT SEARCHRES WITHIN CONTEXT=SEARCH LIST-STATUS BINARY MOVE REPLACE SNIPPET=FUZZY PREVIEW=FUZZY PREVIEW SPECIAL-USE STATUS=SIZE SAVEDATE COMPRESS=DEFLATE INPROGRESS NOTIFY LITERAL+ UTF8=ACCEPT FILTER=SIEVE

- Push: idle, 668 ms to message.received
- A message moved into the inbox by another client took 29637 ms to be noticed (server notifies late for mail copied into an already-seen state)
- 25 external flag changes delivered in 650 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, drafts=Drafts, inbox=INBOX, spam=Junk, sent=Sent, trash=Trash
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=668, external_flag_ms=206, external_move_out_ms=415, external_move_in_ms=29637, external_expunge_ms=638, storm_ms=650

### stalwart-imap

Stalwart 0.13.3 over IMAP (docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: idle, 205 ms to message.received
- 25 external flag changes delivered in 339 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, trash=Deleted Items, drafts=Drafts, inbox=INBOX, spam=Junk Mail, sent=Sent Items
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=205, external_flag_ms=217, external_move_out_ms=208, external_move_in_ms=204, external_expunge_ms=207, storm_ms=339

### stalwart-jmap

Stalwart 0.13.3 over JMAP (docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"labels","push":"jmap","incremental_sync":"delta","undo_send_seconds":0,"server_rules":"sieve","max_connections":10,"send_limit_per_day":null,"threads":"native","permanent_delete":true,"sent_copy":"server"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: jmap, 212 ms to message.received
- 25 external flag changes delivered in 960 ms
- Incremental sync: delta; expunge detection: Email/changes
- Folder model: labels; roles: inbox=Inbox, trash=Deleted Items, spam=Junk Mail, drafts=Drafts, sent=Sent Items, sent=Sent, trash=Trash, archive=Archive
- Threads: native
- Sent copy filed by: server

Measurements: push_ms=212, external_flag_ms=1035, external_move_out_ms=810, external_move_in_ms=418, external_expunge_ms=1035, storm_ms=960

### inbound-smtp

The engine's own inbound SMTP listener (forwarded mail)

Capability descriptor:

```json
{"folders":"folders","push":"smtp","incremental_sync":"none","undo_send_seconds":0,"server_rules":"none","max_connections":1,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

- Push: smtp, 206 ms to message.received
- Incremental sync: none; expunge detection: n/a
- Folder model: folders; roles: inbox=Inbox
- No archive folder by default
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=206

