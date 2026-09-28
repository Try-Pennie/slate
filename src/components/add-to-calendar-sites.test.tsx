// @vitest-environment jsdom
//
// Where the add to calendar group and the advisor's name are drawn (#2165): the
// Booker's confirmation and the manage page, through ONE component. What each
// screen must get right is WHICH booking the name and the links describe, and
// when they are withheld:
//
// - the confirmation draws them from the same response that gave it the time, so
//   they always describe the call this lead just made or moved;
// - a weak identity match (#1340) is never confirmed at all: its panel names no
//   time and hands over no token, so it must name no advisor and offer no links
//   either, which is the same predicate;
// - the manage page swaps the links for the moved call's after a move made on it,
//   because links at the old time would put the wrong meeting on a calendar, and
//   drops them once the call is cancelled.
import { describe, it, expect, vi, beforeEach } from "vitest";

// #2310: the booker and the manage page offer a time only inside the lead's
// calling window, judged in the DEVICE zone. These fixtures' times are ordinary
// Eastern daytime, so which are offered would otherwise depend on the machine
// running the suite. Pinned here, never inherited (L504).
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import Booker from "@/components/Booker";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import {
  ADD_TO_CALENDAR_COPY,
  CONFIRMED_COPY,
  DETAILS_COPY,
  DUPLICATE_COPY,
  MOVE_COPY,
  confirmedAdvisor,
} from "@/lib/booking/booker-copy";
import { CANCEL_COPY, LIVE_COPY } from "@/lib/booking/manage-copy";
import { bookerSlotIso } from "@/components/booker-test-slot";

// 15:00 in the pinned zone two days out, never `setHours` on a machine Date (#2310).
const slotIso = bookerSlotIso(2, 15, "America/New_York");

const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};

const bookerProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

const linksAt = (tag: string) => ({
  google: `https://calendar.google.com/${tag}`,
  outlook: `https://outlook.live.com/${tag}`,
  office365: `https://outlook.office.com/${tag}`,
  ics: `https://slate.example/api/bookings/tok1/ics?${tag}`,
});

const pageText = () => document.body.textContent ?? "";
const calendarGroup = () => screen.queryByRole("group", { name: ADD_TO_CALENDAR_COPY.heading });

/** Drive the Booker to its confirm, answering the confirm with `confirm`. */
async function bookWith(confirm: () => Response) {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/availability")) {
      return { ok: true, json: async () => availability } as Response;
    }
    return confirm();
  }) as unknown as typeof fetch;
  render(<Booker {...bookerProps} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
  fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
  fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Dana" } });
  fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Lead" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
  fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));
}

const confirmed = (body: Record<string, unknown>) => () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ startsAt: slotIso, manageUrl: "https://slate.example/booking/manage/tok1", ...body }),
  }) as Response;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the Booker's confirmation (#2165)", () => {
  it("names the advisor and offers the call's own calendar links", async () => {
    await bookWith(confirmed({ advisorName: "Aisha Bello", calendarLinks: linksAt("new") }));
    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(confirmedAdvisor("Aisha Bello"));
    const group = calendarGroup();
    expect(group).toBeTruthy();
    expect(within(group!).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(
      Object.values(linksAt("new")),
    );
  });

  it("says who will call without a name when the booking holds none, never a placeholder", async () => {
    await bookWith(confirmed({ advisorName: null, calendarLinks: linksAt("new") }));
    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(confirmedAdvisor(null));
    expect(pageText()).not.toContain("null");
  });

  it("offers no calendar links when the server could not build them", async () => {
    await bookWith(confirmed({ advisorName: "Aisha Bello", calendarLinks: null }));
    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(calendarGroup()).toBeNull();
  });

  it("draws the links for THIS call, never the other booking a duplicate warning names", async () => {
    await bookWith(
      confirmed({
        advisorName: "Aisha Bello",
        calendarLinks: linksAt("new"),
        duplicateWarning: { disclose: false },
      }),
    );
    expect(await screen.findByText(DUPLICATE_COPY.heading)).toBeTruthy();
    // One group, and it is the new call's.
    expect(screen.getAllByRole("group", { name: ADD_TO_CALENDAR_COPY.heading })).toHaveLength(1);
    expect(within(calendarGroup()!).getAllByRole("link")[0].getAttribute("href")).toBe(linksAt("new").google);
  });

  it("names no advisor and offers no links for a weak match it will not disclose (#1340)", async () => {
    await bookWith(
      () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ existingCall: { disclose: false } }),
        }) as Response,
    );
    await act(async () => {});
    // Positive control first, in this same fixture: the declined panel is up.
    expect(await screen.findByText(/You already have a call booked/)).toBeTruthy();
    expect(calendarGroup()).toBeNull();
    expect(pageText()).not.toContain(confirmedAdvisor(null));
  });

  it("after moving a disclosed call, names its advisor and offers the links at the NEW time", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      if (u.includes("/reschedule")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ startsAt: slotIso, advisorName: "Sam Advisor", calendarLinks: linksAt("moved") }),
        } as Response;
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          existingCall: {
            disclose: true,
            startsAt: slotIso,
            advisorName: "Sam Advisor",
            manageToken: "tok-existing",
            phone: null,
            mayCancel: false,
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    render(<Booker {...bookerProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call/ }));

    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(confirmedAdvisor("Sam Advisor"));
    expect(within(calendarGroup()!).getAllByRole("link")[0].getAttribute("href")).toBe(linksAt("moved").google);
  });
});

describe("the manage page (#2165)", () => {
  const manageProps = {
    token: "tok1",
    bucketCode: "411",
    rescheduleTimesFrom: "pool" as const,
    startsAt: slotIso,
    status: "confirmed",
    eventName: "Debt consultation",
    rescheduleReasons: RESCHEDULE_REASONS,
    cancelReasons: CANCEL_REASONS,
    theme: "light" as const,
    durationMin: 20,
    attendeePhone: "(215) 555-0100",
    attendeeEmail: "dana@example.com",
    advisorName: "Aisha Bello",
    advisorRole: "Senior Loan Advisor",
    calendarLinks: linksAt("old"),
  };

  it("offers the booking's calendar links on a live call", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ slots: [] }) }) as Response) as unknown as typeof fetch;
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    expect(within(calendarGroup()!).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(
      Object.values(linksAt("old")),
    );
  });

  it("offers none on a cancelled call, nor when the server could not build them", async () => {
    const { unmount } = render(<ManageBooking {...manageProps} status="cancelled" />);
    await act(async () => {});
    expect(calendarGroup()).toBeNull();
    unmount();
    render(<ManageBooking {...manageProps} calendarLinks={null} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: LIVE_COPY.reschedule })).toBeTruthy();
    expect(calendarGroup()).toBeNull();
  });

  it("swaps to the moved call's links after a move made on this page", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/reschedule")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ startsAt: slotIso, calendarLinks: linksAt("moved") }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slots: [slotIso] }) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: LIVE_COPY.reschedule }));
    fireEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^(MON|TUE|WED|THU|FRI|SAT|SUN|TODAY)/ }))[0]);
    fireEvent.click((await screen.findAllByRole("button", { name: /^\d{1,2}:\d{2}/ }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
    await act(async () => {});

    expect(within(calendarGroup()!).getAllByRole("link")[0].getAttribute("href")).toBe(linksAt("moved").google);
  });

  it("drops a moved call's links when the move answer carries none, rather than keep the old time's", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/reschedule")) {
        return { ok: true, status: 200, json: async () => ({ startsAt: slotIso, calendarLinks: null }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slots: [slotIso] }) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    expect(calendarGroup()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: LIVE_COPY.reschedule }));
    fireEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^(MON|TUE|WED|THU|FRI|SAT|SUN|TODAY)/ }))[0]);
    fireEvent.click((await screen.findAllByRole("button", { name: /^\d{1,2}:\d{2}/ }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: LIVE_COPY.reschedule })).toBeTruthy();
    expect(calendarGroup()).toBeNull();
  });

  it("drops the links once the call is cancelled on this page", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/cancel")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ slots: [] }) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    expect(calendarGroup()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: LIVE_COPY.cancel }));
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_COPY.confirm }));
    await act(async () => {});
    expect(calendarGroup()).toBeNull();
  });
});
