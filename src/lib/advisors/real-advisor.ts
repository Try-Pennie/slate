// The one rule for which `users` rows are REAL advisors (#4201).
//
// `users` holds three kinds of advisor: the real ones, the permanent test advisors
// the smoke canary books (#396), and the placeholder advisor that holds the calls a
// coordinator stacks when nobody real is free (#4200). It also holds the scheduling
// coordinators themselves (#4205), real people who are never an advisor at all, so
// they are left out by role. Only the first kind belongs
// on an advisor screen, picker, pool, default schedule, sync or monitor. The
// placeholder's BOOKINGS are real customer calls and stay wherever bookings are
// listed; it is the advisor that must not appear.
//
// Every advisor surface used to exclude test advisors with its own
// `.eq("is_test", false)`, and a third kind would have walked past every copy. So
// the exclusion lives here, a list read of `users` either applies it or carries
// `// any-advisor-ok: <why>`, and a bare test only filter is refused outside this
// file (scripts/test-real-advisor-reads.ts). No `@/` imports, so node scripts load it.

/**
 * What the helpers call on a builder. `Q` is deliberately unconstrained: checking
 * supabase-js's generic `eq` against any shape instantiates its row types too
 * deeply (TS2589) on longer chains, and every builder these wrap, a test fake's
 * included, returns itself from `.eq`.
 */
interface EqChain {
  eq(column: string, value: boolean): EqChain;
  neq(column: string, value: string): EqChain;
}

/** The role that is never an advisor (#4205). A literal, so this file keeps no imports. */
const COORDINATOR_ROLE = "coordinator";

/**
 * Narrow a `users` query to real advisors: neither a test advisor, the placeholder,
 * nor a coordinator. Wrap the whole chain, `realAdvisorsOnly(db.from("users")...)`,
 * so the guard can see the read is declared. `role` is NOT NULL, so `neq` is exact.
 */
export function realAdvisorsOnly<Q>(query: Q): Q {
  return (query as unknown as EqChain)
    .eq("is_test", false)
    .eq("is_placeholder", false)
    .neq("role", COORDINATOR_ROLE) as unknown as Q;
}

/**
 * Narrow a `users` query to everyone but the placeholder, keeping the test
 * advisors, for a read that must still serve the smoke canary: the default
 * schedule fill (a test advisor needs working hours to be booked) and the roster
 * syncs, whose test exclusions live in their planners. It keeps coordinators too:
 * a coordinator is never bookable (users_coordinator_never_bookable, 0209), so a
 * default schedule or a sync row for one can route nothing.
 */
export function withoutPlaceholder<Q>(query: Q): Q {
  return (query as unknown as EqChain).eq("is_placeholder", false) as unknown as Q;
}

/**
 * The columns a read must select for `isRealAdvisor` to judge its rows. Selecting
 * this constant (rather than spelling the names) is how the guard sees the read
 * means to apply the predicate.
 */
export const REAL_ADVISOR_COLUMNS = "is_test, is_placeholder, role";

/** The fields `isRealAdvisor` reads. */
export interface AdvisorKindFlags {
  is_test?: boolean | null;
  is_placeholder?: boolean | null;
  role?: string | null;
}

/**
 * The same rule for rows already read, when one read serves both real and other
 * advisors. An absent or null flag reads as false, matching the column default:
 * some reads select `is_test` nullable through an embed, and a row read before
 * migration 0207 carries no `is_placeholder` at all. An absent role reads as not a
 * coordinator, which is why `REAL_ADVISOR_COLUMNS` names it.
 */
export function isRealAdvisor(row: AdvisorKindFlags): boolean {
  return row.is_test !== true && row.is_placeholder !== true && row.role !== COORDINATOR_ROLE;
}
