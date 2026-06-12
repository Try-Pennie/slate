/**
 * Pure: the availability rule rows for an org's default working hours. Used
 * by the daily agents cron to give newly-synced agents a schedule (agents
 * refine on /me later). Exercised by scripts/test-schedule.ts.
 */

export interface OrgDefaults {
  default_timezone: string;
  default_start_minute: number;
  default_end_minute: number;
  default_weekdays: number[];
}

// A `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to the Supabase client's insert param (same convention as core.ts).
export type RuleRow = {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
};

export function defaultRuleRows(scheduleId: string, org: OrgDefaults): RuleRow[] {
  if (org.default_end_minute <= org.default_start_minute) return [];
  return org.default_weekdays.map((weekday) => ({
    schedule_id: scheduleId,
    weekday,
    start_minute: org.default_start_minute,
    end_minute: org.default_end_minute,
  }));
}
