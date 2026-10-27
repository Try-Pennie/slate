import { describe, it, expect, vi, beforeEach } from "vitest";

// The 24 hour reminder lane's IO (#2500, #2496).
//
// Two properties live here and nowhere else, because both are about the QUERY and
// the wiring rather than about the pure decision beside them:
//
//  1. the worklist is cap safe. It used to be one `.limit(200)` page over every live
//     booking starting in the next 24 HOURS, with no filter on what had already been
//     reminded, so once more than 200 live bookings sat inside a day the page filled
//     with rows already dealt with and the unreminded ones behind them were never
//     reached. Nothing said so: the heartbeat stamped, `sent` stayed non zero, and a
//     truncated page reads exactly like the whole set (L101, L98).
//
//  2. a MASS failure reaches its own alert. One lead's refused address and every
//     reminder failing used to be the same single throttled message at the same rate.
//
// Both are driven through a fake PostgREST builder rather than the real client, so a
// page boundary can be produced on demand.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  /** Pages the bookings read hands back, in order. */
  pages: [] as Row[][],
  /** Every `.range(from, to)` the bookings read asked for. */
  ranges: [] as [number, number][],
  /** Every equality filter and projection the worklist read carried (#2660). */
  worklistFilters: [] as [string, unknown][],
  worklistSelects: [] as string[],
  bookingsReadError: null as { message: string } | null,
  claimed: [] as string[],
  /** Every conditional update on bookings: what it set and every equality it carried. */
  updates: [] as { set: Row; eqs: [string, unknown][] }[],
  /** The stored reminder rate window, or null for a first run. */
  rateRow: null as Row | null,
  rateReadError: null as { message: string } | null,
  upserts: [] as Row[],
  sendFailures: [] as (string | Error | null)[],
  sent: [] as { to: string[]; from?: string; subject: string; body?: string; attachments?: { content: string }[] }[],
}));

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
const email = vi.hoisted(() => ({
  sendGmailEmail: vi.fn(async (_msg: { to: string[]; subject: string }) => "gmail-id"),
}));

const admin = vi.hoisted(() => {
  function make(table: string) {
    let mode: "select" | "update" | "upsert" = "select";
    let updateId = "";
    let updateSet: Row = {};
    const updateEqs: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    const self = () => b as never;
    Object.assign(b, {
      select: (projection: string) => {
        // The worklist read only: the claim is an update that also selects.
        if (mode === "select" && table === "bookings") state.worklistSelects.push(projection);
        return self();
      },
      in: () => self(),
      gt: () => self(),
      lte: () => self(),
      order: () => self(),
      is: (col: string, value: unknown) => {
        if (mode === "update") updateEqs.push([col, value]);
        return self();
      },
      eq: (col: string, value: unknown) => {
        if (mode === "update" && col === "id") updateId = String(value);
        if (mode === "update") updateEqs.push([col, value]);
        if (mode === "select" && table === "bookings") state.worklistFilters.push([col, value]);
        return self();
      },
      update: (set: Row) => {
        mode = "update";
        updateSet = set;
        return self();
      },
      upsert: async (row: Row) => {
        mode = "upsert";
        state.upserts.push(row);
        return { data: null, error: null };
      },
      range: (from: number, to: number) => {
        state.ranges.push([from, to]);
        return self();
      },
      maybeSingle: async () => {
        if (table === "booking_failure_rate_state") {
          if (state.rateReadError) return { data: null, error: state.rateReadError };
          return { data: state.rateRow, error: null };
        }
        // The claim, or a release: a conditional update returning the row it wrote.
        state.updates.push({ set: updateSet, eqs: [...updateEqs] });
        state.claimed.push(updateId);
        return { data: { id: updateId }, error: null };
      },
      then: (
        resolve: (v: { data: unknown; error: unknown }) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        if (table !== "bookings") return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        if (state.bookingsReadError) {
          return Promise.resolve({ data: null, error: state.bookingsReadError }).then(resolve, reject);
        }
        const page = state.pages.shift() ?? [];
        return Promise.resolve({ data: page, error: null }).then(resolve, reject);
      },
    });
    return b;
  }
  return { supabaseAdmin: () => ({ from: (t: string) => make(t) }) };
});

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/email", () => email);
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/env", () => ({ appUrl: () => "https://slate.example" }));
// Spied rather than silenced, so the failed send's log line can be asserted: it is
// where every page points its reader ("Diagnose via the booking-reminder log lines").
const logSpy = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/log", () => logSpy);

// #1334: the calling number read and the invite write, the two new outside calls.
const callingNumber = vi.hoisted(() => ({
  readLeadCallingNumbersLive: vi.fn(async (_ids: string[]) => new Map<string, string | null>()),
}));
const calendar = vi.hoisted(() => ({
  updateEventDescription: vi.fn(async (_email: string, _eventId: string, _description: string) => {}),
  getEventOnPrimary: vi.fn(async (_email: string, _eventId: string) => ({
    description: "Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://slate.example/booking/manage/tok-1",
  }) as { description?: string } | null),
}));
// Only the live read is replaced; the deadline helper the lane uses stays real.
vi.mock("@/lib/salesforce/lead-calling-number", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/salesforce/lead-calling-number")>()),
  ...callingNumber,
}));
vi.mock("@/lib/google/calendar", () => calendar);

import { GET } from "./route";
import { REMINDER_FAILURE_RATE_KEY } from "@/lib/booking/reminder-rate";
import { PAGE_SIZE } from "@/lib/supabase/paginate";
import { EmailSendError } from "@/lib/notify/email-errors";

const HOUR = 60 * 60_000;

/** A booking due its reminder: live, inside the window, and never reminded. */
function due(i: number, over: Row = {}): Row {
  return {
    id: `bk-${i}`,
    starts_at: new Date(Date.now() + 12 * HOUR).toISOString(),
    reminder_sent_for: null,
    status: "confirmed",
    attendee_email: `lead-${i}@example.com`,
    agent_email: "jordan@trypennie.com",
    agent_name: "Jordan Lee",
    timezone: "America/New_York",
    manage_token: `tok-${i}`,
    ...over,
  };
}

/** A booking already reminded for the start it currently holds: still live, still
 *  inside the window, and no longer work. These are what filled the old page. */
function alreadyReminded(i: number): Row {
  const startsAt = new Date(Date.now() + 12 * HOUR).toISOString();
  return due(i, { starts_at: startsAt, reminder_sent_for: startsAt });
}

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  state.pages = [];
  state.ranges = [];
  state.worklistFilters = [];
  state.worklistSelects = [];
  state.bookingsReadError = null;
  state.claimed = [];
  state.updates = [];
  state.rateRow = null;
  state.rateReadError = null;
  state.upserts = [];
  state.sendFailures = [];
  state.sent = [];
  email.sendGmailEmail.mockImplementation(async (msg: { to: string[]; subject: string }) => {
    state.sent.push(msg);
    const failure = state.sendFailures.shift();
    if (failure) throw typeof failure === "string" ? new Error(failure) : failure;
    return "gmail-id";
  });
});

describe("GET /api/cron/booking-reminders", () => {
  it("returns 401 and reads nothing when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(state.ranges).toEqual([]);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // #396 / #2660: test bookings are kept out through the BUCKET, which is where
  // the flag lives. The canary books a real row every hour against a real
  // inbox, and a partner's test booking on the public test bucket carries the
  // tester's own address, so a reminder to either would be a live email nobody
  // asked for. Pinned by name here, since a filter on a select string is exactly
  // the kind of line that goes missing in a refactor with nothing to say so.
  it("excludes test bookings through the bucket join", async () => {
    state.pages = [[due(1)]];
    await GET(req());
    expect(state.worklistSelects.length).toBeGreaterThan(0);
    for (const s of state.worklistSelects) expect(s).toContain("buckets!inner(is_test)");
    expect(state.worklistFilters).toContainEqual(["buckets.is_test", false]);
  });

  // #2500 (1). THE regression this file exists for: a lead sitting past the first
  // page must still be reminded. Under the old single `.limit(200)` read this
  // booking was invisible, and the lane reported a healthy tick while it happened.
  it("reads past the first page, so a lead behind a page of already reminded bookings still gets one", async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) => alreadyReminded(i));
    state.pages = [first, [due(9999)]];

    const res = await GET(req());
    expect(res.status).toBe(200);

    // It asked for a SECOND page, which is the mechanism, and it sent to the lead
    // that page held, which is the consequence.
    expect(state.ranges.length).toBeGreaterThan(1);
    expect(state.ranges[0]).toEqual([0, PAGE_SIZE - 1]);
    expect(state.sent.map((m) => m.to[0])).toEqual(["lead-9999@example.com"]);
    await expect(res.json()).resolves.toMatchObject({ sent: 1 });
  });

  // A page that came back SHORT is the whole set, so the lane must not spend a
  // second read on every tick of a normal day.
  it("stops after one page when that page is short", async () => {
    state.pages = [[due(1)]];
    await GET(req());
    expect(state.ranges).toEqual([[0, PAGE_SIZE - 1]]);
  });

  // #277 / the `unwrap` rule. An empty worklist is the NORMAL state here, so a read
  // that failed must not resolve to one: it would stop every reminder and look
  // exactly like a quiet afternoon.
  it("fails the tick and stamps no heartbeat when the worklist cannot be read", async () => {
    state.bookingsReadError = { message: "relation does not exist" };
    await expect(GET(req())).rejects.toThrow();
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // #2496. One lead's address is an incident about that booking, and nothing more.
  it("pages about the one booking, and not about a wave, when a single send fails", async () => {
    state.pages = [[due(1)]];
    state.sendFailures = ["Gmail send failed: 400 Invalid To header"];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const keys = dispatch.sendThrottledAlert.mock.calls.map((c) => c[0]);
    // Keyed per booking, so this page cannot hold back another booking's for the
    // six hour cooldown (2026-10-05).
    expect(keys).toContain("booking_reminder_failed:bk-1");
    expect(keys).not.toContain(REMINDER_FAILURE_RATE_KEY);
  });

  // Plan item E: the page says to diagnose via the log, so the log line has to carry
  // the booking, the code, the outcome and the claim, and the Error itself as the
  // THIRD argument so Cloudflare serializes its cause and stack. No contact data.
  it("logs a failed send with its booking, code, outcome and claim, and the Error passed through", async () => {
    state.pages = [[due(1)]];
    const refused = new EmailSendError("Gmail send failed: 400 Invalid To header", {
      outcome: "refused",
      stage: "post",
      status: 400,
      transient: false,
    });
    state.sendFailures = [refused];
    await GET(req());
    const call = logSpy.log.warn.mock.calls.find(
      (c) => c[0] === "booking-reminder" && (c[1] as Record<string, unknown>)?.booking_id === "bk-1",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      booking_id: "bk-1",
      code: "recipient_refused",
      outcome: "refused",
      disposition: "refused",
      claim_released: false,
    });
    expect(call![2]).toBe(refused);
    expect(JSON.stringify(call![1])).not.toContain("lead-1@example.com");
  });

  // 2026-10-05: a token mint that timed out delivered nothing, because the mint runs
  // before the Gmail POST, yet the claim was kept and the lead was never reminded.
  // The typed outcome now hands the claim back, conditionally, and pages nobody.
  it("releases the claim and pages nobody when the send provably never reached Gmail", async () => {
    state.pages = [[due(1)]];
    state.sendFailures = [
      new EmailSendError("google token mint did not answer within 8000ms", {
        outcome: "never_sent",
        stage: "token",
        transient: true,
      }),
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const startsAt = String(due(1).starts_at).slice(0, 13);
    expect(state.updates).toHaveLength(2);
    const [claim, release] = state.updates;
    expect(String(claim!.set.reminder_sent_for).slice(0, 13)).toBe(startsAt);
    // Back to what the tick read (null: never reminded), only where the row still
    // holds the claim this tick wrote.
    expect(release!.set).toEqual({ reminder_sent_for: null });
    expect(release!.eqs).toContainEqual(["id", "bk-1"]);
    expect(release!.eqs.find(([col]) => col === "reminder_sent_for")?.[1]).toBe(claim!.set.reminder_sent_for);
    const keys = dispatch.sendThrottledAlert.mock.calls.map((c) => String(c[0]));
    expect(keys.filter((k) => k.startsWith("booking_reminder_failed"))).toEqual([]);
    await expect(res.json()).resolves.toMatchObject({ failed: 1, retrying: 1 });
    // The share's sample carries the booking, so a retried booking counts once.
    const saved = state.upserts.find((u) => u.key === "booking_reminders");
    const samples = (saved?.samples ?? []) as { retried?: Record<string, string> }[];
    expect(samples.at(-1)?.retried).toEqual({ "bk-1": "token_unavailable" });
  });

  // #2496, the other half. Enough failures against enough attempts inside the
  // window IS a wave, and it says so separately from the per booking incident.
  it("pages about the wave when the share over the window breaches", async () => {
    state.rateRow = {
      key: "booking_reminders",
      day: new Date().toISOString().slice(0, 10),
      attempts: 0,
      failures: 0,
      by_code: {},
      refusals: {},
      samples: [{ atMs: Date.now() - 60_000, attempts: 20, failures: 20, byCode: { not_authorised: 20 } }],
    };
    state.pages = [[due(1)]];
    state.sendFailures = ["Gmail send failed: 403 forbidden"];

    const res = await GET(req());
    expect(res.status).toBe(200);
    const wave = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === REMINDER_FAILURE_RATE_KEY);
    expect(wave).toBeDefined();
    expect(String(wave?.[2])).toContain("21 of 21");
  });

  // The all-clear hangs off a MEASURED healthy window (#1134).
  it("clears the wave page once the window is measurably healthy again", async () => {
    state.rateRow = {
      key: "booking_reminders",
      day: new Date().toISOString().slice(0, 10),
      attempts: 0,
      failures: 0,
      by_code: {},
      refusals: {},
      samples: [{ atMs: Date.now() - 60_000, attempts: 40, failures: 0, byCode: {} }],
    };
    state.pages = [[due(1)]];
    await GET(req());
    expect(dispatch.resolveAlert).toHaveBeenCalledWith(
      REMINDER_FAILURE_RATE_KEY,
      expect.stringContaining("going out again"),
    );
  });

  // THE failure path for the new signal: a window nobody could read claims nothing,
  // writes nothing, and above all does not take the reminders down with it.
  it("still sends, and neither pages nor clears, when the rate window cannot be read", async () => {
    state.rateReadError = { message: "booking_failure_rate_state unreadable" };
    state.pages = [[due(1)]];

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(state.sent.length).toBe(1);
    expect(state.upserts).toEqual([]);
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(
      dispatch.sendThrottledAlert.mock.calls.map((c) => c[0]),
    ).not.toContain(REMINDER_FAILURE_RATE_KEY);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("booking-reminders");
  });

  // #1334: the wiring for the calling number. The lane's own suite proves the order
  // and the copy; this proves the worklist carries what the lane needs and the two
  // outside calls are the real ones.
  // #4206: a call on the placeholder advisor (kind `staff_placed`) is reminded from the
  // seat with its own copy, so the worklist must carry the kind to the lane.
  it("reminds a call on the placeholder from the seat, with no number and the reply to our texts line", async () => {
    callingNumber.readLeadCallingNumbersLive.mockResolvedValue(new Map([["00QUi000010889Z", "+12197588170"]]));
    state.pages = [
      [
        due(1, {
          kind: "staff_placed",
          agent_email: "scheduling@trypennie.com",
          agent_name: "Marcia",
          salesforce_id: "00QUi000010889ZMAQ",
          gcal_event_id: "evt-1",
        }),
      ],
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    for (const s of state.worklistSelects) expect(s).toContain("kind");
    expect(state.sent[0]?.from).toBe("scheduling@trypennie.com");
    expect(state.sent[0]?.body).toContain("reply to one of our texts");
    expect(state.sent[0]?.body).not.toContain("(219) 758-8170");
    expect(state.sent[0]?.attachments ?? []).toHaveLength(0);
    expect(callingNumber.readLeadCallingNumbersLive).not.toHaveBeenCalled();
    expect(calendar.updateEventDescription).not.toHaveBeenCalled();
    callingNumber.readLeadCallingNumbersLive.mockReset();
    callingNumber.readLeadCallingNumbersLive.mockImplementation(async () => new Map());
  });

  it("names the calling number, attaches the card and writes it into the invite", async () => {
    callingNumber.readLeadCallingNumbersLive.mockResolvedValueOnce(
      new Map([["00QUi000010889Z", "+12197588170"]]),
    );
    state.pages = [
      [due(1, { salesforce_id: "00QUi000010889ZMAQ", external_id: null, gcal_event_id: "evt-1" })],
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    for (const s of state.worklistSelects) {
      expect(s).toContain("salesforce_id");
      expect(s).toContain("gcal_event_id");
    }
    expect(callingNumber.readLeadCallingNumbersLive).toHaveBeenCalledWith(["00QUi000010889ZMAQ"]);
    expect(state.sent[0]?.body).toContain("(219) 758-8170");
    expect(state.sent[0]?.attachments?.[0]?.content).toContain("TEL;TYPE=WORK,VOICE:+12197588170");
    // Named after the advisor, with Pennie beside it (Dan, 2026-10-01).
    expect(state.sent[0]?.attachments?.[0]?.content).toContain("FN:Jordan Lee (Pennie)\r\n");
    expect((state.sent[0]?.attachments?.[0] as { filename?: string } | undefined)?.filename).toBe("Jordan Lee Pennie.vcf");
    // It read the invite first and changed only the calling number line.
    expect(calendar.getEventOnPrimary).toHaveBeenCalledWith("jordan@trypennie.com", "evt-1");
    expect(calendar.updateEventDescription).toHaveBeenCalledWith(
      "jordan@trypennie.com",
      "evt-1",
      expect.stringContaining("(219) 758-8170"),
    );
    const written = String(calendar.updateEventDescription.mock.calls[0]?.[2]);
    expect(written.startsWith("Booked via Pennie. Phone: +12035615295\n")).toBe(true);
    expect(written.endsWith("Reschedule or cancel: https://slate.example/booking/manage/tok-1")).toBe(true);
    await expect(res.json()).resolves.toMatchObject({ sent: 1, withCallingNumber: 1, callingNumberUnread: false });
  });

  // #1334 review: a booking with no advisor name used to fall back to the address,
  // which then greeted the lead and named the contact card. It never reaches a lead
  // as a name now.
  it("never shows the advisor's address as their name when the name is missing", async () => {
    callingNumber.readLeadCallingNumbersLive.mockResolvedValueOnce(
      new Map([["00QUi000010889Z", "+12197588170"]]),
    );
    state.pages = [[due(1, { agent_name: null, salesforce_id: "00QUi000010889ZMAQ", gcal_event_id: "evt-1" })]];
    await GET(req());
    const msg = state.sent[0];
    expect(msg?.body).not.toContain("jordan@trypennie.com");
    expect(msg?.body).toContain("your call with Pennie is");
    const card = msg?.attachments?.[0] as { content: string; filename?: string } | undefined;
    expect(card?.content).toContain("FN:Pennie\r\n");
    expect(card?.filename).toBe("Pennie.vcf");
    expect(msg?.body).toContain("Our contact card is attached");
  });

  it("still sends, without a number, when Salesforce cannot be read", async () => {
    callingNumber.readLeadCallingNumbersLive.mockRejectedValueOnce(new Error("SF query failed: 503"));
    state.pages = [[due(1, { salesforce_id: "00QUi000010889ZMAQ", gcal_event_id: "evt-1" })]];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(state.sent.length).toBe(1);
    expect(state.sent[0]?.attachments ?? []).toEqual([]);
    expect(calendar.updateEventDescription).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ sent: 1, callingNumberUnread: true });
  });
});
