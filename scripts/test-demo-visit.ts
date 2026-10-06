// The demo page's per visit identity (#3424).
//
// Every visit to /demo is prefilled with made up contact details, and each visit
// gets its OWN, because Slate's one call per person check matches on email and
// phone: two visitors sharing one address and number would grade as the same
// person, and the second visitor's booking would silently move the first one's
// call. So the property under test is distinctness across visits, alongside the
// details reading as a demo and reaching nobody.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-demo-visit.ts
import { DEMO_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";
import { DEMO_AREA_CODES, DEMO_SUFFIX_LENGTH, demoVisit, newDemoSuffix } from "../src/lib/embed/demo-visit.ts";
import { isUsPhone } from "../src/lib/phone-format.ts";
import { readBookEntryQuery } from "../src/lib/booking/book-link.ts";
import { toE164 } from "../src/lib/phone.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- one visit ---------------------------------------------------------------------
{
  const v = demoVisit("k3f9q2");
  eq(v.query.xbc, DEMO_BUCKET_CODE, "the visit books the demo bucket");
  eq(v.query.name, "Demo Lead", "the name reads as a demo");
  eq(v.query.email, "demo+k3f9q2@trypennie.com", "the email is demo plus the visit's own code");
  eq(v.salesforceId, v.query.external_id, "the lead id the booker sends is the one on the query");
  assert(/^demo-k3f9q2$/.test(v.salesforceId), `the lead id carries the visit code (${v.salesforceId})`);

  const e164 = toE164(v.query.phone);
  assert(e164 !== null, `the phone is a number the booker accepts (${v.query.phone})`);
  // 555-0100 to 555-0199 is the range reserved for fiction in every area code, so
  // no real person can own the number even if something ever dialled it.
  assert(/^\+1\d{3}55501\d{2}$/.test(e164 ?? ""), `the phone is in the 555-01xx fiction range (${e164})`);

  // Read through the SAME reader /book uses, so the page and the booking agree on
  // what the visit carries, and the attendee is complete (no Salesforce read).
  const entry = readBookEntryQuery(v.query);
  eq(entry.requestedCode, DEMO_BUCKET_CODE, "the shared reader sees the demo code");
  eq(entry.externalId, v.salesforceId, "the shared reader sees the lead id");
  assert(
    entry.link.name !== "" && entry.link.email !== "" && entry.link.phone !== "",
    "the link attendee is complete, so landing it reads nothing about anybody",
  );
}

// --- many visits are many people ----------------------------------------------------
{
  // A seeded generator, so the run is deterministic and every draw is exercised.
  let state = 7;
  const random = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const visits = Array.from({ length: 500 }, () => demoVisit(newDemoSuffix(random)));
  eq(new Set(visits.map((v) => v.query.email)).size, visits.length, "no two visits share an email");
  eq(new Set(visits.map((v) => v.salesforceId)).size, visits.length, "no two visits share a lead id");
  // Phones are drawn from a small reserved range, so the bound is a collision RATE:
  // a shared phone alone grades weak, which asks rather than moves, and the email
  // keeps them apart. Measured over the 500 visits, never more than a handful.
  const phones = new Set(visits.map((v) => toE164(v.query.phone)));
  assert(phones.size >= 480, `phones are spread widely (${phones.size} distinct in 500 visits)`);

  for (const v of visits.slice(0, 50)) {
    const suffix = v.salesforceId.slice("demo-".length);
    eq(suffix.length, DEMO_SUFFIX_LENGTH, `a drawn code is ${DEMO_SUFFIX_LENGTH} characters (${suffix})`);
    assert(/^[a-z0-9]+$/.test(suffix), `a drawn code is plain lower case letters and digits (${suffix})`);
  }
}

// --- every area code is one the booker accepts ---------------------------------------
{
  eq(new Set(DEMO_AREA_CODES).size, DEMO_AREA_CODES.length, "no area code is listed twice");
  assert(DEMO_AREA_CODES.length >= 100, `the number is spread over at least 100 area codes (${DEMO_AREA_CODES.length})`);
  for (const area of DEMO_AREA_CODES) {
    const p = `(${area}) 555-0199`;
    assert(isUsPhone(p) && /^\+1\d{10}$/.test(toE164(p) ?? ""), `${area} makes a number the booker accepts`);
  }
}

// --- refuses a code it cannot use ----------------------------------------------------
{
  let threw = "";
  try {
    demoVisit("Not ok!");
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(threw.includes("demo visit code"), `an unusable code is refused by name, not built into an address (${threw})`);
}

finish();
