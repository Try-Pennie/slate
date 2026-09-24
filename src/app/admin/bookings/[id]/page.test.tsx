// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1649. This page gained two `unwrap` reads in #1629 and had NO test file at
// all, so nothing anywhere would have noticed either being reverted.
//
// The booking read is the sharper of the two, and the reason is the surface it
// sits on. A null booking here is `notFound()`, and this is the page somebody
// opens precisely because they suspect a booking has gone missing. "It does not
// exist" is therefore the one answer that has to be TRUE when it is given: told
// it on a read that merely failed, the next thing anybody does is rebook, which
// is a second invite and a second slot consumed for a lead who already has one.
//
// The roster read is quieter and still wrong: an empty roster renders every actor
// in the history as a bare id, so the audit trail stops naming who did what
// exactly when somebody is reading it to find out.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);

// One seam per READ, never one for the page: the two fail differently and draw
// different wrong screens, so a fixture that fails both at once could not tell
// them apart and would pass on a page that guarded only one.
const dbState = vi.hoisted(() => ({
  booking: null as unknown,
  bookingError: null as { message: string } | null,
  roster: [] as unknown[],
  rosterError: null as { message: string } | null,
}));

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () =>
        dbState.bookingError
          ? { data: null, error: dbState.bookingError }
          : { data: dbState.booking, error: null },
      // The roster is awaited straight off the builder with no terminal, so the
      // builder itself is thenable. Resolving it WITHOUT an error key would put
      // the swallow back inside the double: `unwrap` would see no error, the page
      // would render, and the guard would pass on the bug (L143).
      then: (res: (v: { data: unknown; error: unknown }) => void) => {
        if (table === "users" && dbState.rosterError) {
          return res({ data: null, error: dbState.rosterError });
        }
        return res({ data: table === "users" ? dbState.roster : [], error: null });
      },
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  ...env,
}));
// `useRouter` is needed by AdminBookingActions, which the healthy control renders.
vi.mock("next/navigation", () => ({
  redirect,
  notFound,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/admin/bookings/b1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: async () => ({
    reschedule: { active: [] },
    cancel: { active: [] },
    reassign: { active: [] },
  }),
}));

import BookingDetailPage from "./page";
import { TEST_MODE_COPY } from "@/lib/booking/booker-copy";

const props = { params: Promise.resolve({ id: "b1" }) };
const propsFor = (id: string) => ({ params: Promise.resolve({ id }) });

const bookingRow = (isTest = false) => ({
  id: "b1",
  org_id: "o1",
  bucket_code: "120",
  // The joined bucket flag (#2660), as the page's `buckets!inner(is_test)` read
  // hands it back.
  buckets: { is_test: isTest },
  status: "confirmed",
  starts_at: "2026-09-10T14:00:00Z",
  ends_at: "2026-09-10T14:30:00Z",
  assigned_user_id: "u1",
  attendee_name: "Lead Person",
  attendee_email: "lead@example.com",
  attendee_phone: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  dbState.booking = null;
  dbState.bookingError = null;
  dbState.roster = [];
  dbState.rosterError = null;
});

describe("BookingDetailPage guards", () => {
  it("sends an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(BookingDetailPage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await BookingDetailPage(props));
    expect(screen.getByText(/manager or admin account to view bookings/i)).toBeTruthy();
  });
});

describe("the reads behind the booking detail refuse rather than draw a blank (#1649)", () => {
  const asManager = () =>
    auth.currentUser.mockResolvedValueOnce({
      id: "m1",
      role: "manager",
      org_id: "o1",
      email: "m@trypennie.com",
    });

  it("does not report a 404 when the booking could not be READ", async () => {
    asManager();
    dbState.bookingError = { message: "permission denied for table bookings" };
    await expect(BookingDetailPage(props)).rejects.toThrow(/booking detail row/);
    // The whole point: "no such booking" is not a thing to say about a read that
    // never ran, on the page somebody opens because a booking may be missing.
    expect(notFound).not.toHaveBeenCalled();
  });

  it("still reports a real 404 when the read works and finds nothing", async () => {
    asManager();
    dbState.booking = null;
    await expect(BookingDetailPage(propsFor("nope"))).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(notFound).toHaveBeenCalled();
  });

  it("refuses when the roster could not be read, rather than rendering the history as bare ids", async () => {
    asManager();
    dbState.booking = bookingRow();
    dbState.rosterError = { message: "statement timeout" };
    await expect(BookingDetailPage(props)).rejects.toThrow(/booking detail roster/);
  });

  // The control, in the same fixture. Without it the three refusals above would
  // pass just as happily on a page that had stopped rendering altogether, and an
  // empty roster is a legitimate reading that must NOT refuse.
  it("renders the booking when both reads work", async () => {
    asManager();
    dbState.booking = bookingRow();
    dbState.roster = [{ id: "u1", name: "Aria Agent", email: "aria@trypennie.com" }];
    render(await BookingDetailPage(props));
    expect(screen.getByText(/Lead Person/)).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});

// #2660: a booking on the public test bucket is a stranger's test, not a lead,
// and this page carries the controls that would move it. It stays visible and is
// MARKED, in the one treatment reserved for test mode, so nobody reads it as a
// customer; a real booking carries no mark. Both in one fixture.
describe("the detail page marks a test booking (#2660)", () => {
  const asManager = () =>
    auth.currentUser.mockResolvedValueOnce({
      id: "m1",
      role: "manager",
      org_id: "o1",
      email: "m@trypennie.com",
    });

  it("shows the test mark for a booking whose bucket is a test bucket", async () => {
    asManager();
    dbState.booking = bookingRow(true);
    dbState.roster = [{ id: "u1", name: "Aria Agent", email: "aria@trypennie.com" }];
    render(await BookingDetailPage(props));
    const mark = document.querySelector(".pn-test-mode-mark");
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toContain(TEST_MODE_COPY.label);
  });

  it("shows no mark for a real booking", async () => {
    asManager();
    dbState.booking = bookingRow(false);
    dbState.roster = [{ id: "u1", name: "Aria Agent", email: "aria@trypennie.com" }];
    render(await BookingDetailPage(props));
    expect(document.querySelector(".pn-test-mode-mark")).toBeNull();
  });
});
