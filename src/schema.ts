// The specification's source of truth. Every event, action, token and
// capability descriptor the engine speaks is defined here with zod, and the
// JSON Schema files published with the spec are generated from these.
import { z } from "zod";

// ---------- shared ----------

export const Address = z.object({
  address: z.string(),
  name: z.string().optional(),
});
export type Address = z.infer<typeof Address>;

export const Flags = z.object({
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  draft: z.boolean(),
});
export type Flags = z.infer<typeof Flags>;

export const Trust = z.enum(["verified", "known", "unverified", "suspicious"]);
export type Trust = z.infer<typeof Trust>;

export const FolderRole = z.enum([
  "inbox",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
  "other",
]);
export type FolderRole = z.infer<typeof FolderRole>;

export const AccountStatus = z.enum([
  "connected",
  "syncing",
  "auth_expired",
  "rate_limited",
  "disconnected",
  "disabled",
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

// ---------- capability descriptor ----------
// The USB device descriptor: what this account's provider can do.

export const Capabilities = z.object({
  folders: z.enum(["folders", "labels"]),
  push: z.enum(["idle", "jmap", "pubsub", "graph", "smtp", "none"]),
  incremental_sync: z.enum([
    "qresync",
    "condstore",
    "uidnext",
    "history",
    "delta",
    "none",
  ]),
  undo_send_seconds: z.number().int().nonnegative(),
  server_rules: z.enum(["sieve", "gmail_filters", "none"]),
  max_connections: z.number().int().positive(),
  send_limit_per_day: z.number().int().positive().nullable(),
  threads: z.enum(["native", "hint", "none"]),
  permanent_delete: z.boolean(),
  /** Who files the copy in Sent after a send: the engine (IMAP) or the server (JMAP submission). */
  sent_copy: z.enum(["client", "server"]),
});
export type Capabilities = z.infer<typeof Capabilities>;

// ---------- events ----------

export const MessageSummary = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  folder_ids: z.array(z.string()),
  from: Address.nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  flags: Flags,
  trust: Trust,
  has_attachments: z.boolean(),
  size: z.number().int().nonnegative(),
});
export type MessageSummary = z.infer<typeof MessageSummary>;

export const EventPayloads = {
  "message.received": MessageSummary,
  "message.updated": z.object({
    message_id: z.string(),
    thread_id: z.string(),
    folder_ids: z.array(z.string()),
    changes: z.object({
      flags: z.object({ before: Flags, after: Flags }).optional(),
      folder_ids: z
        .object({ before: z.array(z.string()), after: z.array(z.string()) })
        .optional(),
      tags: z.object({ before: z.array(z.string()), after: z.array(z.string()) }).optional(),
    }),
  }),
  "message.deleted": z.object({
    message_id: z.string(),
    thread_id: z.string(),
    folder_ids: z.array(z.string()),
  }),
  "thread.updated": z.object({
    thread_id: z.string(),
    message_count: z.number().int().positive(),
    participants: z.array(Address),
    last_activity: z.string(),
    cause_cursor: z.number().int(),
  }),
  "action.updated": z.object({
    action_id: z.string(),
    client_key: z.string(),
    type: z.string(),
    previous_status: z.string().nullable(),
    status: z.string(),
    requested_by: z.string(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    undo_deadline: z.string().optional(),
  }),
  "account.status": z.object({
    account_id: z.string(),
    status: AccountStatus,
    capabilities: Capabilities.nullable(),
    last_sync: z.string().nullable(),
    error: z.string().optional(),
  }),
  "timer.fired": z.object({
    timer_id: z.string(),
    event_type: z.string(),
    payload: z.unknown(),
    created_by: z.string(),
  }),
} as const;

export const EventType = z.enum(
  Object.keys(EventPayloads) as [keyof typeof EventPayloads, ...(keyof typeof EventPayloads)[]],
);
export type EventType = z.infer<typeof EventType>;

export const Event = z.object({
  cursor: z.number().int(),
  type: z.string(), // one of EventType, or a namespaced derived type from a plug-in
  account: z.string(),
  occurred_at: z.string(),
  observed_at: z.string(),
  payload: z.unknown(),
});
export type Event = z.infer<typeof Event>;

// ---------- actions ----------

export const ActionStatus = z.enum([
  "proposed",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
  "reverted",
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

const Draft = z.object({
  account: z.string(),
  to: z.array(Address),
  cc: z.array(Address).default([]),
  subject: z.string(),
  text: z.string(),
  in_reply_to: z.string().optional(), // engine message id
});

/** Engine-owned tag names: lowercase, dotted or dashed, at most 64 characters. */
export const TagName = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/, "lowercase letters, digits, . _ : -");

export const ActionParams = {
  move: z.object({ message_id: z.string(), to_folder_id: z.string() }),
  /** The complete set of folders a message should be in. The primitive; move is sugar for a one-to-one change. */
  set_folders: z.object({ message_id: z.string(), folder_ids: z.array(z.string()).min(1) }),
  /** Engine-owned tags: live in the engine, never on the server, visible to every consumer that can see the message. */
  tag: z.object({ message_id: z.string(), add: z.array(TagName).default([]), remove: z.array(TagName).default([]) }),
  set_flags: z.object({ message_id: z.string(), set: Flags.partial() }),
  delete: z.object({ message_id: z.string(), permanent: z.boolean().default(false) }),
  create_draft: Draft,
  send: z.union([z.object({ draft_id: z.string() }), Draft]),
  schedule_timer: z.object({
    account: z.string(),
    fire_at: z.string(),
    event_type: z.string(),
    payload: z.unknown(),
  }),
} as const;

export const MutatingActionType = z.enum(
  Object.keys(ActionParams) as [keyof typeof ActionParams, ...(keyof typeof ActionParams)[]],
);
export type MutatingActionType = z.infer<typeof MutatingActionType>;

export const ReadActionType = z.enum(["search", "get_message", "get_thread"]);
export const ControlActionType = z.enum(["propose", "approve", "reject", "undo"]);

// High-risk verbs always queue below autopilot. Fixed, not configurable.
export const HIGH_RISK: ReadonlySet<string> = new Set(["send", "delete"]);

export const ActionRequest = z.object({
  client_key: z.string().min(1).max(200),
  type: MutatingActionType,
  params: z.unknown(),
});
export type ActionRequest = z.infer<typeof ActionRequest>;

// ---------- tokens ----------

export const Token = z.object({
  id: z.string(),
  name: z.string(),
  accounts: z.array(z.string()).default([]), // empty = all
  folders: z.array(FolderRole).default([]), // empty = all
  events: z.array(z.string()).default([]), // empty = all
  actions: z.array(z.string()).default([]), // empty = all
  redact: z.array(z.string()).default([]),
  mode: z.enum(["propose_only", "direct"]).default("propose_only"),
  publish: z.boolean().default(false), // plug-ins may append derived events
  expires_at: z.string().nullable().default(null),
});
export type Token = z.infer<typeof Token>;
export const TokenCreate = Token.omit({ id: true });

/** A derived event published by a plug-in. Namespaced type, never one of the core seven. */
export const PublishRequest = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/, "namespaced like classify.newsletter"),
  account: z.string(),
  occurred_at: z.string().optional(),
  payload: z.unknown(),
});

// ---------- account config ----------

export const ImapAccountConfig = z.object({
  provider: z.literal("imap"),
  address: z.string().email(),
  imap: z.object({
    host: z.string(),
    port: z.number().int().default(993),
    secure: z.boolean().default(true),
    user: z.string(),
    pass: z.string(),
    insecure_tls: z.boolean().default(false), // dev only: accept self-signed certificates
  }),
  smtp: z
    .object({
      host: z.string(),
      port: z.number().int().default(587),
      secure: z.boolean().default(false),
      user: z.string(),
      pass: z.string(),
    })
    .optional(),
});
export type ImapAccountConfig = z.infer<typeof ImapAccountConfig>;

export const JmapAccountConfig = z.object({
  provider: z.literal("jmap"),
  address: z.string().email(),
  jmap: z.object({
    /** Session URL, e.g. https://api.fastmail.com/.well-known/jmap or http://host:8080/.well-known/jmap */
    url: z.string().url(),
    user: z.string().optional(),
    pass: z.string().optional(),
    token: z.string().optional(), // bearer token instead of user/pass
  }),
});
export type JmapAccountConfig = z.infer<typeof JmapAccountConfig>;

export const InboundAccountConfig = z.object({
  provider: z.literal("inbound"),
  address: z.string().email(), // the address forwarders send to
  inbound: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int(),
    user: z.string().optional(), // when both are set, SMTP AUTH is required
    pass: z.string().optional(),
    accept_any_recipient: z.boolean().default(false),
  }),
});
export type InboundAccountConfig = z.infer<typeof InboundAccountConfig>;

export const GmailAccountConfig = z.object({
  provider: z.literal("gmail"),
  address: z.string().email(),
  gmail: z.object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    refresh_token: z.string(), // obtained once with `node test/oauth.mjs google`
    poll_seconds: z.number().int().min(2).default(30), // history.list polling until Pub/Sub push is configured
    base_url: z.string().url().optional(), // tests point this at a mock
    token_url: z.string().url().optional(),
  }),
});
export type GmailAccountConfig = z.infer<typeof GmailAccountConfig>;

export const GraphAccountConfig = z.object({
  provider: z.literal("graph"),
  address: z.string().email(),
  graph: z.object({
    tenant: z.string().default("common"), // "common", "consumers", or a tenant id
    client_id: z.string(),
    client_secret: z.string().optional(), // absent for a public client
    refresh_token: z.string(), // obtained once with `node test/oauth.mjs microsoft`
    poll_seconds: z.number().int().min(2).default(30), // delta polling until change notifications are configured
    base_url: z.string().url().optional(), // tests point this at a mock
    token_url: z.string().url().optional(),
  }),
});
export type GraphAccountConfig = z.infer<typeof GraphAccountConfig>;

export const AccountConfig = z.discriminatedUnion("provider", [ImapAccountConfig, JmapAccountConfig, InboundAccountConfig, GmailAccountConfig, GraphAccountConfig]);
export type AccountConfig = z.infer<typeof AccountConfig>;
