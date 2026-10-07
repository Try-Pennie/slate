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
import { isDemoBucket } from "../src/lib/embed/public-test-bucket.ts";
import { SEED_START_MINUTE, SEED_END_MINUTE } from "../src/lib/schedule-core.ts";

/**
 * The public test bucket's event type (#2660): its name, which becomes the
 * invite's title ("<name> with <lead>"), so a calendar reader sees it is a test
 * without opening it; and the orphan sweep (`lib/smoke-event-cleanup.ts`) matches
 * it, so a cancelled partner test cannot clutter the smoke agent's calendar for
 * ever.
 */
export const PUBLIC_TEST_EVENT_TYPE_NAME = "Partner test call";

/**
 * The demo bucket's event type (#3424). The booker draws the event type's name as
 * its heading, and the demo is shown to somebody outside Pennie, so it must not
 * read "Partner test call". The orphan sweep matches this name too.
 */
export const DEMO_EVENT_TYPE_NAME = "Demo call";

/**
 * How many partner test calls the smoke agent takes a day (#2660).
 *
 * The public test bucket shares smoketest@ with the canary, and anyone who knows
 * the code can book it. Without a cap of its own it would inherit the org's
 * (unlimited), and one enthusiastic tester could fill the horizon: the canary's
 * cross bucket scenario then finds no free slot and pages about a booking outage
 * nobody has. Eight is a working day of tests and leaves the rest of the day to
 * the canary.
 */
export const PUBLIC_TEST_DAILY_CAP = 8;

/** The org event type fields the public test one copies, so the test booker reads
 *  like the real one: same length, same notice, same interval, same words. */
export interface EventTypeTemplate {
  description: string | null;
  regal_type: string;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  slot_interval_min: number;
}

export interface SmokeSeedParams {
  orgId: string;
  /** The org's event type, which the HIDDEN buckets use. */
  eventTypeId: string;
  /** That event type's settings, which the public test bucket's own copies. */
  eventTypeTemplate: EventTypeTemplate;
  /** The smoke mailbox; also the calendar-event organizer (must be a real Workspace user). */
  agentEmail: string;
  /** The HIDDEN bucket codes the agent serves (the canary's), from
   *  `HIDDEN_TEST_BUCKET_CODES`. Never a hand spelled list. */
  bucketCodes: string[];
  /** The PUBLIC test bucket codes (#2660), from `PUBLIC_TEST_BUCKET_CODES`. Each
   *  gets the public event type and the primary agent alone. */
  publicBucketCodes: string[];
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
/** The public test bucket's own event type row (#2660), upserted on its id. */
export interface SmokeSeedEventType extends EventTypeTemplate {
  id: string;
  org_id: string;
  name: string;
  daily_cap: number;
}
export interface SmokeSeed {
  user: SmokeSeedUser;
  /** Event type rows to upsert BEFORE the buckets that reference them. */
  eventTypes: SmokeSeedEventType[];
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
// The public test bucket's event type (#2660), its own row so it can carry a
// daily cap the org's does not, keyed like the rest so a re-run upserts in place.
const PUBLIC_TEST_EVENT_TYPE_ID = "e0000000-0000-4000-8000-000000000001";
// #3424: the demo bucket's own row, for its name only. The cap is the same number:
// it is counted per agent across every event type, so a row of its own could not
// give the demo a separate allowance; the demo's 30 minute auto cancel bounds it.
const DEMO_EVENT_TYPE_ID = "e0000000-0000-4000-8000-000000000002";

/**
 * Mon-Fri working-hours rules for one schedule, on the SAME seeded day the real
 * roster runs (#1299). Read from `schedule-core` rather than written out here: the
 * smoke agents book against the same org window every real agent does, so a stale
 * literal here would make the canary exercise a day nobody else works.
 */
function weekdayRules(scheduleId: string): SmokeSeedRule[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    schedule_id: scheduleId,
    weekday,
    start_minute: SEED_START_MINUTE,
    end_minute: SEED_END_MINUTE,
  }));
}

export function buildSmokeSeed(p: SmokeSeedParams): SmokeSeed {
  const timezone = p.timezone ?? "America/New_York";

  const user: SmokeSeedUser = {
    id: AGENT_ID,
    org_id: p.orgId,
    email: p.agentEmail,
    // #3424: read out on the booker's confirmation, which the /demo link shows
    // to people outside Pennie, so a made up person's name (Dan, 2026-10-06),
    // checked against the roster when chosen. Rename it if Pennie ever hires
    // somebody by this name, so a visitor never takes the demo for them.
    name: "Sarah Mitchell",
    role: "agent",
    attributes: {},
    bookable: true,
    deactivated_at: null,
    is_test: true,
  };

  // Mon-Fri 9:00-17:00, like the default working hours, so the agent has open
  // slots for the smoke test to book.
  const schedule: SmokeSeedSchedule = { id: SCHEDULE_ID, user_id: user.id, timezone };

  const publicEventType: SmokeSeedEventType = {
    id: PUBLIC_TEST_EVENT_TYPE_ID,
    org_id: p.orgId,
    name: PUBLIC_TEST_EVENT_TYPE_NAME,
    daily_cap: PUBLIC_TEST_DAILY_CAP,
    ...p.eventTypeTemplate,
  };

  const demoEventType: SmokeSeedEventType = {
    ...publicEventType,
    id: DEMO_EVENT_TYPE_ID,
    name: DEMO_EVENT_TYPE_NAME,
  };

  const buckets: SmokeSeedBucket[] = [
    ...p.bucketCodes.map(
      (code): SmokeSeedBucket => ({
        org_id: p.orgId,
        code,
        name: `Smoke Test (${code})`,
        event_type_id: p.eventTypeId,
        assignment: "round_robin",
        criteria: {},
        is_test: true,
      }),
    ),
    // The public test bucket (#2660): the same isolation (is_test, empty
    // criteria, the smoke agent alone) on its own capped event type.
    ...p.publicBucketCodes.map(
      (code): SmokeSeedBucket => ({
        org_id: p.orgId,
        code,
        // #3424: the demo bucket is named as one, so the admin never reads a
        // visitor's demo booking as a partner's test.
        name: isDemoBucket(code) ? `Demo (${code})` : `Partner Test (${code})`,
        event_type_id: isDemoBucket(code) ? demoEventType.id : publicEventType.id,
        assignment: "round_robin",
        criteria: {},
        is_test: true,
      }),
    ),
  ];

  const members: SmokeSeedMember[] = buckets.map((b) => ({
    bucketCode: b.code,
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
    // A bookable fallback in the first HIDDEN bucket (SMOKE) only. Never the
    // public one: a partner's test call must land on the one agent the docs name.
    members.push({ bucketCode: p.bucketCodes[0], user_id: reassignTarget.id });
  }

  return {
    user,
    eventTypes: [
      ...(p.publicBucketCodes.some((c) => !isDemoBucket(c)) ? [publicEventType] : []),
      ...(p.publicBucketCodes.some(isDemoBucket) ? [demoEventType] : []),
    ],
    schedules,
    rules,
    buckets,
    members,
    reassignTarget,
  };
}
