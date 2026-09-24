// Person-level dedupe / auto-reschedule decision for the direct booking API
// (#357). Pure so it runs under `node --experimental-strip-types`. This is the
// heart of "one active appointment per person": match a returning lead to their
// existing active booking, grade the match confidence, and decide create vs
// dedupe vs auto-reschedule vs confirm-required.
//
// Locked rule: auto-move only on a HIGH-confidence match — a strong id
// (external_id or salesforce_id) OR both email AND phone. A single-field
// (email-only / phone-only) match must NOT auto-move; it returns the existing
// appointment for the bot to confirm (unless the bot passes confirmReschedule).
// Run: node --experimental-strip-types scripts/test-person-dedupe.ts
import {
  findPersonMatch,
  decidePersonBooking,
  type PersonIdentity,
} from "../src/lib/booking/person-dedupe.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

// Minimal Booking builder — only the fields the matcher reads matter.
function booking(over: Partial<Booking>): Booking {
  return {
    id: "b1",
    starts_at: "2026-07-01T15:00:00.000Z",
    status: "confirmed",
    external_id: null,
    salesforce_id: null,
    attendee_email: null,
    attendee_phone: null,
    // remaining fields are unread by the matcher; fill with placeholders.
    org_id: "o", bucket_id: "bk", event_type_id: "et", assigned_user_id: "u",
    agent_name: null, agent_email: null, ends_at: "2026-07-01T15:30:00.000Z",
    original_starts_at: null, original_ends_at: null, timezone: "UTC",
    attendee_name: null, prefill: {}, gcal_event_id: null, manage_token: "t",
    idempotency_key: null, routing_trace: null, allow_double_book: false,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  } as Booking;
}

const id = (over: Partial<PersonIdentity>): PersonIdentity => ({
  externalId: null, salesforceId: null, email: null, phone: null, ...over,
});

const SAME = "2026-07-01T15:00:00.000Z";
const DIFFERENT = "2026-07-08T18:00:00.000Z";

function decide(
  identity: PersonIdentity,
  startIso: string,
  candidates: Booking[],
  confirmReschedule = false,
) {
  const match = findPersonMatch(identity, candidates);
  return decidePersonBooking({ startIso, match, confirmReschedule });
}

// --- no existing appointment -> create ---
assert(decide(id({ externalId: "lead-1" }), SAME, []).action === "create", "no candidates -> create");
assert(
  decide(id({ externalId: "lead-1" }), SAME, [booking({ external_id: "OTHER" })]).action === "create",
  "no matching candidate (different person) -> create",
);

// --- strong id match (external_id) ---
{
  const existing = [booking({ external_id: "lead-1", starts_at: SAME })];
  assert(
    decide(id({ externalId: "lead-1" }), SAME, existing).action === "dedupe",
    "external_id match + same slot -> dedupe",
  );
  const diff = [booking({ external_id: "lead-1", starts_at: SAME })];
  assert(
    decide(id({ externalId: "lead-1" }), DIFFERENT, diff).action === "reschedule",
    "external_id match + different time -> auto-reschedule (strong)",
  );
}

// --- strong id match (salesforce_id), cross-channel (embed booking, no external_id) ---
{
  const embed = [booking({ salesforce_id: "SF1", external_id: null, starts_at: SAME })];
  assert(
    decide(id({ externalId: "lead-1", salesforceId: "SF1" }), DIFFERENT, embed).action === "reschedule",
    "salesforce_id match on an embed booking + different time -> auto-reschedule",
  );
}

// --- medium match: both email AND phone (no ids) -> auto-reschedule ---
{
  const embed = [booking({ attendee_email: "dana@example.com", attendee_phone: "+12155550100", starts_at: SAME })];
  assert(
    decide(id({ email: "dana@example.com", phone: "2155550100" }), DIFFERENT, embed).action === "reschedule",
    "email + phone both match + different time -> auto-reschedule (medium)",
  );
}

// --- weak match: single field only -> confirm_required (no auto-move) ---
{
  const emailOnly = [booking({ attendee_email: "dana@example.com", attendee_phone: "+19999999999", starts_at: SAME })];
  assert(
    decide(id({ email: "dana@example.com", phone: "2155550100" }), DIFFERENT, emailOnly).action ===
      "confirm_required",
    "email-only match + different time -> confirm_required (weak)",
  );
  const phoneOnly = [booking({ attendee_email: "other@example.com", attendee_phone: "+12155550100", starts_at: SAME })];
  assert(
    decide(id({ email: "dana@example.com", phone: "2155550100" }), DIFFERENT, phoneOnly).action ===
      "confirm_required",
    "phone-only match + different time -> confirm_required (weak)",
  );
  // The bot confirmed with the lead -> confirmReschedule forces the move.
  assert(
    decide(id({ email: "dana@example.com", phone: "2155550100" }), DIFFERENT, emailOnly, true).action ===
      "reschedule",
    "weak match + confirmReschedule=true -> reschedule",
  );
  // Same slot still dedupes even on a weak match (same instant = same booking).
  assert(
    decide(id({ email: "dana@example.com", phone: "2155550100" }), SAME, emailOnly).action === "dedupe",
    "weak match + same slot -> dedupe",
  );
}

// --- normalization: phone formatting + email case must not defeat the match ---
{
  const existing = [booking({ attendee_email: "Dana@Example.com", attendee_phone: "+12155550100", starts_at: SAME })];
  assert(
    decide(id({ email: "dana@example.com", phone: "(215) 555-0100" }), DIFFERENT, existing).action ===
      "reschedule",
    "email case-insensitive + phone format-insensitive still matches",
  );
}

// --- strongest match wins when several candidates match ---
{
  const candidates = [
    booking({ id: "weak", attendee_email: "dana@example.com", attendee_phone: "+19999999999", starts_at: SAME }),
    booking({ id: "strong", external_id: "lead-1", starts_at: DIFFERENT }),
  ];
  const m = findPersonMatch(id({ externalId: "lead-1", email: "dana@example.com" }), candidates);
  assert(m?.booking.id === "strong" && m?.strength === "strong", "strong id match beats a weak email match");
}

// The strong id ownership check that used to sit here (bookingBelongsToPerson,
// #386) was replaced by src/lib/booking/lookup-identity.ts in #2657, which
// scripts/test-booking-lookup-identity.ts drives.

finish();
