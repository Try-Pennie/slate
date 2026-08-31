// SOQL literal escaping and IN-list sizing (#1587).
//
// The escaping was written out inline at four sites in sync.ts before this, and
// the sizing was a bare `CHUNK = 200`. A row count is not the unit the limit is
// expressed in (L81): what refuses an oversized query is Salesforce's 16,384 byte
// cap on a REST GET URI, and the list is percent encoded by the time it meets that
// cap, so 200 short emails and 200 long ones are the same number and very
// different URIs.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-salesforce-soql.ts

import { assert, eq, finish } from "./lib/harness.ts";
import {
  chunkSoqlValues,
  sfInList,
  sfQuote,
  SOQL_URI_BUDGET,
} from "../src/lib/salesforce/soql.ts";

// --- escaping ----------------------------------------------------------------
eq(sfQuote("a@x.com"), "'a@x.com'", "an ordinary value is just quoted");
eq(sfQuote("O'Brien"), "'O\\'Brien'", "a single quote is escaped");
eq(sfQuote("back\\slash"), "'back\\\\slash'", "a backslash is escaped");
// Order matters: escaping the quote first and the backslash second would turn the
// escape character it just added into a literal one and reopen the injection.
eq(
  sfQuote("a\\'b"),
  "'a\\\\\\'b'",
  "a backslash followed by a quote escapes both, in that order",
);
eq(sfInList(["a", "b"]), "'a','b'", "a list is comma separated");
eq(sfInList([]), "", "an empty list renders empty");

// --- sizing ------------------------------------------------------------------
{
  const chunks = chunkSoqlValues(["a@x.com", "b@x.com", "c@x.com"]);
  eq(chunks.length, 1, "a small roster is one chunk");
  eq(chunks[0].length, 3, "and carries every value");
}
{
  // Every value must survive the split. A chunker that drops one produces a false
  // absence, which the caller reports as "Salesforce has no record for them".
  const many = Array.from({ length: 900 }, (_, i) => `agent.number${i}@trypennie.com`);
  const chunks = chunkSoqlValues(many);
  assert(chunks.length > 1, `900 long emails split into more than one chunk (${chunks.length})`);
  eq(chunks.flat().length, many.length, "every value survives the split");
  eq(new Set(chunks.flat()).size, many.length, "and none is duplicated across chunks");
  for (const chunk of chunks) {
    const encoded = encodeURIComponent(sfInList(chunk)).length;
    assert(
      encoded <= SOQL_URI_BUDGET,
      `each chunk stays inside the encoded budget (${encoded} <= ${SOQL_URI_BUDGET})`,
    );
  }
}
{
  // The measurement is on the ENCODED length, not the raw one. Two lists of the
  // same raw size but different encodings must chunk differently, or the budget is
  // being applied to the wrong quantity.
  const plain = Array.from({ length: 400 }, () => "aaaaaaaaaaaaaaaaaaaa");
  const encodes = Array.from({ length: 400 }, () => "a a a a a a a a a a ");
  eq(plain[0].length, encodes[0].length, "the two fixtures are the same RAW length");
  const budget = 2000;
  assert(
    chunkSoqlValues(encodes, budget).length > chunkSoqlValues(plain, budget).length,
    "the value that encodes longer produces more chunks (the budget is on encoded length)",
  );
}
{
  // A single value too large for the budget is still SENT, in its own chunk, so
  // Salesforce refuses it loudly instead of it vanishing (L98).
  const huge = "x".repeat(SOQL_URI_BUDGET * 2);
  const chunks = chunkSoqlValues([huge, "a@x.com"]);
  eq(chunks.flat().length, 2, "an oversized value is not dropped");
  eq(chunks.length, 2, "it gets its own chunk rather than poisoning a shared one");
}
eq(chunkSoqlValues([]).length, 0, "nothing in, nothing out (no empty query is built)");

finish();
