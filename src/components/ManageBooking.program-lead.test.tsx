// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The zone is pinned, never inherited from the machine (L504), as in ManageBooking.test.tsx.
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import { PROGRAM_LEAD_HEADER } from "@/lib/booking/program-lead-header";

// #4390: a program lead's booking reads its move times with its move token, as a header
// (never in the address), with the lead's zone in the address, so the placeholder's
// starts are offered beside the pool's. Every other booking's read is unchanged.

// An opaque fixture: this component only forwards the token, it never reads it.
const MOVE_TOKEN = "program-lead-move-token-fixture";
const props = {
  token: "tok1",
  bucketCode: "411",
  rebookHref: "/booking/manage/tok1/rebook?xbc=411",
  rescheduleTimesFrom: "pool" as const,
  startsAt: "2026-06-20T15:00:00.000Z",
  status: "confirmed",
  eventName: "Senior Loan Advisor Call",
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  theme: "light" as const,
  durationMin: 20,
  attendeePhone: "(215) 555-0100",
  attendeeEmail: "dana@example.com",
  callingNumber: null as string | null,
  advisorName: "Aisha Bello",
  advisorRole: "Senior Loan Advisor",
};

function recordReads() {
  const reads: { url: string; headers: Record<string, string> }[] = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    reads.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: true, status: 200, json: async () => ({ slots: [] }) } as Response;
  }) as unknown as typeof fetch;
  return reads;
}

async function openReschedule() {
  await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
}

beforeEach(() => vi.clearAllMocks());

describe("ManageBooking for a program lead's booking (#4390)", () => {
  it("reads the move times with the move token in a header and the zone in the address", async () => {
    const reads = recordReads();
    render(<ManageBooking {...props} programLeadMoveToken={MOVE_TOKEN} />);
    await openReschedule();
    const read = reads.find((r) => r.url.includes("/api/availability"))!;
    expect(read.url).toBe("/api/availability?bucket=411&leadZone=America%2FNew_York");
    expect(read.headers[PROGRAM_LEAD_HEADER]).toBe(MOVE_TOKEN);
  });

  it("reads every other booking's move times exactly as before", async () => {
    const reads = recordReads();
    render(<ManageBooking {...props} />);
    await openReschedule();
    const read = reads.find((r) => r.url.includes("/api/availability"))!;
    expect(read.url).toBe("/api/availability?bucket=411");
    expect(read.headers[PROGRAM_LEAD_HEADER]).toBeUndefined();
  });

  it("sends no token on an advisor's own times, which have no placeholder to add", async () => {
    const reads = recordReads();
    render(<ManageBooking {...props} rescheduleTimesFrom="advisor" programLeadMoveToken={MOVE_TOKEN} />);
    await openReschedule();
    const read = reads.find((r) => r.url.includes("/api/availability"))!;
    expect(read.url).toBe("/api/availability?booking=tok1");
    expect(read.headers[PROGRAM_LEAD_HEADER]).toBeUndefined();
  });
});
