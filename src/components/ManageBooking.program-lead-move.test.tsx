// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The zone is pinned, never inherited from the machine (L504), as in ManageBooking.test.tsx.
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import { BOOKING_ERROR_COPY, NEAREST_TIMES_COPY } from "@/lib/booking/booker-copy";

// #4391: the manage page's move of a program lead's call sends the call's move token, and a
// full day is answered with its own sentence and a reloaded picker, never an alternatives
// panel about a time somebody took. The times this page reads are #4390's.

// An opaque fixture: this component only forwards the token, it never reads it.
const MOVE_TOKEN = "program-lead-move-token-fixture";
const SLOT = "2026-06-21T15:00:00.000Z";
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

/** Serves one slot and answers the move from `move`, recording the reads and the move's body. */
function serve(move: { ok: boolean; status: number; body: unknown }) {
  const reads: string[] = [];
  const moves: Record<string, unknown>[] = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/reschedule")) {
      moves.push(JSON.parse(String(init?.body)));
      return { ok: move.ok, status: move.status, json: async () => move.body } as Response;
    }
    reads.push(u);
    return { ok: true, status: 200, json: async () => ({ slots: [SLOT] }) } as Response;
  }) as unknown as typeof fetch;
  return { reads, moves };
}

async function pickAndMove() {
  await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
  await userEvent.click((await screen.findAllByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }))[0]!);
  await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
  await userEvent.click(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));
  await userEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
}

beforeEach(() => vi.clearAllMocks());

describe("ManageBooking moving a program lead's call (#4391)", () => {
  it("sends the call's move token with the move", async () => {
    const { moves } = serve({ ok: true, status: 200, body: { startsAt: SLOT } });
    render(<ManageBooking {...props} programLeadMoveToken={MOVE_TOKEN} />);
    await pickAndMove();
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]!.programLeadMoveToken).toBe(MOVE_TOKEN);
  });

  it("sends none for every other call", async () => {
    const { moves } = serve({ ok: true, status: 200, body: { startsAt: SLOT } });
    render(<ManageBooking {...props} />);
    await pickAndMove();
    await waitFor(() => expect(moves).toHaveLength(1));
    expect("programLeadMoveToken" in moves[0]!).toBe(false);
  });

  it("answers a full day with its own sentence and reloads the times, with no alternatives panel", async () => {
    const { reads } = serve({
      ok: false,
      status: 409,
      body: { error: BOOKING_ERROR_COPY.placeholderDayFull, reason: "reschedule_placeholder_day_full", code: "PLACEHOLDER_DAY_FULL" },
    });
    render(<ManageBooking {...props} programLeadMoveToken={MOVE_TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click((await screen.findAllByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }))[0]!);
    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));
    const before = reads.length;
    await userEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
    expect(await screen.findByText(BOOKING_ERROR_COPY.placeholderDayFull)).toBeTruthy();
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
    expect(screen.queryByText(NEAREST_TIMES_COPY.heading)).toBeNull();
  });
});
