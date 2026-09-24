// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// #2542: the booker's own test-bucket refusal was a swallowed read.
//
// `/book` reads the bucket to find out whether it is a synthetic SMOKE bucket
// (#396), which has no public booking page. It read it as `const { data:
// bucketRow } = await ...`, so a FAILED query arrived as `bucketRow === null`
// and `bucketRow?.is_test` was false: an unreadable `buckets` table renders the
// ordinary public booker for a test code, against the test agents the canary
// books. Empty and "not a test bucket" are the same answer, which is the whole
// class (L215).
//
// It sat outside the swallowed-read guard's hand written directory list, which
// is why nothing had ever asked. The list is derived now, and this is the
// behaviour the fix is about: a read error is a broken deploy and belongs on the
// screen as one, not as a silently relaxed refusal.
//
// Both directions are asserted in the same fixture, because a page that threw on
// everything would satisfy the negative alone (L159): the healthy test bucket is
// still refused with its own words, and an ordinary bucket still renders.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/components/ClientErrorBeacon", () => ({ ClientErrorBeacon: () => null }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({
    reschedule: { active: [] },
    cancel: { active: [] },
  })),
}));
// #2556 gave the page a second call into this module, so the mock has to carry it or
// every case here dies on the import rather than on what it is testing. It answers the
// link's own values unchanged, which is what a landing page carrying all three costs:
// this suite is about the BUCKET read, and the attendee resolution must not decide
// anything in it.
vi.mock("@/lib/booking/service", () => ({
  existingCallForLanding: vi.fn(async () => null),
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));

import BookEntry from "./page";

type Result = { data: unknown; error: { message: string } | null };

/** One `buckets` read, answering whatever this fixture is set to. */
function dbAnswering(result: Result) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => result,
  };
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const params = { searchParams: Promise.resolve({ xbc: "111" }) };

describe("/book on an unreadable bucket read (#2542)", () => {
  it("throws rather than serving the public booker on a read it could not make", async () => {
    admin.supabaseAdmin.mockReturnValue(
      dbAnswering({ data: null, error: { message: "permission denied for table buckets" } }),
    );

    await expect(BookEntry(params)).rejects.toThrow(/permission denied for table buckets/);
  });

  // #2660 deleted the refusal this file used to assert on ("This booking link is
  // not available"): after the resolver change no reachable code produces a
  // hidden test bucket here, so the branch was dead and the test that pinned it
  // defended a screen production never drew (L29, L84). What the read decides now
  // is whether the booker is in TEST MODE, which `page.test.tsx` pins. The two
  // controls below keep this suite honest about the ordinary and the empty read.
  it("CONTROL: a readable ordinary bucket still renders the booker", async () => {
    admin.supabaseAdmin.mockReturnValue(
      dbAnswering({ data: { org_id: "o1", is_test: false }, error: null }),
    );

    await expect(BookEntry(params)).resolves.toBeTruthy();
  });

  // A bucket code nothing matches is a NOT FOUND, not a failure: `unwrap` passes
  // a null row with a null error straight through, and the booker routes an
  // unknown code rather than refusing it (#1908). Without this the case above
  // would be satisfied by a page that treated every empty answer as an error.
  it("CONTROL: a bucket code that matches no row still renders the booker", async () => {
    admin.supabaseAdmin.mockReturnValue(dbAnswering({ data: null, error: null }));

    await expect(BookEntry(params)).resolves.toBeTruthy();
  });
});
