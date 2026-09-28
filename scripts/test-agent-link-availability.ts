// The times an agent's own booking link offers (#2073).
//
// One agent's live slots in the shape /api/availability serves, bounded to the
// booking horizon, with one refusal body for every way a link books nobody.
// Run: node --experimental-strip-types scripts/test-agent-link-availability.ts
import {
  agentLinkAvailability,
  type AgentLinkAvailabilityDeps,
} from "../src/lib/agent-link/availability.ts";
import type { AgentLinkJudgement, AgentLinkRefusal } from "../src/lib/agent-link/link.ts";
import type { EventType } from "../src/lib/db/types.ts";
import { AGENT_LINK_COPY } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-08T12:00:00.000Z"); // a Monday
const TOKEN = "ab".repeat(32);
const eventType = {
  id: "et1",
  name: "Follow up call",
  description: "desc",
  duration_min: 30,
  min_notice_min: 60,
} as unknown as EventType;
const agent = { id: "u1", name: "Jane", email: "jane@x.com", bookable: true, deactivated_at: null };
const okLink: AgentLinkJudgement = { ok: true, agent, bucketCode: "411", bucket: { code: "411", is_test: false } };
const openAllWeek = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

function deps(over: Partial<AgentLinkAvailabilityDeps> & { slots?: string[] } = {}) {
  const calls = { slotsFor: [] as { code: string; agent: string; from: string; to: string }[], refusals: [] as string[] };
  const d: AgentLinkAvailabilityDeps = {
    resolve: async () => okLink,
    horizonDays: async () => 4,
    slotsFor: async (code, agentId, from, to) => {
      calls.slotsFor.push({ code, agent: agentId, from, to });
      return { slots: over.slots ?? [], eventType, orgName: "Pennie" };
    },
    businessHours: async () => openAllWeek as never,
    logRefusal: (why) => calls.refusals.push(why),
    ...over,
  };
  return { d, calls };
}

async function run() {
  // --- a good link serves that one agent's times ---------------------------------
  {
    const { d, calls } = deps({
      slots: [
        "2026-06-08T12:30:00.000Z", // inside the hour of notice: dropped
        "2026-06-08T14:00:00.000Z",
        "2026-06-09T14:00:00.000Z",
      ],
    });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200, "a good link answers 200");
    if (r.status === 200) {
      eq(r.body.slots, ["2026-06-08T14:00:00.000Z", "2026-06-09T14:00:00.000Z"], "times inside the event type's notice are dropped");
      eq(r.body.bucket.code, "", "the bucket the booking is stored in is never sent to the lead");
      eq(r.body.eventType.durationMin, 30, "the event type is sent in the public shape");
      eq(r.body.emptyBecause, null, "no empty reason when there are times");
    }
    assert(calls.slotsFor.length === 1 && calls.slotsFor[0].agent === "u1" && calls.slotsFor[0].code === "411", "computed for the named agent in the bucket the judge chose");
  }

  // --- the window is bounded to the horizon ----------------------------------------
  {
    const { d, calls } = deps();
    await agentLinkAvailability(TOKEN, { from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" }, NOW, d);
    const w = calls.slotsFor[0];
    assert(Date.parse(w.from) === NOW, "a window starting in the past starts now");
    assert(Date.parse(w.to) === NOW + 5 * 86_400_000, "a window past the horizon stops at the horizon plus one day");
  }
  {
    const { d } = deps({ slots: ["2026-06-10T14:00:00.000Z", "2026-06-11T14:00:00.000Z"] });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: "2026-06-10T23:00:00.000Z" }, NOW, d);
    assert(r.status === 200 && r.body.slots.length === 1, "times after the asked for end are not served");
  }
  {
    const { d, calls } = deps();
    const r = await agentLinkAvailability(TOKEN, { from: "not a date", to: null }, NOW, d);
    assert(r.status === 400, "an unreadable window is refused");
    assert(calls.slotsFor.length === 0, "and nothing is computed for it");
  }

  // --- every refusal is one body --------------------------------------------------------
  {
    const bodies = new Set<string>();
    for (const why of ["unknown", "departed", "not_bookable", "no_bucket"] as AgentLinkRefusal[]) {
      const { d, calls } = deps({ resolve: async () => ({ ok: false, why }) });
      const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
      assert(r.status === 404, `${why}: refused with 404`);
      bodies.add(JSON.stringify(r.body));
      assert(calls.refusals[0] === why, `${why}: the cause reaches the log`);
      assert(calls.slotsFor.length === 0, `${why}: nothing is computed`);
    }
    eq(bodies.size, 1, "every cause answers the identical body, so the response names no cause");
    assert([...bodies][0].includes(AGENT_LINK_COPY.unavailable), "and that body carries the lead's sentence");
  }
  {
    const { d, calls } = deps({ slotsFor: async () => null });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 404, "a bucket that vanished between reads is the same refusal");
    assert(calls.refusals[0] === "bucket_unresolvable", "with its own cause in the log");
  }

  // --- nothing to offer says why ---------------------------------------------------------
  {
    const { d } = deps({ slots: [] });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200 && r.body.emptyBecause?.kind === "busy", "an open org and an empty week is the advisor being full, never an empty picker");
  }
  {
    const { d } = deps({ slots: [], businessHours: async () => ({ ...openAllWeek, rules: [] }) as never });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200 && r.body.emptyBecause?.kind === "closed", "a shut org says it is closed");
  }
  {
    const { d } = deps({ slots: [], businessHours: async () => null });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200 && r.body.emptyBecause === null, "unreadable hours leave the reason unknown rather than guessed");
  }
  {
    const { d } = deps({ slots: [] });
    const r = await agentLinkAvailability(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200 && r.body.emptyBecause?.kind !== "unstaffed", "one named agent is never reported as an unstaffed bucket");
  }

  finish();
}

run();
