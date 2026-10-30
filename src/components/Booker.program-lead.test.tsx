// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import { NEXT_DAYS_COPY } from "@/lib/booking/booker-copy";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { PROGRAM_LEAD_HEADER, PROGRAM_LEAD_ZONE_PARAM } from "@/lib/booking/program-lead-header";

// #4390: the booker on a program lead's texted link sends its token on the times reads,
// the ordinary one and the look further ahead, as a header (never in the address) with
// the lead's zone in the address. Every other lead's reads are sent as they always were.

vi.mock("@/components/ConfirmationMarkPlayer", () => ({ ConfirmationMarkPlayer: () => null }));

const TOKEN = "00Q5f00000AbCdE.new.9999999999999.abc";
const slotIso = bookerSlotIso(3);
const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};
const props = {
  bucketCode: "411",
  salesforceId: "00Q5f00000AbCdEFGH",
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

/** Every read the booker sends, with its headers. */
function recordReads(answer: (url: string) => unknown) {
  const reads: { url: string; headers: Record<string, string> }[] = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    reads.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: true, status: 200, json: async () => answer(String(url)) } as Response;
  }) as unknown as typeof fetch;
  return reads;
}

beforeEach(() => vi.clearAllMocks());

describe("Booker for a program lead (#4390)", () => {
  it("sends the token as a header and the zone in the address on the times read", async () => {
    const reads = recordReads(() => availability);
    render(<Booker {...props} programLeadToken={TOKEN} />);
    await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
    const read = reads.find((r) => r.url.startsWith("/api/availability?"))!;
    expect(read.headers[PROGRAM_LEAD_HEADER]).toBe(TOKEN);
    expect(read.url).toContain(`${PROGRAM_LEAD_ZONE_PARAM}=`);
    expect(read.url).not.toContain(TOKEN);
  });

  it("sends an ordinary lead's times read exactly as before", async () => {
    const reads = recordReads(() => availability);
    render(<Booker {...props} />);
    await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
    const read = reads.find((r) => r.url.startsWith("/api/availability?"))!;
    expect(read.headers[PROGRAM_LEAD_HEADER]).toBeUndefined();
    expect(read.url).not.toContain(PROGRAM_LEAD_ZONE_PARAM);
  });

  it("sends the token on the look further ahead too", async () => {
    const reads = recordReads((url) =>
      url.includes("/api/availability/next")
        ? { slots: [] }
        : { ...availability, slots: [], emptyBecause: { kind: "closed", reopensOn: "2026-08-17" } },
    );
    render(<Booker {...props} programLeadToken={TOKEN} />);
    await userEvent.click(await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask }));
    const next = reads.find((r) => r.url.includes("/api/availability/next"))!;
    expect(next.headers[PROGRAM_LEAD_HEADER]).toBe(TOKEN);
    expect(next.url).toContain(`${PROGRAM_LEAD_ZONE_PARAM}=`);
    expect(next.url).not.toContain(TOKEN);
  });
});
