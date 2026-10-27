// The coordinator page's customer lookup (#4205), through hand written fakes.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-lookup.ts
//
// The coordinator pastes the Lead link (or the 00Q id at its end). The page answers who
// the customer is, their zone (from the Lead, never the coordinator, never Eastern),
// their bucket (as routing derives it), their existing call and what will happen to it,
// and the hours a call may start that day in the customer's zone. Each missing piece is
// its own refusal: not a lead id, no such lead, Salesforce unreadable, no bucket, zone
// unknown. Every value is invented.
import { parseLeadReference } from "../src/lib/coordinator/lead-reference.ts";
import { findCustomer, lookupCustomer, type CustomerDeps, type LookupDeps } from "../src/lib/coordinator/customer.ts";
import { bookableHoursOn } from "../src/lib/coordinator/bookable-hours.ts";
import type { SalesforceLeadWithPlace } from "../src/lib/salesforce/lead-contact.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import type { Booking, Bucket, EventType } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ID15 = "00QUi00000AbCdE";
const ID18 = "00QUi00000AbCdEMAC";

// --- the pasted reference ------------------------------------------------------------
eq(parseLeadReference(ID18), { ok: true, leadId: ID18 }, "an 18 character Lead id is itself");
eq(parseLeadReference(`  ${ID15} `), { ok: true, leadId: ID15 }, "a 15 character one, trimmed");
eq(
  parseLeadReference(`https://pennie.lightning.force.com/lightning/r/Lead/${ID18}/view`),
  { ok: true, leadId: ID18 },
  "a Lightning record link is the id in it",
);
eq(parseLeadReference(`https://pennie.my.salesforce.com/${ID15}`), { ok: true, leadId: ID15 }, "and so is a classic one");
eq(parseLeadReference(`https://pennie.lightning.force.com/lightning/r/Lead/${ID18}/view?ws=x#top`), { ok: true, leadId: ID18 }, "a query or fragment is ignored");
for (const bad of ["", "   ", "003Ui00000AbCdEMAC", "https://pennie.lightning.force.com/lightning/r/Contact/003Ui00000AbCdEMAC/view", "Jane Doe", "00QUi00000AbC", "javascript:alert(1)"]) {
  eq(parseLeadReference(bad), { ok: false, refusal: "not-a-lead-id" }, `not a Lead id: ${JSON.stringify(bad)}`);
}

// --- fakes ---------------------------------------------------------------------------
const bucket = { id: "bkt1", org_id: "org1", code: "412", is_test: false } as unknown as Bucket;
const catchall = { id: "bkt0", org_id: "org1", code: "100", is_test: false } as unknown as Bucket;
const eventType = { id: "et1", duration_min: 30 } as unknown as EventType;
const LEAD: SalesforceLeadWithPlace = {
  id: ID18,
  name: "Invented Customer",
  firstName: "Invented",
  email: "invented.customer@example.com",
  phone: "+15555550100",
  postalCode: "85001",
  state: "AZ",
};
interface Fake {
  lead?: SalesforceLeadWithPlace | null;
  leadThrows?: boolean;
  xbc?: string | null | undefined;
  xbcThrows?: boolean;
  noBucket?: boolean;
}
function deps(f: Fake = {}): CustomerDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    readLead: async (id) => {
      asked.push(`lead:${id}`);
      if (f.leadThrows) throw new Error("SF query failed: 503");
      return f.lead === undefined ? LEAD : f.lead;
    },
    readLeadXbc: async (id) => {
      asked.push(`xbc:${id}`);
      if (f.xbcThrows) throw new Error("SF query failed: 503");
      return "xbc" in f ? f.xbc : "412";
    },
    resolveBucketByCode: async (code) => {
      asked.push(`bucket:${code}`);
      if (f.noBucket) return null;
      return { bucket: code === "100" ? catchall : bucket, eventType };
    },
  };
}

async function run() {
  {
    const d = deps();
    const out = await findCustomer(`https://pennie.lightning.force.com/lightning/r/Lead/${ID15}/view`, d);
    assert(out.ok, "a readable lead is found");
    if (out.ok) {
      eq(out.customer.salesforceLeadId, ID18, "named by the id as Salesforce spells it, the 18 characters bookings store");
      eq([out.customer.name, out.customer.firstName, out.customer.phone, out.customer.email], [LEAD.name, LEAD.firstName, LEAD.phone, LEAD.email], "with the Lead's contact details");
      eq([out.customer.zone, out.customer.zoneFrom], ["America/Phoenix", "zip"], "in the zone its zip gives, Arizona's");
      eq([out.customer.bucketCode, out.customer.bucketSource], ["412", "salesforce"], "in the bucket its score routes to");
      eq(out.customer.durationMin, 30, "with the bucket's call length");
    }
    eq(d.asked[0], `lead:${ID15}`, "the Lead is read by the id pasted");
  }
  {
    const out = await findCustomer(ID18, deps({ xbc: "012" }));
    assert(out.ok && out.customer.bucketCode === "100" && out.customer.bucketSource === "catchall",
      "a score routing cannot use goes to the catch all, exactly as the booker routes it");
  }
  const refusals: [string, string, Fake, string][] = [
    ["a pasted contact", "003Ui00000AbCdEMAC", {}, "not-a-lead-id"],
    ["no such lead", ID18, { lead: null }, "no-such-lead"],
    ["Salesforce down on the Lead", ID18, { leadThrows: true }, "salesforce-unreadable"],
    ["Salesforce down on the score", ID18, { xbcThrows: true }, "salesforce-unreadable"],
    ["no bucket for the code", ID18, { noBucket: true }, "no-bucket"],
    ["no zip and a split state", ID18, { lead: { ...LEAD, postalCode: null, state: "TX" } }, "zone-unknown"],
    ["a malformed zip and no state", ID18, { lead: { ...LEAD, postalCode: "N/A", state: null } }, "zone-unknown"],
  ];
  for (const [label, ref, fake, refusal] of refusals) {
    const out = await findCustomer(ref, deps(fake));
    eq(out.ok ? "found" : out.refusal, refusal, `${label} is refused as ${refusal}`);
  }
  {
    const d = deps();
    await findCustomer("Jane Doe", d);
    eq(d.asked, [], "a reference that is not a Lead id reads nothing from Salesforce");
  }
}

// --- the hours a call may start, in the customer's zone -------------------------------
// Pennie open 09:00 to 18:00 Eastern, Monday to Friday.
const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 18 * 60 })),
  exceptions: [],
};
const MONDAY_MORNING = Date.parse("2026-06-08T12:00:00.000Z"); // 08:00 Eastern, Monday
{
  // Chicago, Tuesday: the org opens at 08:00 Chicago and a 30 minute call must END by
  // 17:00 Chicago (18:00 Eastern), so the last start is 16:30. The customer's own
  // 08:00 to 20:00 never binds.
  const out = bookableHoursOn({ hours: HOURS, zone: "America/Chicago", date: "2026-06-09", durationMin: 30, nowMs: MONDAY_MORNING, horizonDays: 10 });
  eq(out, { ok: true, date: "2026-06-09", windows: [{ firstStart: "2026-06-09T08:00:00.000-05:00", lastStart: "2026-06-09T16:30:00.000-05:00" }] },
    "Chicago: the org's hours in the customer's clock, ending where the call must end");
}
{
  // Honolulu is six hours behind Eastern in June: the org's 09:00 is 03:00 there, so the
  // customer's own window (08:00) is what opens, and the org's close (12:00 Honolulu)
  // less the call is the last start.
  const out = bookableHoursOn({ hours: HOURS, zone: "Pacific/Honolulu", date: "2026-06-09", durationMin: 30, nowMs: MONDAY_MORNING, horizonDays: 10 });
  eq(out, { ok: true, date: "2026-06-09", windows: [{ firstStart: "2026-06-09T08:00:00.000-10:00", lastStart: "2026-06-09T11:30:00.000-10:00" }] },
    "Honolulu: the customer's 8am is the later opening, so it is the one that binds");
}
{
  const today = bookableHoursOn({ hours: HOURS, zone: "America/New_York", date: "2026-06-08", durationMin: 30, nowMs: Date.parse("2026-06-08T18:00:00.000Z"), horizonDays: 10 });
  eq(today, { ok: true, date: "2026-06-08", windows: [{ firstStart: "2026-06-08T14:01:00.000-04:00", lastStart: "2026-06-08T17:30:00.000-04:00" }] },
    "today: only what is still ahead of now");
  const saturday = bookableHoursOn({ hours: HOURS, zone: "America/New_York", date: "2026-06-13", durationMin: 30, nowMs: MONDAY_MORNING, horizonDays: 10 });
  eq(saturday, { ok: true, date: "2026-06-13", windows: [] }, "a day Pennie is closed has no hours, said as an empty day");
  const beyond = bookableHoursOn({ hours: HOURS, zone: "America/New_York", date: "2026-06-10", durationMin: 30, nowMs: MONDAY_MORNING, horizonDays: 2 });
  eq(beyond, { ok: true, date: "2026-06-10", windows: [] }, "a day past the horizon has none either");
  eq(bookableHoursOn({ hours: HOURS, zone: "America/New_York", date: "June 9", durationMin: 30, nowMs: MONDAY_MORNING, horizonDays: 2 }), { ok: false, reason: "date-unreadable" }, "an unreadable day is refused");
}

// --- the lookup the page calls: the customer, their call, and the day's hours ----------
function existing(over: Partial<Booking> = {}): Booking {
  return {
    id: "bk1",
    starts_at: "2026-06-10T18:00:00.000Z",
    timezone: "America/Phoenix",
    agent_name: "Advisor A",
    kind: "routed",
    status: "confirmed",
    salesforce_id: ID18,
    external_id: null,
    attendee_email: LEAD.email,
    attendee_phone: LEAD.phone,
    manage_token: "tok1",
    ...over,
  } as unknown as Booking;
}
function lookupDeps(f: Fake & { calls?: Booking[]; callsThrow?: boolean; hoursThrow?: boolean; horizon?: number | null } = {}): LookupDeps {
  const worlds: boolean[] = [];
  return {
    ...deps(f),
    findActiveBookingsForPerson: async (_identity, world) => {
      worlds.push(world.isTest);
      if (f.callsThrow) throw new Error("statement timeout");
      return f.calls ?? [];
    },
    businessHours: async () => {
      if (f.hoursThrow) throw new Error("business hours are unusable");
      return HOURS;
    },
    horizonDays: async () => (f.horizon === undefined ? 10 : f.horizon),
    now: () => MONDAY_MORNING,
  };
}
async function runLookup() {
  {
    const out = await lookupCustomer({ reference: ID18, date: "2026-06-09" }, lookupDeps());
    assert(out.ok && out.existingCall.kind === "none", "a customer with no call has none to move");
    assert(out.ok && out.hours.ok && out.hours.windows.length === 1 && out.hours.windows[0].firstStart.endsWith("-07:00"), "and the day's hours in Arizona's clock");
  }
  {
    const out = await lookupCustomer({ reference: ID18 }, lookupDeps({ calls: [existing()] }));
    assert(out.ok && out.existingCall.kind === "found" && out.existingCall.happens === "moves-when-confirmed" && out.existingCall.call.bookingId === "bk1",
      "a call on the same Lead id is shown, and placing a call moves it once the coordinator confirms");
    assert(out.ok && out.hours.ok && out.hours.date === "2026-06-08", "with no day asked, the hours are today's in the customer's zone");
  }
  {
    const out = await lookupCustomer({ reference: ID18 }, lookupDeps({ calls: [existing({ salesforce_id: "00QUi00000ZzZzZMAC" })] }));
    assert(out.ok && out.existingCall.kind === "found" && out.existingCall.happens === "refused-loose-match" && out.existingCall.matchedOn === "email-and-phone",
      "a call matching only on email and phone is shown, and placing is refused rather than moving a stranger's call");
  }
  {
    const out = await lookupCustomer({ reference: ID18 }, lookupDeps({ callsThrow: true }));
    assert(out.ok && out.existingCall.kind === "unreadable", "an unreadable call check is said as unreadable, never as no call");
  }
  {
    const hours = await lookupCustomer({ reference: ID18 }, lookupDeps({ hoursThrow: true }));
    assert(hours.ok && !hours.hours.ok && hours.hours.reason === "hours-unreadable", "unreadable business hours are said as such, never as closed");
    const horizon = await lookupCustomer({ reference: ID18 }, lookupDeps({ horizon: null }));
    assert(horizon.ok && !horizon.hours.ok && horizon.hours.reason === "horizon-unreadable", "and so is an unreadable horizon");
  }
  {
    const out = await lookupCustomer({ reference: "nope" }, lookupDeps());
    assert(!out.ok && out.refusal === "not-a-lead-id", "a lookup refused for the customer is refused whole");
  }
}

run()
  .then(runLookup)
  .then(finish, (err) => {
    console.error(err);
    process.exit(1);
  });
