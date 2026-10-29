// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { useSlotPicker } from "@/components/use-slot-picker";

// #1336: the one hook owning the fetch, the race guard, the grouping in the
// viewer's zone, the chosen day and the loading / failed / empty states. The
// four surfaces used to own a copy each.

const ZONE = "America/New_York";

/** A harness that prints the hook's decisions so they can be asserted as text. */
function Harness({
  url,
  slotsOverride = null,
  zone = ZONE,
}: {
  url: string | null;
  slotsOverride?: string[] | null;
  /** The lead's zone, used as both the viewer's and the lead's, as on the booker. */
  zone?: string;
}) {
  const picker = useSlotPicker({ url, zone, leadZone: zone, slotsOverride });
  return (
    <div>
      <p data-testid="kind">{picker.view.kind}</p>
      <p data-testid="days">{picker.days.join(",")}</p>
      <p data-testid="slots">
        {picker.view.kind === "times" ? picker.view.slots.join(",") : ""}
      </p>
      <p data-testid="org">
        {(picker.payload as { orgName?: string } | null)?.orgName ?? ""}
      </p>
      {picker.days.map((d) => (
        <button key={d} type="button" onClick={() => picker.selectDay(d)}>
          {d}
        </button>
      ))}
      <button type="button" onClick={picker.retry}>
        retry
      </button>
    </div>
  );
}

// Aug 14 09:00 and 14:00 New York, then Aug 15 09:00.
const SLOTS = [
  "2026-08-14T13:00:00.000Z",
  "2026-08-14T18:00:00.000Z",
  "2026-08-15T13:00:00.000Z",
];

const okResponse = (slots: string[]) =>
  ({
    ok: true,
    json: async () => ({ orgName: "Pennie", slots }),
  }) as Response;

beforeEach(() => vi.clearAllMocks());

describe("useSlotPicker", () => {
  it("offers the days but no times until a day is chosen, then that day's times", async () => {
    global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;

    render(<Harness url="/api/availability?bucket=411" />);
    await act(async () => {});

    expect(screen.getByTestId("days").textContent).toBe("2026-08-14,2026-08-15");
    // The rule: days are ready, and still nothing to press a time on.
    expect(screen.getByTestId("kind").textContent).toBe("pick-a-day");
    expect(screen.getByTestId("slots").textContent).toBe("");

    await act(async () => {
      screen.getByRole("button", { name: "2026-08-14" }).click();
    });
    expect(screen.getByTestId("kind").textContent).toBe("times");
    expect(screen.getByTestId("slots").textContent).toBe(
      "2026-08-14T13:00:00.000Z,2026-08-14T18:00:00.000Z",
    );
  });

  it("reports a failed load as failed, never as an empty week", async () => {
    global.fetch = vi.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch;

    render(<Harness url="/api/availability?bucket=411" />);
    await act(async () => {});

    // An error state and an empty state are different screens: a lead reading
    // "nothing is bookable" over a broken fetch gives up and never comes back.
    expect(screen.getByTestId("kind").textContent).toBe("failed");
  });

  it("shows loading again on a retry rather than the stale failure", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false } as Response;
      return okResponse(SLOTS);
    }) as unknown as typeof fetch;

    render(<Harness url="/api/availability?bucket=411" />);
    await act(async () => {});
    expect(screen.getByTestId("kind").textContent).toBe("failed");

    await act(async () => {
      screen.getByRole("button", { name: "retry" }).click();
    });
    expect(screen.getByTestId("kind").textContent).toBe("pick-a-day");
    expect(calls).toBe(2);
  });

  it("fetches nothing and settles empty when there is no url to load", async () => {
    global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;

    render(<Harness url={null} />);
    await act(async () => {});

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("kind").textContent).toBe("no-days");
  });

  it("keeps the loaded payload so a surface reading it does not blank mid load", async () => {
    global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;

    const { rerender } = render(<Harness url="/api/availability?bucket=411&from=a" />);
    await act(async () => {});
    expect(screen.getByTestId("org").textContent).toBe("Pennie");

    // A new window starts loading: slots clear so a stale time is not tappable,
    // but the event panel's own facts must stay on screen.
    let release: (() => void) | null = null;
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(okResponse(SLOTS));
        }),
    ) as unknown as typeof fetch;
    rerender(<Harness url="/api/availability?bucket=411&from=b" />);
    await act(async () => {});

    expect(screen.getByTestId("kind").textContent).toBe("loading");
    expect(screen.getByTestId("org").textContent).toBe("Pennie");
    await act(async () => {
      release?.();
    });
  });

  it("returns the lead to the strip when the chosen day's last time goes", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      // The second load has lost Aug 14 entirely (someone took the last slot).
      return okResponse(calls === 1 ? SLOTS : ["2026-08-15T13:00:00.000Z"]);
    }) as unknown as typeof fetch;

    render(<Harness url="/api/availability?bucket=411" />);
    await act(async () => {});
    await act(async () => {
      screen.getByRole("button", { name: "2026-08-14" }).click();
    });
    expect(screen.getByTestId("kind").textContent).toBe("times");

    await act(async () => {
      screen.getByRole("button", { name: "retry" }).click();
    });
    // Not "day-empty": that would name a day the strip no longer draws.
    expect(screen.getByTestId("kind").textContent).toBe("pick-a-day");
    expect(screen.getByTestId("days").textContent).toBe("2026-08-15");
  });

  // #1329: the far side of a closure comes from a different, on-demand search, and
  // it is routed through THIS hook rather than a second strip and times panel, so
  // the chosen day, the grouping and the no-times-before-a-day rule stay in one
  // place. A private copy for the closure state is the divergence #1336 removed.
  describe("slotsOverride", () => {
    it("shows the supplied days instead of the fetched ones, with no fetch at all", async () => {
      global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;

      render(<Harness url={null} slotsOverride={["2026-09-14T13:00:00.000Z"]} />);
      await act(async () => {});

      expect(screen.getByTestId("days").textContent).toBe("2026-09-14");
      // Still no times until a day is chosen, out here as everywhere else.
      expect(screen.getByTestId("kind").textContent).toBe("pick-a-day");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("treats an empty override as a settled answer, not a load", async () => {
      render(<Harness url={null} slotsOverride={[]} />);
      await act(async () => {});

      // The caller looked and found nothing. A loading state here would show a
      // working signal forever over a question already answered.
      expect(screen.getByTestId("kind").textContent).toBe("no-days");
    });

    it("settles a failed fetch when an override arrives", async () => {
      global.fetch = vi.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch;

      const { rerender } = render(<Harness url="/api/availability?bucket=411" />);
      await act(async () => {});
      expect(screen.getByTestId("kind").textContent).toBe("failed");

      rerender(
        <Harness url="/api/availability?bucket=411" slotsOverride={["2026-09-14T13:00:00.000Z"]} />,
      );
      // The days are on screen, so a stale failure must not still be claimed.
      expect(screen.getByTestId("kind").textContent).toBe("pick-a-day");
    });
  });

  // #2310: the lead's calling window, applied here once for every surface.
  describe("the lead's calling window", () => {
    it("re-filters the offered times when the lead changes zone, and says why a day has none", async () => {
      global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;

      const { rerender } = render(<Harness url="/api/availability?bucket=411" />);
      await act(async () => {});
      await act(async () => {
        screen.getByRole("button", { name: "2026-08-14" }).click();
      });
      // New York: 09:00 and 14:00 are both inside 08:00 to 20:00.
      expect(screen.getByTestId("slots").textContent).toBe(
        "2026-08-14T13:00:00.000Z,2026-08-14T18:00:00.000Z",
      );

      // Honolulu: the same instants are 03:00 and 08:00, so only 08:00 stays.
      rerender(<Harness url="/api/availability?bucket=411" zone="Pacific/Honolulu" />);
      expect(screen.getByTestId("kind").textContent).toBe("times");
      expect(screen.getByTestId("slots").textContent).toBe("2026-08-14T18:00:00.000Z");

      // Aug 15 has only a 03:00 Honolulu time: the day is still offered, and
      // choosing it says why rather than reading as empty.
      expect(screen.getByTestId("days").textContent).toBe("2026-08-14,2026-08-15");
      await act(async () => {
        screen.getByRole("button", { name: "2026-08-15" }).click();
      });
      expect(screen.getByTestId("kind").textContent).toBe("outside-calling-hours");
    });
  });

  // #4390: a program lead's token rides on the read as a header, never in the address,
  // and the lead's zone joins the address so a change of zone is a fresh read.
  describe("a program lead's read", () => {
    function ProgramHarness({ token, zone = ZONE }: { token: string | null; zone?: string }) {
      const picker = useSlotPicker({ url: "/api/availability?bucket=411", zone, leadZone: zone, programLeadToken: token });
      return <p data-testid="kind">{picker.view.kind}</p>;
    }

    it("sends an ordinary lead's read exactly as before", async () => {
      global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;
      render(<ProgramHarness token={null} />);
      await act(async () => {});
      const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
      expect(url).toBe("/api/availability?bucket=411");
      expect((init as RequestInit).headers).toBeUndefined();
    });

    it("carries the token in a header and the zone in the address, and reads again when the zone changes", async () => {
      global.fetch = vi.fn(async () => okResponse(SLOTS)) as unknown as typeof fetch;
      const { rerender } = render(<ProgramHarness token="tok" />);
      await act(async () => {});
      const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
      expect(url).toBe("/api/availability?bucket=411&leadZone=America%2FNew_York");
      expect((init as RequestInit).headers).toEqual({ "x-slate-program-lead": "tok" });

      rerender(<ProgramHarness token="tok" zone="America/Chicago" />);
      expect(screen.getByTestId("kind").textContent).toBe("loading");
      await act(async () => {});
      expect(vi.mocked(global.fetch).mock.calls[1]![0]).toBe("/api/availability?bucket=411&leadZone=America%2FChicago");
    });
  });
});
