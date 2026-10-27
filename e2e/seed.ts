/**
 * The world the browser checks run in, written into the throwaway local stack.
 *
 * Deliberately small and deliberately real: one organization, the staff the
 * checks sign in as, one bookable agent in the Low pool (bucket 100), and hours
 * that are open every day around the clock, so the booker always has a time to
 * offer whatever hour the run starts. Not always on TODAY, though: the lead's
 * calling window (8 AM to 8 PM their time) still applies, so from late afternoon
 * today can carry only times outside it, and a spec opens a day through
 * `openDayWithTimes` in `fixtures.ts` rather than the first chip. Nobody here
 * has an `auth_user_id`: each staff session is made by a real sign in through
 * `/api/auth/callback`, which links the auth user to these rows by email exactly as production does.
 *
 * Every id is fixed, so a spec can name a row without a lookup, and every write
 * is checked, so a refused seed fails the run here rather than as a confusing
 * empty screen three steps later.
 */
import { createClient } from "@supabase/supabase-js";
import { E2E_EMAIL_DOMAIN, localStackRefusal, type LocalStack } from "./env.ts";

export const SEED = {
  orgId: "00000000-0000-4000-8000-000000000001",
  eventTypeId: "00000000-0000-4000-8000-000000000101",
  bucketId: "00000000-0000-4000-8000-000000000201",
  bucketCode: "100",
  scheduleId: "00000000-0000-4000-8000-000000000301",
  users: {
    admin: {
      id: "00000000-0000-4000-8000-000000001001",
      email: `ada.admin@${E2E_EMAIL_DOMAIN}`,
      name: "Ada Admin",
      role: "super_admin",
    },
    manager: {
      id: "00000000-0000-4000-8000-000000001002",
      email: `morgan.manager@${E2E_EMAIL_DOMAIN}`,
      name: "Morgan Manager",
      role: "manager",
    },
    agent: {
      id: "00000000-0000-4000-8000-000000001003",
      email: `avery.agent@${E2E_EMAIL_DOMAIN}`,
      name: "Avery Agent",
      role: "agent",
    },
    roleTarget: {
      id: "00000000-0000-4000-8000-000000001004",
      email: `riley.rolechange@${E2E_EMAIL_DOMAIN}`,
      name: "Riley Rolechange",
      role: "agent",
    },
    // #4205: a scheduling coordinator, who opens the coordinator booking page and nothing
    // else. The address starts "sc" because the header draws the first two letters of it,
    // and the settled design's header was captured showing "SC".
    coordinator: {
      id: "00000000-0000-4000-8000-000000001005",
      email: `scheduling.coordinator@${E2E_EMAIL_DOMAIN}`,
      name: "Sky Coordinator",
      role: "coordinator",
    },
  },
} as const;

export type Seeded = typeof SEED;

/** The secret key client for the LOCAL stack, refusing any other. */
export function localAdminClient(stack: LocalStack) {
  const refusal = localStackRefusal(stack);
  if (refusal) throw new Error(refusal);
  return createClient(stack.apiUrl, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function check(label: string, res: { error: { message: string } | null }): void {
  if (res.error) throw new Error(`seed: ${label} was refused: ${res.error.message}`);
}

export async function seedStack(stack: LocalStack): Promise<Seeded> {
  const db = localAdminClient(stack);

  check(
    "organization",
    await db.from("organizations").insert({ id: SEED.orgId, name: "Pennie", is_default: true }),
  );
  check(
    "users",
    await db.from("users").insert(
      Object.values(SEED.users).map((u) => ({
        id: u.id,
        org_id: SEED.orgId,
        email: u.email,
        name: u.name,
        role: u.role,
        bookable: u === SEED.users.agent,
        attributes: u === SEED.users.agent ? { debt_team: ["low"] } : {},
      })),
    ),
  );
  check(
    "event type",
    await db.from("event_types").insert({
      id: SEED.eventTypeId,
      org_id: SEED.orgId,
      name: "Loan consultation",
      duration_min: 30,
      min_notice_min: 120,
      slot_interval_min: 30,
    }),
  );
  check(
    "bucket",
    await db.from("buckets").insert({
      id: SEED.bucketId,
      org_id: SEED.orgId,
      code: SEED.bucketCode,
      name: "Low | None | No Legal Param",
      event_type_id: SEED.eventTypeId,
      criteria: { debt_team: "low" },
    }),
  );
  check(
    "schedule",
    await db.from("availability_schedules").insert({
      id: SEED.scheduleId,
      user_id: SEED.users.agent.id,
      timezone: "America/New_York",
    }),
  );
  check(
    "schedule rules",
    await db.from("availability_rules").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        schedule_id: SEED.scheduleId,
        weekday,
        start_minute: 0,
        end_minute: 1440,
      })),
    ),
  );
  check(
    "agent calendar",
    await db.from("agent_calendars").insert({
      user_id: SEED.users.agent.id,
      calendar_id: SEED.users.agent.email,
      last_success_at: new Date().toISOString(),
    }),
  );
  // The migrations seed Monday to Saturday, 8am to 8pm. Open it around the clock
  // so a run at any hour has times inside the booking notice.
  check(
    "business hours",
    await db
      .from("business_hours")
      .update({ is_open: true, start_minute: 0, end_minute: 1440 })
      .gte("weekday", 1),
  );
  check(
    "booking settings",
    await db
      .from("booking_settings")
      .upsert({ id: 1, horizon_days: 7, public_booking_paused: false }, { onConflict: "id" }),
  );
  return SEED;
}
