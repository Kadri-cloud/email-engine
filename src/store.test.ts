import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintOf, mintMessageId } from "./store.js";

const base = { from: { address: "Alice@Example.com", name: "Alice" }, to: [{ address: "bob@example.com" }, { address: "Carol@example.com" }], subject: "  Quarterly   plan ", date: "2026-10-06T09:14:02.000Z" };

test("fingerprint ignores case, whitespace, recipient order, names and sub-second time", () => {
  const a = fingerprintOf(base);
  const b = fingerprintOf({ from: { address: "alice@example.com" }, to: [{ address: "carol@example.com", name: "C" }, { address: "BOB@example.com" }], subject: "quarterly plan", date: "2026-10-06T09:14:02.731Z" });
  assert.equal(a, b);
});

test("fingerprint separates messages that differ in any travelling header", () => {
  const a = fingerprintOf(base);
  assert.notEqual(a, fingerprintOf({ ...base, subject: "Quarterly plan v2" }));
  assert.notEqual(a, fingerprintOf({ ...base, date: "2026-10-06T09:14:03Z" }));
  assert.notEqual(a, fingerprintOf({ ...base, from: { address: "mallory@example.com" } }));
});

test("id from Message-ID is stable and ignores the fingerprint; without one the fingerprint decides", () => {
  const fp = fingerprintOf(base);
  assert.equal(mintMessageId("acc", "<x@y>", fp), mintMessageId("acc", "<x@y>", "other"));
  assert.equal(mintMessageId("acc", null, fp), mintMessageId("acc", null, fp));
  assert.notEqual(mintMessageId("acc", null, fp), mintMessageId("acc", null, fingerprintOf({ ...base, subject: "x" })));
  assert.notEqual(mintMessageId("acc", "<x@y>", fp), mintMessageId("acc2", "<x@y>", fp), "ids are per account");
});

test("a reused Message-ID with a different fingerprint mints a distinct id", () => {
  const fp1 = fingerprintOf(base);
  const fp2 = fingerprintOf({ ...base, subject: "forged" });
  const first = mintMessageId("acc", "<x@y>", fp1);
  const second = mintMessageId("acc", `<x@y>\n${fp2}`, fp2);
  assert.notEqual(first, second);
});
