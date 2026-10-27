import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The demotion backstop names each stuck call once, end to end through the REAL dispatcher.
// Dan, 2026-10-26 21:04 ET, after three posts in two hours that each repeated every call:
// "make it so that every call only pages once. i don't need an hourly update about this
// unless it resolves", and new calls "at most every 3 hours", except a call starting
// within those 3 hours, which posts at once.
//
// Replays the shape of that evening: two agents' calls posted at 7:00 PM, a third agent's
// six arrived at 8:40 PM and a fourth's one at 9:00 PM, and the old rule posted the whole
// list each time. Supabase and Slack are faked; `alert_state` is the shared in-memory store that
// keeps the repeat columns. The streak is mocked as already sustained, because what is
// under test is what the dispatcher does once the check decides to page.

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
vi.mock("@/lib/notify/streak", () => ({
  recordConsecutiveStreak: async () => true,
  clearFailureStreak: async () => undefined,
}));
vi.mock("@/lib/supabase/admin", async () =>
  (await import("@/lib/notify/alert-state-fake.test-support")).fakeSupabaseAdminModule(),
);

import { alertStateRows } from "@/lib/notify/alert-state-fake.test-support";
import { withoutSeverityLead } from "@/lib/notify/severity-lead";
import { resetRepeatColumnsProbe } from "@/lib/notify/dispatch";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import {
  DEMOTED_AGENT_BOOKINGS_KEY,
  demotedAgentBookingsSend,
  demotedHolders,
  formatDemotedAgentBookingsAlert,
  formatDemotedAgentBookingsRecovery,
  runInactiveAgentBookingsCheck,
  type DemotedAgent,
} from "./inactive-agent-bookings";

const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_MIN = 5 * MIN;
// Monday 2026-10-26, 7:00 PM ET.
const T0 = Date.UTC(2026, 9, 26, 23, 0);
/** Far enough ahead that every call stays upcoming for every tick of a test. */
const LATER = T0 + 5 * 24 * HOUR;

// Invented advisors; no real contact details.
const call = (id: string, startMs = LATER) => ({ id, startsAt: new Date(startMs).toISOString() });
const agent = (id: string, name: string, calls: { id: string; startsAt: string }[]): DemotedAgent => ({
  id,
  name,
  email: `${id}@example.com`,
  unserved: calls,
  coveredByPendingSweep: false,
});
const MORGAN = agent("morgan", "Morgan Example", [call("m1")]);
const AVERY = agent("avery", "Avery Example", [call("a1")]);
const KAI = agent("kai", "Kai Example", ["k1", "k2", "k3", "k4", "k5", "k6"].map((id) => call(id)));
const ELI = agent("eli", "Eli Example", [call("e1")]);

let agents: DemotedAgent[];

function tick() {
  return runInactiveAgentBookingsCheck({
    loadHolders: async () => demotedHolders(agents),
    // What the settings hand it today; the change only rule must win over it.
    cooldownMs: CONDITION_REPEAT_MS,
    key: DEMOTED_AGENT_BOOKINGS_KEY,
    formatAlert: formatDemotedAgentBookingsAlert,
    formatRecovery: formatDemotedAgentBookingsRecovery,
    sendOptions: (holders) => demotedAgentBookingsSend(holders, Date.now()),
  });
}

/** Tick every five minutes from T0 for `hours`, letting `change(minute)` move the world
 *  first (whole minutes from T0, so the comparisons are exact), and return the hour (from
 *  T0) of every post. */
async function drive(hours: number, change: (minute: number) => void = () => undefined): Promise<number[]> {
  const at: number[] = [];
  for (let t = 0; t <= hours * HOUR; t += FIVE_MIN) {
    vi.setSystemTime(T0 + t);
    change(t / MIN);
    const before = posted.length;
    await tick();
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
  agents = [MORGAN, AVERY];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the demotion backstop names each stuck call once", () => {
  it("the same stuck calls for three days post once, with no reminder", async () => {
    expect(await drive(72)).toEqual([0]);
  });

  it("collects calls that get stuck after a post into one post three hours later, naming only them", async () => {
    const at = await drive(48, (m) => {
      if (m === 100) agents = [MORGAN, AVERY, KAI];
      if (m === 120) agents = [MORGAN, AVERY, KAI, ELI];
    });
    expect(at).toEqual([0, 3]);
    expect(posted[0]).toContain("Morgan Example");
    expect(posted[0]).toContain("Avery Example");
    expect(posted[1]).toContain("could not move 7 appointments");
    expect(posted[1]).toContain("Kai Example (kai@example.com), 6 appointments");
    expect(posted[1]).toContain("Eli Example (eli@example.com), 1 appointment");
    expect(posted[1]).not.toContain("Morgan Example");
    expect(posted[1]).not.toContain("Avery Example");
  });

  it("posts a call starting within three hours at once, and holds one that is days away for three hours after that post", async () => {
    const soon = agent("eli", "Eli Example", [call("e-soon", T0 + 30 * MIN + 2 * HOUR)]);
    const at = await drive(12, (m) => {
      if (m === 30) agents = [MORGAN, AVERY, soon];
      if (m === 60) agents = [MORGAN, AVERY, soon, KAI];
    });
    // The urgent post at 0.5 is a post, so the next batch is three hours after it.
    expect(at).toEqual([0, 0.5, 3.5]);
    expect(posted[1]).toContain("could not move 1 appointment");
    expect(posted[1]).toContain("Eli Example");
    expect(posted[1]).not.toContain("Kai Example");
    expect(posted[2]).toContain("Kai Example");
    expect(posted[2]).not.toContain("Eli Example");
  });

  it("says once when every call is cleared, and a call stuck again after that posts at once", async () => {
    const at = await drive(6, (m) => {
      if (m === 60) agents = [];
      if (m === 90) agents = [MORGAN];
    });
    // The page, the all-clear, then the same call stuck again (an agent whose tier came
    // back and was taken away again): a new episode, so it is not held for the batch.
    expect(at).toEqual([0, 1, 1.5]);
    expect(posted[1]).toContain("No agent moved off a pool");
    expect(posted[2]).toContain("Morgan Example");
  });

  it("retries a page Slack refused, rather than counting it as told", async () => {
    slackOk.value = false;
    const at = await drive(48, (m) => {
      if (m === 15) slackOk.value = true;
    });
    // Refused at 0, retried while Slack is down, delivered once it is back, then never again.
    expect(at[0]).toBe(0);
    const delivered = at.filter((h) => h >= 0.25);
    expect(delivered).toEqual([0.25]);
    expect(posted.at(-1)).toContain("Morgan Example");
    expect(posted.at(-1)).toContain("Avery Example");
  });
});
