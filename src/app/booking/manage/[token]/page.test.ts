import { describe, it, expect, vi, beforeEach } from "vitest";

// #1338: the manage page names the advisor the call is with. The booking row
// ALSO carries `agent_name`, stamped when the booking was made, and reading that
// instead of the live assignee is a one-line mistake nobody would catch in
// review: coverage reassignment (#1219) and bulk reassign both move a booking, so
// the stamped name would promise a lead one person and send another (L75).
//
// These assertions are about the WIRING, which no component test can see: which
// id the lookup is asked for, and that the name handed to the page is the
// resolved one rather than the stamped column.

const service = vi.hoisted(() => ({
  getBookingByToken: vi.fn(),
  getBookingAdvisorName: vi.fn(async () => null as string | null),
  getBookingAdvisorPhoto: vi.fn(async () => null as string | null),
  getBookingCallingNumber: vi.fn(async (_booking: unknown) => null as string | null),
  bookingDetailExtras: vi.fn((_booking: unknown) => ({
    contact: { name: "Dana", email: "dana@example.com", phone: "+12155550100" },
    calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" } as Record<string, string> | null,
  })),
}));
const loadReasonOptions = vi.hoisted(() =>
  vi.fn(async () => ({
    reschedule: { active: [{ code: "schedule_conflict", label: "Schedule conflict" }] },
    cancel: { active: [{ code: "booked_by_mistake", label: "Booked by mistake" }] },
  })),
);

vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/reason-options", () => ({ loadReasonOptions }));
// Next's redirect throws to end the render; this one throws a readable marker.
const redirect = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new Error(`REDIRECT ${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

import ManagePage from "./page";

const found = {
  booking: {
    id: "bk1",
    starts_at: "2026-08-17T14:00:00.000Z",
    status: "confirmed",
    assigned_user_id: "user-current",
    // The stamped copy, deliberately different from the live one below.
    agent_name: "Stale Stamped Agent",
    attendee_phone: "+12155550100",
    attendee_email: "dana@example.com",
  },
  bucket: { code: "411" },
  eventType: { name: "Senior Loan Advisor Call", duration_min: 20 },
};

/** Walk the returned tree for the ManageBooking element's props. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findManageProps(node: any): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findManageProps(child);
      if (hit) return hit;
    }
    return null;
  }
  if (node.props && typeof node.props.advisorName !== "undefined") return node.props;
  return findManageProps(node.props?.children ?? null);
}

async function renderPage(sp: Record<string, string> = {}) {
  const tree = await ManagePage({
    params: Promise.resolve({ token: "tok1" }),
    searchParams: Promise.resolve(sp),
  });
  return findManageProps(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  service.getBookingByToken.mockResolvedValue(found);
  service.getBookingAdvisorName.mockResolvedValue("Aisha Bello");
});

describe("manage page advisor wiring (#1338)", () => {
  it("resolves the advisor from the booking's CURRENT assignee", async () => {
    await renderPage();
    expect(service.getBookingAdvisorName).toHaveBeenCalledWith("user-current");
    // #2600: the face and the name must come from the SAME assignee, or a
    // reassigned booking shows one advisor's photo above another's name.
    expect(service.getBookingAdvisorPhoto).toHaveBeenCalledWith("user-current");
  });

  it("hands the page the live name, never the name stamped on the booking", async () => {
    const props = await renderPage();
    expect(props?.advisorName).toBe("Aisha Bello");
    expect(props?.advisorName).not.toBe("Stale Stamped Agent");
    // The role line is lead-facing copy, so it must be present to render.
    expect(props?.advisorRole).toBe("Senior Loan Advisor");
  });

  it("passes no name through when the advisor cannot be resolved", async () => {
    service.getBookingAdvisorName.mockResolvedValue(null);
    const props = await renderPage();
    // Null, not the stamped fallback: no name at all is the fail-safe.
    expect(props?.advisorName).toBeNull();
  });

  it("asks for no advisor at all when the booking has no assignee", async () => {
    service.getBookingByToken.mockResolvedValue({
      ...found,
      booking: { ...found.booking, assigned_user_id: null },
    });
    const props = await renderPage();
    expect(service.getBookingAdvisorName).toHaveBeenCalledWith(null);
    expect(service.getBookingAdvisorPhoto).toHaveBeenCalledWith(null);
    expect(props?.advisorName).toBe("Aisha Bello");
  });

  it("carries the duration and the lead's own contact details through", async () => {
    const props = await renderPage();
    expect(props?.durationMin).toBe(20);
    expect(props?.attendeePhone).toBe("+12155550100");
    expect(props?.attendeeEmail).toBe("dana@example.com");
  });

  // #2982: "Book a new time" opens the rebook booker under THIS page's own path,
  // which resolves the Lead id, details and source server side. No contact data
  // may ride on the URL, and the token must not reach the public /book page.
  it("hands the page a rebook link naming the booking by token and carrying no contact data", async () => {
    service.getBookingByToken.mockResolvedValue({
      ...found,
      booking: {
        ...found.booking,
        status: "cancelled",
        salesforce_id: "00QUi00000ABCdeMAH",
        attendee_name: "Dana Lead",
        source: "my-offers-result",
      },
    });
    const props = await renderPage();
    const href = String(props?.rebookHref);
    const url = new URL(href, "https://slate.example");
    expect(url.pathname).toBe("/booking/manage/tok1/rebook");
    expect([...url.searchParams.keys()]).toEqual(["xbc"]);
    expect(url.searchParams.get("xbc")).toBe("411");
    for (const secret of ["00QUi00000ABCdeMAH", "Dana", "dana", "5550100"]) {
      expect(href).not.toContain(secret);
    }
  });

  it("carries a dark manage page's theme onto the rebook booker", async () => {
    const dark = new URL(String((await renderPage({ theme: "dark" }))?.rebookHref), "https://slate.example");
    expect(dark.searchParams.get("theme")).toBe("dark");
    const light = new URL(String((await renderPage())?.rebookHref), "https://slate.example");
    expect(light.searchParams.has("theme")).toBe(false);
  });

  // #2165: the add to calendar links come from the one builder the confirm and the
  // booking lookup use, built from THIS booking, never a second copy on the page.
  it("hands the page the booking's calendar links from the shared builder", async () => {
    const props = await renderPage();
    expect(service.bookingDetailExtras.mock.calls.at(-1)?.[0]).toMatchObject({ id: "bk1" });
    expect(props?.calendarLinks).toEqual({ google: "g", outlook: "o", office365: "m", ics: "i" });
  });

  it("passes null through when the builder has no links for this booking", async () => {
    service.bookingDetailExtras.mockReturnValueOnce({
      contact: { name: "Dana", email: "dana@example.com", phone: "+12155550100" },
      calendarLinks: null,
    });
    const props = await renderPage();
    expect(props?.calendarLinks).toBeNull();
  });

  // #2827: the move picker's times follow the booking's kind, decided here from
  // the row rather than left for the component to guess.
  it("an advisor link booking's picker reads that advisor's times, a routed one its pool", async () => {
    service.getBookingByToken.mockResolvedValue({ ...found, booking: { ...found.booking, kind: "agent_link" } });
    expect((await renderPage())?.rescheduleTimesFrom).toBe("advisor");
    service.getBookingByToken.mockResolvedValue({ ...found, booking: { ...found.booking, kind: "routed" } });
    expect((await renderPage())?.rescheduleTimesFrom).toBe("pool");
  });

  it("does not look up an advisor for a token that resolves to nothing", async () => {
    service.getBookingByToken.mockResolvedValue(null);
    await renderPage();
    expect(service.getBookingAdvisorName).not.toHaveBeenCalled();
    expect(service.getBookingAdvisorPhoto).not.toHaveBeenCalled();
    expect(service.getBookingCallingNumber).not.toHaveBeenCalled();
  });

  // #1334: the number the call will come FROM, read for THIS booking's lead.
  it("hands the page the calling number read for this booking", async () => {
    service.getBookingCallingNumber.mockResolvedValueOnce("+12197588170");
    const props = await renderPage();
    expect(service.getBookingCallingNumber.mock.calls.at(-1)?.[0]).toMatchObject({ id: "bk1" });
    expect(props?.callingNumber).toBe("+12197588170");
  });

  it("passes null through when no calling number is known", async () => {
    const props = await renderPage();
    expect(props?.callingNumber).toBeNull();
  });

  // A cancelled or completed call has no call left to screen, so nothing is read.
  it("does not read a calling number for a call that is over", async () => {
    service.getBookingByToken.mockResolvedValue({ ...found, booking: { ...found.booking, status: "cancelled" } });
    const props = await renderPage();
    expect(service.getBookingCallingNumber).not.toHaveBeenCalled();
    expect(props?.callingNumber).toBeNull();
  });
});

// #3672: the booking API moved the call to another bucket, which cancelled the booking
// this token names and made a new one under a new token. Every link the lead already
// holds (the text Regal sent, the calendar invite) carries the OLD token, and it used
// to open "This booking is cancelled" while they still had a call.
describe("an old token for a booking the API moved (#3672)", () => {
  const moved = {
    ...found,
    booking: { ...found.booking, id: "bk-new", manage_token: "tok-new", status: "confirmed" },
    followedToToken: "tok-new",
  };

  it("opens the manage page of the booking that replaced it", async () => {
    service.getBookingByToken.mockResolvedValue(moved);
    await expect(renderPage()).rejects.toThrow("REDIRECT /booking/manage/tok-new");
    // Nothing about either booking is read or drawn on the way.
    expect(service.getBookingAdvisorName).not.toHaveBeenCalled();
  });

  it("keeps a dark page dark on the way", async () => {
    service.getBookingByToken.mockResolvedValue(moved);
    await expect(renderPage({ theme: "dark" })).rejects.toThrow("REDIRECT /booking/manage/tok-new?theme=dark");
  });

  it("CONTROL: a booking cancelled any other way still opens as itself, cancelled", async () => {
    service.getBookingByToken.mockResolvedValue({ ...found, booking: { ...found.booking, status: "cancelled" } });
    const props = await renderPage();
    expect(redirect).not.toHaveBeenCalled();
    expect(props?.status).toBe("cancelled");
    expect(props?.token).toBe("tok1");
  });
});
