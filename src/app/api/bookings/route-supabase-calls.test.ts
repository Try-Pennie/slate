import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3416: how many Supabase round trips a booking API create makes BEFORE it reaches the
// confirm line, and how many a follower makes before it is answered from the line.
//
// Load run 37547143303 put a hundred confirms for one slot into the same second. Every one
// spent 3 to 5 seconds in `route-checks` (the authorizer and the body read) and the leader's
// own Supabase calls took up to 3 seconds each, while every statement inside Postgres was
// fast. The queue was the Supabase API layer's few connections on a Micro database, filled
// by the CROWD's calls made before the line: whatever a confirm asks Supabase before it joins
// the line, a burst asks a hundred times at once, and the one confirm that will actually book
// waits behind all of them.
//
// So this drives the REAL route, the real authorizer, the real limiters and the real booking
// service, with only the outside world faked: the Supabase HTTP API (a stubbed `fetch`, so
// every request the real client sends is counted), the Cloudflare bindings, and the
// orchestration's `bookViaApi`, which stands for the confirm line itself (its first act is
// joining the line, #3257). Work deferred past the response (`after()`) is queued and run only
// once the answer exists, the way the platform runs it, so a call is charged to the side of
// the answer it really falls on.
//
// Measured on main at ac3d1d92, before this change:
//   - a create made 2 Supabase calls before the line: `rate_limit_hit` for the hourly per key
//     ceiling and again for the hourly per address ceiling (both in `authorizeBookingApi`);
//   - a follower refused from the line made the same 2 and nothing more before its answer;
//   - a follower that timed out waiting in the line made those 2 plus the outage page's
//     `alert_state` read, 3, before its answer.
// The caller sighting, the outcome tally and the stored offer check were already deferred.

const SUPABASE = "https://db.test";
const IP = "203.0.113.9";

/** Everything that happened, in order: a Supabase request, a call to the edge counter, the
 *  confirm line being reached, and the answer. */
const events = vi.hoisted(() => [] as string[]);
/** What the fake line does with the next confirm. */
const line = vi.hoisted(() => ({ next: "lead" as "lead" | "refused" | "timed-out" }));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  bookingApiKeyFor: (caller: string, slot: string) => (caller === "regal" && slot === "primary" ? "real-secret" : ""),
  publicSupabaseUrl: () => SUPABASE,
  supabaseSecretKey: () => "sb_secret_test",
  appUrl: () => "https://slate.test",
  // Slack configured, so the outage page reads its cooldown exactly as production does.
  slackBotToken: () => "xoxb-test",
}));

// Production's answer on the runtime question, so every alert path behaves as it would live.
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime: () => true, workersRuntimeMarker: () => "test" }));

/** The Cloudflare bindings: the native limiters allow everything, and the Durable Object
 *  counter answers whatever it is asked, recording that it was asked. */
const cf = vi.hoisted(() => {
  const allow = { limit: async () => ({ success: true }) };
  const counts = new Map<string, number>();
  const burstLimiter = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const name = String(id);
        const body = JSON.parse(String(init?.body ?? "{}")) as { bump?: number; hit?: { windowMs?: number } };
        events.push(`counter:${name}`);
        const count = (counts.get(name) ?? 0) + (body.hit ? 1 : (body.bump ?? 1));
        counts.set(name, count);
        return Response.json({
          count,
          windowStartMs: 0,
          ...(body.hit ? { windowMs: body.hit.windowMs } : {}),
        });
      },
    }),
  };
  return {
    counts,
    burstLimiter,
    env: {
      BOOKINGAPI_RATE_LIMITER: allow,
      BOOKINGAPI_IP_RATE_LIMITER: allow,
      BOOKINGAPI_READ_RATE_LIMITER: allow,
      BURST_LIMITER: burstLimiter,
    } as Record<string, unknown>,
  };
});
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: cf.env }) }));

// Deferred work is QUEUED and run only after the answer, the way the platform runs it.
const afterQueue = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn);
  },
}));

// The confirm line, as the orchestration's entry: joining the line is the first thing
// `bookViaApi` does (#3257), so reaching this IS reaching the line. A leader books; a
// follower is answered from the line, either refused because the leader took the time or
// timed out waiting behind it.
vi.mock("@/lib/booking/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/orchestration")>();
  return {
    ...actual,
    bookViaApi: async () => {
      events.push("line");
      if (line.next === "refused") throw new actual.SlotUnavailableError();
      if (line.next === "timed-out") {
        throw new actual.DependencyTimeoutError(
          { label: "the confirm ahead of it in line", timeoutMs: 5_000, budget: null },
          null,
        );
      }
      return {
        outcome: "created",
        booking: {
          id: "bk-1",
          external_id: "lead-abc-123",
          starts_at: "2026-07-01T15:00:00.000Z",
          ends_at: "2026-07-01T15:30:00.000Z",
          status: "confirmed",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          attendee_name: "Dana Lee",
          attendee_email: "dana@example.com",
          attendee_phone: "2155550100",
          manage_token: "tok",
          prefill: null,
          routing_trace: { bucket_code: "411" },
        },
        manageUrl: "https://slate.test/booking/manage/tok",
      };
    },
  };
});

import { POST } from "./route";
import { POOL_GROUPING_RETRY_MS } from "@/lib/booking/pool-grouping-reader";
import { LIMITER_FAIL_OPEN_PAGE_AFTER } from "@/lib/rate-limit-core";

const BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
  salesforceId: "00Q5x000001abcEAA",
  externalId: "lead-abc-123",
};

/** Every call to the pool grouping directory (#3460), by op, across a whole burst. */
const directoryCalls: string[] = [];
/** The `CONFIRM_LINE` binding, serving only the directory: it holds no snapshot, the
 *  state in which a server would otherwise fetch again for every confirm. */
const emptyDirectory = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (_url: string, init?: RequestInit) => {
      directoryCalls.push(String((JSON.parse(String(init?.body ?? "{}")) as { op?: unknown }).op));
      return Response.json({ kind: "grouping", snapshot: null });
    },
  }),
};

/** What the outcome tally was asked to count, and which alert cooldowns were read. */
const seen = { outcomes: [] as string[], alertKeys: [] as string[] };

/** The Supabase HTTP API: every request is recorded by path, and answered the way the real
 *  one would for what the code under test asks. */
function supabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== SUPABASE) throw new Error(`unexpected fetch to ${url.origin}`);
  events.push(`supabase:${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname === "/rest/v1/rpc/bump_booking_api_outcome") {
    seen.outcomes.push(String((JSON.parse(String(init?.body ?? "{}")) as { p_outcome?: unknown }).p_outcome));
  }
  if (url.pathname === "/rest/v1/alert_state") seen.alertKeys.push(url.searchParams.get("key") ?? "");
  if (url.pathname === "/rest/v1/rpc/rate_limit_hit") return Promise.resolve(Response.json(true));
  // The outage page's cooldown, armed a moment ago by an earlier page in the same burst.
  if (url.pathname === "/rest/v1/alert_state") {
    return Promise.resolve(Response.json([{ last_sent_at: new Date().toISOString() }]));
  }
  return Promise.resolve(Response.json([]));
}

/** One confirm through the real route; the events it caused, split at the line and the answer. */
async function confirm(kind: typeof line.next) {
  line.next = kind;
  events.length = 0;
  const res = await POST(
    new Request("http://localhost/api/bookings", {
      method: "POST",
      headers: { authorization: "Bearer real-secret", "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify(BODY),
    }) as never,
  );
  events.push("answered");
  while (afterQueue.length > 0) await afterQueue.shift()!();
  const lineAt = events.indexOf("line");
  const answeredAt = events.indexOf("answered");
  const supabase = (from: number, to: number) => events.slice(from, to).filter((e) => e.startsWith("supabase:"));
  return {
    status: res.status,
    body: (await res.json()) as { code?: string; outcome?: string },
    reachedLine: lineAt >= 0,
    beforeLine: supabase(0, lineAt < 0 ? answeredAt : lineAt),
    beforeAnswer: supabase(0, answeredAt),
    afterAnswer: supabase(answeredAt + 1, events.length),
    counterAsked: events.slice(0, lineAt < 0 ? answeredAt : lineAt).filter((e) => e.startsWith("counter:")),
  };
}

beforeEach(() => {
  afterQueue.length = 0;
  cf.counts.clear();
  cf.env.BURST_LIMITER = cf.burstLimiter;
  delete cf.env.CONFIRM_LINE;
  directoryCalls.length = 0;
  seen.outcomes.length = 0;
  seen.alertKeys.length = 0;
  vi.stubGlobal("fetch", supabaseFetch);
  // The route logs every answer; nothing here reads the log.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * #3460, #3355 item 1: the shared line switch read now STARTS before the line, the moment
 * the key is good, so it runs during the ceilings' I/O rather than after them. It is the
 * one read the line already made before entering (`decide`), through the same cached
 * reader, so it moves earlier and adds nothing: one per server per TTL, however many
 * confirms arrive. The case below the first describe pins that bound; every other call
 * before the line is still none.
 */
const SWITCH_READ = "supabase:GET /rest/v1/booking_settings";
const beyondSwitch = (calls: string[]) => calls.filter((e) => e !== SWITCH_READ);

describe("Supabase round trips around the confirm line (#3416)", () => {
  it("a create reaches the line having made no Supabase call but the cached switch read", async () => {
    const out = await confirm("lead");
    expect(out.status).toBe(200);
    expect(out.reachedLine).toBe(true);
    expect(beyondSwitch(out.beforeLine)).toEqual([]);
  });

  it("#3460 the switch read started before the line is one per server per TTL, never one per confirm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Past any reading an earlier case cached, so this server reads the switch afresh.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const first = await confirm("lead");
      // The positive control (L1): the count sees the switch read, and it is the only call.
      expect(first.beforeLine).toEqual([SWITCH_READ]);
      const second = await confirm("lead");
      const third = await confirm("refused");
      expect([...second.beforeAnswer, ...third.beforeAnswer]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The other half of the same claim. "No Supabase call before the line" is also what a
  // build that DELETED the hourly ceilings would show, so the ceilings have to be seen to
  // run: each is asked of the edge counter, under the key its Postgres row was keyed by.
  it("and still asks both hourly ceilings, of the edge counter, before the line", async () => {
    const out = await confirm("lead");
    expect(out.counterAsked).toContain("counter:exact:bookapi:h:key:regal");
    expect(out.counterAsked).toContain(`counter:exact:bookapi:ip:h:ip:${IP}`);
  });

  it("a follower refused from the line is answered having made NO Supabase call", async () => {
    const out = await confirm("refused");
    expect(out.status).toBe(409);
    expect(out.body.code).toBe("SLOT_TAKEN");
    expect(beyondSwitch(out.beforeAnswer)).toEqual([]);
  });

  it("a follower that timed out in the line is answered having made NO Supabase call", async () => {
    const out = await confirm("timed-out");
    expect(out.status).toBe(503);
    expect(out.body.code).toBe("VERIFY_UNAVAILABLE");
    expect(beyondSwitch(out.beforeAnswer)).toEqual([]);
  });

  // The positive control (L1, L98): an empty list above is only evidence if this counter can
  // see a Supabase call at all. The outcome tally a refusal records is one, after the answer.
  it("CONTROL: the count sees the calls that run after the answer", async () => {
    const out = await confirm("refused");
    expect(out.afterAnswer).toContain("supabase:POST /rest/v1/rpc/bump_booking_api_outcome");
  });

  // Moved, not dropped: the timed out follower's outage page still reads its cooldown, once
  // the answer has gone.
  it("the outage page a timed out follower owes still runs, after the answer", async () => {
    const out = await confirm("timed-out");
    expect(out.afterAnswer).toContain("supabase:GET /rest/v1/alert_state");
    expect(seen.alertKeys).toEqual(["eq.verify_on_book_outage"]);
  });
});

// Review of #3471: the early reads start the moment the key is good, BEFORE the hourly
// ceilings answer, so a caller with a good key over its ceiling starts them too. That is
// only acceptable while what it starts is bounded per SERVER, never per request. So drive
// a burst of requests the per key ceiling refuses at a cold server whose directory holds
// nothing (the state in which an unbounded reader would fetch on every request), and
// count every call either read makes.
describe("a good key over its ceiling starts only the coalesced reads (#3460)", () => {
  it("a burst of refused requests costs one switch read and one directory call, however many it sends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Past any switch reading or fetch an earlier case left, so this server is cold.
      vi.setSystemTime(Date.now() + 20 * 60_000);
      cf.env.CONFIRM_LINE = emptyDirectory;
      cf.counts.set("exact:bookapi:h:key:regal", 10_000);
      const burst = async (n: number) => {
        const switchReads: string[] = [];
        const before = directoryCalls.length;
        for (let i = 0; i < n; i++) {
          const out = await confirm("lead");
          expect(out.status).toBe(429);
          expect(out.body).toEqual({ error: "Rate limit exceeded for this API key." });
          expect(out.reachedLine).toBe(false);
          switchReads.push(...[...out.beforeAnswer, ...out.afterAnswer].filter((e) => e === SWITCH_READ));
        }
        return { switchReads: switchReads.length, directory: directoryCalls.slice(before) };
      };
      const first = await burst(25);
      // The positive control (L1): the counts see both reads, so the ones below are not zero by blindness.
      expect(first.switchReads).toBe(1);
      expect(first.directory).toEqual(["grouping-get"]);
      // Inside the switch's TTL and the directory's retry window: nothing at all.
      const again = await burst(25);
      expect(again).toEqual({ switchReads: 0, directory: [] });
      // Once the retry window has passed, ONE more directory call for the whole next burst:
      // the bound is the clock, never the number of requests.
      vi.setSystemTime(Date.now() + POOL_GROUPING_RETRY_MS);
      const later = await burst(25);
      expect(later).toEqual({ switchReads: 0, directory: ["grouping-get"] });
    } finally {
      vi.useRealTimers();
    }
  });
});

// The hourly ceilings are a security control, so moving them must not loosen them. These drive
// the real route into each one at its real limit, and into a counter that cannot be reached.
describe("the hourly ceilings on the edge counter, through the route (#3416)", () => {
  it("still refuses the per address ceiling's 1201st request in an hour, as throttled_ip", async () => {
    cf.counts.set(`exact:bookapi:ip:h:ip:${IP}`, 1199);
    expect((await confirm("lead")).status).toBe(200);
    seen.outcomes.length = 0;
    const out = await confirm("lead");
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ error: "Rate limit exceeded for this client." });
    expect(out.reachedLine).toBe(false);
    // Counted under its own name and kept out of the failure share, as before (#1442).
    expect(seen.outcomes).toEqual(["refused_ceiling_ip"]);
  });

  it("still refuses the per caller ceiling's 6001st request in an hour, as throttled_key", async () => {
    cf.counts.set("exact:bookapi:h:key:regal", 5999);
    expect((await confirm("lead")).status).toBe(200);
    seen.outcomes.length = 0;
    const out = await confirm("lead");
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ error: "Rate limit exceeded for this API key." });
    expect(out.reachedLine).toBe(false);
    expect(seen.outcomes).toEqual(["refused_ceiling_key"]);
    // Refused at the caller's ceiling, so the address's was never spent on it.
    expect(cf.counts.get(`exact:bookapi:ip:h:ip:${IP}`)).toBe(1);
  });

  // THE DIRECTION, end to end. A ceiling whose counter cannot be read lets the request
  // through and pages, exactly as the Postgres ceiling did on an unreadable row. Refusing
  // here instead would turn a counter outage into a booking outage.
  it("serves a create when the counter cannot be reached, and pages the outage after the answer", async () => {
    cf.env.BURST_LIMITER = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("object unreachable");
        },
      }),
    };
    const out = await confirm("lead");
    expect(out.status).toBe(200);
    expect(out.reachedLine).toBe(true);
    expect(beyondSwitch(out.beforeLine)).toEqual([]);
    // #3670: one count that could not be made is a log line, never a page. `confirm` has
    // already run the deferred work, so this reads what was really sent.
    expect(seen.alertKeys).not.toContain("eq.rate_limit_broken:bookapi:h");
    // A sustained run of them pages, after the answer, as before.
    for (let i = 1; i < LIMITER_FAIL_OPEN_PAGE_AFTER; i++) expect((await confirm("lead")).status).toBe(200);
    expect(seen.alertKeys).toEqual(expect.arrayContaining(["eq.rate_limit_broken:bookapi:h"]));
  });
});
