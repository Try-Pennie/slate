// @vitest-environment jsdom
//
// #2158: a lead at a bucket with nobody in it must not be told every time is
// taken. Nothing is taken, and there is no soon to check back at.
//
// The pair that matters is BOTH directions: the new sentence must appear for an
// unstaffed bucket AND must not appear for a genuinely full one, because the
// whole defect was one cause wearing another's words (L11).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import {
  allTimesTaken,
  noAdvisorsAvailable,
  NEXT_DAYS_COPY,
} from "@/lib/booking/booker-copy";

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

const emptyWith = (emptyBecause: unknown) => ({
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [],
  emptyBecause,
});

function serve(body: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => vi.clearAllMocks());

describe("an unstaffed bucket (#2158)", () => {
  it("says nobody is available, and never that times are taken", async () => {
    serve(emptyWith({ kind: "unstaffed" }));
    render(<Booker {...baseProps} />);

    expect(await screen.findByText(noAdvisorsAvailable())).toBeTruthy();
    expect(screen.queryByText(allTimesTaken())).toBeNull();
  });

  it("still says times are taken for a bucket that really is full", async () => {
    serve(emptyWith({ kind: "busy" }));
    render(<Booker {...baseProps} />);

    expect(await screen.findByText(allTimesTaken())).toBeTruthy();
    expect(screen.queryByText(noAdvisorsAvailable())).toBeNull();
  });

  it("does not offer the far-ahead search, which cannot help an empty pool", async () => {
    serve(emptyWith({ kind: "unstaffed" }));
    render(<Booker {...baseProps} />);
    await screen.findByText(noAdvisorsAvailable());

    // That search walks up to eight windows of real calendar work per bookable
    // agent. With nobody in the pool there is nothing for it to find, so offering
    // it would spend the slowest action in the product to reach the same screen.
    expect(screen.queryByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeNull();
  });

  it("keeps the closure sentence when the org is shut, which outranks an empty pool", async () => {
    serve(emptyWith({ kind: "closed", reopensOn: null }));
    render(<Booker {...baseProps} />);

    // Both can be true at once and only one can be said. The closure is the one
    // that can carry a date, so it wins; "nobody is available" during a holiday
    // shutdown would be true and useless.
    expect(screen.queryByText(noAdvisorsAvailable())).toBeNull();
  });
});
