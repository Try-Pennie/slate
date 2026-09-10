// @vitest-environment jsdom
//
// #2155: the wiring half. The guard is pinned in scripts/test-next-days-reply.ts;
// this asks whether a lead actually SEES the difference, which that one cannot.
//
// The screen under test is the last thing offered to somebody who has found
// nothing nearby, so the failure that matters is a 200 carrying something
// unreadable being drawn as "we looked and there are no times".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { NEXT_DAYS_COPY } from "@/lib/booking/booker-copy";

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

/** A bucket that is CLOSED, which is the only state that offers the search. */
const closedAvailability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [],
  // The server's own classification, which is what puts the booker into the
  // closure state that offers the search at all (#1414).
  emptyBecause: { kind: "closed", reopensOn: null },
};

/** Answer the availability read normally and the next-days read with `next`. */
function fetchWith(next: { ok: boolean; body?: unknown }) {
  return vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/availability/next")) {
      if (!next.ok) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => next.body } as Response;
    }
    return { ok: true, status: 200, json: async () => closedAvailability } as Response;
  }) as unknown as typeof fetch;
}

async function search() {
  const button = await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask });
  await userEvent.click(button);
}

beforeEach(() => vi.clearAllMocks());

describe("next available days, a reply that cannot be read (#2155)", () => {
  for (const [name, body] of [
    ["slots is null", { slots: null }],
    ["slots is missing", {}],
    ["an error page answered 200", { error: "Bad gateway" }],
    ["slots holds something that is not a string", { slots: [1759323600000] }],
  ] as const) {
    it(`says it could not look, not that there is nothing, when ${name}`, async () => {
      global.fetch = fetchWith({ ok: true, body });
      render(<Booker {...baseProps} />);
      await search();

      // The thing this exists to prevent: a lead being told, confidently, that
      // there is no day to offer, off a reply nobody could read.
      expect(screen.queryByText(NEXT_DAYS_COPY.foundNothing)).toBeNull();
      expect(await screen.findByText(NEXT_DAYS_COPY.unreadable)).toBeTruthy();
    });
  }

  it("keeps 'we looked and found nothing' for a reply that really is empty", async () => {
    global.fetch = fetchWith({ ok: true, body: { slots: [] } });
    render(<Booker {...baseProps} />);
    await search();

    expect(await screen.findByText(NEXT_DAYS_COPY.foundNothing)).toBeTruthy();
    expect(screen.queryByText(NEXT_DAYS_COPY.unreadable)).toBeNull();
    expect(screen.queryByText(NEXT_DAYS_COPY.failed)).toBeNull();
  });

  it("tells a lead who could not be reached something different from one whose reply was unreadable", async () => {
    global.fetch = fetchWith({ ok: false });
    render(<Booker {...baseProps} />);
    await search();

    // Two causes, two messages. Retrying can fix one and can never fix the other,
    // so telling somebody to check their connection about a malformed payload
    // sends them to do a thing that cannot work (L11).
    expect(await screen.findByText(NEXT_DAYS_COPY.failed)).toBeTruthy();
    expect(screen.queryByText(NEXT_DAYS_COPY.unreadable)).toBeNull();
    expect(NEXT_DAYS_COPY.failed).not.toBe(NEXT_DAYS_COPY.unreadable);
  });
});
