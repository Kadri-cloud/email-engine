// Least privilege per consumer. A scope says which accounts, folder roles,
// event types and actions one token may touch, whether its writes become
// proposals, whether it may publish derived events, and what to redact.
import { createHash, randomBytes } from "node:crypto";
import type { Token } from "./schema.js";
import type { Store } from "./store.js";

export type Scope = Token;

export const ADMIN: Scope = {
  id: "admin",
  name: "admin",
  accounts: [],
  folders: [],
  events: [],
  actions: [],
  redact: [],
  mode: "direct",
  publish: true,
  expires_at: null,
};

export const mintSecret = () => "tok_" + randomBytes(24).toString("hex");
export const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");

export function resolveScope(store: Store, authorization: string | undefined, adminToken: string): Scope | null {
  const m = /^Bearer\s+(.+)$/.exec(authorization ?? "");
  if (!m) return null;
  if (m[1] === adminToken) return ADMIN;
  const t = store.tokenByHash(hashSecret(m[1]!));
  if (!t) return null;
  if (t.expires_at && Date.parse(t.expires_at) < Date.now()) return null;
  return t;
}

const any = (list: string[], v: string) => list.length === 0 || list.includes(v);
export const allowsAccount = (s: Scope, account: string) => any(s.accounts, account);
export const allowsEvent = (s: Scope, type: string) => any(s.events, type);
export const allowsAction = (s: Scope, type: string) => any(s.actions, type);
/** A message is visible when any of its folders has an allowed role. No folders (deleted) is visible. */
export const allowsFolders = (s: Scope, roles: string[]) =>
  s.folders.length === 0 || roles.length === 0 || roles.some((r) => s.folders.includes(r as any));

/** Filter and redact one event for a scope; null when the scope may not see it. */
export function visibleEvent(s: Scope, e: { type: string; account: string; payload: any }, rolesOf: (account: string, folderIds: string[]) => string[]) {
  if (!allowsAccount(s, e.account) || !allowsEvent(s, e.type)) return null;
  const p = e.payload;
  if (p && Array.isArray(p.folder_ids) && !allowsFolders(s, rolesOf(e.account, p.folder_ids))) return null;
  if (s.redact.length && p && typeof p.snippet === "string") {
    return { ...e, payload: { ...p, snippet: redact(p.snippet, s.redact) } };
  }
  return e;
}

// ---------- redaction ----------
// Deterministic patterns only. Each class replaces matches with a typed placeholder.

function luhn(digits: string) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CLASSES: Record<string, (t: string) => string> = {
  // 4 to 8 digit codes near the words that announce them
  otp: (t) =>
    t
      .replace(/((?:code|otp|pin|passcode|password|verification|verify|token)\b\D{0,40}?)(\d{4,8})\b/gi, "$1[OTP]")
      .replace(/\b(\d{4,8})(\s+is\s+(?:your|the)\s+(?:\w+\s+){0,3}(?:code|otp|pin|passcode))/gi, "[OTP]$2"),
  // 13 to 19 digit runs with separators that pass Luhn
  card: (t) => t.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[CARD]" : m)),
  iban: (t) => t.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[IBAN]"),
  email: (t) => t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"),
  phone: (t) => t.replace(/(?<!\w)\+?\d[\d ()-]{8,16}\d(?!\w)/g, (m) => (/\d{9,}/.test(m.replace(/\D/g, "")) ? "[PHONE]" : m)),
};

/** Apply redaction classes. Unknown classes of the form `re:<pattern>` are custom regexes. */
export function redact(text: string, classes: string[]): string {
  let out = text;
  for (const c of classes) {
    const fn = CLASSES[c];
    if (fn) out = fn(out);
    else if (c.startsWith("re:")) {
      try {
        out = out.replace(new RegExp(c.slice(3), "gi"), "[REDACTED]");
      } catch {
        /* bad pattern: ignore */
      }
    }
  }
  return out;
}
