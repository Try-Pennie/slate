import { describe, it, expect, vi, beforeEach } from "vitest";

// #1989: a time off request whose form carried no timezone used to be read as
// Eastern, so an agent in Phoenix asking for 9 to 5 was booked out 7 to 3 their
// time, and the request reported success. Refused instead, with the message the
// form draws, and nothing submitted.
const submitOoo = vi.hoisted(() => vi.fn());
const modifyOoo = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({ id: "a1", role: "agent", org_id: "o1" })),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/ooo/service", () => ({ submitOoo, modifyOoo, cancelOoo: vi.fn() }));

import { modifyMyOoo, submitMyOoo } from "./actions";
import { MISSING_TIMEZONE_TIME_OFF } from "@/lib/submitted-timezone";

function oooForm(over: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    timezone: "America/Phoenix",
    start_date: "2026-10-20",
    end_date: "2026-10-20",
    start_time: "09:00",
    end_time: "17:00",
    reason: "Personal",
    request_id: "r1",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (v !== null) fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitOoo.mockResolvedValue({ ok: false, error: "stop here" });
  modifyOoo.mockResolvedValue({ ok: false, error: "stop here" });
});

describe("a time off request with no timezone (#1989)", () => {
  it("is refused on submit, with a message, and nothing is submitted", async () => {
    const state = await submitMyOoo({ error: null }, oooForm({ timezone: null }));
    expect(state.error).toBe(MISSING_TIMEZONE_TIME_OFF);
    expect(submitOoo).not.toHaveBeenCalled();
  });

  it("is refused on a change to an existing request too", async () => {
    const state = await modifyMyOoo({ error: null }, oooForm({ timezone: "  " }));
    expect(state.error).toBe(MISSING_TIMEZONE_TIME_OFF);
    expect(modifyOoo).not.toHaveBeenCalled();
  });

  // The control: with a zone the window is built in THAT zone, so the refusal
  // above is about the missing field and not about the action having stopped.
  it("CONTROL: a submitted zone is used as given, never Eastern", async () => {
    await submitMyOoo({ error: null }, oooForm());
    expect(submitOoo).toHaveBeenCalledTimes(1);
    const input = submitOoo.mock.calls[0][1] as { startIso: string; displayTzId: string };
    expect(input.displayTzId).toBe("America/Phoenix");
    expect(input.startIso).toBe("2026-10-20T16:00:00.000Z");
  });
});
