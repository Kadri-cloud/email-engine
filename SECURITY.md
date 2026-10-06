# Security

This is beta software that holds mailbox credentials and reads every message in the accounts it is given. Read this before exposing it to anything.

## What is protected

- Account credentials (passwords, OAuth refresh tokens) are encrypted at rest with AES-256-GCM under a key derived from `ENGINE_SECRET`, or from `engine.secret` generated beside the database. A copied database is useless without that secret. Back both up together.
- Scoped token secrets are stored as SHA-256 hashes and shown once at creation.
- Message content is never executed or interpreted as instructions. Trust levels come from DMARC/DKIM results reported by the receiving server, never from headers on mail handed to the inbound SMTP listener.
- Redaction classes mask one-time codes, card numbers and bank identifiers for tokens configured with them.

## What is not

- The HTTP API and SSE stream are plain HTTP. Run the engine behind a reverse proxy with TLS, or bind it to localhost and reach it over a tunnel. Never expose port 8080 to the internet as is.
- The inbound SMTP listener has no STARTTLS and no spam filtering. Treat anything that arrives on it as untrusted, which the engine does by marking it `unverified`.
- Webhook deliveries are unsigned. A consumer must treat webhook payloads as hints and read the log over the authenticated API.
- Message metadata and snippets are stored in plain text in the SQLite database. Protect the data directory as you would a mailbox.
- The MCP server holds one token in its environment. Give it a scoped, `propose_only` token, not the admin token.

## Reporting

Report vulnerabilities privately to the maintainer before disclosing them. Expect an acknowledgement within a few days and a fix or a workaround before any public write-up.
