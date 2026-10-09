// Sanity test for the pure booking cores: slot window, verify-on-book
// selection, and the write-through busy block.
// Run: node --experimental-strip-types scripts/test-booking.ts
import {
  bookingWindow,
  busyBlockFor,
  eventDescription,
  withCallingNumberLine,
  withPhoneLine,
  idempotencyKeyFor,
  selectAgent,
  selectReassignTarget,
} from "../src/lib/booking/core.ts";
import { TEST_MODE_COPY } from "../src/lib/booking/booker-copy.ts";
import { assert, finish } from "./lib/harness.ts";

// --- bookingWindow ---
const w = bookingWindow("2026-06-08T13:00:00.000Z", 30);
assert(w.startIso === "2026-06-08T13:00:00.000Z", "start normalized to ISO");
assert(w.endIso === "2026-06-08T13:30:00.000Z", "end is start + 30m");

const w2 = bookingWindow("2026-06-08T09:00:00-04:00", 20);
assert(w2.startIso === "2026-06-08T13:00:00.000Z", "non-UTC start normalized to UTC");
assert(w2.endIso === "2026-06-08T13:20:00.000Z", "end adds duration to normalized start");

// --- busyBlockFor ---
const block = busyBlockFor(
  "u1",
  "2026-06-08T13:00:00.000Z",
  "2026-06-08T13:30:00.000Z",
  "bk1",
);
assert(
  JSON.stringify(block) ===
    JSON.stringify({
      user_id: "u1",
      starts_at: "2026-06-08T13:00:00.000Z",
      ends_at: "2026-06-08T13:30:00.000Z",
      source: "slate",
      booking_id: "bk1",
    }),
  "write-through block has the expected shape (source=slate)",
);

// --- idempotencyKeyFor ---
const k1 = idempotencyKeyFor({
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  email: "K@X.com",
  phone: "+1 203 561 5295",
  salesforceId: "sf1",
});
const k2 = idempotencyKeyFor({
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  email: "k@x.com ",
  phone: "+12035615295",
  salesforceId: "sf1",
});
assert(k1 !== null && k1 === k2, "idempotency key stable across email case + phone whitespace");
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T14:00:00.000Z", phone: "+12035615295" }) !==
    idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z", phone: "+12035615295" }),
  "different slot yields a different key",
);
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z" }) === null,
  "no attendee identity yields null (no dedup)",
);
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z", salesforceId: "sf1" }) !== null,
  "salesforceId alone is enough identity",
);

// --- selectAgent (verify-on-book, wave-batched) ---
// "c" has an empty email, "d" has none; the rest resolve to real addresses.
// selectAgent now verifies candidates in round-robin WAVES of `batchSize`, each
// wave a single batched verifyFree(emails) call, and returns the first free
// candidate in round-robin order — bounding latency to ~one wave in the common
// case instead of one serial Google call per candidate.
const emailOf: Record<string, string | null> = { a: "a@x", b: "b@x", c: "", d: null };
// Batched email resolver: userId[] -> Map(userId -> email), skipping emailless.
const loadEmails = async (ids: string[]) => {
  const m = new Map<string, string>();
  for (const id of ids) {
    const e = emailOf[id];
    if (e) m.set(id, e);
  }
  return m;
};

// verifyFree now reports both the free subset AND which emails could NOT be
// verified (read errors / outage), so selectAgent can tell a genuinely-full slot
// apart from "couldn't check" (#319). `unverified` defaults to none.
function batchVerifier(free: Set<string>, unverified: Set<string> = new Set()) {
  const waves: string[][] = [];
  return {
    fn: async (emails: string[]) => {
      waves.push(emails);
      return {
        free: new Set(emails.filter((e) => free.has(e))),
        unverified: new Set(emails.filter((e) => unverified.has(e))),
      };
    },
    waves: () => waves,
    waveCount: () => waves.length,
  };
}

async function run() {
  // First free candidate wins; one wave covers both, so a single verify call.
  let v = batchVerifier(new Set(["a@x", "b@x"]));
  let r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a" && r.assignment?.email === "a@x", "first free candidate wins");
  assert(v.waveCount() === 1, "one wave when batchSize covers all candidates");

  // Candidate with an empty email is skipped (not passed to verifyFree).
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent(["c", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a", "candidate with empty email is skipped");
  assert(
    JSON.stringify(v.waves()[0]) === JSON.stringify(["a@x"]),
    "emailless candidate is not sent to verifyFree",
  );

  // Candidate with a null email is skipped.
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent(["d", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a", "candidate with null email is skipped");

  // Walks past a busy candidate to the next free one (same wave).
  v = batchVerifier(new Set(["b@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "walks past busy candidate to next free");

  // No free candidate yields a null assignment (caller maps to SlotUnavailable).
  v = batchVerifier(new Set());
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment === null, "no free candidate yields a null assignment");
  assert(r.anyUnverified === false, "all-busy failure is NOT flagged unverified");

  // Round-robin order is respected when several are free.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  r = await selectAgent(["b", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "returns first free in candidate order");

  // Empty candidate list yields null with zero verify calls.
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent([], loadEmails, v.fn, 50);
  assert(r.assignment === null && v.waveCount() === 0, "empty candidate list yields null, no verify");

  // Wave batching: free agent in the first wave → later waves never verified.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  r = await selectAgent(["a", "b", "c", "d", "a", "b"], loadEmails, v.fn, 2);
  assert(r.assignment?.userId === "a", "first wave's free agent wins");
  assert(v.waveCount() === 1, "stops after the first wave that has a free agent");
  assert(v.waves()[0].length === 2, "a wave carries at most batchSize emails");

  // Wave batching: whole first wave busy → advance to the next wave.
  // Wave 1 = [a,b] (both busy), wave 2 = [a] again but now free.
  let wavesSeen = 0;
  const toggling = async (emails: string[]) => {
    wavesSeen++;
    const free = wavesSeen === 1 ? new Set<string>() : new Set(["a@x"]);
    return {
      free: new Set(emails.filter((e) => free.has(e))),
      unverified: new Set<string>(),
    };
  };
  r = await selectAgent(["a", "b", "a", "b"], loadEmails, toggling, 2);
  assert(wavesSeen === 2, "advances to the next wave when the first is all busy");
  assert(r.assignment?.userId === "a", "returns a free agent found in a later wave");

  // Outage signal: nobody free AND a candidate couldn't be verified → anyUnverified.
  v = batchVerifier(new Set(), new Set(["a@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment === null, "couldn't-verify-anyone still yields a null assignment");
  assert(r.anyUnverified === true, "an unverifiable candidate flags anyUnverified");

  // A successful assignment doesn't care about earlier unverified candidates.
  v = batchVerifier(new Set(["b@x"]), new Set(["a@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "an unverifiable candidate is skipped for a free one");
}

await run();

// --- selectReassignTarget (coverage reassign, #972) ---
// Picks the first GENUINELY-free + under-cap candidate in round-robin order,
// excluding the out agent. Freeness is the live verify-on-book path (verifyFree),
// NOT the busy_blocks cache, because the reassign swap rides allow_double_book:
// a stale-cache "free" would silently double-book the covering agent. The cap
// predicate is checked ONLY for free candidates (so a busy agent never costs a
// cap read) and a free-but-over-cap agent is passed over. Null means unplaceable.
// `isUnderCap` fake: any userId in `overCap` is at its daily cap; records calls.
function capChecker(overCap: Set<string> = new Set()) {
  const calls: string[] = [];
  return {
    fn: async (userId: string) => {
      calls.push(userId);
      return !overCap.has(userId);
    },
    calls: () => calls,
  };
}

async function runReassignTarget() {
  const WAVE = 50;
  // First free + under-cap candidate wins.
  let v = batchVerifier(new Set(["a@x", "b@x"]));
  let cap = capChecker();
  let r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment?.userId === "a", "first free + under-cap candidate wins");
  // #3495: like `selectAgent`, the wave carries the advisor id each email was read from.
  {
    const seen: (Record<string, string> | null)[] = [];
    await selectReassignTarget(["a", "b"], null, loadEmails, async (emails: string[], ids?: ReadonlyMap<string, string>) => {
      seen.push(ids ? Object.fromEntries(ids) : null);
      return { free: new Set(emails), unverified: new Set<string>() };
    }, capChecker().fn, WAVE);
    assert(JSON.stringify(seen[0]) === JSON.stringify({ "a@x": "a", "b@x": "b" }), `the reassign wave is handed each email's advisor id (got ${JSON.stringify(seen[0])})`);
  }
  assert(cap.calls().length === 1, "cap checked only until the first free+under-cap agent is found");

  // The out agent is excluded even when free + under-cap (next candidate wins).
  v = batchVerifier(new Set(["a@x", "b@x"]));
  cap = capChecker();
  r = await selectReassignTarget(["a", "b"], "a", loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment?.userId === "b", "the out agent is excluded from the candidate set");
  assert(!cap.calls().includes("a"), "the excluded out agent is never cap-checked");
  assert(
    JSON.stringify(v.waves()[0]) === JSON.stringify(["b@x"]),
    "the excluded out agent is never sent to verifyFree",
  );

  // A free-but-over-cap candidate is passed over for the next free + under-cap one.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  cap = capChecker(new Set(["a"]));
  r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment?.userId === "b", "a free-but-over-cap candidate is skipped for a free+under-cap one");

  // Round-robin order is respected among free + under-cap candidates.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  cap = capChecker();
  r = await selectReassignTarget(["b", "a"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment?.userId === "b", "returns first free+under-cap in candidate order");

  // A busy candidate never costs a cap read (cap is checked only for free ones).
  v = batchVerifier(new Set(["b@x"]));
  cap = capChecker();
  r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment?.userId === "b", "walks past a busy candidate to the next free one");
  assert(JSON.stringify(cap.calls()) === JSON.stringify(["b"]), "a busy candidate is never cap-checked");

  // Unplaceable: every candidate is busy → null, and NOT flagged as an outage.
  v = batchVerifier(new Set());
  cap = capChecker();
  r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment === null, "all-busy yields an unplaceable (null) target");
  assert(r.anyUnverified === false, "an all-busy unplaceable is NOT an outage");

  // Unplaceable: every candidate is free but over cap → null, definite (no outage).
  v = batchVerifier(new Set(["a@x", "b@x"]));
  cap = capChecker(new Set(["a", "b"]));
  r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment === null, "all free-but-over-cap yields an unplaceable (null) target");
  assert(r.anyUnverified === false, "an all-over-cap unplaceable is a definite miss, not an outage");

  // Outage: nobody free AND a candidate couldn't be verified → anyUnverified true.
  v = batchVerifier(new Set(), new Set(["a@x"]));
  cap = capChecker();
  r = await selectReassignTarget(["a", "b"], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(r.assignment === null, "couldn't-verify-anyone still yields a null target");
  assert(r.anyUnverified === true, "an unverifiable candidate flags anyUnverified for the caller to retry");

  // Empty candidate set → null with no verify and no cap reads.
  v = batchVerifier(new Set(["a@x"]));
  cap = capChecker();
  r = await selectReassignTarget([], null, loadEmails, v.fn, cap.fn, WAVE);
  assert(
    r.assignment === null && v.waveCount() === 0 && cap.calls().length === 0,
    "empty candidate set yields null with no verify or cap reads",
  );

  // Wave batching: a free+under-cap agent in the first wave → later waves unread.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  cap = capChecker();
  r = await selectReassignTarget(["a", "b", "a", "b"], null, loadEmails, v.fn, cap.fn, 2);
  assert(r.assignment?.userId === "a", "first wave's free+under-cap agent wins");
  assert(v.waveCount() === 1, "stops after the first wave that has a free+under-cap agent");
}

await runReassignTarget();

// --- eventDescription (#64: invite carries the manage link) ---
const desc = eventDescription("+12035615295", "https://slate.trypennie.app/booking/manage/tok123");
assert(
  desc === "Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://slate.trypennie.app/booking/manage/tok123",
  "description carries phone and the manage link",
);
assert(
  eventDescription(null, "https://x/m/t") === "Booked via Pennie.\nReschedule or cancel: https://x/m/t",
  "no phone -> still carries the manage link",
);
assert(!desc.includes(" - ") && !desc.includes("\u2014"), "lead-facing copy has no dashes");
// #2660: a TEST booking's invite opens with the test line, so the calendar event
// says what it is without being opened, and a real booking's is untouched.
{
  const testDesc = eventDescription("+12035615295", "https://x/m/t", { isTest: true });
  assert(testDesc.startsWith(`${TEST_MODE_COPY.line}\n`), "a test booking's invite opens with the test line");
  assert(
    testDesc.endsWith("Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://x/m/t"),
    "and still carries the phone and the manage link after it",
  );
  assert(
    eventDescription("+12035615295", "https://x/m/t", { isTest: false }) ===
      eventDescription("+12035615295", "https://x/m/t"),
    "a real booking's invite is unchanged",
  );
  assert(!desc.includes(TEST_MODE_COPY.line), "and never carries the test line");
}

// #1334: the invite names the number the call will come FROM when it is known, so it
// sits on the lead's phone next to the appointment, and says nothing when it is not.
{
  const withFrom = eventDescription("+12035615295", "https://x/m/t", { isTest: false, callingNumber: "+12197588170" });
  assert(withFrom.includes("(219) 758-8170"), "the calling number is named, formatted for the lead");
  assert(
    withFrom.startsWith("Booked via Pennie. Phone: +12035615295\n"),
    "the advisor's dial line stays first and as stored",
  );
  assert(withFrom.endsWith("Reschedule or cancel: https://x/m/t"), "and the manage link is still the last line");
  assert(
    eventDescription("+12035615295", "https://x/m/t", { isTest: false, callingNumber: null }) === desc.replace(
      "https://slate.trypennie.app/booking/manage/tok123",
      "https://x/m/t",
    ),
    "with no calling number the invite is exactly as before",
  );
  // ONE rule for where the line goes: the full builder and the one line edit the
  // reminder lane makes to an existing invite agree.
  const plain = eventDescription("+12035615295", "https://x/m/t");
  assert(
    withCallingNumberLine(plain, "+12197588170") === withFrom,
    "editing a plain invite gives the same text as building it with the number",
  );
  assert(
    withCallingNumberLine(withFrom, "+12197588170") === withFrom,
    "applying it twice changes nothing",
  );
  assert(withCallingNumberLine(withFrom, null) === withFrom, "an unknown number never removes a line");
  assert(withCallingNumberLine("", "+12197588170").startsWith("The call will come from"), "an empty description gets the line alone");

  // The phone line is edited in place by the same rule the builder writes it with.
  assert(
    withPhoneLine(eventDescription("+12035615295", "https://x/m/t", { isTest: true, callingNumber: "+12197588170" }), "+12155559999") ===
      eventDescription("+12155559999", "https://x/m/t", { isTest: true, callingNumber: "+12197588170" }),
    "editing the phone line gives the same text as building with the new phone, test line and calling line kept",
  );
  assert(
    withPhoneLine("Booked via Pennie. Phone: +12035615295\nhttps://x", null) === "Booked via Pennie.\nhttps://x",
    "a removed phone leaves the plain booked line",
  );
  assert(
    withPhoneLine("Some text nobody here wrote.", "+12155559999") === "Booked via Pennie. Phone: +12155559999\nSome text nobody here wrote.",
    "an invite with no phone line gets one at the top, and keeps the rest",
  );
}

finish();
