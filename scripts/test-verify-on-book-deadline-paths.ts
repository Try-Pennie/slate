// #3313: what the REAL orchestration does with a deadline raised inside verify on
// book, on both the booking path and the time change path.
//
// The service half lives in `src/lib/booking/verify-on-book-deadline.test.ts`:
// it drives the real verify on book wiring and proves a spent confirm budget comes
// back out of it as the deadline, not as an unverified agent, and that the service
// pages it as the dependency timeout. This half proves the link between them: the
// orchestration lets that deadline through untouched, from the booking's wave,
// from a time change's reroute and from its in place guard, so it reaches
// `timeoutAsRetryable` as itself and never as `VerifyUnavailableError`, whose
// page says "likely a Google/DB outage" (L11).
//
// The split is the harness boundary (AGENTS.md, "Where a new test goes"): the
// service half needs `vi.mock`, and the shared booking fake lives here in
// `scripts/`, which the app's `tsc` program does not include.
import {
  createBooking,
  rescheduleBooking,
  DependencyTimeoutError,
  VerifyUnavailableError,
  timeoutAsRetryable,
} from "../src/lib/booking/orchestration.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  RR,
  NOW,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const BUDGET = { label: "the booking confirm", totalMs: 12_000 };

/** The deadline the confirm's spent budget raises, as the 2026-10-05 incident logged it. */
const spent = () => new DeadlineExceededError("supabase", 0, BUDGET);

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return null;
}

/** The deadline arrived as itself, and maps to the dependency timeout the page needs. */
function assertTimeout(err: unknown, deadline: DeadlineExceededError, path: string) {
  assert(err === deadline, `${path}: the deadline escapes the orchestration unchanged`);
  assert(!(err instanceof VerifyUnavailableError), `${path}: it is not turned into the verify outage`);
  const mapped = timeoutAsRetryable(err);
  assert(
    mapped instanceof DependencyTimeoutError && mapped.dependency === "supabase" && mapped.timeoutMs === 0,
    `${path}: it maps to the dependency timeout, naming the call and the spent budget`,
  );
}

async function run() {
  // 1. A new booking: the deadline is raised by the verify on book wave.
  {
    const fake = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const deadline = spent();
    fake.deps.verifyFree = async () => {
      throw deadline;
    };
    const err = await caught(() => createBooking({ ...input, bucketCode: bucket.code }, fake.deps));
    assertTimeout(err, deadline, "booking");
    assert(fake.calls.createEvent.length === 0, "booking: no invite is created");
    assert(fake.calls.insertBooking.length === 0, "booking: no booking row is written");
  }

  // 2. A time change that reroutes (the 2026-10-05 shape): the assigned advisor is
  // off shift at the new time, so the move asks verify on book for somebody else.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fake = makeDeps({
      existing: ctx,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A's Monday shift ends 13:30 NY, so 14:00 NY sends the move to the reroute.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    const deadline = spent();
    fake.deps.verifyFree = async () => {
      throw deadline;
    };
    const err = await caught(() =>
      rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", fake.deps, NOW),
    );
    assertTimeout(err, deadline, "time change (reroute)");
    assert(fake.calls.createEvent.length === 0, "time change (reroute): no invite is created");
    assert(fake.calls.updateEventTime.length === 0, "time change (reroute): the old invite is not moved");
  }

  // 3. A time change kept with the same advisor: the deadline is raised by the in
  // place guard's live read, which must not read as "could not tell" and reroute.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fake = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const deadline = spent();
    let guardRead = 0;
    fake.deps.busyIntervalsForAgent = async () => {
      guardRead++;
      throw deadline;
    };
    const err = await caught(() =>
      rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", fake.deps, NOW),
    );
    assert(guardRead === 1, "time change (in place): the guard's live read was the one asked");
    assertTimeout(err, deadline, "time change (in place)");
    assert(fake.calls.verifyFree.length === 0, "time change (in place): no reroute is attempted with no time left");
  }

  // 4. The control: a wave that really could not be verified is still the verify
  // outage, and is left alone by the timeout mapping.
  {
    const fake = makeDeps({
      candidates: ["a"],
      freeEmails: new Set<string>(),
      unverifiedEmails: new Set(["a@x.com"]),
    });
    const err = await caught(() => createBooking({ ...input, bucketCode: bucket.code }, fake.deps));
    assert(err instanceof VerifyUnavailableError, "control: an unverifiable wave is still the verify outage");
    assert(!(err instanceof DependencyTimeoutError), "control: and is not called a timeout");
    assert(timeoutAsRetryable(err) === err, "control: the timeout mapping leaves it untouched");
  }

  finish();
}

void run();
