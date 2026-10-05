import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSubject, threadBatch, type Threadable } from "./threading.js";

const msg = (id: string, o: Partial<Threadable> = {}): Threadable => ({
  id,
  messageId: `<${id}@x>`,
  inReplyTo: null,
  references: [],
  subject: "Hello",
  date: `2026-01-0${id.length % 9 || 1}T00:00:00Z`,
  ...o,
});

test("reply chain groups into one thread keyed by the oldest message", () => {
  const a = msg("a", { date: "2026-01-01T00:00:00Z" });
  const b = msg("b", { inReplyTo: "<a@x>", subject: "Re: Hello", date: "2026-01-02T00:00:00Z" });
  const c = msg("c", { references: ["<a@x>", "<b@x>"], subject: "Re: Hello", date: "2026-01-03T00:00:00Z" });
  const t = threadBatch([c, a, b]);
  assert.equal(t.get("a"), "a");
  assert.equal(t.get("b"), "a");
  assert.equal(t.get("c"), "a");
});

test("missing parent still joins siblings", () => {
  const b = msg("b", { references: ["<lost@x>"], subject: "Re: Topic", date: "2026-01-02T00:00:00Z" });
  const c = msg("c", { references: ["<lost@x>"], subject: "Re: Topic", date: "2026-01-03T00:00:00Z" });
  const t = threadBatch([b, c]);
  assert.equal(t.get("b"), t.get("c"));
});

test("unrelated subjects stay apart", () => {
  const t = threadBatch([msg("a", { subject: "Invoice 12" }), msg("b", { subject: "Lunch?" })]);
  assert.notEqual(t.get("a"), t.get("b"));
});

test("reply with dropped references joins by subject", () => {
  const a = msg("a", { subject: "Quarterly plan", date: "2026-01-01T00:00:00Z" });
  const b = msg("b", { subject: "RE: Quarterly plan", date: "2026-01-02T00:00:00Z" });
  const t = threadBatch([a, b]);
  assert.equal(t.get("b"), "a");
});

test("reference loops do not hang or crash", () => {
  const a = msg("a", { references: ["<b@x>"] });
  const b = msg("b", { references: ["<a@x>"] });
  const t = threadBatch([a, b]);
  assert.equal(t.size, 2);
});

test("duplicate Message-ID copies both survive", () => {
  const a1 = msg("a1", { messageId: "<same@x>", date: "2026-01-01T00:00:00Z" });
  const a2 = msg("a2", { messageId: "<same@x>", date: "2026-01-01T00:00:00Z" });
  const t = threadBatch([a1, a2]);
  assert.ok(t.has("a1") && t.has("a2"));
});

test("subject normalisation strips prefixes and list tags", () => {
  assert.deepEqual(normalizeSubject("Re: Fwd: [dev] Hello"), { base: "hello", isReply: true });
  assert.deepEqual(normalizeSubject("AW: Rechnung"), { base: "rechnung", isReply: true });
  assert.deepEqual(normalizeSubject("Hello"), { base: "hello", isReply: false });
});
