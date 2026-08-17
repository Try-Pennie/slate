import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #922: the bookable reachability probe passes a bounded timeoutMs into
// listCalendars so a hanging Google can't stall the 'Make bookable' click. These
// tests prove listCalendars threads that bound into gfetch's abort wiring: a
// fetch that never responds is aborted once the bound elapses, and a fetch that
// responds in time is left alone. getDelegatedToken and global fetch are stubbed
// so nothing hits Google.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);

import { listCalendars, createEventOnCalendar, updateEventDescription, syncEvents } from "./calendar";
import { EventGone } from "@/lib/booking/core";

const event = {
  summary: "Dana Ruiz - OOO",
  description: "Request ID: req-1",
  start: "2026-08-20T21:00:00.000Z",
  end: "2026-08-20T23:00:00.000Z",
  timezone: "America/New_York",
};

describe("listCalendars timeout (#922)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("aborts a hung calendarList fetch once timeoutMs elapses", async () => {
    // The fetch never resolves on its own; it rejects only if the abort signal
    // fires, exactly as a real hung Google request would under an AbortController.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
    );
    await expect(listCalendars("a@b.com", 20)).rejects.toThrow(/abort/i);
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith("a@b.com");
  });

  it("does not abort a calendarList fetch that responds before timeoutMs", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: [{ id: "primary" }] }), { status: 200 }),
    );
    await expect(listCalendars("a@b.com", 20000)).resolves.toEqual([{ id: "primary" }]);
  });
});

// #1469: the OOO calendar creates are bounded at 8 seconds because the manager
// is waiting, so a slow moment at Google surfaces as an abort. The orchestration
// retries once, and a retry is only safe if the first attempt cannot have left
// an event behind: an aborted insert may still have been applied on Google's
// side. A deterministic client id makes the second attempt a 409 that resolves
// to the event already created, rather than a duplicate on the agent's calendar.
describe("createEventOnCalendar idempotency (#1469)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("sends the client id as the event id so a repeat insert collides", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    });

    const id = await createEventOnCalendar("a@b.com", "primary", event, "slateabc");

    expect(id).toBe("evt-1");
    expect(JSON.parse(bodies[0]).id).toBe("slateabc");
  });

  it("returns the EXISTING event when Google 409s the duplicate id", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return url.includes("/events/slateabc")
        ? new Response(JSON.stringify({ id: "evt-already-there" }), { status: 200 })
        : new Response("duplicate", { status: 409 });
    });

    const id = await createEventOnCalendar("a@b.com", "primary", event, "slateabc");

    // The event Google already had, not a second one: this is the whole point.
    expect(id).toBe("evt-already-there");
    expect(calls.some((u) => u.includes("/events/slateabc"))).toBe(true);
  });

  it("still throws on a 409 when no client id was supplied", async () => {
    // Without an id of our own, a 409 is a genuine conflict we cannot resolve,
    // and swallowing it would report an event that does not exist.
    vi.stubGlobal("fetch", async () => new Response("conflict", { status: 409 }));

    await expect(createEventOnCalendar("a@b.com", "primary", event)).rejects.toThrow(/409/);
  });

  it("throws on any other failure rather than inventing an id", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));

    await expect(
      createEventOnCalendar("a@b.com", "primary", event, "slateabc"),
    ).rejects.toThrow(/503/);
  });
});

// #1341: a lead corrects the number the advisor will ring, so the event BODY is
// rewritten. Three things about that request are decisions, not incidentals, and
// each is invisible from the call site.
describe("updateEventDescription (#1341)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  function capture(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? "{}" : "", { status });
    });
    return calls;
  }

  it("patches only the description, so a phone correction can never move the time", async () => {
    const calls = capture();
    await updateEventDescription("agent@trypennie.com", "evt-1", "Phone: (215) 555-9999");

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ description: "Phone: (215) 555-9999" });
    expect(body.start).toBeUndefined();
    expect(body.end).toBeUndefined();
  });

  it("does not email the attendees about it", async () => {
    // Google syncs the event CONTENT either way; sendUpdates decides only whether
    // people are mailed. A number the lead just typed on our own page is not news
    // to them, and "your event was updated" for their own correction is noise.
    const calls = capture();
    await updateEventDescription("agent@trypennie.com", "evt-1", "Phone: (215) 555-9999");

    expect(calls[0].url).toContain("sendUpdates=none");
    expect(calls[0].url).not.toContain("sendUpdates=all");
  });

  it("impersonates the agent whose calendar holds the event", async () => {
    capture();
    await updateEventDescription("agent@trypennie.com", "evt-1", "x");
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith("agent@trypennie.com");
  });

  for (const status of [404, 410]) {
    it(`raises a typed EventGone on ${status}, not a generic failure`, async () => {
      capture(status);
      await expect(updateEventDescription("agent@trypennie.com", "gone", "x")).rejects.toThrow(
        EventGone,
      );
    });
  }

  it("still throws on an unwell Google, so the caller can page about a stale invite", async () => {
    capture(503);
    await expect(updateEventDescription("agent@trypennie.com", "evt-1", "x")).rejects.toThrow();
  });
});

describe("syncEvents windows a BOOTSTRAP and never a delta (#1261)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  /** Capture the URL each call asked for, answering with one empty final page. */
  function capture() {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextSyncToken: "next" }), { status: 200 }),
      );
    });
    return urls;
  }

  const MIN = "2026-06-08T00:00:00.000Z";
  const MAX = "2026-06-29T00:00:00.000Z";

  it("sends timeMin AND timeMax when there is no sync token", async () => {
    const urls = capture();
    await syncEvents("a@b.com", "primary", null, MIN, MAX);

    const params = new URL(urls[0]!).searchParams;
    expect(params.get("timeMin")).toBe(MIN);
    // The bound that stops the cache claiming coverage it never fetched. Whatever is sent
    // here is exactly what the reconcile is then allowed to judge and the prune to act on.
    expect(params.get("timeMax")).toBe(MAX);
    expect(params.get("syncToken")).toBeNull();
  });

  it("sends NEITHER bound alongside a sync token, which Google answers 400 to", async () => {
    const urls = capture();
    await syncEvents("a@b.com", "primary", "a-stored-token", MIN, MAX);

    const params = new URL(urls[0]!).searchParams;
    expect(params.get("syncToken")).toBe("a-stored-token");
    // Both, not just timeMax: `timeMin` or `timeMax` with a `syncToken` is a documented
    // 400 from Google, so getting this wrong does not degrade the delta, it stops every
    // incremental sync in the fleet outright.
    expect(params.get("timeMin")).toBeNull();
    expect(params.get("timeMax")).toBeNull();
  });
});
