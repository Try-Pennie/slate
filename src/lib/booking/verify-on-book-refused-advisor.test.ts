import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3700: one advisor whose Google account is REFUSED (archived in the Workspace, so
// Google answers their calendar with `403 notACalendarUser`) must be left out of the
// wave, not fail it and not read as an outage.
//
// Measured 2026-10-13: smoketest2 was archived for #3667, and from 3:35 PM ET every
// canary booking on bucket SMOKE answered 500, although smoketest@ in the same bucket
// was readable and free. #3845 has since stopped the 500 (the per agent read failing
// outright scores the agent unverified), which left the lead a retriable "try again"
// for a slot no retry can ever fix, and a pool of one archived advisor paging as a
// Google outage. A definitive refusal is now its own verdict: neither free nor
// unverified, so the next free advisor is booked and a pool with nobody else answers
// the ordinary no availability refusal.
//
// Everything below the Supabase client, the token mint and the Google HTTP call is
// the real shipped wiring: `realDeps().verifyFree` and its per agent fallback, read
// through the real `selectAgent`, which is how `assignAgent` picks an advisor. What
// `assignAgent` then throws is read off the outcome exactly as it does: a null
// assignment with `anyUnverified` is `VerifyUnavailableError` (the retriable outage),
// and without it `SlotUnavailableError` (pick another time).

const REFUSED = "archived@trypennie.com";
const OK1 = "ok1@trypennie.com";
const OK2 = "ok2@trypennie.com";
const START = "2026-06-08T15:00:00.000Z";
const END = "2026-06-08T15:30:00.000Z";

const ids = vi.hoisted(() => ({
  byEmail: {
    "archived@trypennie.com": "u-archived",
    "ok1@trypennie.com": "u-ok1",
    "ok2@trypennie.com": "u-ok2",
  } as Record<string, string>,
}));

vi.mock("@/lib/supabase/admin", () => {
  const emailById = Object.fromEntries(Object.entries(ids.byEmail).map(([e, id]) => [id, e]));
  // Each advisor holds one synced calendar, their own primary (the calendar id IS
  // the email), so every Supabase read succeeds and the only fault is Google's.
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: async (_col: string, values: string[]) =>
          table === "agent_calendars"
            ? { data: values.map((id) => ({ user_id: id, calendar_id: emailById[id] })), error: null }
            : { data: values.map((email) => ({ id: ids.byEmail[email], email })), error: null },
        eq: (_col: string, value: string) => ({
          maybeSingle: async () => ({ data: { id: ids.byEmail[value] }, error: null }),
          then: (resolve: (r: unknown) => unknown) =>
            resolve({ data: [{ calendar_id: emailById[value] }], error: null }),
        }),
      }),
    }),
  };
  return { supabaseAdmin: vi.fn(() => client) };
});

// The token is minted per identity, so the fake Google below can answer each call
// as the identity it was made as.
const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn(async (email: string) => `tok:${email}`) }));
vi.mock("@/lib/google/dwd", () => dwd);

vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
  resolveRecovered: vi.fn(async () => {}),
}));

import { realDeps } from "./service";
import { selectAgent } from "./core";
import { googleBreaker } from "@/lib/google/calendar";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Every Google call this run made: the identity it was made as and the calendars it asked about. */
let googleCalls: { as: string; items: string[] }[] = [];

/**
 * A fake Google. A call made AS a refused identity answers 403 `notACalendarUser`,
 * the way Google answered smoketest2 on 2026-10-13. A call made as anyone else
 * answers every calendar clean, except a refused advisor's own, which Google will
 * not report on (`notFound` inside the 200). `transient` answers every call 503.
 */
function google(opts: { refused?: string[]; transient?: boolean; busy?: string[] } = {}) {
  const refused = new Set(opts.refused ?? []);
  const busy = new Set(opts.busy ?? []);
  googleCalls = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const auth = String((init.headers as Record<string, string>).authorization ?? "");
    const as = auth.replace(/^Bearer tok:/, "");
    const items = (JSON.parse(String(init.body)) as { items: { id: string }[] }).items.map((i) => i.id);
    googleCalls.push({ as, items });
    if (opts.transient) return json({ error: { code: 503, errors: [{ reason: "backendError" }] } }, 503);
    if (refused.has(as)) {
      return json(
        { error: { code: 403, message: "The user must be signed up for Google Calendar.", errors: [{ reason: "notACalendarUser" }] } },
        403,
      );
    }
    return json({
      calendars: Object.fromEntries(
        items.map((id) => [
          id,
          refused.has(id)
            ? { errors: [{ domain: "global", reason: "notFound" }] }
            : { busy: busy.has(id) ? [{ start: START, end: END }] : [] },
        ]),
      ),
    });
  });
}

/** The confirm's selection over these advisors, through the real live check. */
async function select(emails: string[]) {
  const verify = realDeps().verifyFree;
  return selectAgent(
    emails.map((e) => ids.byEmail[e]),
    async (userIds) => new Map(userIds.map((id) => [id, Object.keys(ids.byEmail).find((e) => ids.byEmail[e] === id)!])),
    (wave, waveIds) => verify(wave, START, END, waveIds),
    10,
  );
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  googleBreaker.reset();
  dwd.getDelegatedToken.mockReset();
  dwd.getDelegatedToken.mockImplementation(async (email: string) => `tok:${email}`);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an advisor Google refuses is left out of the wave (#3700)", () => {
  it("a wave of two whose first is refused notACalendarUser books the second", async () => {
    google({ refused: [REFUSED] });

    const res = await realDeps().verifyFree([REFUSED, OK1], START, END);
    expect([...res.free]).toEqual([OK1]);
    // The refusal is not an outage: no retry fixes an archived account.
    expect([...res.unverified]).toEqual([]);

    const picked = await select([REFUSED, OK1]);
    expect(picked.assignment?.email).toBe(OK1);
  });

  it("a wave whose only candidate is refused answers the no availability refusal, not the outage", async () => {
    google({ refused: [REFUSED] });

    const picked = await select([REFUSED]);

    // `assignAgent` throws SlotUnavailableError on exactly this outcome.
    expect(picked.assignment).toBeNull();
    expect(picked.anyUnverified).toBe(false);
  });

  it("logs the refusal, naming the advisor and how Google refused them", async () => {
    google({ refused: [REFUSED] });

    await realDeps().verifyFree([REFUSED, OK1], START, END);

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("refused"));
    expect(lines.some((l) => l.includes(`email="${REFUSED}"`) && l.includes(`failure="not-provisioned"`))).toBe(true);
  });

  // The control that keeps an outage an outage: a transient failure is still unverified.
  it("a transient 503 still answers the retriable outage", async () => {
    google({ transient: true });

    const res = await realDeps().verifyFree([OK1], START, END);
    expect([...res.unverified]).toEqual([OK1]);

    const picked = await select([OK1]);
    expect(picked.assignment).toBeNull();
    expect(picked.anyUnverified).toBe(true);
  });
});

// The guard on the refusal: Google refusing EVERY advisor in a wave of two or more is
// far likelier to be Slate's own credential (delegation revoked, a bad service account
// key, a clock skewed `invalid_grant` on the mint) than that many offboarded advisors,
// and it must stay the retriable outage that pages, never a quiet "pick another time"
// that walks the ladder down. A wave of one refused advisor is the archived one person
// pool this issue is about, and stays the no availability refusal (above).
describe("a wave Google refuses entirely is an outage, not a full slot (#3700)", () => {
  const ALL = [REFUSED, OK1, OK2];

  it("a wave of three all refused is the retriable outage, and says how many", async () => {
    google({ refused: ALL });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await realDeps().verifyFree(ALL, START, END);
    expect([...res.free]).toEqual([]);
    expect([...res.unverified].sort()).toEqual([...ALL].sort());

    const picked = await select(ALL);
    // `assignAgent` throws VerifyUnavailableError on exactly this outcome.
    expect(picked.assignment).toBeNull();
    expect(picked.anyUnverified).toBe(true);

    const lines = errors.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("every advisor") && l.includes("count=3"))).toBe(true);
  });

  it("the same holds for a token mint refused for every advisor", async () => {
    google();
    const { GoogleHttpError } = await import("@/lib/google/http-error");
    dwd.getDelegatedToken.mockImplementation(async () => {
      throw new GoogleHttpError("Delegated token failed: 400 invalid_grant", 400, "invalid_grant");
    });

    const res = await realDeps().verifyFree([OK1, OK2], START, END);

    expect([...res.unverified].sort()).toEqual([OK1, OK2]);
  });

  // The control: a refused advisor beside a BUSY one is a full slot, as before.
  it("a wave of two with one refused and one busy is still no availability", async () => {
    google({ refused: [REFUSED], busy: [OK1] });

    const res = await realDeps().verifyFree([REFUSED, OK1], START, END);
    expect([...res.free]).toEqual([]);
    expect([...res.unverified]).toEqual([]);

    const picked = await select([REFUSED, OK1]);
    expect(picked.assignment).toBeNull();
    expect(picked.anyUnverified).toBe(false);
  });
});

describe("a refused subject does not push the whole wave onto the per agent read (#3700)", () => {
  it("the bulk read is asked again as the next advisor, and only the refused one is read on their own", async () => {
    google({ refused: [REFUSED] });

    const res = await realDeps().verifyFree([REFUSED, OK1, OK2], START, END);

    expect([...res.free].sort()).toEqual([OK1, OK2]);
    expect([...res.unverified]).toEqual([]);
    // One bulk call as the refused advisor, one as the next advisor covering everyone
    // else, and the refused advisor's own read. OK2 is never read on their own.
    expect(googleCalls).toEqual([
      { as: REFUSED, items: [REFUSED, OK1, OK2] },
      { as: OK1, items: [OK1, OK2] },
      { as: REFUSED, items: [REFUSED] },
    ]);
  });

  // A DELETED account fails one step earlier, at the token mint, which Google refuses
  // with a 400 (`invalid_grant`). That is a refusal of the subject too.
  it("a token mint refused for the subject is retried as the next advisor too", async () => {
    google();
    const { GoogleHttpError } = await import("@/lib/google/http-error");
    dwd.getDelegatedToken.mockImplementation(async (email: string) => {
      if (email === REFUSED) throw new GoogleHttpError("Delegated token failed: 400 invalid_grant", 400, "invalid_grant");
      return `tok:${email}`;
    });

    const res = await realDeps().verifyFree([REFUSED, OK1, OK2], START, END);

    expect([...res.free].sort()).toEqual([OK1, OK2]);
    expect([...res.unverified]).toEqual([]);
    expect(googleCalls).toEqual([{ as: OK1, items: [OK1, OK2] }]);
  });

  it("a transient bulk failure is not retried as another subject: every advisor is read on their own, as before", async () => {
    google({ transient: true });

    const res = await realDeps().verifyFree([OK1, OK2], START, END);

    expect([...res.unverified].sort()).toEqual([OK1, OK2]);
    expect(googleCalls.filter((c) => c.items.length > 1)).toEqual([{ as: OK1, items: [OK1, OK2] }]);
  });

  it("two refused subjects in a row fall back per agent rather than walking the wave", async () => {
    const SECOND = OK1;
    google({ refused: [REFUSED, SECOND] });

    const res = await realDeps().verifyFree([REFUSED, SECOND, OK2], START, END);

    expect([...res.free]).toEqual([OK2]);
    expect([...res.unverified]).toEqual([]);
    // Two bulk calls, then everyone on their own: no third bulk call as OK2.
    expect(googleCalls.slice(0, 2)).toEqual([
      { as: REFUSED, items: [REFUSED, SECOND, OK2] },
      { as: SECOND, items: [SECOND, OK2] },
    ]);
    expect(googleCalls.slice(2).map((c) => c.as).sort()).toEqual([REFUSED, SECOND, OK2].sort());
    expect(googleCalls.slice(2).every((c) => c.items.length === 1 && c.items[0] === c.as)).toBe(true);
  });
});
