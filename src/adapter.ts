// The adapter interface: the only contract between a mail protocol and the
// engine. An adapter speaks IMAP, JMAP or a vendor API; the engine speaks
// folders, messages, flags and refs. Everything protocol-specific stays
// behind this file.
import type { Address, Capabilities, Flags, FolderRole } from "./schema.js";

export interface RemoteFolder {
  /** Provider key for the folder: an IMAP path, a JMAP mailbox id. Stable for the account's lifetime. */
  path: string;
  name: string;
  role: FolderRole;
}

export interface RemoteMessage {
  /** Provider handle for the message within a folder: an IMAP uid, a JMAP email id. */
  ref: string;
  /** Folders the message is in. For IMAP one path per fetch; for JMAP the complete set. */
  folderPaths: string[];
  flags: Flags;
  headerMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  authResults: string | null;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: string;
  size: number;
  hasAttachments: boolean;
  snippet: string;
  /** Provider's own thread grouping, used as a hint only. */
  threadHint: string | null;
}

/** What an adapter reports during sync. The engine turns these into events. */
export interface SyncSink {
  /** Refs the engine currently believes are in a folder, so an adapter can detect removals. */
  knownRefs(folderPath: string): { ref: string; message_id: string }[];
  /**
   * A message is present with these folders and flags. `complete` means folderPaths is the
   * whole set and links to other folders should be dropped (JMAP); otherwise only additions
   * are inferred (IMAP, one folder at a time).
   */
  seen(m: RemoteMessage, complete: boolean): void;
  /** Flags changed on a message identified by its ref in a folder. */
  flags(folderPath: string, ref: string, flags: Flags): void;
  /** The message is no longer in this folder. */
  gone(folderPath: string, ref: string): void;
  /** The message is gone from every folder (JMAP destroy). */
  destroyed(ref: string): void;
  /** The provider renumbered this folder; forget its refs without emitting anything. */
  resetFolder(folderPath: string): void;
}

/** Fallback when a server assigns no role: recognise the usual names in a few languages. */
export function roleFromName(name: string): FolderRole | null {
  const n = name.trim().toLowerCase();
  if (n === "inbox") return "inbox";
  if (/^(sent( items| mail| messages)?|gesendet|envoyés|enviados|inviati)$/.test(n)) return "sent";
  if (/^(drafts?|entwürfe|brouillons|borradores|bozze)$/.test(n)) return "drafts";
  if (/^(archive|archives|all mail|archiv|archivo|archivio)$/.test(n)) return "archive";
  if (/^(junk( e-?mail)?|spam|bulk mail|unerwünscht|indésirables|correo no deseado)$/.test(n)) return "spam";
  if (/^(trash|deleted( items| messages)?|bin|papierkorb|corbeille|papelera|cestino)$/.test(n)) return "trash";
  return null;
}

export interface Adapter {
  readonly capabilities: Capabilities | null;
  connect(): Promise<Capabilities>;
  listFolders(): Promise<RemoteFolder[]>;
  /**
   * Bring the given folders up to date, reporting changes through the sink.
   * `state` is adapter-owned JSON persisted by the engine; the returned value replaces it.
   */
  sync(folders: RemoteFolder[], state: Record<string, unknown>, sink: SyncSink): Promise<Record<string, unknown>>;
  /** Park a connection watching for changes; call onWake on any, onClose when it drops. */
  watch(folderPath: string, onWake: (kind: string) => void, onClose: (err?: Error) => void): Promise<void>;
  setFlags(folderPath: string, ref: string, set: Partial<Flags>): Promise<void>;
  /** Returns the ref in the destination when known; the next sync discovers it otherwise. */
  move(fromPath: string, ref: string, toPath: string): Promise<string | null>;
  expunge(folderPath: string, ref: string): Promise<void>;
  append(folderPath: string, raw: Buffer, flags: Partial<Flags>): Promise<string | null>;
  source(folderPath: string, ref: string): Promise<Buffer | null>;
  send(raw: Buffer): Promise<void>;
  close(): Promise<void>;
}
