# Conformance report

Generated 2026-10-06T20:35:21.597Z by email-engine 0.1.0-beta.0. One fresh engine per target; the same scenarios for every adapter. ✓ passed, ✗ failed, n/a = the capability does not exist on that target.

| Scenario | dovecot-imap | stalwart-imap | stalwart-imap-oauth | stalwart-jmap | gmail-mock | graph-mock | inbound-smtp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| initial sync: exactly the 3 seeded messages, reply threaded (2 threads) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| arrival: exactly one message.received and one thread.updated, with trust | ✓ 619 ms | ✓ 210 ms | ✓ 206 ms | ✓ 219 ms | ✓ 418 ms | ✓ 425 ms | ✓ 211 ms |
| search: full-text finds body text from the sync-time snippet | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| body: fetched on demand from the server and parsed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| set_flags via the engine: one message.updated with before/after | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| flag change from another client arrives as message.updated | ✓ 206 ms | ✓ 207 ms | ✓ 212 ms | ✓ 1038 ms | ✓ 874 ms | ✓ 1053 ms | n/a |
| move via the engine to archive, then undo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| set_folders: a message in two folders at once, then undo back to one | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| tags: engine-owned tags set, searched, listed, scoped and undone | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| move from another client: one message.updated, no received, no deleted | ✓ 413 ms out | ✓ 212 ms out | ✓ 208 ms out | ✓ 845 ms out | ✓ 1933 ms out | ✓ 1911 ms out | n/a |
| expunge from another client: exactly one message.deleted | ✓ 620 ms | ✓ 214 ms | ✓ 213 ms | ✓ 831 ms | ✓ 1928 ms | ✓ 1895 ms | n/a |
| idempotency: same client_key returns the same action | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| propose -> approve: delete to trash only after approval, then undo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| permanent delete: exactly one message.deleted | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reject: a rejected proposal never touches the server | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| create_draft: lands in Drafts as a draft, threaded with its parent, then undone | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| attachments: listed on the message and downloadable byte for byte | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| send: delivered to another mailbox, marked machine-sent, copy filed in Sent | n/a | ✓ | ✓ | ✓ | n/a | n/a | n/a |
| schedule_timer: fires as timer.fired with the payload | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| flag storm: 25 flag changes from another client arrive as exactly 25 updates | ✓ 698 ms for 25 | ✓ 373 ms for 25 | ✓ 338 ms for 25 | ✓ 983 ms for 25 | ✓ 1910 ms for 25 | ✓ 2162 ms for 25 | n/a |
| tokens: scoped token sees only allowed types in allowed folders; propose_only writes queue; forbidden verbs 403 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| redaction: one-time codes and card numbers masked for the scoped token, raw for admin, snippet too | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| folder scope: a message moved out of the allowed folder disappears for the scoped token, and returns | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| publish: a plug-in token appends a derived event; core types reserved; non-publishers refused | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| tokens: expired and deleted tokens are unauthorized | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cursor log: strictly increasing, no gaps | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| offline catch-up: changes made while the engine was down arrive exactly once after restart | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |

## Targets

### dovecot-imap

Dovecot 2.4 (docker dovecot/dovecot:latest)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev1 IMAP4rev2 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS THREAD=ORDEREDSUBJECT MULTIAPPEND URL-PARTIAL CATENATE UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED I18NLEVEL=1 CONDSTORE QRESYNC ESEARCH ESORT SEARCHRES WITHIN CONTEXT=SEARCH LIST-STATUS BINARY MOVE REPLACE SNIPPET=FUZZY PREVIEW=FUZZY PREVIEW SPECIAL-USE STATUS=SIZE SAVEDATE COMPRESS=DEFLATE INPROGRESS NOTIFY LITERAL+ UTF8=ACCEPT FILTER=SIEVE

- Push: idle, 619 ms to message.received
- A message moved into the inbox by another client took 29584 ms to be noticed (server notifies late for mail copied into an already-seen state)
- 25 external flag changes delivered in 698 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, drafts=Drafts, inbox=INBOX, spam=Junk, sent=Sent, trash=Trash
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=619, external_flag_ms=206, external_move_out_ms=413, external_move_in_ms=29584, external_expunge_ms=620, storm_ms=698

### stalwart-imap

Stalwart 0.13.3 over IMAP (docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: idle, 210 ms to message.received
- 25 external flag changes delivered in 373 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, trash=Deleted Items, drafts=Drafts, inbox=INBOX, spam=Junk Mail, sent=Sent Items
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=210, external_flag_ms=207, external_move_out_ms=212, external_move_in_ms=211, external_expunge_ms=214, storm_ms=373

### stalwart-imap-oauth

Stalwart 0.13.3 over IMAP with OAuth (XOAUTH2/OAUTHBEARER, refresh token from Stalwart's own token endpoint; docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"folders","push":"idle","incremental_sync":"qresync","undo_send_seconds":0,"server_rules":"none","max_connections":5,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: idle, 206 ms to message.received
- 25 external flag changes delivered in 338 ms
- Incremental sync: qresync; expunge detection: VANISHED
- Folder model: folders; roles: archive=Archive, trash=Deleted Items, drafts=Drafts, inbox=INBOX, spam=Junk Mail, sent=Sent Items
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=206, external_flag_ms=212, external_move_out_ms=208, external_move_in_ms=216, external_expunge_ms=213, storm_ms=338

### stalwart-jmap

Stalwart 0.13.3 over JMAP (docker stalwartlabs/stalwart:v0.13.3)

Capability descriptor:

```json
{"folders":"labels","push":"jmap","incremental_sync":"delta","undo_send_seconds":0,"server_rules":"sieve","max_connections":10,"send_limit_per_day":null,"threads":"native","permanent_delete":true,"sent_copy":"server"}
```

IMAP extensions advertised: IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID PREVIEW QUOTA QUOTA=RES-STORAGE

- Push: jmap, 219 ms to message.received
- 25 external flag changes delivered in 983 ms
- Incremental sync: delta; expunge detection: Email/changes
- Folder model: labels; roles: inbox=Inbox, trash=Deleted Items, spam=Junk Mail, drafts=Drafts, sent=Sent Items, sent=Sent, trash=Trash, archive=Archive
- Threads: native
- Sent copy filed by: server

Measurements: push_ms=219, external_flag_ms=1038, external_move_out_ms=845, external_move_in_ms=420, external_expunge_ms=831, storm_ms=983

### gmail-mock

Mock Gmail API (test/mock-gmail.mjs): labels, history.list, drafts, send. Documented shapes, not Google's quirks

Capability descriptor:

```json
{"folders":"labels","push":"none","incremental_sync":"history","undo_send_seconds":0,"server_rules":"gmail_filters","max_connections":15,"send_limit_per_day":500,"threads":"native","permanent_delete":true,"sent_copy":"server"}
```

- Push: none, 418 ms to message.received
- 25 external flag changes delivered in 1910 ms
- Incremental sync: history; expunge detection: UID set comparison
- Folder model: labels; roles: archive=Archive, drafts=DRAFT, inbox=INBOX, sent=SENT, spam=SPAM, trash=TRASH
- Threads: native
- Sent copy filed by: server

Measurements: push_ms=418, external_flag_ms=874, external_move_out_ms=1933, external_move_in_ms=1298, external_expunge_ms=1928, storm_ms=1910

### graph-mock

Mock Microsoft Graph (test/mock-graph.mjs): well-known folders, per-folder delta, move, MIME create, sendMail. Documented shapes, not Microsoft's quirks

Capability descriptor:

```json
{"folders":"folders","push":"none","incremental_sync":"delta","undo_send_seconds":0,"server_rules":"none","max_connections":4,"send_limit_per_day":null,"threads":"hint","permanent_delete":true,"sent_copy":"server"}
```

- Push: none, 425 ms to message.received
- 25 external flag changes delivered in 2162 ms
- Incremental sync: delta; expunge detection: Email/changes
- Folder model: folders; roles: inbox=Inbox, sent=Sent Items, drafts=Drafts, trash=Deleted Items, spam=Junk Email, archive=Archive
- Threads: hint
- Sent copy filed by: server

Measurements: push_ms=425, external_flag_ms=1053, external_move_out_ms=1911, external_move_in_ms=1470, external_expunge_ms=1895, storm_ms=2162

### inbound-smtp

The engine's own inbound SMTP listener (forwarded mail)

Capability descriptor:

```json
{"folders":"folders","push":"smtp","incremental_sync":"none","undo_send_seconds":0,"server_rules":"none","max_connections":1,"send_limit_per_day":null,"threads":"none","permanent_delete":true,"sent_copy":"client"}
```

- Push: smtp, 211 ms to message.received
- Incremental sync: none; expunge detection: n/a
- Folder model: folders; roles: inbox=Inbox
- No archive folder by default
- Threads: none
- Sent copy filed by: client

Measurements: push_ms=211

