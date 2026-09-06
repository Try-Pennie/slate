// @vitest-environment jsdom
/**
 * The erasure purge worklist screen (#1124).
 *
 * A static scan cannot mount React, so this is where the claims that matter get
 * proved on a real DOM:
 *
 *   - an unreadable trail renders the UNREADABLE screen, never an empty list. The
 *     two are one keystroke apart in the code and read as opposites to a person.
 *   - an unmeasured residual renders as unknown, never as clean.
 *   - a failed purge, and a purge we stopped waiting for, each surface as their
 *     own state and leave the control usable again. A time taking action must show
 *     started, still alive, and failed as visibly distinct things.
 *   - each control says its own SCOPE before it runs, and sends the request that
 *     matches what it said.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// No router and no http mock: with the controls gone this component posts
// nothing and navigates nowhere, and a mock for a call it can no longer make
// would be a fixture defending a removed behaviour (L252).

import { ErasureWorklist } from "./ErasureWorklist";
import { emptyTrailText } from "@/lib/snowflake/erasure-worklist-copy";
import type { ErasureWorklistState } from "@/lib/snowflake/erasure-worklist";

/** #1961: the ages on this page are measured from an instant the SERVER takes
 *  and passes in, so the tests pin it rather than reading a clock. Fifteen days
 *  after the fixture entry's erasure. */
const NOW = Date.parse("2026-09-04T09:00:00+00:00");

const entry = (over: Record<string, unknown> = {}) => ({
  auditId: "a1",
  createdAt: "2026-08-20T09:00:00+00:00",
  emailSha256: "bf887269aa11223344556677889900aabbccddeeff00112233445566778899aa",
  bookingIds: ["bk1", "bk2"],
  residuals: [{ table: "bookings", residual: 0 }],
  unmeasuredReason: null,
  ...over,
});

const ready = (over: Partial<Extract<ErasureWorklistState, { kind: "ready" }>> = {}) =>
  ({
    kind: "ready",
    nowMs: NOW,
    entries: [entry()],
    trail: { entryCount: 1, bookingCount: 2, otherOrgBookingCount: 0 },
    warehouse: { kind: "measured" },
    ...over,
  }) as ErasureWorklistState;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ErasureWorklist: reading the state", () => {
  it("renders the unreadable screen, not an empty list, when the trail read failed", () => {
    render(<ErasureWorklist state={{ kind: "trail-unreadable", reason: "permission denied" }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read/i);
    expect(screen.getByRole("alert").textContent).toMatch(/permission denied/);
    // The reassuring screen must be absent, not merely different.
    expect(screen.queryByText(emptyTrailText())).toBeNull();
    // And nothing destructive is offered off a state we could not read.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the empty trail as its own measured sentence", () => {
    render(
      <ErasureWorklist
        state={ready({ entries: [], trail: { entryCount: 0, bookingCount: 0, otherOrgBookingCount: 0 } })}
      />,
    );
    expect(screen.getByText(emptyTrailText())).toBeTruthy();
  });

  it("shows an unmeasured residual as unknown, never as clean", () => {
    render(
      <ErasureWorklist
        state={ready({
          warehouse: { kind: "unreadable", reason: "Snowflake returned 503" },
          entries: [entry({ residuals: null, unmeasuredReason: "Snowflake returned 503" })],
        })}
      />,
    );
    expect(screen.getByText(/Not measured/)).toBeTruthy();
    expect(screen.queryByText(/Clean in the warehouse/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/503/);
  });

  it("says an unconfigured mirror is a different thing from an unreadable one", () => {
    render(<ErasureWorklist state={ready({ warehouse: { kind: "unconfigured" } })} />);
    expect(screen.getByRole("alert").textContent).toMatch(/not configured/i);
  });

  it("names the erasure by its hash, and never renders a cleartext address", () => {
    render(<ErasureWorklist state={ready()} />);
    expect(screen.getByText(/bf887269/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/@/);
  });
});

// #1961: THE CONTROLS ARE GONE, and this is the guard on that.
//
// Dan, 2026-09-04: "feels like it shouldn't be this easy to purge data and I
// think I'd prefer to go through Claude to do it." Both controls went on his
// decision of 2026-09-06, the single and the bulk.
//
// The tests that used to live here drove those controls: the confirmation, the
// scope per button, the three progress states, the timeout. They were deleted
// rather than adjusted, because their whole content was the behaviour being
// removed and a test that defends a reversed decision is the guard keeping it
// alive (L252). What replaces them asserts the ABSENCE, which is the thing that
// can regress: a purge button is an easy thing to add back.
describe("ErasureWorklist: nothing here purges (#1961)", () => {
  it("offers no control at all, on a trail with an outstanding purge", () => {
    render(
      <ErasureWorklist
        state={ready({ entries: [entry({ residuals: [{ table: "bookings", residual: 4 }] })] })}
      />,
    );
    // The row still SAYS it is outstanding: what went is the button, not the fact.
    expect(screen.getByText(/4 rows/i)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // Not just "no button": nothing clickable of any kind, which is what a
    // link or an anchor styled as one would slip back in as.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("posts nothing, because it renders no form", () => {
    const { container } = render(
      <ErasureWorklist
        state={ready({ entries: [entry({ residuals: [{ table: "bookings", residual: 4 }] })] })}
      />,
    );
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  // A SCREEN THAT NAMES A FAULT AND OFFERS NO REMEDY teaches its reader to skim
  // it (L126, L148), so the absence of a button is explained rather than left as
  // a gap where one used to be.
  it("says how an outstanding purge is run instead", () => {
    render(<ErasureWorklist state={ready()} />);
    expect(screen.getByText(/no button for this, deliberately/i)).toBeTruthy();
    expect(screen.getByText(/naming who asked for the erasure/i)).toBeTruthy();
    expect(screen.getByText(/pii-erasure-runbook/i)).toBeTruthy();
  });
});
