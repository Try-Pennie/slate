// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import {
  AGENT_LINK_COPY,
  NEXT_DAYS_COPY,
  allTimesTaken,
  closedNoReopenDate,
} from "@/lib/booking/booker-copy";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";

// #2073: the booker on an agent's own link is the same booker with the pool
// resolution removed. These pin the three places it differs: where the times
// come from, what the confirm names, and what an empty window says.

vi.mock("@/components/ConfirmationMarkPlayer", () => ({ ConfirmationMarkPlayer: () => null }));

// #3026: the address carries the advisor's readable name.
const LINK = "rdaboub";
const slotIso = bookerSlotIso(3);
const availability = {
  bucket: { code: "" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};
const props = {
  bucketCode: "",
  agentLink: LINK,
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

beforeEach(() => vi.clearAllMocks());

describe("Booker on an agent's own link (#2073)", () => {
  it("reads the named agent's times, never a bucket's", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return { ok: true, json: async () => availability } as Response;
    }) as unknown as typeof fetch;
    render(<Booker {...props} />);
    await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
    const read = urls.find((u) => u.includes("/api/availability"));
    expect(read).toContain(`advisor=${LINK}`);
    expect(read).not.toContain("bucket=");
  });

  it("confirms naming the link, never a bucket", async () => {
    let posted: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      posted = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso, advisorName: "Jane Doe" }) } as Response;
    }) as unknown as typeof fetch;
    render(<Booker {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await userEvent.type(screen.getByLabelText("First name"), "Dana");
    await userEvent.type(screen.getByLabelText("Last name"), "Lead");
    await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
    await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
    await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
    expect(await screen.findByText("You're all set")).toBeTruthy();
    expect(posted).not.toBeNull();
    expect(posted!.agentLink).toBe(LINK);
    expect(posted).not.toHaveProperty("agentLinkToken");
    expect(posted).not.toHaveProperty("bucketCode");
    expect(posted).not.toHaveProperty("requestedCode");
  });

  it("says the advisor has no open times rather than that every time is taken", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
    })) as unknown as typeof fetch;
    render(<Booker {...props} />);
    expect((await screen.findAllByText(AGENT_LINK_COPY.noTimes)).length).toBeGreaterThan(0);
    expect(screen.queryByText(allTimesTaken())).toBeNull();
  });

  it("says a closure as a closure, and offers no far ahead search of a pool", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "closed", reopensOn: null } }),
    })) as unknown as typeof fetch;
    render(<Booker {...props} />);
    expect(await screen.findByText(closedNoReopenDate())).toBeTruthy();
    // The far ahead search walks a BUCKET's pool, which is the wrong answer here.
    expect(screen.queryByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeNull();
  });

  it("says the link books nobody when the times read is refused as unavailable", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: AGENT_LINK_COPY.unavailable, code: "AGENT_LINK_UNAVAILABLE" }),
    })) as unknown as typeof fetch;
    render(<Booker {...props} />);
    expect((await screen.findAllByText(AGENT_LINK_COPY.unavailable)).length).toBeGreaterThan(0);
  });
});
