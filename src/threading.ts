// JWZ threading: rebuild conversations from Message-ID, In-Reply-To and
// References headers. Ships as its own package once a second project needs it.
// Reference: https://www.jwz.org/doc/threading.html

export interface Threadable {
  id: string; // engine message id
  messageId: string | null; // Message-ID header, normalised
  inReplyTo: string | null;
  references: string[];
  subject: string;
  date: string; // ISO
}

class Container {
  message: Threadable | null = null;
  parent: Container | null = null;
  children: Container[] = [];
  constructor(public key: string) {}
  hasAncestor(c: Container): boolean {
    for (let p: Container | null = this; p; p = p.parent) if (p === c) return true;
    return false;
  }
}

const PREFIX =
  /^\s*((re|fw|fwd|aw|wg|sv|vs|tr|rif|r|ris|odp|antw|ynt|回复|转发|答复)\s*(\[\d+\])?\s*[:：]\s*|\[[^\]]{1,40}\]\s*)+/i;

/** Strip reply and forward prefixes in a dozen languages plus list tags. */
export function normalizeSubject(subject: string): { base: string; isReply: boolean } {
  const trimmed = subject.replace(/\s+/g, " ").trim();
  const base = trimmed.replace(PREFIX, "").trim().toLowerCase();
  return { base, isReply: base !== trimmed.toLowerCase() };
}

/** Normalise a Message-ID-like token to "<...>" form, or null when unusable. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<[^<>\s]+@[^<>\s]+>/);
  return m ? m[0] : null;
}

/**
 * Full JWZ pass over a batch. Returns engine message id -> thread key, where
 * the thread key is the id of the thread's oldest message. Deterministic.
 */
export function threadBatch(messages: Threadable[]): Map<string, string> {
  const byKey = new Map<string, Container>();
  const get = (key: string) => {
    let c = byKey.get(key);
    if (!c) byKey.set(key, (c = new Container(key)));
    return c;
  };

  // Step 1: build containers and link references.
  for (const m of messages) {
    let key = m.messageId ?? `<${m.id}@local>`;
    let c = get(key);
    if (c.message) {
      // duplicate Message-ID: give this copy its own container
      key = `<${m.id}@dup>`;
      c = get(key);
    }
    c.message = m;

    const refs = m.references.length ? m.references : m.inReplyTo ? [m.inReplyTo] : [];
    let prev: Container | null = null;
    for (const r of refs) {
      const rc = get(r);
      if (prev && !rc.parent && !prev.hasAncestor(rc) && rc !== prev) {
        rc.parent = prev;
        prev.children.push(rc);
      }
      prev = rc;
    }
    // References is authoritative for this message's parent.
    if (prev && prev !== c && !prev.hasAncestor(c)) {
      if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
      c.parent = prev;
      prev.children.push(c);
    }
  }

  // Step 2: root set.
  let roots = [...byKey.values()].filter((c) => !c.parent);

  // Step 3: prune empty containers.
  const prune = (c: Container, isRoot: boolean): Container[] => {
    c.children = c.children.flatMap((ch) => prune(ch, false));
    for (const ch of c.children) ch.parent = c;
    if (c.message) return [c];
    if (c.children.length === 0) return [];
    if (c.children.length === 1 || !isRoot) {
      for (const ch of c.children) ch.parent = null;
      return c.children;
    }
    return [c]; // empty root with several children: keep as a dummy root
  };
  roots = roots.flatMap((r) => prune(r, true));
  for (const r of roots) r.parent = null;

  // Step 4: group roots by normalised subject.
  const bySubject = new Map<string, Container>();
  const subjectOf = (c: Container): string => {
    const m = c.message ?? firstMessage(c);
    return m ? normalizeSubject(m.subject).base : "";
  };
  const merged: Container[] = [];
  for (const r of roots) {
    const s = subjectOf(r);
    if (!s) {
      merged.push(r);
      continue;
    }
    const other = bySubject.get(s);
    if (!other) {
      bySubject.set(s, r);
      merged.push(r);
      continue;
    }
    // Merge: the one whose subject is not a reply becomes the root.
    const rIsReply = r.message ? normalizeSubject(r.message.subject).isReply : true;
    const oIsReply = other.message ? normalizeSubject(other.message.subject).isReply : true;
    const [root, child] = oIsReply && !rIsReply ? [r, other] : [other, r];
    child.parent = root;
    root.children.push(child);
    if (root !== other) {
      bySubject.set(s, root);
      merged[merged.indexOf(other)] = root;
    }
  }

  // Output: every message maps to the id of the oldest message in its tree.
  const out = new Map<string, string>();
  for (const root of merged) {
    const all: Threadable[] = [];
    walk(root, (m) => all.push(m));
    all.sort((a, b) => a.date.localeCompare(b.date));
    const key = all[0]?.id;
    if (key) for (const m of all) out.set(m.id, key);
  }
  return out;
}

function walk(c: Container, fn: (m: Threadable) => void) {
  if (c.message) fn(c.message);
  for (const ch of c.children) walk(ch, fn);
}
function firstMessage(c: Container): Threadable | null {
  let found: Threadable | null = null;
  walk(c, (m) => (found ??= m));
  return found;
}
