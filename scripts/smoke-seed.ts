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
}
export interface SmokeSeedMember {
  /** Resolved to bucket_id by the I/O layer after the buckets upsert. */
  bucketCode: string;
  user_id: string;
}
export interface SmokeSeed {
  user: SmokeSeedUser;
  schedule: SmokeSeedSchedule;
  rules: SmokeSeedRule[];
  buckets: SmokeSeedBucket[];
  members: SmokeSeedMember[];
}

// Deterministic, valid 8-4-4-4-12 hex UUIDs (version 4 / variant 8), namespaced
// by row kind — same convention as scripts/loadtest/generate.ts. A single agent
// and schedule, so a fixed suffix is enough.
const AGENT_ID = "c0000000-0000-4000-8000-000000000001";
const SCHEDULE_ID = "d0000000-0000-4000-8000-000000000001";

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
  };

  const schedule: SmokeSeedSchedule = {
    id: SCHEDULE_ID,
    user_id: user.id,
    timezone,
  };

  // Mon-Fri 9:00-17:00 (minutes 540-1020), like the default working hours, so
  // the agent has open slots for the smoke test to book.
  const rules: SmokeSeedRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
    schedule_id: schedule.id,
    weekday,
    start_minute: 540,
    end_minute: 1020,
  }));

  const buckets: SmokeSeedBucket[] = p.bucketCodes.map((code) => ({
    org_id: p.orgId,
    code,
    name: `Smoke Test (${code})`,
    event_type_id: p.eventTypeId,
    assignment: "round_robin",
    criteria: {},
  }));

  const members: SmokeSeedMember[] = p.bucketCodes.map((bucketCode) => ({
    bucketCode,
    user_id: user.id,
  }));

  return { user, schedule, rules, buckets, members };
}
