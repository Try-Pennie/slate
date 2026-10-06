import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #922: the bookable reachability probe passes a bounded timeoutMs into
// listCalendars so a hanging Google can't stall the 'Make bookable' click. These
// tests prove listCalendars threads that bound into gfetch's abort wiring: a
// fetch that never responds is aborted once the bound elapses, and a fetch that
// responds in time is left alone. getDelegatedToken and global fetch are stubbed
// so nothing hits Google.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);
// #3134: the breaker is module state shared by every case here, and several cases
// fail Google on purpose, so it is reset before each and its pages never leave.
vi.mock("@/lib/google/breaker-alert", () => ({ announceGoogleBreaker: vi.fn() }));
beforeEach(() => googleBreaker.reset());

import {
  listCalendars,
  createEventOnCalendar,
  deleteEvent,
  deleteEventOnCalendar,
  updateEventDescription,
  updateEventContact,
  syncEvents,
  createEvent,
  freeBusyMany,
  updateEventTime,
  GOOGLE_CONFIRM_TIMEOUT_MS,
  GOOGLE_SYNC_TIMEOUT_MS,
  googleBreaker,
} from "./calendar";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { REQUEST_TIMEOUT_MS } from "@/lib/http";
import { SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { isDefinitiveFailure, reachabilityFromError } from "@/lib/google/reachability-classify";
import { EventGone, EventCancelledOnReuse, freshEventId, TOMBSTONE_FRESH_IDS } from "@/lib/booking/core";

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
    await expect(listCalendars("a@b.com", 20)).rejects.toBeInstanceOf(DeadlineExceededError);
    // The token mint is held to the same deadline as the call it is for (#3102).
    // The trailing undefined: a first mint names no refused token (#3144).
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith("a@b.com", undefined, 20, undefined);
  });

  it("does not abort a calendarList fetch that responds before timeoutMs", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: [{ id: "primary" }] }), { status: 200 }),
    );
    await expect(listCalendars("a@b.com", 20000)).resolves.toEqual([{ id: "primary" }]);
  });
});

// #3144 (L742): a cached delegated token Google refuses must not lose the call
// it was carrying. The call is resent once on a fresh token; a second refusal
// still throws, classified exactly as before.
describe("a refused delegated token (#3144)", () => {
  beforeEach(() => {
    dwd.getDelegatedToken.mockReset();
    dwd.getDelegatedToken.mockImplementation(async (_e: string, _s?: string, _d?: unknown, rejected?: string) =>
      rejected ? "fresh" : "stale",
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resends the same insert on a fresh token and returns its event", async () => {
    const sent: { auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      sent.push({ auth, body: init.body });
      return auth === "Bearer stale"
        ? new Response("Invalid Credentials", { status: 401 })
        : new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    });
    await expect(createEventOnCalendar("a@b.com", "primary", event)).resolves.toBe("evt-1");
    expect(sent.map((s) => s.auth)).toEqual(["Bearer stale", "Bearer fresh"]);
    // The same request both times, so the work is the work that was asked for.
    expect(sent[1].body).toEqual(sent[0].body);
    expect(dwd.getDelegatedToken).toHaveBeenLastCalledWith("a@b.com", undefined, expect.anything(), "stale");
  });

  it("throws on a second refusal after one resend, still classified definitive", async () => {
    let sends = 0;
    vi.stubGlobal("fetch", async () => {
      sends += 1;
      return new Response("unauthorized", { status: 401 });
    });
    const err = await deleteEvent("a@b.com", "evt-1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(sends).toBe(2);
    expect(reachabilityFromError(err)).toBe("gone");
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

// #3217: Google keeps a deleted event's id, so a deterministic id whose event was
// deleted 409s on the next insert and the event the GET then returns is CANCELLED.
// Adopting it confirms a booking (or a time off block) with nothing on the
// calendar. Both creates walk the same fixed chain of fresh ids instead, so a
// retry walks it the same way and adopts the first live event on it.
describe("a create never adopts a cancelled event on a 409 (#3217)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  /** A calendar holding these ids, with these statuses. An insert of a held id
   *  409s; any other id is created and becomes held. */
  function googleHolding(held: Record<string, string>) {
    const calls: { method: string; id: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        const id = JSON.parse(String(init.body)).id as string;
        calls.push({ method, id });
        if (held[id]) return new Response("duplicate", { status: 409 });
        held[id] = "confirmed";
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      const id = decodeURIComponent(url.split("/events/")[1].split("?")[0]);
      calls.push({ method, id });
      return new Response(JSON.stringify({ id, status: held[id] }), { status: 200 });
    });
    return calls;
  }

  it("createEvent creates the next id in the chain, and writes nothing to the tombstone", async () => {
    const calls = googleHolding({ slateabc: "cancelled" });
    await expect(createEvent("a@b.com", event, "slateabc")).resolves.toBe(freshEventId("slateabc", 1));
    expect(calls).toEqual([
      { method: "POST", id: "slateabc" },
      { method: "GET", id: "slateabc" },
      { method: "POST", id: freshEventId("slateabc", 1) },
    ]);
  });

  it("a time off re-approved after its block was deleted gets a live block (createEventOnCalendar)", async () => {
    googleHolding({ slateabc: "cancelled" });
    await expect(createEventOnCalendar("a@b.com", "primary", event, "slateabc")).resolves.toBe(
      freshEventId("slateabc", 1),
    );
  });

  it("a retry walks the same chain and ADOPTS the live event an earlier attempt made on it", async () => {
    const calls = googleHolding({ slateabc: "cancelled", [freshEventId("slateabc", 1)]: "confirmed" });
    await expect(createEvent("a@b.com", event, "slateabc")).resolves.toBe(freshEventId("slateabc", 1));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("tells the caller each fresh id BEFORE it is created, so it can record it first", async () => {
    const calls = googleHolding({ slateabc: "cancelled" });
    const seen: string[] = [];
    await createEvent("a@b.com", event, "slateabc", {
      onFreshId: async (id) => {
        seen.push(`${id} after ${calls.length} calls`);
      },
    });
    expect(seen).toEqual([`${freshEventId("slateabc", 1)} after 2 calls`]);
  });

  it("fails loudly with the typed error once every id in the chain is a tombstone", async () => {
    const held: Record<string, string> = { slateabc: "cancelled" };
    for (let n = 1; n <= TOMBSTONE_FRESH_IDS; n++) held[freshEventId("slateabc", n)] = "cancelled";
    googleHolding(held);
    await expect(createEventOnCalendar("a@b.com", "primary", event, "slateabc")).rejects.toBeInstanceOf(
      EventCancelledOnReuse,
    );
  });

  it("still adopts a LIVE event under the id itself, so a plain resume is unchanged", async () => {
    const calls = googleHolding({ slateabc: "confirmed" });
    await expect(createEvent("a@b.com", event, "slateabc")).resolves.toBe("slateabc");
    await expect(createEventOnCalendar("a@b.com", "primary", event, "slateabc")).resolves.toBe("slateabc");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.id)).toEqual(["slateabc", "slateabc"]);
  });
});

// #2371: the owner alert's removal decides whether to retry by classifying the error,
// and `reachabilityFromError` can only classify what it can read: a plain Error carries
// no status, so it is scored TRANSIENT and retried. That made a refusal no retry can
// ever fix look like a blip.
describe("deleteEventOnCalendar throws a classifiable error (#2371)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  const caught = async (status: number, body: string) => {
    vi.stubGlobal("fetch", async () => new Response(body, { status }));
    try {
      await deleteEventOnCalendar("a@b.com", "b@b.com", "evt-1");
      throw new Error("expected deleteEventOnCalendar to throw");
    } catch (err) {
      return err;
    }
  };

  it("carries the status and reason, so a never provisioned calendar reads as definitive", async () => {
    const err = await caught(
      403,
      JSON.stringify({ error: { errors: [{ reason: "notACalendarUser" }] } }),
    );
    expect(reachabilityFromError(err)).toBe("not-provisioned");
    expect(isDefinitiveFailure(reachabilityFromError(err))).toBe(true);
  });

  it("and a 503 still reads as transient, so the two are told apart", async () => {
    // The control: without this, a change that classified everything as definitive
    // would pass the assertion above while stopping every legitimate retry.
    const err = await caught(503, "backendError");
    expect(reachabilityFromError(err)).toBe("transient");
    expect(isDefinitiveFailure(reachabilityFromError(err))).toBe(false);
  });

  it("still treats an already gone event as success", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(deleteEventOnCalendar("a@b.com", "b@b.com", "evt-1")).resolves.toBeUndefined();
  });
});

// #2561: the same defect as #2371, one function along. The booking cancel's delete
// (and the retry drain behind it) threw a PLAIN Error, which carries no status, so
// `reachabilityFromError` scored every refusal TRANSIENT. An advisor who was never
// given Calendar, or whose account has gone, was retried by the drain every tick and
// then paged about with advice that can never work, while a real blip looked exactly
// the same.
describe("deleteEvent throws a classifiable error (#2561)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  const caught = async (status: number, body: string) => {
    vi.stubGlobal("fetch", async () => new Response(body, { status }));
    try {
      await deleteEvent("a@b.com", "evt-1");
      throw new Error("expected deleteEvent to throw");
    } catch (err) {
      return err;
    }
  };

  it("carries the status and reason, so a never provisioned calendar reads as definitive", async () => {
    const err = await caught(
      403,
      JSON.stringify({ error: { errors: [{ reason: "notACalendarUser" }] } }),
    );
    expect(reachabilityFromError(err)).toBe("not-provisioned");
    expect(isDefinitiveFailure(reachabilityFromError(err))).toBe(true);
  });

  it("classifies a gone account as definitive too", async () => {
    const err = await caught(401, "unauthorized");
    expect(reachabilityFromError(err)).toBe("gone");
    expect(isDefinitiveFailure(reachabilityFromError(err))).toBe(true);
  });

  it("and a 503 still reads as transient, so the two are told apart", async () => {
    // The control: without it, a change that classified everything as definitive
    // would satisfy the assertions above while stopping every legitimate retry (L1).
    const err = await caught(503, "backendError");
    expect(reachabilityFromError(err)).toBe("transient");
    expect(isDefinitiveFailure(reachabilityFromError(err))).toBe(false);
  });

  it("keeps the message shape, so nothing reading last_error changes", async () => {
    const err = await caught(503, "backendError");
    expect(String((err as Error).message)).toContain("events.delete failed: 503");
  });

  for (const status of [404, 410]) {
    it(`still treats an already gone event (${status}) as success`, async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status }));
      await expect(deleteEvent("a@b.com", "evt-1")).resolves.toBeUndefined();
    });
  }

  it("still tells the attendee unless the caller says not to", async () => {
    // The reassign (#969) is the silent one; every other delete is a real
    // cancellation the customer is owed an email about. Pinned here because the
    // typed throw above sits in the same function and a rewrite could lose it.
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response("", { status: 200 });
    });
    await deleteEvent("a@b.com", "evt-1");
    await deleteEvent("a@b.com", "evt-2", { notifyAttendee: false });
    expect(urls[0]).toContain("sendUpdates=all");
    expect(urls[1]).toContain("sendUpdates=none");
  });
});

// #2371: the advisor only "previously pitched" alert needs two fields no existing
// caller sends. Both halves matter and each is invisible from the call site: the alert
// must reach Google marked FREE (or it occupies the advisor's slot and Slate stops
// offering a time it is not actually busy at), and every caller that predates this
// must keep sending the body it always sent, with no null where a field used to be
// absent.
describe("createEventOnCalendar transparency and colour (#2371)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  const bodyOf = async (input: Parameters<typeof createEventOnCalendar>[2]) => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    });
    await createEventOnCalendar("a@b.com", "b@b.com", input, "slatealert");
    return JSON.parse(bodies[0]);
  };

  it("sends transparency and colorId when they are given", async () => {
    const sent = await bodyOf({ ...event, transparency: "transparent", colorId: "4" });
    expect(sent.transparency).toBe("transparent");
    expect(sent.colorId).toBe("4");
    // Still no attendees: this event is never an invitation.
    expect(sent.attendees).toBeUndefined();
  });

  it("OMITS both when they are not, rather than sending null", async () => {
    const sent = await bodyOf(event);
    // `in`, not a truthiness check: Google reads an explicit null as a value, so
    // "absent" and "null" are different requests and only one of them is what the
    // OOO writes have always sent.
    expect("transparency" in sent).toBe(false);
    expect("colorId" in sent).toBe(false);
  });
});

// #3376: the booking invite's LOCATION is the lead's phone, which is what the
// advisor's calendar shows after the time. Sent on the insert and on the contact
// patch, absent rather than empty when there is none, and cleared with "" when the
// lead removed their number.
describe("the invite's location (#3376)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  function capture() {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    });
    return calls;
  }

  it("sends the location on the booking insert", async () => {
    const calls = capture();
    await createEvent("a@b.com", { ...event, location: "+12155550100", attendeeEmail: "lead@x.com" }, "slateabc");
    expect(JSON.parse(String(calls[0].init.body)).location).toBe("+12155550100");
  });

  it("OMITS it when the booking has no number, rather than sending an empty one", async () => {
    const calls = capture();
    await createEvent("a@b.com", { ...event, attendeeEmail: "lead@x.com" }, "slateabc");
    expect("location" in JSON.parse(String(calls[0].init.body))).toBe(false);
  });

  it("patches the location with the lead's correction, and only what moved", async () => {
    const calls = capture();
    await updateEventContact("agent@trypennie.com", "evt-1", { location: "+12155559999" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ location: "+12155559999" });
  });

  it("clears it with an empty string when the number was removed", async () => {
    const calls = capture();
    await updateEventContact("agent@trypennie.com", "evt-1", { location: "" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ location: "" });
  });

  it("leaves it alone when the patch does not name it", async () => {
    const calls = capture();
    await updateEventContact("agent@trypennie.com", "evt-1", { summary: "x" });
    expect("location" in JSON.parse(String(calls[0].init.body))).toBe(false);
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
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith(
      "agent@trypennie.com",
      undefined,
      GOOGLE_CONFIRM_TIMEOUT_MS,
      undefined,
    );
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

// #3102: no Google call is unbounded any more. Every call names a deadline, sized
// for who is waiting: a lead on the confirm path, or a cron lane's shared budget.
// The fetch here never settles, not even on abort, and the timers are fake, so
// nothing waits for real time.
describe("default Google deadlines (#3102)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dwd.getDelegatedToken.mockResolvedValue("tok");
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Advance to one millisecond short of `ms`, then to it, recording when it settled. */
  async function settlesAt(p: Promise<unknown>, ms: number): Promise<unknown> {
    let outcome: unknown = "pending";
    p.then(
      () => (outcome = "resolved"),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    return outcome;
  }

  // The confirm path's WORST CASE, every call in a row, is pinned by
  // `booking/confirm-budget.test.ts`; one call here only has to fit inside it.
  it("keeps one confirm path call well inside the booker's abort", () => {
    expect(GOOGLE_CONFIRM_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS / 2);
  });

  it("sizes the sync deadline inside one sync tick's budget", () => {
    expect(GOOGLE_SYNC_TIMEOUT_MS).toBeLessThan(SYNC_TICK_BUDGET_MS);
  });

  it("bounds the confirm path's event insert, which used to wait forever", async () => {
    const outcome = await settlesAt(
      createEvent("a@b.com", { ...event, attendeeEmail: "lead@x.com" }, "slateabc"),
      GOOGLE_CONFIRM_TIMEOUT_MS,
    );
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
    expect((outcome as DeadlineExceededError).label).toBe("google events.insert");
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith("a@b.com", undefined, GOOGLE_CONFIRM_TIMEOUT_MS, undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the token mint and the request ONE expiry, not a deadline each", async () => {
    // A mint that takes 7.9 of the call's 8 seconds leaves the request 0.1. Two
    // full deadlines would have let this one call run to 15.9 seconds.
    dwd.getDelegatedToken.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("tok"), 7_900)),
    );
    const outcome = await settlesAt(
      createEvent("a@b.com", { ...event, attendeeEmail: "lead@x.com" }, "slateabc"),
      GOOGLE_CONFIRM_TIMEOUT_MS,
    );
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
    expect((outcome as DeadlineExceededError).label).toBe("google events.insert");
    expect((outcome as DeadlineExceededError).timeoutMs).toBe(GOOGLE_CONFIRM_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds verify-on-book's bulk free/busy read", async () => {
    const outcome = await settlesAt(
      freeBusyMany("ops@x.com", event.start, event.end, ["a@x.com"]),
      GOOGLE_CONFIRM_TIMEOUT_MS,
    );
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a lead's in place reschedule move", async () => {
    const outcome = await settlesAt(
      updateEventTime("a@b.com", "evt-1", event.start, event.end, event.timezone),
      GOOGLE_CONFIRM_TIMEOUT_MS,
    );
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
  });

  it("gives a sync read the longer lane deadline, not the confirm one", async () => {
    const outcome = await settlesAt(
      syncEvents("a@b.com", "primary", "tok", "2026-06-08T00:00:00.000Z", "2026-06-29T00:00:00.000Z"),
      GOOGLE_SYNC_TIMEOUT_MS,
    );
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
    expect((outcome as DeadlineExceededError).timeoutMs).toBe(GOOGLE_SYNC_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the calendar list on the sync path too, when no caller names a deadline", async () => {
    const outcome = await settlesAt(listCalendars("a@b.com"), GOOGLE_SYNC_TIMEOUT_MS);
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
  });
});
