// The public booking kill switch, and the direction it fails in (#2297).
//
// Run: node --experimental-strip-types scripts/test-booking-kill-switch.ts
//
// `judgePublicBooking` is the whole decision: a stored flag read per request says
// whether Slate is still taking public bookings. It is pure so the one interesting
// choice in it can be driven here, with no database and no route.
//
// That choice is what happens when the flag CANNOT BE READ. This is the only gate
// in the booking path that fails CLOSED, and it is deliberate. The switch exists to
// stop real Google invites reaching real agents' calendars and real `booking.created`
// webhooks reaching Regal, in seconds, without a deploy. A lever that a failed read
// turns back on is a lever nobody can rely on at the moment they reach for it (L42),
// and the failure that would defeat it is the same #277 shape the repo has shipped
// before: a read error resolving to a benign-looking value that nothing reports.
//
// The cost of the choice is small and bounded, which is why it is affordable here
// and not everywhere. The booking WRITE already cannot complete without Postgres
// (the hourly cap, then every read inside createBooking), so a database that cannot
// answer this question was going to refuse the booking a few lines later anyway.
// What fails closed here is narrower than it looks: a column this route cannot read
// while the rest of the database answers, which is a half-applied migration rather
// than an outage, and refusing loudly is the correct response to that.
//
// The two refusals are separate values rather than one, because they send two
// different people to do two different things: one is somebody deliberately holding
// bookings, the other is a schema fault nobody chose (L11). A shared refusal would
// have the pause explain away the fault.
import { assert, eq, finish } from "./lib/harness.ts";
import { judgePublicBooking } from "../src/lib/booking/kill-switch.ts";

// The ordinary day: a flag that reads fine and says bookings are open.
const open = judgePublicBooking(false);
eq(open.allow, true, "a stored flag reading false takes bookings exactly as before");

// The switch thrown on purpose.
const paused = judgePublicBooking(true);
eq(paused.allow, false, "a stored flag reading true refuses the public booking write");
assert(
  paused.allow === false && paused.refusal === "booking_paused",
  "a deliberate pause names itself, so the refusal can be told from a fault",
);

// The direction this file exists for.
const unreadable = judgePublicBooking(null);
eq(unreadable.allow, false, "a flag that could not be read refuses rather than booking on");
assert(
  unreadable.allow === false && unreadable.refusal === "booking_pause_unreadable",
  "an unreadable flag carries its OWN refusal, never the deliberate pause's",
);

// The two refusals must stay distinguishable. Collapsing them would make a schema
// fault read as somebody holding bookings on purpose, and nobody would look.
assert(
  paused.allow === false &&
    unreadable.allow === false &&
    paused.refusal !== unreadable.refusal,
  "the deliberate pause and the unreadable flag are different refusals",
);

// A positive control, so this file cannot rot into a test of nothing: the judge has
// to be capable of returning BOTH answers. A judge hard-wired to refuse would satisfy
// every assertion above except this pair read together (L1).
assert(
  open.allow === true && paused.allow === false,
  "the judge really can both allow and refuse, so the refusals above mean something",
);

finish();
