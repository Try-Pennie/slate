// The booking failure page names where a refused confirm's time went (#3511).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-page-time-spent.ts
//
// On 2026-10-07 16:55 ET the commit gate (#3338) declined to write a booking with
// 4 seconds of the confirm left, and the page told the reader the time went "inside
// Slate", to look "rather than Google Calendar API and Supabase health". The
// request's own confirm answered line said otherwise: `assign-and-verify:7555`,
// `calls_by=google:7068/4/6529`, one Google call of 6.5 seconds. The page reasoned
// only about the step that refused, never about which earlier step used the time
// (L11). The profile already held every call's label; the line kept only the
// dependency, so it could not even say WHICH Google call stalled.
import { dependencyTimeoutAlert } from "../src/lib/booking/alert-copy.ts";
import { confirmProfileFields, makeConfirmProfile } from "../src/lib/booking/confirm-profile.ts";
import { timeSpentInThisRequest, whereTimeWent } from "../src/lib/booking/time-spent.ts";
import { withinCallBudget } from "../src/lib/call-budget.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// A clock the test moves, so no test waits on real time (L524).
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** The 16:55 confirm, replayed: a stage holding four Google calls, one of them 6.5s. */
async function replay1655() {
  const c = clock();
  const profile = makeConfirmProfile({ now: c.now }).observeCalls();
  await profile.time("idempotency-lookup", async () => {
    profile.call("supabase idempotency", c.now(), c.now() + 45);
    c.advance(45);
  });
  await profile.time("assign-and-verify", async () => {
    profile.call("google token mint", c.now(), c.now() + 120);
    c.advance(120);
    profile.call("google freeBusy.many", c.now(), c.now() + 6529);
    c.advance(6529);
    profile.call("google freeBusy.many", c.now(), c.now() + 300);
    c.advance(906);
  });
  return { profile, at: c.now() };
}

// --- the line names the slowest call, label and all ----------------------------
{
  const { profile, at } = await replay1655();
  const fields = confirmProfileFields(profile.read(at));
  assert(
    fields.slowest_call === "google freeBusy.many:6529",
    `the confirm answered line names the slowest call by its full label (got ${String(fields.slowest_call)})`,
  );
  const quiet = makeConfirmProfile({ now: () => 5 }).observeCalls();
  assert(!("slowest_call" in confirmProfileFields(quiet.read(5))), "a confirm that made no call names none, never a blank");
}

// --- where the time went, from the request's own reading ------------------------
{
  const { profile, at } = await replay1655();
  const spent = whereTimeWent(profile.read(at));
  assert(spent.stage?.name === "assign-and-verify" && spent.stage.ms === 7555, "the dearest stage, as the line counts it");
  assert(spent.call?.label === "google freeBusy.many" && spent.call.ms === 6529, "and the slowest single call");
}

// --- read from the request in force, and only there ------------------------------
{
  const { profile, at } = await replay1655();
  const inside = await withinCallBudget(12_000, "the booking confirm", async () => timeSpentInThisRequest(() => at), undefined, profile);
  assert(inside?.call?.label === "google freeBusy.many", "inside the confirm's budget, the page reads that confirm's profile");
  assert(timeSpentInThisRequest(() => at) === null, "outside any request, there is nothing to read and it says so");
  const plain = await withinCallBudget(12_000, "a lane", async () => timeSpentInThisRequest(() => at));
  assert(plain === null, "a budget nothing profiles is not read as a profile");
}

// --- the page ----------------------------------------------------------------------
const GATE = { dependency: "writing the booking and its calendar event", timeoutMs: 3882, budget: null, neededMs: 7253 };
const PENDING = "Check booking_reservations for a pending row before asking them to rebook";
{
  const { profile, at } = await replay1655();
  const page = dependencyTimeoutAlert({ ...GATE, spent: whereTimeWent(profile.read(at)) });
  assert(page.includes(PENDING), "the pending row check stays first");
  assert(
    page.includes("The time went to the assign-and-verify step (8 seconds), 7 seconds of it in one call to google freeBusy.many"),
    `the 16:55 page names the step and the call that used the time (got: ${page})`,
  );
  assert(page.includes("start from Google Calendar API health and that request's confirm answered log line"), "and sends the reader to Google");
  assert(!page.includes("inside Slate") && !page.includes("rather than Google"), "and never away from it");
}
{
  // The slow part was Slate's own: the stage's calls were quick.
  const page = dependencyTimeoutAlert({
    ...GATE,
    spent: { stage: { name: "route-checks", ms: 7000 }, call: { label: "supabase bookings", ms: 300 } },
  });
  assert(page.includes("The time went to the route-checks step (7 seconds) inside Slate"), `a stage no call explains is Slate's own (got: ${page})`);
  assert(page.includes("rather than Google Calendar API and Supabase health"), "and the reader is still steered off the dependencies");
}
{
  const page = dependencyTimeoutAlert({
    ...GATE,
    spent: { stage: { name: "idempotency-lookup", ms: 6000 }, call: { label: "supabase idempotency", ms: 5200 } },
  });
  assert(page.includes("start from Supabase health"), "a Supabase call that ate the stage sends the reader to Supabase");
}
{
  // An unprofiled request keeps today's wording exactly.
  const page = dependencyTimeoutAlert(GATE);
  assert(page.includes("The time went inside Slate before that call"), "without a profile the page says what it said before");
}
{
  // A call that ran out on its own (not a refused one) is unchanged by a profile.
  const page = dependencyTimeoutAlert({
    dependency: "google events.insert",
    timeoutMs: 8000,
    budget: null,
    spent: { stage: { name: "complete-reservation", ms: 8100 }, call: { label: "google events.insert", ms: 8000 } },
  });
  assert(page.endsWith(", and Google Calendar API and Supabase health."), "a call that did not answer still points at the dependencies");
}

finish();
