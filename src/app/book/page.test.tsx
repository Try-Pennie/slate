// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { CATCHALL_CODE } from "@/lib/routing/catchall";

// #2660: `/book?xbc=<public test code>` renders the Booker AGAINST THE TEST
// BUCKET, in test mode.
//
// This is the page level fact the route tests cannot see. The code is not an
// XBC, so before the resolver learned it the catch-all rewrote it to the Low pool
// before the bucket row was ever read: a partner opening the embed with the test
// code was shown the live Low booker and booked a real advisor, which is the
// harm the whole feature exists to prevent (red team finding 1). What matters is
// therefore WHICH code the Booker is handed, and whether it is told the booking
// is a test one, so the mode is drawn on every screen it reaches (L319, L678).
//
// The old "This booking link is not available" refusal is gone with the branch
// that drew it: after the resolver change no reachable code produces a hidden
// test bucket here (a non XBC code is rescued, an XBC code is a real bucket), so
// the branch was dead code guarded by a fixture production never produces (L29,
// L84). The confirm still refuses a hidden bucket (#2667).

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
vi.mock("@/lib/booking/service", () => ({
  existingCallForLanding: vi.fn(async () => null),
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));

import BookEntry from "./page";
import Booker from "@/components/Booker";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

/** The Booker element in the tree the page returned, found by its (mocked) type.
 *  The page hands back elements rather than rendering, so the props are read off
 *  the element itself. */
function bookerElement(node: unknown): Record<string, unknown> {
  const found = findByType(node, Booker as unknown);
  if (!found) throw new Error("the page rendered no Booker");
  return found;
}
function findByType(node: unknown, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> };
  if (el.type === type) return el.props ?? {};
  return findByType(el.props?.children, type);
}

/** The `buckets` read, answering per code, and recording which code was asked. */
function dbByCode(rows: Record<string, { org_id: string; is_test: boolean }>, asked: string[]) {
  let code = "";
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (_col: string, value: string) => {
      code = value;
      asked.push(value);
      return builder;
    },
    maybeSingle: async () => ({ data: rows[code] ?? null, error: null }),
  };
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/book on the public test bucket (#2660)", () => {
  it("hands the Booker the test code itself, not the Low pool, in test mode", async () => {
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(
      dbByCode({ [PUBLIC_TEST]: { org_id: "o1", is_test: true } }, asked),
    );

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });

    expect(asked).toEqual([PUBLIC_TEST]);
    expect(bookerElement(el)).toMatchObject({
      bucketCode: PUBLIC_TEST,
      requestedCode: PUBLIC_TEST,
      isTest: true,
    });
  });

  it("CONTROL: a real code renders the ordinary booker, not in test mode", async () => {
    admin.supabaseAdmin.mockReturnValue(dbByCode({ "111": { org_id: "o1", is_test: false } }, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "111" }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: "111", isTest: false });
  });

  it("CONTROL: a hidden test code is still rescued to the Low pool and drawn as a real booker", async () => {
    // The row read is for the RESOLVED code, so the hidden bucket's row is never
    // even asked for: to this page the canary's code is a typo like any other.
    const asked: string[] = [];
    admin.supabaseAdmin.mockReturnValue(
      dbByCode(
        { SMOKE: { org_id: "o1", is_test: true }, [CATCHALL_CODE]: { org_id: "o1", is_test: false } },
        asked,
      ),
    );

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: "SMOKE" }) });

    expect(asked).toEqual([CATCHALL_CODE]);
    expect(bookerElement(el)).toMatchObject({ bucketCode: CATCHALL_CODE, requestedCode: "SMOKE", isTest: false });
  });

  it("renders the booker, not in test mode, when the resolved code has no row yet", async () => {
    // Before the seed has run the test code resolves to no row. The page still
    // draws the booker (the availability read then answers 404 and the booker
    // says it could not load), rather than refusing with a sentence about a
    // link: nothing here is the tester's to fix.
    admin.supabaseAdmin.mockReturnValue(dbByCode({}, []));

    const el = await BookEntry({ searchParams: Promise.resolve({ xbc: PUBLIC_TEST }) });

    expect(bookerElement(el)).toMatchObject({ bucketCode: PUBLIC_TEST, isTest: false });
  });
});
