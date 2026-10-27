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

// #4206 (Dan, 2026-10-26 and 27): a call on the placeholder advisor, Marcia, sends its
// invite from the placeholder seat, whose inbox nobody reads. Its invite names no
// number, offers no way to change the call (no manage link: a customer who asks to
// change it by text is handled then), and sends a question to our texts. A routed
// invite is unchanged.
{
  const placed = eventDescription("+12035615295", "https://x/m/t", { isTest: false, onPlaceholder: true });
  assert(
    placed ===
      "Booked via Pennie. Phone: +12035615295\n" +
        "Nobody reads replies to this invite. If you have a question, reply to one of our texts and someone will answer you there.",
    "the placeholder invite is the dial line and the reply to our texts line, nothing else",
  );
  assert(!/Reschedule or cancel|https:\/\/x\/m\/t/.test(placed), "it carries no manage link");
  assert(!/change/i.test(placed), "and never says the call can be changed");
  assert(
    eventDescription("+12035615295", "https://x/m/t", { isTest: false, onPlaceholder: false }) ===
      eventDescription("+12035615295", "https://x/m/t"),
    "a routed invite is exactly as before",
  );
  assert(!/reply to one of our texts/.test(eventDescription("+12035615295", "https://x/m/t")), "and never carries the line");
  assert(
    !eventDescription("+12035615295", "https://x/m/t", { isTest: false, onPlaceholder: true, callingNumber: "+12197588170" }).includes(
      "(219) 758-8170",
    ),
    "the placeholder invite names no calling number even when one is known",
  );
  assert(
    eventDescription(null, "https://x/m/t", { isTest: true, onPlaceholder: true }).startsWith(`${TEST_MODE_COPY.line}\n`),
    "a test placeholder invite still opens with the test line",
  );
  assert(!placed.includes(" - ") && !/[\u2013\u2014]/.test(placed), "no dashes as punctuation");
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
