// @vitest-environment jsdom
//
// The public test bucket's pass is SENT where it is needed, and only there (#2666).
//
// The routes verify a header; that proves nothing unless the components that call
// them put it on. So this mounts each sender and reads the header off the request it
// actually made: the booker's availability read, its next days search and its
// confirm, and the reschedule reads on the manage page and the admin panel, which a
// TEST booking reaches with the public bucket's code. Each is also asserted to send
// NOTHING for a real bucket, so a sender that stamped every request fails too (L1).
//
// And the far end: a pass that ran out while the page sat open comes back with its
// own sentence, and that sentence is what the tester reads, in place of "check your
// connection", with no retry offered that could never work.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import ManageBooking from "@/components/ManageBooking";
import AdminBookingActions from "@/components/AdminBookingActions";
import { CANCEL_REASONS, REASSIGN_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { DETAILS_COPY, NEXT_DAYS_COPY, PICKER_COPY, TEST_ACCESS_COPY } from "@/lib/booking/booker-copy";
import { TEST_PASS_HEADER, TEST_PASS_REFUSAL_CODES } from "@/lib/embed/test-pass-header";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { bookerSlotIso } from "@/components/booker-test-slot";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];
const PASS = "pass-value-from-book";
const slotIso = bookerSlotIso(2, 15, "America/New_York");

const availability = {
  bucket: { code: PUBLIC_TEST },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};

type Route = { ok: boolean; status?: number; body: unknown };
function mockFetch(routes: { availability?: Route; next?: Route; booking?: Route }) {
  const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url);
    const r: Route =
      (u.includes("/api/availability/next")
        ? routes.next
        : u.includes("/api/availability")
          ? routes.availability
          : u === "/booking"
            ? routes.booking
            : undefined) ?? { ok: true, body: { ok: true } };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 403), json: async () => r.body } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** The pass header on the request the component made to a path, or undefined. */
function passSentTo(fn: ReturnType<typeof mockFetch>, match: (u: string) => boolean): string | undefined {
  const call = fn.mock.calls.find(([u]) => match(String(u)));
  expect(call, "the request was made").toBeTruthy();
  const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  return headers?.[TEST_PASS_HEADER];
}
const bodyText = () => document.body.textContent ?? "";
const isAvailability = (u: string) => u.startsWith("/api/availability?");

const bookerProps = {
  bucketCode: PUBLIC_TEST,
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
  isTest: true,
};

async function fillAndConfirm() {
  fireEvent.click(await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
  fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
  fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Pat" } });
  fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pat@agency.example" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
  fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));
}

beforeEach(() => vi.clearAllMocks());

describe("the booker sends the test pass (#2666)", () => {
  it("on the availability read and on the confirm", async () => {
    const fn = mockFetch({
      availability: { ok: true, body: availability },
      booking: { ok: true, body: { startsAt: slotIso, manageUrl: null, isTest: true } },
    });
    render(<Booker {...bookerProps} testPass={PASS} />);
    await fillAndConfirm();
    await screen.findByRole("heading", { level: 2 });
    expect(passSentTo(fn, isAvailability)).toBe(PASS);
    expect(passSentTo(fn, (u) => u === "/booking")).toBe(PASS);
  });

  it("on the next days search", async () => {
    const fn = mockFetch({
      availability: {
        ok: true,
        body: { ...availability, slots: [], emptyBecause: { kind: "closed", reopensOn: null } },
      },
      next: { ok: true, body: { slots: [] } },
    });
    render(<Booker {...bookerProps} testPass={PASS} />);
    await userEvent.click(await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask }));
    expect(passSentTo(fn, (u) => u.startsWith("/api/availability/next"))).toBe(PASS);
  });

  it("CONTROL: sends no pass header at all for a real bucket", async () => {
    const fn = mockFetch({
      availability: { ok: true, body: { ...availability, bucket: { code: "411" } } },
      booking: { ok: true, body: { startsAt: slotIso, manageUrl: null } },
    });
    render(<Booker {...bookerProps} bucketCode="411" isTest={false} />);
    await fillAndConfirm();
    await screen.findByRole("heading", { level: 2 });
    expect(passSentTo(fn, isAvailability)).toBeUndefined();
    expect(passSentTo(fn, (u) => u === "/booking")).toBeUndefined();
  });

  it("says a pass that ran out mid booking is to be fixed by a reload", async () => {
    mockFetch({
      availability: { ok: true, body: availability },
      booking: {
        ok: false,
        status: 403,
        body: { error: TEST_ACCESS_COPY.passExpired, code: TEST_PASS_REFUSAL_CODES.expired },
      },
    });
    render(<Booker {...bookerProps} testPass={PASS} />);
    await fillAndConfirm();
    expect(await screen.findByText(TEST_ACCESS_COPY.passExpired)).toBeTruthy();
  });

  it("says so on the times too, with no retry that could never work", async () => {
    mockFetch({
      availability: {
        ok: false,
        status: 403,
        body: { error: TEST_ACCESS_COPY.passExpired, code: TEST_PASS_REFUSAL_CODES.expired },
      },
    });
    render(<Booker {...bookerProps} testPass={PASS} />);
    // Split into one line per sentence by the panel, so read as the page's text.
    await vi.waitFor(() => expect(bodyText()).toContain(TEST_ACCESS_COPY.passExpired.replace(". ", ".")));
    expect(bodyText()).not.toContain(PICKER_COPY.failed.replace(". ", "."));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says so on the next days search", async () => {
    mockFetch({
      availability: {
        ok: true,
        body: { ...availability, slots: [], emptyBecause: { kind: "closed", reopensOn: null } },
      },
      next: {
        ok: false,
        status: 403,
        body: { error: TEST_ACCESS_COPY.passExpired, code: TEST_PASS_REFUSAL_CODES.expired },
      },
    });
    render(<Booker {...bookerProps} testPass={PASS} />);
    await userEvent.click(await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask }));
    expect(await screen.findByText(TEST_ACCESS_COPY.passExpired)).toBeTruthy();
    expect(screen.queryByText(NEXT_DAYS_COPY.failed)).toBeNull();
  });

  it("CONTROL: an ordinary failure still reads as one, with its retry", async () => {
    mockFetch({ availability: { ok: false, status: 500, body: { error: "Internal" } } });
    render(<Booker {...bookerProps} bucketCode="411" isTest={false} />);
    await vi.waitFor(() => expect(bodyText()).toContain(PICKER_COPY.failed.replace(". ", ".")));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

const manageProps = {
  token: "tok1",
  bucketCode: PUBLIC_TEST,
  rescheduleTimesFrom: "pool" as const,
  startsAt: "2026-06-20T15:00:00.000Z",
  status: "confirmed",
  eventName: "Advisor Call",
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  theme: "light" as const,
  durationMin: 20,
  attendeePhone: "(215) 555-0100",
  attendeeEmail: "dana@example.com",
  advisorName: "Aisha Bello",
  advisorRole: "Senior Loan Advisor",
};

describe("the manage page and the admin panel send it for a test booking (#2666)", () => {
  it("the manage page's reschedule read carries the pass its page minted", async () => {
    const fn = mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(<ManageBooking {...manageProps} testPass={PASS} />);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(passSentTo(fn, isAvailability)).toBe(PASS);
  });

  it("CONTROL: a real booking's manage page reads its bucket bare", async () => {
    const fn = mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(<ManageBooking {...manageProps} bucketCode="411" />);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(passSentTo(fn, isAvailability)).toBeUndefined();
  });

  const reasonOptions = { reschedule: RESCHEDULE_REASONS, cancel: CANCEL_REASONS, reassign: REASSIGN_REASONS };

  it("the admin panel's reschedule read carries the pass its page minted", async () => {
    const fn = mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(
      <AdminBookingActions
        bookingId="bk1"
        rescheduleTimesFrom="pool"
        bucketCode={PUBLIC_TEST}
        testPass={PASS}
        leadTimeZone="America/New_York"
        status="confirmed"
        reasonOptions={reasonOptions}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(passSentTo(fn, isAvailability)).toBe(PASS);
  });

  it("CONTROL: a real booking's admin panel reads its bucket bare", async () => {
    const fn = mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(
      <AdminBookingActions
        bookingId="bk1"
        rescheduleTimesFrom="pool"
        bucketCode="411"
        leadTimeZone="America/New_York"
        status="confirmed"
        reasonOptions={reasonOptions}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(passSentTo(fn, isAvailability)).toBeUndefined();
  });
});
