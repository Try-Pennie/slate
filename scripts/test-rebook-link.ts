// "Book a new time" carries the lead's identity back into /book (#2982).
//
// The manage page's rebook link used to be a bare `/book?xbc=<bucket>`, so a lead
// who cancelled and booked again arrived as a stranger: no Lead id (no Salesforce
// link, no Regal journey, no dedupe against their record), no source, and every
// detail retyped. The link is now built by ONE helper from what Slate already
// holds for the booking, and this suite proves it by parsing the link back with
// the SAME reader `/book` uses (`readBookEntryQuery`), so a parameter name the
// page does not read cannot pass here (L58: the builder is never asked to agree
// with itself).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-rebook-link.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { readBookEntryQuery, rebookHref } from "../src/lib/booking/book-link.ts";
import { readBookingSource } from "../src/lib/booking/booking-source.ts";

/** What Next hands `/book` as `searchParams`, from an href. */
function searchParamsOf(href: string): Record<string, string | string[] | undefined> {
  const url = new URL(href, "https://slate.example");
  eq(url.pathname, "/book", `the link opens /book: ${href}`);
  const sp: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of url.searchParams) {
    const prior = sp[k];
    sp[k] = prior === undefined ? v : Array.isArray(prior) ? [...prior, v] : [prior, v];
  }
  return sp;
}

// --- a booking with everything: every field comes back where /book reads it ---
{
  const href = rebookHref({
    bucketCode: "100",
    salesforceId: "00QUi00000ABCdeMAH",
    attendeeName: "Dana O'Neil & Co",
    attendeeEmail: "dana+test@example.com",
    attendeePhone: "+1 (215) 555-0100",
    source: "my-offers-result",
  });
  const read = readBookEntryQuery(searchParamsOf(href));
  eq(read.requestedCode, "100", "the bucket rides as xbc");
  eq(read.externalId, "00QUi00000ABCdeMAH", "the Lead id rides as external_id, which /book routes and recognises on");
  eq(read.link.name, "Dana O'Neil & Co", "the name survives encoding");
  eq(read.link.email, "dana+test@example.com", "a plus in the email survives encoding");
  eq(read.link.phone, "+1 (215) 555-0100", "the phone survives encoding");
  eq(readBookingSource(read.prefill).source, "my-offers-result", "the original page's source is recorded again, not not-given");
}

// --- a booking with no Lead id still carries what it has (the issue's floor) ---
{
  const href = rebookHref({
    bucketCode: "777",
    salesforceId: null,
    attendeeName: "Sam",
    attendeeEmail: "sam@example.com",
    attendeePhone: null,
    source: null,
  });
  const sp = searchParamsOf(href);
  const read = readBookEntryQuery(sp);
  eq(read.externalId, null, "no Lead id: none invented");
  assert(!("external_id" in sp), "no empty external_id on the link");
  assert(!("phone" in sp), "no empty phone on the link");
  eq(read.link.name, "Sam", "the name still rides");
  eq(read.link.email, "sam@example.com", "the email still rides");
  eq(read.requestedCode, "777", "the bucket still rides");
  eq(readBookingSource(read.prefill).source, "not-given", "no stored source: none invented");
}

// --- blanks are left off rather than sent as empty values ----------------------
{
  const href = rebookHref({
    bucketCode: "411",
    salesforceId: "  ",
    attendeeName: "",
    attendeeEmail: "  ",
    attendeePhone: "",
    source: null,
  });
  eq(href, "/book?xbc=411", "a booking holding nothing about the lead links to the bare bucket");
}

// --- only a PAGE source is carried: an outcome or an API caller is not a page ---
for (const source of ["not-given", "unrecognised", "api-regal", "api-trypennie"] as const) {
  const sp = searchParamsOf(
    rebookHref({ bucketCode: "411", salesforceId: null, attendeeName: null, attendeeEmail: null, attendeePhone: null, source }),
  );
  assert(!("source" in sp), `a stored ${source} is not put on the link (it would read back as unrecognised)`);
}

// --- /book really reads through the shared reader, so the names above are its own
{
  const page = readFileSync("src/app/book/page.tsx", "utf8");
  assert(page.includes("readBookEntryQuery("), "/book reads its query through readBookEntryQuery");
}

// --- the phone aliases /book accepts are still honoured by the reader ----------
{
  eq(readBookEntryQuery({ attendeePhoneNumber: "+12155550100" }).link.phone, "+12155550100", "attendeePhoneNumber alias");
  eq(readBookEntryQuery({ smsReminderNumber: "+12155550101" }).link.phone, "+12155550101", "smsReminderNumber alias");
  eq(readBookEntryQuery({ xbc: ["7", "8"] }).requestedCode, "7", "a repeated key reads its first value");
  eq(readBookEntryQuery({}).externalId, null, "an absent external_id is null, never an empty string");
}

finish();
