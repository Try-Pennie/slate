import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// What the cal.com dual-write REPORTS, which is what a person reads mid-incident
// and what any retry has to act on (#1250, #1249).
//
// Two distinct things must never collapse into one answer:
//   - cal.com answered and genuinely has no such user. Nobody can book them there,
//     so there is no availability to block and nothing for anyone to do: a SKIP.
//   - the call failed (a rotated key, a 500, a changed response shape). The
//     integration is broken and the override did not land: a FAILURE, and the
//     message must name the cause it actually measured.
//
// Reporting the second as "no cal.com user for <email>" sends the reader looking
// for a missing person instead of a broken integration, and a retry built on it
// would re-attempt writes that can never succeed.
const env = vi.hoisted(() => ({
  orgId: "19474",
  apiKey: "key-1",
  baseUrl: "https://api.cal.com/v2",
}));

vi.mock("@/lib/env", () => ({
  calcomOrgId: () => env.orgId,
  calcomApiKey: () => env.apiKey,
  calcomBaseUrl: () => env.baseUrl,
}));

import { addOooOverrides, calcomRoutedSlots, removeOooOverrides } from "./client";
import {
  isFailure,
  isProvisionalSkip,
  isSettled,
} from "@/lib/monitor/calcom-override-sweep";

/** One queued response per fetch call, in order. */
type Reply = { status: number; data?: unknown };
let replies: Reply[] = [];
let urls: string[] = [];
/** Every request body sent, so a PATCH's override list can be read back (#2417). */
let bodies: unknown[] = [];

const SCHEDULE = {
  id: 55,
  name: "Working Hours",
  timeZone: "America/New_York",
  isDefault: true,
  availability: [{ days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" }],
  overrides: [],
};

beforeEach(() => {
  env.orgId = "19474";
  env.apiKey = "key-1";
  replies = [];
  urls = [];
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      urls.push(String(url));
      if (init?.body) bodies.push(JSON.parse(init.body));
      const next = replies.shift() ?? { status: 500 };
      return {
        status: next.status,
        json: async () => ({ data: next.data }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = () =>
  addOooOverrides("agent@trypennie.com", "2026-08-07T13:00:00Z", "2026-08-07T21:00:00Z", []);

describe("cal.com override outcome: absent versus failed (#1250, #1249)", () => {
  it("reports a genuinely absent user as a skip, not a failure", async () => {
    replies = [{ status: 200, data: [] }]; // cal.com answered: nobody by that email
    const outcome = await run();
    expect(outcome).toMatch(/^skipped/);
    expect(outcome).not.toMatch(/^failed/);
  });

  it("reports an expired or rotated key as a failure naming the status", async () => {
    replies = [{ status: 401 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("401");
    // The dangerous message: it asserts a cause the code never measured.
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a cal.com server error as a failure naming the status", async () => {
    replies = [{ status: 500 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("500");
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a changed response shape as a failure, not as every agent missing", async () => {
    // If cal.com stops returning a bare array, EVERY lookup would otherwise read
    // as "this person does not exist" and every approval would page a false cause.
    replies = [{ status: 200, data: { users: [{ id: 7 }] } }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a failing schedule lookup as a failure naming the status", async () => {
    // The same collapse one call later: this is a class of two sites, not one.
    replies = [{ status: 200, data: [{ id: 7 }] }, { status: 403 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("403");
    expect(outcome).not.toMatch(/no schedule for/);
  });

  it("still reports a real user who has no schedule as a failure", async () => {
    // Distinct from the cases above: cal.com answered, the user exists, and there
    // genuinely is no schedule to patch. Someone can fix that, so it stays a failure.
    replies = [{ status: 200, data: [{ id: 7 }] }, { status: 200, data: [] }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
  });

  it("skips rather than fails when cal.com is not configured", async () => {
    env.orgId = "";
    env.apiKey = "";
    const outcome = await run();
    expect(outcome).toMatch(/^skipped/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a transient server error and succeeds on the second attempt", async () => {
    // The failure that actually consumed the protection in June was a 500 on the
    // patch. A 500 is transient and very likely succeeds seconds later, so the
    // override should land rather than depend on someone reading a Slack message.
    replies = [
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 500 }, // patch fails
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} }, // patch succeeds
    ];
    const outcome = await run();
    expect(outcome).toBe("ok");
  });

  it("retries a rate limit", async () => {
    replies = [
      { status: 429 },
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} },
    ];
    expect(await run()).toBe("ok");
  });

  it("does NOT retry a rejected key, because a second attempt cannot succeed", async () => {
    replies = [{ status: 401 }, { status: 200, data: [{ id: 7 }] }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("401");
    // One attempt only: burning retries on a permanent failure just delays the
    // report and hammers a system that is already refusing us.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a genuinely absent user", async () => {
    replies = [{ status: 200, data: [] }];
    expect(await run()).toMatch(/^skipped/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts and reports the last cause", async () => {
    replies = Array.from({ length: 20 }, () => ({ status: 503 }));
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("503");
    // Bounded: the approval is a person waiting on a click, not a background job.
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("returns ok when the override patch succeeds", async () => {
    replies = [
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} },
    ];
    const outcome = await run();
    expect(outcome).toBe("ok");
    expect(urls.at(-1)).toContain("/schedules/55");
  });
});

// #1276: the outcome string is a CONTRACT between this client, which writes it
// into ooo_requests.side_effects, and the override sweep, which decides from it
// whether to retry and whether to page. Asserted from the PRODUCING end and
// through the sweep's real classifier, never by restating the literal: reword
// the sentence below without this and the sweep silently reverts to treating
// "not in cal.com" as terminal, which is the exact defect #1276 fixes (L35, L26).
describe("the outcome vocabulary the override sweep classifies on (#1276)", () => {
  it("an agent with no cal.com account is classified as PROVISIONAL by the sweep itself", async () => {
    replies = [{ status: 200, data: [] }]; // cal.com answered: nobody by that email
    const outcome = await run();

    expect(isProvisionalSkip(outcome)).toBe(true);
    expect(isSettled(outcome)).toBe(false); // so it is looked at again
    expect(isFailure(outcome)).toBe(false); // and never pages
    // The email rides along for diagnosis, and must survive the prefix contract.
    expect(outcome).toContain("agent@trypennie.com");
  });

  it("an unconfigured cal.com is classified as TERMINAL by the sweep itself", async () => {
    // Unconfigured is exactly "no org id / no key", so it is produced the way it
    // really occurs rather than by stubbing the predicate that reads them.
    env.apiKey = "";
    const outcome = await run();
    env.apiKey = "key-1";

    expect(isSettled(outcome)).toBe(true); // never swept again
    expect(isProvisionalSkip(outcome)).toBe(false);
    expect(isFailure(outcome)).toBe(false);
  });

  it("a real error is classified as a FAILURE, so it still pages mid absence", async () => {
    replies = [{ status: 401 }];
    const outcome = await run();

    expect(isFailure(outcome)).toBe(true);
    expect(isSettled(outcome)).toBe(false);
    expect(isProvisionalSkip(outcome)).toBe(false);
  });
});

// #2417: what this client PATCHes is the date's whole override list, derived
// from every approved absence touching that date. Asserted on the availability
// the patched list adds up to, because cal.com reads a date's overrides
// additively: two individually correct rows union into a day neither describes.
describe("a date's overrides are derived from every approved absence on it (#2417)", () => {
  // 2026-08-07 is a Friday; the fixture schedule is Mon-Fri 09:00-17:00 ET.
  // 09:00 ET = 13:00Z, 12:00 ET = 16:00Z, 13:00 ET = 17:00Z, 17:00 ET = 21:00Z.
  const MORNING = { startIso: "2026-08-07T13:00:00Z", endIso: "2026-08-07T16:00:00Z" };
  const AFTERNOON = { startIso: "2026-08-07T17:00:00Z", endIso: "2026-08-07T21:00:00Z" };

  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  type Span = { date: string; startTime: string; endTime: string };
  const lastPatched = (): Span[] =>
    ((bodies.at(-1) as { overrides?: Span[] } | undefined)?.overrides ?? []);

  /** The union of the patched list's spans on a date, as "HH:mm-HH:mm" pieces. */
  const offered = (date: string): string => {
    const onDate = lastPatched().filter((o) => o.date === date);
    if (onDate.length === 0) return "the normal week";
    const spans = onDate
      .map((o) => [minutes(o.startTime), minutes(o.endTime)] as [number, number])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    if (spans.length === 0) return "nothing";
    const merged: [number, number][] = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const pad = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return merged.map(([s, e]) => `${pad(s)}-${pad(e)}`).join(" + ");
  };

  /** Queue a user lookup, a schedule carrying `held`, and a successful patch. */
  const withStored = (held: Span[]) => {
    replies = [
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [{ ...SCHEDULE, overrides: held }] },
      { status: 200, data: {} },
    ];
  };

  it("leaves only the hour between two partial absences, not the whole day", async () => {
    // The morning absence is already approved and its override is what cal.com
    // holds. Approving the afternoon one must NOT add a second span beside it.
    withStored([{ date: "2026-08-07", startTime: "12:00", endTime: "17:00" }]);
    const outcome = await addOooOverrides(
      "agent@trypennie.com",
      AFTERNOON.startIso,
      AFTERNOON.endIso,
      [MORNING],
    );
    expect(outcome).toBe("ok");
    expect(offered("2026-08-07")).toBe("12:00-13:00");
  });

  it("gives back everything except the remaining absence when one is cancelled", async () => {
    withStored([{ date: "2026-08-07", startTime: "12:00", endTime: "13:00" }]);
    const outcome = await removeOooOverrides(
      "agent@trypennie.com",
      MORNING.startIso,
      MORNING.endIso,
      [AFTERNOON],
    );
    expect(outcome).toBe("ok");
    expect(offered("2026-08-07")).toBe("09:00-13:00");
  });

  it("writes cal.com's whole-day block when the absences cover the working day", async () => {
    // Abutting windows: 09:00-12:00 and 12:00-17:00. An EMPTY override list here
    // would mean "no override", which falls back to the normal week.
    const abutting = { startIso: "2026-08-07T16:00:00Z", endIso: "2026-08-07T21:00:00Z" };
    withStored([{ date: "2026-08-07", startTime: "12:00", endTime: "17:00" }]);
    const outcome = await addOooOverrides(
      "agent@trypennie.com",
      abutting.startIso,
      abutting.endIso,
      [MORNING],
    );
    expect(outcome).toBe("ok");
    expect(offered("2026-08-07")).toBe("nothing");
    expect(lastPatched()).toContainEqual({
      date: "2026-08-07",
      startTime: "00:00",
      endTime: "00:00",
    });
  });

  it("carries overrides on other dates across untouched", async () => {
    const foreign = { date: "2026-09-01", startTime: "00:00", endTime: "00:00" };
    withStored([foreign]);
    await addOooOverrides("agent@trypennie.com", MORNING.startIso, MORNING.endIso, []);
    expect(lastPatched()).toContainEqual(foreign);
  });

  it("does NOT report success for a removal that found no override to remove", async () => {
    // L100: cal.com holding nothing on the date means the approval's write never
    // landed, or something else took it away. The schedule is still rewritten to
    // what Slate says, and the outcome says what was actually measured.
    withStored([]);
    const outcome = await removeOooOverrides(
      "agent@trypennie.com",
      MORNING.startIso,
      MORNING.endIso,
      [],
    );
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("2026-08-07");
    // The patch still went out, so cal.com is left correct either way.
    expect(urls.at(-1)).toContain("/schedules/55");
  });

  it("reports ok for a removal that did find the override it was undoing", async () => {
    withStored([{ date: "2026-08-07", startTime: "12:00", endTime: "17:00" }]);
    const outcome = await removeOooOverrides(
      "agent@trypennie.com",
      MORNING.startIso,
      MORNING.endIso,
      [],
    );
    expect(outcome).toBe("ok");
    expect(offered("2026-08-07")).toBe("the normal week");
  });
});

// #2927 follow up: the pilot offer sample runs on the monitor lane, so a cal.com
// call that never answers would stall every check after it with nothing recorded.
describe("calcomRoutedSlots", () => {
  const WINDOW = {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-02T00:00:00.000Z",
    timeZone: "America/New_York",
  };

  // #3002: without a timeZone cal.com answers a truncated list (measured
  // 2026-10-02: Friday stopped at 3:30pm ET while the live booker ran to 7:40pm).
  it("asks in the time zone it was given", async () => {
    replies = [{ status: 200, data: { eventTypeId: 1, slots: {} } }];
    await calcomRoutedSlots("form-1", { xbc: 112 }, WINDOW);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("timeZone")).toBe("America/New_York");
    expect([q.get("start"), q.get("end")]).toEqual([WINDOW.start, WINDOW.end]);
  });

  it("refuses an empty time zone rather than asking without one", async () => {
    await expect(calcomRoutedSlots("form-1", { xbc: 112 }, { ...WINDOW, timeZone: " " })).rejects.toThrow("time zone");
    expect(urls).toEqual([]);
  });

  it("asks the routing form's calculate-slots with the lead's fields", async () => {
    replies = [{ status: 200, data: { eventTypeId: 1, slots: {} } }];
    const out = await calcomRoutedSlots("form-1", { xbc: 112 }, WINDOW);
    expect(out.status).toBe(200);
    expect(urls[0]).toContain("/routing-forms/form-1/calculate-slots?");
    expect(bodies[0]).toEqual({ xbc: 112 });
  });

  it("gives up on a cal.com that never answers, so the caller records a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    await expect(
      calcomRoutedSlots("form-1", { xbc: 112 }, WINDOW, 20),
    ).rejects.toThrow();
  });

  it("refuses when cal.com is not configured here", async () => {
    env.apiKey = "";
    await expect(
      calcomRoutedSlots("form-1", { xbc: 112 }, WINDOW),
    ).rejects.toThrow("not configured");
  });
});
