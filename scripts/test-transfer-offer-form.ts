// The live transfer settings form on /admin/coordinator-booking (#4380). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-transfer-offer-form.ts
//
// Two settings decide when the coordinator page offers "Transfer now": how many advisors
// must be free, and the line the customer is transferred to. Pinned: what the form
// accepts, each refusal naming what to enter, and both refusals said together so one
// save never hides the second; the bounds are the column check's (migration 0213), read
// from one place, so the form can never accept a value the database refuses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTransferOfferForm, TRANSFER_FORM_COPY } from "../src/lib/admin/transfer-offer-form.ts";
import { TRANSFER_OFFER_DEFAULTS, TRANSFER_THRESHOLD_MAX, TRANSFER_THRESHOLD_MIN } from "../src/lib/coordinator/transfer-queue.ts";
import { assert, eq, finish } from "./lib/harness.ts";

eq(parseTransferOfferForm(" 3 ", "786-504-0671"), { ok: true, threshold: 3, line: "786-504-0671" }, "the defaults save, spaces trimmed");
eq(parseTransferOfferForm("100", " 212-555-0100 "), { ok: true, threshold: 100, line: "212-555-0100" }, "the top of the range saves");
eq(parseTransferOfferForm("1", "212-555-0100"), { ok: true, threshold: 1, line: "212-555-0100" }, "the bottom saves");

for (const bad of ["0", "101", "2.5", "", "three", "-3", "03x"]) {
  const out = parseTransferOfferForm(bad, "786-504-0671");
  assert(!out.ok && out.error === TRANSFER_FORM_COPY.thresholdRefused, `threshold ${JSON.stringify(bad)} is refused, naming the range`);
}
for (const bad of ["7865040671", "(786) 504-0671", "786 504 0671", "", "786-504-067"]) {
  const out = parseTransferOfferForm("3", bad);
  assert(!out.ok && out.error === TRANSFER_FORM_COPY.lineRefused, `line ${JSON.stringify(bad)} is refused, showing the shape`);
}
const both = parseTransferOfferForm("0", "nope");
assert(!both.ok && both.error === `${TRANSFER_FORM_COPY.thresholdRefused} ${TRANSFER_FORM_COPY.lineRefused}`, "both wrong says both");
assert(TRANSFER_FORM_COPY.thresholdRefused.includes(`${TRANSFER_THRESHOLD_MIN} to ${TRANSFER_THRESHOLD_MAX}`), "the refusal names the real range");

// The migration's check and default are the same numbers and the same line.
const sql = readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", "0213_transfer_offer.sql"), "utf8");
assert(sql.includes(`check (transfer_offer_threshold between ${TRANSFER_THRESHOLD_MIN} and ${TRANSFER_THRESHOLD_MAX})`), "the column check is the form's range");
assert(sql.includes(`transfer_offer_threshold integer not null default ${TRANSFER_OFFER_DEFAULTS.threshold}`), "the column default is the coded default threshold");
assert(sql.includes(`transfer_line text not null default '${TRANSFER_OFFER_DEFAULTS.line}'`), "the column default is the coded default line");

finish();
