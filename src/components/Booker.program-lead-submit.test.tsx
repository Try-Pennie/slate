// @vitest-environment jsdom
// #4391: the booker's two submit paths for a program lead: the confirm carries the
// program lead token, the Move panel carries the move token of the call it moves, and a
// full day is answered with its own sentence and a reloaded picker, never "just taken".
// Only the submit and move paths are pinned here; the times a program lead sees are #4390's.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import { BOOKING_ERROR_COPY, MOVE_COPY } from "@/lib/booking/booker-copy";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { PROGRAM_LEAD_HEADER } from "@/lib/booking/program-lead-header";

vi.mock("@/components/ConfirmationMarkPlayer", () => ({ ConfirmationMarkPlayer: () => null }));

const slotIso = bookerSlotIso(3);
const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};
const baseProps = {
  bucketCode: "411",
  salesforceId: "00Q000000000001",
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};
const FULL = { error: BOOKING_ERROR_COPY.placeholderDayFull, code: "PLACEHOLDER_DAY_FULL" };

const dayChip = () => screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });

async function pickFirstTime() {
  await userEvent.click(await dayChip());
  await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
}

async function fillDetails() {
  await pickFirstTime();
  await userEvent.type(screen.getByLabelText("First name"), "Dana");
  await userEvent.type(screen.getByLabelText("Last name"), "Lead");
  await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
  await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
}

async function fillAndConfirm() {
  await fillDetails();
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
}

/** A fetch that serves the times and answers each POST from `answer`, recording both. */
function serve(answer: (url: string) => { ok: boolean; status: number; body: unknown }) {
  const reads: string[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/availability")) {
      reads.push(u);
      return { ok: true, json: async () => availability } as Response;
    }
    posts.push({ url: u, body: JSON.parse(String(init?.body)) });
    const a = answer(u);
    return { ok: a.ok, status: a.status, json: async () => a.body } as Response;
  }) as unknown as typeof fetch;
  return { reads, posts };
}

beforeEach(() => vi.clearAllMocks());

describe("Booker for a program lead (#4391)", () => {
  it("sends the program lead token with the confirm", async () => {
    const { posts } = serve(() => ({ ok: true, status: 200, body: { startsAt: slotIso } }));
    render(<Booker {...baseProps} programLeadToken="tok-program" />);
    await fillAndConfirm();
    expect(await screen.findByText("You're all set")).toBeTruthy();
    expect(posts[0]!.url).toBe("/booking");
    expect(posts[0]!.body.programLeadToken).toBe("tok-program");
  });

  it("sends no token for every other lead", async () => {
    const { posts } = serve(() => ({ ok: true, status: 200, body: { startsAt: slotIso } }));
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You're all set");
    expect("programLeadToken" in posts[0]!.body).toBe(false);
  });

  it("answers a full day with its own sentence and reloads the times", async () => {
    const { reads } = serve(() => ({ ok: false, status: 409, body: FULL }));
    render(<Booker {...baseProps} programLeadToken="tok-program" />);
    await fillDetails();
    const before = reads.length;
    await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
    expect(await screen.findByText(BOOKING_ERROR_COPY.placeholderDayFull)).toBeTruthy();
    expect(screen.queryByText(BOOKING_ERROR_COPY.slotTaken)).toBeNull();
    // The picker reloads, so the day's extra times that filled up are gone from it.
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(before));
  });

  describe("the Move panel for the call they already have", () => {
    const existingIso = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    const landingCall = (programLeadMoveToken: string | null) => ({
      disclose: true as const,
      startsAt: existingIso,
      advisorName: null,
      manageToken: "tok-old",
      rescheduleTimesFrom: "pool" as const,
      mayCancel: true,
      phone: null,
      programLeadMoveToken,
    });

    async function moveIt() {
      await screen.findByText("You already have a call booked");
      fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
      await pickFirstTime();
      await screen.findByText(MOVE_COPY.reasonLegend);
      fireEvent.click(screen.getAllByRole("radio")[0]!);
      fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));
    }

    it("sends the call's own move token with the move", async () => {
      const { posts } = serve(() => ({ ok: true, status: 200, body: { startsAt: slotIso } }));
      render(<Booker {...baseProps} landingCall={landingCall("tok-move")} />);
      await moveIt();
      await screen.findByText("You're all set");
      expect(posts[0]!.url).toBe("/api/bookings/tok-old/reschedule");
      expect(posts[0]!.body.programLeadMoveToken).toBe("tok-move");
    });

    // The times for moving THIS call are the ones its move may take: read with the call's
    // own move token, never the page's new booking token, which the move route refuses.
    it.each([
      ["a program lead's call reads its times with that call's move token", "tok-move", "tok-move"],
      ["a call that is not a program lead's reads real times only", null, undefined],
    ])("%s", async (_label, moveToken, expected) => {
      const reads: Record<string, string>[] = [];
      global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/api/availability")) reads.push((init?.headers ?? {}) as Record<string, string>);
        return { ok: true, status: 200, json: async () => availability } as Response;
      }) as unknown as typeof fetch;
      render(<Booker {...baseProps} programLeadToken="tok-program" landingCall={landingCall(moveToken)} />);
      await screen.findByText("You already have a call booked");
      fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
      await dayChip();
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.at(-1)![PROGRAM_LEAD_HEADER]).toBe(expected);
      expect(reads.every((h) => h[PROGRAM_LEAD_HEADER] !== "tok-program")).toBe(true);
    });

    it("sends none for a call that is not a program lead's", async () => {
      const { posts } = serve(() => ({ ok: true, status: 200, body: { startsAt: slotIso } }));
      render(<Booker {...baseProps} landingCall={landingCall(null)} />);
      await moveIt();
      await screen.findByText("You're all set");
      expect("programLeadMoveToken" in posts[0]!.body).toBe(false);
    });

    it("answers a full day on a move with its own sentence, never just taken", async () => {
      serve(() => ({ ok: false, status: 409, body: { ...FULL, reason: "reschedule_placeholder_day_full" } }));
      render(<Booker {...baseProps} landingCall={landingCall("tok-move")} />);
      await moveIt();
      expect(await screen.findByText(BOOKING_ERROR_COPY.placeholderDayFull)).toBeTruthy();
      expect(screen.queryByText(BOOKING_ERROR_COPY.slotTaken)).toBeNull();
    });
  });
});
