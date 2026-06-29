// Pure row builder for the dedicated smoke-test agent + isolated buckets (#396).
// No DB/network here — seed-smoke-test.ts inserts what this returns. Kept pure so
// the row shapes are unit-tested (scripts/test-smoke-seed.ts) before anything
// touches a real project.
//
// The agent is a non-Salesforce mailbox (smoketest@trypennie.com), so the
// roster sync never deactivates it (it only reaps emails it finds INACTIVE in
// Salesforce). The buckets carry EMPTY criteria so the lone member always
// matches, keeping the smoke test off the production round-robin and its
// fairness data. Ids are deterministic so re-seeding upserts in place.

export interface SmokeSeedParams {
  orgId: string;
  eventTypeId: string;
  /** The smoke mailbox; also the calendar-event organizer (must be a real Workspace user). */
  agentEmail: string;
  /** Isolated bucket codes the agent serves, e.g. ["SMOKE", "SMOKE2"]. */
  bucketCodes: string[];
  /**
   * Optional SECOND bookable test agent — the explicit target of the reassign
   * smoke scenario (#450) AND a bookable fallback member of the FIRST bucket
   * (#464). Must also be a real Workspace mailbox (reassign impersonates it to
   * create the moved calendar event). It gets its own working hours and joins the
   * first bucket only, so round-robin CAN pick it there (giving the #523
   * reschedule-stickiness scenario a real second agent) while other buckets stay
   * single-agent. Omit to skip seeding the target.
   */
  reassignTargetEmail?: string;
  /** Schedule timezone; defaults to America/New_York. */
  timezone?: string;
}

export interface SmokeSeedUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: "agent";
  attributes: Record<string, never>;
  bookable: boolean;
  deactivated_at: null;
  /** Hides it from internal UI and blocks real-lead bookings of its buckets (#396). */
  is_test: true;
}
export interface SmokeSeedSchedule {
  id: string;
  user_id: string;
  timezone: string;
}
export interface SmokeSeedRule {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}
export interface SmokeSeedBucket {
  org_id: string;
  code: string;
  name: string;
  event_type_id: string;
  assignment: "round_robin";
  criteria: Record<string, never>;
  /** Hidden from public availability/book; only the key-authed smoke test books it (#396). */
  is_test: true;
}
export interface SmokeSeedMember {
  /** Resolved to bucket_id by the I/O layer after the buckets upsert. */
  bucketCode: string;
  user_id: string;
}
export interface SmokeSeed {
  user: SmokeSeedUser;
  /** One schedule per seeded agent (primary + reassign target when present). */
  schedules: SmokeSeedSchedule[];
  /** Working-hours rules across ALL seeded schedules, keyed by schedule_id. */
  rules: SmokeSeedRule[];
  buckets: SmokeSeedBucket[];
  members: SmokeSeedMember[];
  /** The reassign-target agent (#450), or null when reassignTargetEmail is omitted. */
  reassignTarget: SmokeSeedUser | null;
}

// Deterministic, valid 8-4-4-4-12 hex UUIDs (version 4 / variant 8), namespaced
// by row kind — same convention as scripts/loadtest/generate.ts. A single agent
// and schedule, so a fixed suffix is enough.
const AGENT_ID = "c0000000-0000-4000-8000-000000000001";
const SCHEDULE_ID = "d0000000-0000-4000-8000-000000000001";
// Distinct id for the reassign-target agent (#450) so it never collides with the
// primary agent and re-seeding upserts it in place.
const REASSIGN_TARGET_ID = "c0000000-0000-4000-8000-000000000002";
// The reassign target's own schedule (#464): it's now a bookable SMOKE member, so
// it needs working hours for round-robin to offer it.
const REASSIGN_TARGET_SCHEDULE_ID = "d0000000-0000-4000-8000-000000000002";

/** Mon-Fri 9:00-17:00 (minutes 540-1020) working-hours rules for one schedule. */
function weekdayRules(scheduleId: string): SmokeSeedRule[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    schedule_id: scheduleId,
    weekday,
    start_minute: 540,
    end_minute: 1020,
  }));
}

export function buildSmokeSeed(p: SmokeSeedParams): SmokeSeed {
  const timezone = p.timezone ?? "America/New_York";

  const user: SmokeSeedUser = {
    id: AGENT_ID,
    org_id: p.orgId,
    email: p.agentEmail,
    name: "Smoke Test Agent",
    role: "agent",
    attributes: {},
    bookable: true,
    deactivated_at: null,
    is_test: true,
  };

  // Mon-Fri 9:00-17:00, like the default working hours, so the agent has open
  // slots for the smoke test to book.
  const schedule: SmokeSeedSchedule = { id: SCHEDULE_ID, user_id: user.id, timezone };

  const buckets: SmokeSeedBucket[] = p.bucketCodes.map((code) => ({
    org_id: p.orgId,
    code,
    name: `Smoke Test (${code})`,
    event_type_id: p.eventTypeId,
    assignment: "round_robin",
    criteria: {},
    is_test: true,
  }));

  const members: SmokeSeedMember[] = p.bucketCodes.map((bucketCode) => ({
    bucketCode,
    user_id: user.id,
  }));

  // Reassign target (#450) + SMOKE fallback agent (#464): a second bookable,
  // is_test agent. It's the explicit target of the reassign scenario AND a
  // bookable member of the FIRST bucket (SMOKE) — giving SMOKE a real fallback so
  // the reschedule-stickiness (#523) scenario has a second agent a small move
  // could (wrongly) re-route to. It joins SMOKE only, NOT the other buckets, so
  // SMOKE2 stays single-agent for the cross-bucket scenario.
  const reassignTarget: SmokeSeedUser | null = p.reassignTargetEmail
    ? {
        id: REASSIGN_TARGET_ID,
        org_id: p.orgId,
        email: p.reassignTargetEmail,
        name: "Smoke Reassign Target",
        role: "agent",
        attributes: {},
        bookable: true,
        deactivated_at: null,
        is_test: true,
      }
    : null;

  const schedules: SmokeSeedSchedule[] = [schedule];
  const rules: SmokeSeedRule[] = weekdayRules(schedule.id);
  if (reassignTarget) {
    const targetSchedule: SmokeSeedSchedule = {
      id: REASSIGN_TARGET_SCHEDULE_ID,
      user_id: reassignTarget.id,
      timezone,
    };
    schedules.push(targetSchedule);
    rules.push(...weekdayRules(targetSchedule.id));
    // A bookable fallback in the first bucket (SMOKE) only.
    members.push({ bucketCode: p.bucketCodes[0], user_id: reassignTarget.id });
  }

  return { user, schedules, rules, buckets, members, reassignTarget };
}
