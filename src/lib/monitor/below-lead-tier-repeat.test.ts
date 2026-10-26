import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// One post per booking, ever, end to end through the REAL dispatcher. Dan, 2026-10-26
// 15:31 ET: "I want a single ping about this per booking", choosing strictly once over
// "once, plus real moves".
//
// The page is one key per booking. Before #4235 it was an INCIDENT reposted every time
// its cooldown ran out. #4235 (the same morning, Dan: "Just page once per call") posted
// once and again on any change to the call, the lead's tier or whether the lead's own
// team was free, and the team answer flips as calendars fill, so one booking posted four
// times in 25 minutes. The rule now: one post, and nothing about the booking (a
// reschedule, a new advisor or bucket, a new tier, the team, a failed read, the call
// coming right and going wrong again) posts it again. Supabase and Slack are faked;
// `alert_state` is the shared in-memory store that keeps the repeat columns and refuses
// what Postgres would, so two runs at once are arbitrated the way production arbitrates
// them.

const posted = vi.hoisted(() => [] as string[]);
const slackOk = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/notify/slack", () => ({
  slackConfigured: () => true,
  postSlack: async (msg: { text: string }) => {
    const body = withoutSeverityLead(msg.text);
    if (body === null) throw new Error(`post without a severity lead: ${msg.text}`);
    posted.push(body);
    return slackOk.value ? { ok: true } : { ok: false, error: "slack down" };
  },
}));
vi.mock("@/lib/platform/runtime", () => ({
  isWorkersRuntime: () => true,
  workersRuntimeMarker: () => "Cloudflare-Workers",
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", async () =>
  (await import("@/lib/notify/alert-state-fake.test-support")).fakeSupabaseAdminModule(),
);

import { alertStateRows } from "@/lib/notify/alert-state-fake.test-support";
import { withoutSeverityLead } from "@/lib/notify/severity-lead";
import { sendThrottledAlert, settleAlertsSilently, resetRepeatColumnsProbe } from "@/lib/notify/dispatch";
import { leadIdKey, type LeadScore } from "@/lib/salesforce/lead-xbc";
import {
  BELOW_LEAD_TIER_KEY,
  runBelowLeadTierCheck,
  type LeadTierOffer,
  type PoolBucket,
  type UpcomingBooking,
} from "./below-lead-tier";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIVE_MIN = 5 * MIN;
// Monday 2026-10-26, 08:00 ET.
const T0 = Date.UTC(2026, 9, 26, 12, 0);

// Invented leads and advisors; no real contact details.
const LEAD = "00QUi00000tierAAAA";
const LEAD_2 = "00QUi00000tierBBBB";

const LOW_112: PoolBucket = { id: "b-112", code: "112", name: "Low | Both | Non-Legal", criteria: { debt_team: "low" } };
const LOW_111: PoolBucket = { id: "b-111", code: "111", name: "Low | Both | Legal", criteria: { debt_team: "low" } };
const MEDIUM_212: PoolBucket = { id: "b-212", code: "212", name: "Medium | Both | Non-Legal", criteria: { debt_team: "medium" } };
const HIGH_312: PoolBucket = { id: "b-312", code: "312", name: "High | Both | Non-Legal", criteria: { debt_team: "high" } };
const BUCKETS = [LOW_112, LOW_111, MEDIUM_212, HIGH_312];

/** The call: Thursday at 6:30pm ET, days ahead, so it stays upcoming for every tick. */
const CALL_MS = Date.UTC(2026, 9, 29, 22, 30);

function booking(over: Partial<UpcomingBooking> = {}): UpcomingBooking {
  return {
    id: "bk-1",
    bucket_id: LOW_112.id,
    starts_at: new Date(CALL_MS).toISOString(),
    salesforce_id: LEAD,
    external_id: null,
    agent_name: "Avery Example",
    agent_email: "avery.example@example.com",
    prefill: { parentOrigin: "https://www.trypennie.com", embed: "1" },
    referrer_origin: "https://www.trypennie.com",
    ...over,
  };
}

/** What the High pool offers, relative to a call at `startMs`. */
type TeamShape = "nobody-that-day" | "free-at-call" | "free-later-that-day" | "unreadable";

function offerFor(shape: TeamShape, startMs: number): LeadTierOffer | "unreadable" {
  const base = { computedAtMs: Date.now(), minNoticeMin: 60 };
  switch (shape) {
    case "free-at-call":
      return { ...base, offeredMs: [startMs, startMs + DAY] };
    case "free-later-that-day":
      return { ...base, offeredMs: [startMs + HOUR, startMs + DAY] };
    case "nobody-that-day":
      return { ...base, offeredMs: [startMs + DAY] };
    case "unreadable":
      return "unreadable";
  }
}

/** The world one tick sees; a test edits it between ticks. */
interface World {
  bookings: UpcomingBooking[];
  /** The XBC Salesforce holds for each lead, by lead id. */
  scores: Record<string, string>;
  team: TeamShape;
  historyFails: boolean;
  routingFails: boolean;
}

let world: World;

function firingBookings(): Set<string> {
  const prefix = `alert_firing:${BELOW_LEAD_TIER_KEY}:`;
  return new Set([...alertStateRows.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}

function tick() {
  const w = world;
  return runBelowLeadTierCheck({
    loadBookings: async () => w.bookings.map((b) => ({ ...b })),
    buckets: BUCKETS,
    readLeadScores: async (ids) =>
      new Map(
        ids.map((id): [string, LeadScore] => [
          leadIdKey(id),
          { code: w.scores[id] ?? null, source: "submission", submissionId: null },
        ]),
      ),
    loadRoutingContext: async (ids) => {
      if (w.routingFails) throw new Error("routing read refused");
      return new Map(
        ids.map((id) => [id, { catchall: false, requestedCode: "112", tierFallback: false, rungsDropped: 0 }]),
      );
    },
    listFiring: async () => firingBookings(),
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    armed: true,
    // Forwarded exactly as the monitor lane wires it (`scripts/test-notify-forwards-repeat.ts`).
    notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
    settle: settleAlertsSilently,
    nowMs: Date.now(),
    leadTierOffer: () => {
      const start = Date.parse(w.bookings[0]?.starts_at ?? new Date(CALL_MS).toISOString());
      return offerFor(w.team, start);
    },
    readSubmissionHistory: async () => {
      if (w.historyFails) throw new Error("history read refused");
      return new Map([[leadIdKey(LEAD), ["312", "312", "212", "112"]]]);
    },
  });
}

/**
 * Tick every `everyMs` from T0 for `hours`, calling `change(hour)` first so a test can
 * move the world, and return the hour (from T0) of every post. `runs` ticks are started
 * at once each time, standing in for two overlapping lane invocations.
 */
async function drive(
  hours: number,
  change: (hour: number) => void = () => undefined,
  opts: { everyMs?: number; runs?: number } = {},
): Promise<number[]> {
  const every = opts.everyMs ?? FIVE_MIN;
  const at: number[] = [];
  for (let t = 0; t <= hours * HOUR; t += every) {
    vi.setSystemTime(T0 + t);
    change(t / HOUR);
    const before = posted.length;
    await Promise.all(Array.from({ length: opts.runs ?? 1 }, () => tick()));
    for (let i = before; i < posted.length; i++) at.push(t / HOUR);
  }
  return at;
}

beforeEach(() => {
  alertStateRows.clear();
  resetRepeatColumnsProbe();
  posted.length = 0;
  slackOk.value = true;
  process.env.SLACK_ALERTS_CHANNEL = "C-alerts";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  world = {
    bookings: [booking()],
    scores: { [LEAD]: "312", [LEAD_2]: "412" },
    team: "nobody-that-day",
    historyFails: false,
    routingFails: false,
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the below tier page posts once per booking, ever", () => {
  it("the same booking, re-measured every five minutes for three days, posts once", async () => {
    expect(await drive(72)).toEqual([0]);
    expect(posted[0]).toMatch(/^A High lead is booked with the Low team: Salesforce scores them XBC 312 today/);
  });

  it("a read that fails on some ticks changes the wording but never posts again", async () => {
    const at = await drive(24, (hour) => {
      const odd = Math.round(hour * 12) % 2 === 1;
      world.historyFails = odd;
      world.routingFails = odd;
      world.team = odd ? "unreadable" : "nobody-that-day";
    });
    expect(at).toEqual([0]);
  });

  it("a new XBC inside the same tier does not post again", async () => {
    expect(await drive(24, (hour) => (world.scores[LEAD] = hour >= 5 ? "322" : "312"))).toEqual([0]);
  });

  it("a change of TIER does not post again", async () => {
    const at = await drive(24, (hour) => (world.scores[LEAD] = hour >= 5 ? "212" : "312"));
    expect(at).toEqual([0]);
  });

  it("a reschedule, a new advisor and a new bucket do not post again", async () => {
    const at = await drive(24, (hour) => {
      const b = booking();
      if (hour >= 5) b.starts_at = new Date(CALL_MS + DAY).toISOString();
      if (hour >= 7) {
        b.agent_name = "Blake Sample";
        b.agent_email = "blake.sample@example.com";
      }
      if (hour >= 9) b.bucket_id = LOW_111.id;
      world.bookings = [b];
    });
    expect(at).toEqual([0]);
  });

  it("the High team becoming free, then not, does not post again", async () => {
    const at = await drive(24, (hour) => {
      world.team = hour >= 8 ? "nobody-that-day" : hour >= 5 ? "free-at-call" : "nobody-that-day";
    });
    expect(at).toEqual([0]);
  });

  it("the High team's free time flipping on and off every few ticks posts once (2026-10-26, four posts in 25 minutes)", async () => {
    const at = await drive(6, (hour) => {
      world.team = Math.floor(hour * 12) % 4 < 2 ? "free-later-that-day" : "nobody-that-day";
    });
    expect(at).toEqual([0]);
  });

  it("two bookings each post once", async () => {
    world.bookings = [booking(), booking({ id: "bk-2", salesforce_id: LEAD_2, agent_name: "Casey Demo", agent_email: "casey.demo@example.com" })];
    expect(await drive(48)).toEqual([0, 0]);
  });

  it("two lane runs at once post once", async () => {
    const at = await drive(12, (hour) => (world.scores[LEAD] = hour >= 5 ? "212" : "312"), { runs: 2 });
    expect(at).toEqual([0]);
  });

  it("a post Slack refused is retried within minutes, then holds", async () => {
    const at = await drive(24, (hour) => {
      slackOk.value = hour > 0;
    });
    // The refused post at 0, the retry once its short hold ran out, and nothing after.
    expect(at).toEqual([0, 5 / 60]);
  });

  it("a call that comes right is settled silently, and going wrong again does not post again", async () => {
    const at = await drive(12, (hour) => {
      world.scores[LEAD] = hour >= 5 && hour < 6 ? "112" : "312";
    });
    // No all clear, and the settle keeps the booking's hold, so a score flipping back
    // (this lead's submissions disagree) is not a second page for the same booking.
    expect(at).toEqual([0]);
    expect(alertStateRows.has(`${BELOW_LEAD_TIER_KEY}:bk-1`)).toBe(true);
  });
});
