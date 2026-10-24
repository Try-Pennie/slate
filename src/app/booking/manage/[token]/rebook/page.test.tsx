// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// #2982: "Book a new time" opens the booker UNDER the manage path the lead is on,
// and the page resolves the booking by its token server side. These assertions
// are about the wiring: which identity the Booker is handed for each outcome of
// the lookup, and that a token naming nothing never draws another booking.

const service = vi.hoisted(() => ({
  rebookRowForToken: vi.fn(),
  getBookingByToken: vi.fn(),
  existingCallForLanding: vi.fn(async (_identity: unknown, _world: unknown) => null),
  landingAttendee: vi.fn(async (_identity: unknown, link: unknown) => link),
}));
vi.mock("@/lib/booking/service", () => service);
const routing = vi.hoisted(() => ({
  resolveLandingCode: vi.fn(async (code: string) => ({ code: code || "CATCHALL" })),
}));
vi.mock("@/lib/routing/landing-code", () => routing);
vi.mock("@/lib/booking/landing-bucket", () => ({ loadLandingBucketIsTest: vi.fn(async () => false) }));
vi.mock("@/lib/embed/test-pass-gate", () => ({ currentTestPassFor: vi.fn(() => null) }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 14) }));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: vi.fn(async () => ({ reschedule: { active: [] }, cancel: { active: [] } })),
}));
vi.mock("@/components/Booker", () => ({ default: () => null }));
vi.mock("@/components/ManageNotFound", () => ({ default: () => null }));
vi.mock("@/components/StandaloneTheme", () => ({ default: () => null }));
vi.mock("@/components/LegalFooter", () => ({ default: () => null }));
vi.mock("@/components/StandaloneBookerShell", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@/components/ClientErrorBeacon", () => ({ ClientErrorBeacon: () => null }));
// Next's redirect throws to end the render; this one throws a readable marker.
const redirect = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new Error(`REDIRECT ${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

import RebookPage, { metadata } from "./page";
import Booker from "@/components/Booker";
import ManageNotFound from "@/components/ManageNotFound";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { REBOOK_ROUTE } from "@/lib/booking/book-link";

const TOKEN = "tok_rebook_fixture_0001";
const ROW = {
  status: "cancelled",
  bucketCode: "100",
  leadId: "00QUi00000ABCdeMAH",
  attendeeName: "Dana Lead",
  attendeeEmail: "dana@example.com",
  attendeePhone: "+12155550100",
  source: "my-offers-result",
};

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

async function render(sp: Record<string, string> = { xbc: "100" }) {
  return RebookPage({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(sp) });
}

beforeEach(() => vi.clearAllMocks());

describe("/booking/manage/[token]/rebook (#2982)", () => {
  it("hands the Booker the booking's Lead id, details, source and bucket", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "found", row: ROW });
    const booker = findByType(await render(), Booker);

    expect(service.rebookRowForToken).toHaveBeenCalledWith(TOKEN);
    expect(booker).toMatchObject({
      bucketCode: "100",
      salesforceId: "00QUi00000ABCdeMAH",
      attendee: { name: "Dana Lead", email: "dana@example.com", phone: "+12155550100" },
      prefill: { source: "my-offers-result" },
    });
    // The lead is recognised by the same Lead id the confirm will send.
    expect(service.existingCallForLanding.mock.calls.at(-1)?.[0]).toEqual({ salesforceId: "00QUi00000ABCdeMAH" });
    // Routed by the resolver /book uses, on the booking's OWN bucket, not the query's.
    expect(routing.resolveLandingCode).toHaveBeenCalledWith("100", "00QUi00000ABCdeMAH", null);
  });

  it("uses the booking's bucket even when the link's xbc says otherwise", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "found", row: ROW });
    const booker = findByType(await render({ xbc: "999" }), Booker);
    expect(booker?.bucketCode).toBe("100");
  });

  it("draws the manage page's not found state for a token naming nothing, never a booker", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "absent" });
    const tree = await render();
    expect(findByType(tree, ManageNotFound)).not.toBeNull();
    expect(findByType(tree, Booker)).toBeNull();
    expect(service.landingAttendee).not.toHaveBeenCalled();
  });

  it("draws the link's bucket booker with NO prefill when the lookup fails", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "failed" });
    const booker = findByType(await render({ xbc: "100" }), Booker);
    expect(booker).toMatchObject({
      bucketCode: "100",
      salesforceId: null,
      attendee: { name: "", email: "", phone: "" },
      prefill: {},
      testPass: null,
    });
    expect(service.existingCallForLanding).not.toHaveBeenCalled();
  });

  it("draws the booker in the theme the manage page was in", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "found", row: ROW });
    expect(findByType(await render({ xbc: "100", theme: "dark" }), Booker)?.theme).toBe("dark");
    expect(findByType(await render({ xbc: "100" }), Booker)?.theme).toBe("light");
  });

  it("names itself to the error beacon by the same route its boundary uses", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "found", row: ROW });
    expect(findByType(await render(), ClientErrorBeacon)?.page).toBe(REBOOK_ROUTE);
    expect(REBOOK_ROUTE).toBe("/booking/manage/[token]/rebook");
  });

  // #3672: the booking API moved the call to another bucket, which cancelled the
  // booking this token names. A rebook from it would book the lead a SECOND call in
  // the old bucket, so the old token opens the call that replaced it instead.
  it("opens the manage page of the booking that replaced a moved one", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "replaced" });
    service.getBookingByToken.mockResolvedValue({
      booking: { id: "bk-new", status: "confirmed", manage_token: "tok-new" },
      bucket: { code: "200" },
      eventType: {},
      followedToToken: "tok-new",
    });
    await expect(render({ xbc: "100", theme: "dark" })).rejects.toThrow("REDIRECT /booking/manage/tok-new?theme=dark");
    expect(service.getBookingByToken).toHaveBeenCalledWith(TOKEN);
    expect(service.landingAttendee).not.toHaveBeenCalled();
  });

  it("draws not found when the replacing booking cannot be opened, never a booker", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "replaced" });
    service.getBookingByToken.mockResolvedValue(null);
    const tree = await render();
    expect(findByType(tree, ManageNotFound)).not.toBeNull();
    expect(findByType(tree, Booker)).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("CONTROL: a booking cancelled any other way still rebooks, with no detour", async () => {
    service.rebookRowForToken.mockResolvedValue({ kind: "found", row: ROW });
    expect(findByType(await render(), Booker)).not.toBeNull();
    expect(service.getBookingByToken).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("keeps the page out of search and its URL out of every Referer but its own", () => {
    expect(metadata.referrer).toBe("same-origin");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
