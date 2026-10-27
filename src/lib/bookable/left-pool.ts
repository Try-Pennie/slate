/**
 * Who has LEFT the bookable pool, decided in one place (#3304).
 *
 * Leaving the pool is the moment an agent's cached busy time stops mattering:
 * `cleanupOnPoolExit` deletes their busy_blocks (booking write throughs included)
 * on the way out, and `reconcileOrphanedPoolExits` deletes them again on every self
 * heal tick for anybody this predicate names. The reconcile missing sweep, which
 * RE-CREATES a booking's block when it finds none, runs on that same tick. Asking
 * it a different question had it re-create a departed agent's block, page about a
 * missed write that never happened, and watch the backstop delete the block again
 * a moment later (2026-10-05). So both ask this one (L342, L261).
 *
 * Somebody has left when they are deactivated, or when they are not bookable and
 * no activation is owed for them. The second clause is #2302: the activation gate
 * establishes an agent's watches and loads their calendar BEFORE it writes
 * `bookable`, so for a moment somebody joining looks exactly like somebody who
 * left, and pruning them then emptied the cache they were about to be booked from.
 * A deactivated agent has left whatever stale mark their row still carries.
 *
 * The placeholder advisor (#4200) has left by construction: it is never bookable
 * (`users_placeholder_never_bookable`, 0207; `writeRoutableState` refuses to arm it)
 * and no activation is ever owed for it. So the block each of its calls writes at
 * create is pruned once by the backstop and never re-created by the repair, and the
 * two do not fight over it (#4259, proved over both sweeps tick after tick in
 * `scripts/verify-recreate-missing-busy-blocks-sql.ts`). It is deliberately NOT given
 * an exemption from the prune: the repair would go on skipping it by this same rule,
 * so the two sweeps would again be asking different questions, the #3304 defect. Its
 * blocks are read by nothing, because it is in no pool.
 *
 * The rule exists in two forms because its two readers need two: the backstop
 * judges roster rows in code (`hasLeftPool`), and the reconcile loader has to
 * filter in SQL, since every row it fetches spends its page budget (#778).
 * `whereStillInPool` is the second form, and `scripts/test-left-pool-predicate.ts`
 * proves it selects exactly the complement of the first for every combination of
 * the three columns, so the two cannot drift apart unseen.
 */

/** The three `users` columns the rule reads. */
export interface PoolStateRow {
  bookable: boolean;
  deactivated_at: string | null;
  bookable_pending_since: string | null;
}

/** The columns to select for `hasLeftPool`, so a reader cannot forget one. */
export const POOL_STATE_COLUMNS = "bookable, deactivated_at, bookable_pending_since";

/**
 * Whether this person has left the pool: their busy time is pruned and nothing
 * should re-create it. `!= null` rather than `!== null`, because an absent key
 * means the same as a null column.
 */
export function hasLeftPool(row: PoolStateRow): boolean {
  if (row.deactivated_at != null) return true;
  return row.bookable === false && row.bookable_pending_since == null;
}

/** The two filter methods `whereStillInPool` needs from a PostgREST query. */
export interface StillInPoolFilterable<Q> {
  is(column: string, value: null): Q;
  or(filters: string, options: { referencedTable: string }): Q;
}

/**
 * Narrow a query to rows whose embedded user has NOT left the pool: the SQL form
 * of `!hasLeftPool`, which reads "not deactivated, and either bookable or owed an
 * activation".
 *
 * `embed` is the name the user row is embedded under, and it MUST be embedded as
 * an inner join (`users!inner(...)`): on a plain embed PostgREST applies these
 * filters to the embedded object alone and returns every parent row anyway, so the
 * narrowing would silently do nothing.
 */
export function whereStillInPool<Q extends StillInPoolFilterable<Q>>(query: Q, embed: string): Q {
  return query
    .is(`${embed}.deactivated_at`, null)
    .or("bookable.eq.true,bookable_pending_since.not.is.null", { referencedTable: embed });
}
