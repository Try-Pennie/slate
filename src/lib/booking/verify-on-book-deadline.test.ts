import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3313: the confirm's own budget running out inside verify on book is the
// dependency timeout, never a Google or database outage.
//
// At 07:59 ET on 2026-10-05 a time change spent the confirm's 12 seconds while
// verify on book's bulk free/busy read was minting its token. That read's catch
// treated the deadline as "bulk freeBusy failed" and handed every candidate to
// the per agent fallback, which had no time left either: its calendar lookup
// came back refused, the agent was scored unverified, and the page that went
// out said "likely a Google/DB outage". A new booking that hit the same deadline
// somewhere else was paged as the dependency timeout. Same cause, two messages,
// and the outage one sent the reader to systems that were healthy (L11).
//
// Everything below the Supabase client, the token mint and the Google HTTP call
// is the real shipped wiring: `realDeps().verifyFree`, `verifyAgentsDirectly`
// and `agentBusyIntervals`, reached the way the booker and the reschedule reach
// them. The last block drives the two service entry points with an orchestration
// stand in that asks verify on book exactly once, so the classification and the
// page are the real ones; what the REAL orchestration does with a deadline from
// verify on book is `scripts/test-verify-on-book-deadline-paths.ts`.

const AGENT = "agent@trypennie.com";
const START = "2026-06-08T15:00:00.000Z";
const END = "2026-06-08T15:30:00.000Z";

const state = vi.hoisted(() => ({
  /** Once true, every Supabase read answers the way PostgREST folds a deadline. */
  spent: false,
  /** An ordinary refusal for every Supabase read, for the controls. */
  ordinaryError: null as { message: string } | null,
  readsAfterSpent: 0,
  reads: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => {
  const AGENT_EMAIL = "agent@trypennie.com";
  // PostgREST never throws: a fetch that failed comes back as `error`, with the
  // thrown error's name and message folded into `error.message`.
  const answer = (table: string, rows: unknown) => {
    state.reads.push(table);
    if (state.spent) {
      state.readsAfterSpent++;
      return {
        data: null,
        error: {
          message:
            "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
          details: "",
          hint: "",
          code: "",
        },
      };
    }
    if (state.ordinaryError) return { data: null, error: state.ordinaryError };
    return { data: rows, error: null };
  };
  const rowsFor = (table: string) =>
    table === "agent_calendars"
      ? [{ user_id: "u-1", calendar_id: AGENT_EMAIL }]
      : [{ id: "u-1", email: AGENT_EMAIL }];
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: async () => answer(table, rowsFor(table)),
        eq: () => ({
          maybeSingle: async () => answer(table, { id: "u-1" }),
          then: (resolve: (r: unknown) => unknown) =>
            resolve(answer(table, [{ calendar_id: AGENT_EMAIL }])),
        }),
      }),
    }),
  };
  return { supabaseAdmin: vi.fn(() => client) };
});

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);

const alert = vi.hoisted(() => vi.fn(async (_k: string, _ms: number, _msg: string) => {}));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert: alert,
  sendThrottledInfo: vi.fn(async () => {}),
  resolveRecovered: vi.fn(async () => {}),
}));

// The stand in for the orchestration: ask verify on book once for the one agent,
// and refuse the way `assignAgent` does with what comes back. Anything verify on
// book THROWS reaches the service wrapper untouched, as it does in the real one.
const orchestrationStandIn = vi.hoisted(() => {
  async function verifyThenRefuse(deps: { verifyFree: (e: string[], s: string, t: string) => Promise<{ free: Set<string>; unverified: Set<string> }> }) {
    const { VerifyUnavailableError, SlotUnavailableError } = await import("./orchestration");
    const { free, unverified } = await deps.verifyFree(["agent@trypennie.com"], "2026-06-08T15:00:00.000Z", "2026-06-08T15:30:00.000Z");
    if (free.size > 0) throw new Error("stand in: the agent read as free, which no case here expects");
    if (unverified.size > 0) throw new VerifyUnavailableError();
    throw new SlotUnavailableError();
  }
  return {
    createBooking: vi.fn((_input: unknown, deps: Parameters<typeof verifyThenRefuse>[0]) => verifyThenRefuse(deps)),
    // rescheduleBooking(token, newStartIso, reason, initiator, deps, ...)
    rescheduleBooking: vi.fn(
      (_t: unknown, _s: unknown, _r: unknown, _i: unknown, deps: Parameters<typeof verifyThenRefuse>[0]) =>
        verifyThenRefuse(deps),
    ),
  };
});
vi.mock("./orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./orchestration")>()),
  createBooking: orchestrationStandIn.createBooking,
  rescheduleBooking: orchestrationStandIn.rescheduleBooking,
}));

import {
  realDeps,
  verifyAgentsDirectly,
  agentBusyIntervals,
  createBooking,
  rescheduleBooking,
  bookingFailureAlert,
  type CreateBookingInput,
} from "./service";
import { DependencyTimeoutError, VerifyUnavailableError, timeoutAsRetryable } from "./orchestration";
import { DeadlineExceededError, findDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { googleBreaker } from "@/lib/google/calendar";
import { dependencyTimeoutAlert, verifyOutageAlert } from "./alert-copy";

const BUDGET = { label: "the booking confirm", totalMs: 12_000 };

/** The confirm's budget runs out while the token for this Google call is being minted. */
function budgetRunsOutDuringTheMint() {
  dwd.getDelegatedToken.mockImplementation(async () => {
    state.spent = true;
    throw new DeadlineExceededError("supabase", 0, BUDGET);
  });
}

const CLEAN = { calendars: { [AGENT]: { busy: [] } } };

/** Google's replies in order; the last one repeats. */
function googleAnswers(...replies: Response[]) {
  const queue = [...replies];
  const fetchFake = vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0].clone()));
  vi.stubGlobal("fetch", fetchFake);
  return fetchFake;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The pages verify on book's per agent read sends when it could not resolve calendars. */
const verifyReadPages = () => alert.mock.calls.filter(([key]) => key === "verify_on_book_calendars_read");

beforeEach(() => {
  state.spent = false;
  state.ordinaryError = null;
  state.readsAfterSpent = 0;
  state.reads.length = 0;
  alert.mockClear();
  dwd.getDelegatedToken.mockReset();
  dwd.getDelegatedToken.mockResolvedValue("tok");
  googleBreaker.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe("a deadline inside verify on book is the dependency timeout (#3313)", () => {
  it("the budget running out in the bulk free/busy read propagates, and the per agent fallback is not tried", async () => {
    googleAnswers(json(CLEAN));
    budgetRunsOutDuringTheMint();

    const caught = await realDeps().verifyFree([AGENT], START, END).catch((e: unknown) => e);

    expect(findDeadlineExceeded(caught)).toEqual({ label: "supabase", timeoutMs: 0, budget: BUDGET });
    // A fallback with no time left cannot answer anything: nothing is asked after
    // the budget ran out, and no read failure is paged on the agent's behalf.
    expect(state.readsAfterSpent).toBe(0);
    expect(dwd.getDelegatedToken).toHaveBeenCalledOnce();
    expect(verifyReadPages()).toEqual([]);
  });

  it("a deadline on the wave's calendar lookup propagates rather than falling back per agent", async () => {
    googleAnswers(json(CLEAN));
    state.spent = true;

    const caught = await realDeps().verifyFree([AGENT], START, END).catch((e: unknown) => e);

    expect(findDeadlineExceeded(caught)?.label).toBe("supabase");
    expect(state.reads).toEqual(["users"]);
    expect(dwd.getDelegatedToken).not.toHaveBeenCalled();
  });

  it("the per agent read does not score a deadline as an unverified agent", async () => {
    googleAnswers(json(CLEAN));
    state.spent = true;

    const caught = await verifyAgentsDirectly([AGENT], START, END).catch((e: unknown) => e);

    expect(findDeadlineExceeded(caught)?.timeoutMs).toBe(0);
    expect(verifyReadPages()).toEqual([]);
  });

  it("the reschedule guard's live read does not read a deadline as a calendar it could not tell about", async () => {
    googleAnswers(json(CLEAN));
    state.spent = true;

    const caught = await agentBusyIntervals(AGENT, START, END).catch((e: unknown) => e);

    expect(findDeadlineExceeded(caught)?.label).toBe("supabase");
    expect(verifyReadPages()).toEqual([]);
  });

  // The control that keeps the fallback for what it exists for: a REAL Google
  // failure on the bulk read is still answered by asking each agent directly.
  it("still falls back per agent when the bulk read fails for an ordinary Google reason", async () => {
    const fetchFake = googleAnswers(json({ error: { errors: [{ reason: "backendError" }] } }, 503), json(CLEAN));

    const res = await realDeps().verifyFree([AGENT], START, END);

    expect([...res.free]).toEqual([AGENT]);
    expect([...res.unverified]).toEqual([]);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it("still scores an agent unverified when the per agent read is refused for an ordinary reason", async () => {
    googleAnswers(json(CLEAN));
    state.ordinaryError = { message: "connection reset" };

    const res = await verifyAgentsDirectly([AGENT], START, END);
    expect([...res.unverified]).toEqual([AGENT]);
    expect(await agentBusyIntervals(AGENT, START, END)).toBeNull();
  });

  it("still scores a wave unverified when its calendar lookup is refused for an ordinary reason", async () => {
    googleAnswers(json(CLEAN));
    state.ordinaryError = { message: "connection reset" };

    const res = await realDeps().verifyFree([AGENT], START, END);
    expect([...res.unverified]).toEqual([AGENT]);
  });
});

describe("both entry points page the spent budget as the dependency timeout (#3313)", () => {
  const expectedPage = dependencyTimeoutAlert({ dependency: "supabase", timeoutMs: 0, budget: BUDGET });

  it("a new booking", async () => {
    googleAnswers(json(CLEAN));
    budgetRunsOutDuringTheMint();

    const caught = await createBooking({} as CreateBookingInput).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(DependencyTimeoutError);
    expect(bookingFailureAlert(caught)?.message).toBe(expectedPage);
    const outagePages = alert.mock.calls.filter(([key]) => key === "verify_on_book_outage");
    expect(outagePages.map(([, , text]) => text)).toEqual([expectedPage]);
    expect(outagePages[0][2]).not.toBe(verifyOutageAlert());
  });

  it("a time change (POST /api/bookings/<token>/reschedule)", async () => {
    googleAnswers(json(CLEAN));
    budgetRunsOutDuringTheMint();

    const caught = await rescheduleBooking("tok", START, { code: "other", text: null } as never, "customer").catch(
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(DependencyTimeoutError);
    expect(bookingFailureAlert(caught)?.message).toBe(expectedPage);
    const outagePages = alert.mock.calls.filter(([key]) => key === "verify_on_book_outage");
    expect(outagePages.map(([, , text]) => text)).toEqual([expectedPage]);
  });

  // The control: an outage that really is one still pages as the outage.
  it("an ordinary unverifiable wave still pages as the verify outage", async () => {
    googleAnswers(json(CLEAN));
    state.ordinaryError = { message: "connection reset" };

    const caught = await createBooking({} as CreateBookingInput).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(VerifyUnavailableError);
    expect(caught).not.toBeInstanceOf(DependencyTimeoutError);
    expect(timeoutAsRetryable(caught)).toBe(caught);
    const outagePages = alert.mock.calls.filter(([key]) => key === "verify_on_book_outage");
    expect(outagePages.map(([, , text]) => text)).toEqual([verifyOutageAlert()]);
  });
});
