# Contributing

Thank you. The shortest useful contribution is a conformance run against a mail server we have not seen. The longest is an adapter. Both are welcome.

## Ground rules

- Apache-2.0, no contributor licence agreement. You keep your copyright and license your contribution under Apache-2.0 by submitting it.
- The core stays small and deterministic. It never runs a language model. Anything needing judgement is a plug-in that publishes derived events.
- Protocol code lives in exactly one file per protocol (`src/imap.ts`, `src/jmap.ts`, ...). Nothing above `src/adapter.ts` may know which protocol is underneath.
- Changes to the event envelope, the seven event types, the actions, the token schema or the capability descriptor go through a short written proposal in an issue first. Adapters, plug-ins and tests do not.

## Running the tests

```bash
npm install && npm run build
npm test                              # unit tests
docker compose up -d                  # Dovecot and Stalwart
node test/stalwart-setup.mjs bob pass
node test/conformance.mjs             # every target, writes conformance/REPORT.md
```

A pull request that touches sync, actions or an adapter should come with the conformance report from the targets it affects. A new server quirk should become a scenario, so it stays fixed.

## Adding a target

Add an entry to `test/targets.json` (or `test/targets.local.json` for one with credentials): an account config and a side channel the suite can use to change the mailbox behind the engine's back. Mark it `"destructive": true` only if the suite may purge it.

## Adding an adapter

Implement `Adapter` from `src/adapter.ts`: connect, list folders, sync through the `SyncSink`, watch, and the actions. Report a capability descriptor honestly, including what the provider cannot do. Add a target for it. The suite tells you what is missing.
