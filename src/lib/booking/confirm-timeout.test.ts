import { describe, it, expect, vi, beforeEach } from "vitest";

// #3102: a dependency that times out on the confirm path used to escape as an
// unexpected error, so the lead got the generic 500 and nobody was paged about an
// outage. It now reaches every booking route as the retryable outage they already
// answer with a 503 and a sentence the booker already shows, and it pages under the
// verify outage key with the name of what did not answer.

const createBooking = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn(async (_k: string, _ms: number, _msg: string) => {}));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: alert, resolveRecovered: vi.fn() }));
vi.mock("@/lib/booking/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/orchestration")>()),
  createBooking,
}));

import { createBooking as serviceCreateBooking, bookingFailureAlert } from "./service";
import {
  DependencyTimeoutError,
  SlotUnavailableError,
  VerifyUnavailableError,
  timeoutAsRetryable,
} from "./orchestration";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { deadlineWithinBudget } from "@/lib/call-budget";
import { GoogleBreakerOpenError } from "@/lib/google/breaker";
import type { CreateBookingInput } from "./service";

const input = {} as CreateBookingInput;

beforeEach(() => vi.clearAllMocks());

describe("a timeout on the confirm path (#3102)", () => {
  it("reaches the route as the retryable outage, with the sentence the booker shows", async () => {
    createBooking.mockRejectedValue(new DeadlineExceededError("google events.insert", 8000));
    const caught = await serviceCreateBooking(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(VerifyUnavailableError);
    expect((caught as Error).message).toBe(new VerifyUnavailableError().message);
  });

  it("pages under the verify outage key, naming what did not answer", async () => {
    createBooking.mockRejectedValue(new DeadlineExceededError("google events.insert", 8000));
    await serviceCreateBooking(input).catch(() => {});
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0][0]).toBe("verify_on_book_outage");
    expect(String(alert.mock.calls[0][2])).toContain("google events.insert");
    expect(String(alert.mock.calls[0][2])).toContain("8 seconds");
  });

  it("recognises a Supabase timeout that unwrap has already quoted", () => {
    const fromUnwrap = new Error(
      "read failed [pool]: DeadlineExceededError: supabase did not answer within 15000ms",
    );
    const mapped = timeoutAsRetryable(fromUnwrap);
    expect(mapped).toBeInstanceOf(DependencyTimeoutError);
    expect((mapped as DependencyTimeoutError).dependency).toBe("supabase");
    expect(bookingFailureAlert(mapped)?.message).toContain("supabase");
  });

  // When the request's budget is what cut a call short, the page still names the
  // dependency that was running, and says the budget ran out, rather than naming
  // only "the booking confirm", which tells on call nobody which system to open.
  it("names the call in flight when the confirm's budget cut it short", async () => {
    createBooking.mockRejectedValue(
      new DeadlineExceededError("supabase", 3000, { label: "the booking confirm", totalMs: 12_000 }),
    );
    await serviceCreateBooking(input).catch(() => {});
    const page = String(alert.mock.calls[0][2]);
    expect(page).toContain("supabase");
    expect(page).toContain("the booking confirm");
    expect(page).toContain("12 seconds");
  });

  it("names the call it refused when the budget was already spent", () => {
    const fromUnwrap = new Error(
      "read failed [pool]: DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
    );
    const mapped = timeoutAsRetryable(fromUnwrap) as DependencyTimeoutError;
    expect(mapped.dependency).toBe("supabase");
    expect(mapped.budget).toEqual({ label: "the booking confirm", totalMs: 12_000 });
    const page = bookingFailureAlert(mapped)?.message ?? "";
    expect(page).toContain("supabase");
    expect(page).not.toContain("within 0 seconds");
    // #3263: plainly, the budget was used up before Slate asked supabase; "was
    // not started" read as though supabase had failed to start.
    expect(page).toContain("the booking confirm had used up its 12 seconds before Slate asked supabase");
    expect(page).not.toContain("was not started");
  });

  // #3313: when the budget was spent before Slate asked, the dependency was never
  // asked, so sending the reader to Google and Supabase health is a claim the
  // check never measured (L11). On 2026-10-06 at 13:54 ET both were healthy and
  // the page sent Dan there. The advice points inside Slate instead, at the line
  // that reads the request's time; the pending row check stays.
  describe("what the page tells the reader to check (#3313)", () => {
    const BUDGET = { label: "the booking confirm", totalMs: 12_000 };
    const page = (timeoutMs: number, budget: typeof BUDGET | null) =>
      bookingFailureAlert(timeoutAsRetryable(new DeadlineExceededError("supabase", timeoutMs, budget)))?.message ?? "";
    const PENDING = "Check booking_reservations for a pending row before asking them to rebook";
    const DEPENDENCIES = "Google Calendar API and Supabase health.";

    it("points inside Slate, not at the dependencies, when the budget was spent before the call", () => {
      const spent = page(0, BUDGET);
      expect(spent).toContain(PENDING);
      expect(spent).toContain("The time went inside Slate before that call");
      expect(spent).toContain("start from that request's confirm answered log line");
      // #3401: a time change writes that line too, so the advice names no kind of confirm.
      expect(spent).not.toContain("for a booking");
      expect(spent).not.toContain(`, and ${DEPENDENCIES}`);
      expect(spent).not.toMatch(/check[^.]*(Google|Supabase)[^.]*health/i);
    });

    it("still points at the dependency when the budget ran out while the call was running", () => {
      const running = page(3000, BUDGET);
      expect(running).toContain(`${PENDING}, and ${DEPENDENCIES}`);
      expect(running).not.toContain("confirm answered");
    });

    it("still points at the dependency when the call ran out of its own limit", () => {
      const ownLimit = page(15_000, null);
      expect(ownLimit).toContain(`${PENDING}, and ${DEPENDENCIES}`);
      expect(ownLimit).not.toContain("confirm answered");
    });
  });

  // L11: the page may claim only what was measured. Nothing at the moment of the
  // page knows whether the reservation was written or whether the drain will
  // finish it, so it must not promise either.
  it("does not promise the drain will finish the booking", () => {
    const page =
      bookingFailureAlert(timeoutAsRetryable(new DeadlineExceededError("google events.insert", 8000)))?.message ?? "";
    expect(page).not.toMatch(/finishes|will finish|can still receive/i);
  });

  // The page is sent AFTER the confirm's budget may already be spent, so it has to
  // run under the cleanup allowance, or the alert about the timeout would itself
  // fail at once on its alert_state read.
  it("sends the page under the cleanup allowance", async () => {
    let label: string | undefined;
    alert.mockImplementationOnce(async () => {
      label = deadlineWithinBudget(60_000, "probe").reportAs.budget?.label;
    });
    createBooking.mockRejectedValue(new DeadlineExceededError("google events.insert", 8000));
    await serviceCreateBooking(input).catch(() => {});
    expect(label).toBe("the booking cleanup");
  });

  // #3134: an open Google breaker refuses verify-on-book's reads at once. It must
  // reach the lead as the same retryable 503 a timeout does, never as a 500 and
  // never as a booking.
  it("answers an open Google breaker as the retryable outage", async () => {
    createBooking.mockRejectedValue(new GoogleBreakerOpenError(30_000));
    const caught = await serviceCreateBooking(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(VerifyUnavailableError);
    expect((caught as Error).message).toBe(new VerifyUnavailableError().message);
    expect(alert.mock.calls[0]?.[0]).toBe("verify_on_book_outage");
  });

  it("leaves every other failure exactly as it was", async () => {
    const taken = new SlotUnavailableError();
    expect(timeoutAsRetryable(taken)).toBe(taken);
    const boom = new Error("boom");
    expect(timeoutAsRetryable(boom)).toBe(boom);
    createBooking.mockRejectedValue(boom);
    await expect(serviceCreateBooking(input)).rejects.toBe(boom);
    expect(alert).not.toHaveBeenCalled();
  });
});
