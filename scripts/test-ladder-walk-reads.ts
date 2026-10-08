// #3489: a confirm that walked its ladder from ONE ladder read takes everything it needs
// about the advisors from that read too.
//
// After the candidate read, a booking made three more reads about people the ladder read
// already holds: the advisors' emails for the live check (`loadEmails`), the bucket's
// pool for the routing trace (`resolveBucketPool`, two requests) and the booked
// advisor's row (`getUser`). Request COUNT is what queues a crowd (#3492), and that is
// four requests a booking. A walk with a ladder read makes none of them, and the booking
// it writes names the same advisor, with the same name and email, and the same routing
// trace, as one walked without it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ladder-walk-reads.ts
import { createBooking } from "../src/lib/booking/orchestration.ts";
import type { LadderInputs } from "../src/lib/availability/ladder-inputs.ts";
import type { Booking, Bucket, User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, input, users, bucket as fakeBucket, eventType as fakeEventType } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

type Made = ReturnType<typeof makeDeps>;

/** Counts the three reads a ladder read makes unnecessary, keeping each fake behind it. */
function counting(made: Made) {
  const n = { getUser: 0, resolveBucketPool: 0, loadEmails: 0 };
  const d = made.deps;
  const getUser = d.getUser;
  const pool = d.resolveBucketPool;
  const emails = d.loadEmails;
  d.getUser = (id) => (n.getUser++, getUser(id));
  d.resolveBucketPool = (b) => (n.resolveBucketPool++, pool(b));
  d.loadEmails = (ids) => (n.loadEmails++, emails(ids));
  return n;
}

/** A ladder read holding what the fakes would have answered: the rung's bucket, its
 *  pool as the pool read gives it, and every advisor's row. */
async function ladderFor(made: Made): Promise<LadderInputs> {
  const pool = await made.deps.resolveBucketPool(fakeBucket as Bucket);
  return {
    bucket: (code: string) => ({ bucket: { ...fakeBucket, code } as Bucket, eventType: fakeEventType }),
    covers: () => true,
    pool: () => pool,
    user: (id: string) => (users[id] as User | undefined) ?? null,
    emails: (ids: readonly string[]) => new Map(ids.flatMap((id) => (users[id]?.email ? [[id, users[id]!.email] as [string, string]] : []))),
  } as unknown as LadderInputs;
}

async function book(withLadder: boolean) {
  const made = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(["b@x.com"]) });
  if (withLadder) {
    const ladder = await ladderFor(made);
    made.deps.readLadderInputs = async () => ladder;
  }
  const n = counting(made);
  const res = await createBooking(input, made.deps);
  return { booking: res.booking as Booking, n };
}

async function main() {
  const live = await book(false);
  const fromLadder = await book(true);

  // Control (L1): without a ladder read the three reads are made, so the zeros below
  // are the ladder read's doing and not a path that never reads.
  assert(live.n.getUser >= 1 && live.n.resolveBucketPool >= 1 && live.n.loadEmails >= 1, `control: a walk without a ladder read makes all three reads (got ${JSON.stringify(live.n)})`);

  assert(fromLadder.n.getUser === 0, `the booked advisor's row comes from the ladder read (advisor reads: ${fromLadder.n.getUser})`);
  assert(fromLadder.n.resolveBucketPool === 0, `the routing trace's pool comes from the ladder read (pool reads: ${fromLadder.n.resolveBucketPool})`);
  assert(fromLadder.n.loadEmails === 0, `the live check's emails come from the ladder read (email reads: ${fromLadder.n.loadEmails})`);

  for (const field of ["assigned_user_id", "agent_name", "agent_email"] as const) {
    assert(fromLadder.booking[field] === live.booking[field], `the booking's ${field} is the same either way (got ${fromLadder.booking[field]} and ${live.booking[field]})`);
  }
  assert(live.booking.assigned_user_id === "b", `control: the live check really chose among advisors, the free one (got ${live.booking.assigned_user_id})`);
  const trace = (b: Booking) => JSON.stringify({ considered: b.routing_trace?.considered, excluded: b.routing_trace?.excluded });
  assert(trace(fromLadder.booking) === trace(live.booking), `the routing trace's pool is the same either way (got ${trace(fromLadder.booking)} and ${trace(live.booking)})`);
}

main().then(finish);
