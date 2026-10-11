/**
 * Finding things in the admin audit trail (#1222).
 *
 * Measured against production on 2026-08-17: `audit_log` held 378 rows, and 373
 * of them (98.7%) were time off actions. The five rows the trail exists for, two
 * impersonations, two PII actions and one settings change, were all from June and
 * July, so a 25 row window opened on routine approvals and the privileged changes
 * were the hardest rows in the table to reach.
 *
 * Hence the default: the routine family is HIDDEN unless asked for. That is the
 * one decision here that came from the data rather than from taste.
 *
 * Pure, so scripts/test-audit-filter.ts can drive it without a database.
 */

/**
 * Time off is the routine family. Matched by PREFIX rather than by a list, so an
 * action added later defaults to SHOWN.
 *
 * That direction is deliberate. A new privileged action silently hidden by a list
 * nobody updated is the failure that matters; a new routine action showing up
 * until somebody notices is merely untidy (L113).
 *
 * The match is ANCHORED, so `agent.ooo_calendar` (an agent edit, which is
 * privileged) is never caught by it, and the trailing dot is not what saves it.
 * The dot guards only a hypothetical future top-level action beginning "ooo" that
 * is not part of the family, which nothing today writes. Said plainly because a
 * comment claiming protection the code is not providing is worse than no comment.
 */
const ROUTINE_PREFIX = "ooo.";

export function isRoutineAudit(action: string): boolean {
  return (action ?? "").startsWith(ROUTINE_PREFIX);
}

/** How many rows a page of the trail shows. */
export const AUDIT_PAGE_SIZE = 25;

export interface AuditFilters {
  /** Specific actions asked for, or null for no action filter. */
  actions: string[] | null;
  actorId: string | null;
  /** A calendar date (YYYY-MM-DD), already proven parseable, or null. */
  fromIso: string | null;
  toIso: string | null;
  includeRoutine: boolean;
  /** #3615: rows about the smoke test advisors (the daily reroute drill's), hidden unless asked for. */
  includeTest: boolean;
  page: number;
}

type Params = Record<string, string | undefined>;

const trimmed = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
};

/**
 * A calendar date we are willing to hand to the query, or null.
 *
 * Anything unreadable is DROPPED rather than passed through. A bad date reaching
 * the query would either error or silently match nothing, and an empty table that
 * looks like a real answer is the failure this panel cannot afford (L50: a value
 * parsed from input must never feed a comparison directly).
 */
function readDate(v: string | undefined): string | null {
  const t = trimmed(v);
  if (t === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round trip, so 2026-13-45 and 2026-02-31 are refused rather than rolled over
  // into a different date the person never asked for.
  return d.toISOString().slice(0, 10) === t ? t : null;
}

function readPage(v: string | undefined): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  // NaN and anything below one land on the first page, never on a page that
  // renders empty and reads as "nothing here".
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function parseAuditFilters(sp: Params): AuditFilters {
  const action = trimmed(sp.action);
  const actions = action === null ? null : [action];
  // Naming a routine action explicitly wins over the default that hides the
  // family: a filter the person set must not be overruled by one they did not.
  const includeRoutine = sp.routine === "1" || (action !== null && isRoutineAudit(action));

  return {
    actions,
    actorId: trimmed(sp.actor),
    fromIso: readDate(sp.from),
    toIso: readDate(sp.to),
    includeRoutine,
    includeTest: sp.test === "1",
    page: readPage(sp.page),
  };
}

/**
 * A link that changes one thing and keeps the rest of the filter.
 *
 * Defaults are left OUT of the URL, so the address bar stays readable and a link
 * someone copies says only what they actually chose.
 */
export function auditFilterHref(
  filters: AuditFilters,
  overrides: Partial<Pick<AuditFilters, "page">> & { action?: string | null; routine?: boolean } = {},
): string {
  const page = overrides.page ?? filters.page;
  const action =
    overrides.action !== undefined ? overrides.action : (filters.actions?.[0] ?? null);
  const routine = overrides.routine ?? filters.includeRoutine;

  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (filters.actorId) params.set("actor", filters.actorId);
  if (filters.fromIso) params.set("from", filters.fromIso);
  if (filters.toIso) params.set("to", filters.toIso);
  // Only when it is not implied by the action already named, so the URL does not
  // carry a parameter that changes nothing.
  if (routine && !(action !== null && isRoutineAudit(action))) params.set("routine", "1");
  if (filters.includeTest) params.set("test", "1");
  if (page > 1) params.set("page", String(page));

  const q = params.toString();
  return `/admin${q ? `?${q}` : ""}#audit`;
}

/**
 * The filter that hides rows about the test advisors (#3615), as a PostgREST `or`, or null when
 * there are none to hide. It KEEPS rows with no target: SQL's NOT IN answers unknown for a missing
 * value, so a bare "target not in the test advisors" would also hide every action about nobody,
 * which reads as a quieter trail rather than as a filter.
 */
export function testAdvisorRowsFilter(testUserIds: string[]): string | null {
  if (testUserIds.length === 0) return null;
  return `target_id.is.null,target_id.not.in.(${testUserIds.join(",")})`;
}

/**
 * What the panel says it is showing.
 *
 * It always names the filter, because a filtered view that reads like the whole
 * trail is how somebody concludes nothing happened (L11). An empty RESULT is
 * described as an empty result, never as an empty trail.
 */
export function describeAuditFilters(filters: AuditFilters, total: number): string {
  const bits: string[] = [];
  if (filters.actions?.length) bits.push("this action");
  if (filters.actorId) bits.push("this person");
  if (filters.fromIso || filters.toIso) bits.push("this date range");

  const scope = bits.length > 0 ? ` matching ${bits.join(" and ")}` : "";

  if (total === 0) {
    return bits.length > 0
      ? `No privileged actions match this filter. Clear it to see the rest of the trail.`
      : `No privileged actions recorded yet. Time off decisions are hidden; show them to see routine activity.`;
  }

  const noun = filters.includeRoutine ? "recorded action" : "privileged action";
  const rows = total === 1 ? `1 ${noun}` : `${total} ${noun}s`;
  const hidden =
    filters.includeRoutine || filters.actions?.length
      ? ""
      : " Time off decisions are hidden, because they are almost all of the trail.";
  return `${rows}${scope}.${hidden}`;
}

/**
 * Actions written by a DATABASE function rather than by `recordAudit` (#1222).
 *
 * `AUDIT_ACTIONS` in `src/lib/audit.ts` is the vocabulary the APPLICATION writes,
 * and it deliberately excludes these: `pii.erasure` is written by the
 * `erase_booking_pii` function itself, as that file's own comment says. They still
 * appear in the trail, and production holds a `pii.erasure` row, so a filter built
 * from the application list alone could never reach one of the most privileged
 * actions there is.
 *
 * Adding a database-written action means adding it here AND giving it a label in
 * `audit-display.ts`, or it renders in the table as its raw key.
 */
export const DB_WRITTEN_AUDIT_ACTIONS = ["pii.erasure"] as const;

/**
 * Every action the filter can offer, application-written and database-written
 * alike, in one stable order so the dropdown does not reshuffle on an edit.
 */
export function auditActionChoices(appActions: readonly string[]): string[] {
  return [...new Set([...appActions, ...DB_WRITTEN_AUDIT_ACTIONS])].sort();
}
