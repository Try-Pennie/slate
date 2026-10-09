/**
 * A bucket's own eligibility resolver narrowed to one advisor (#3489).
 *
 * The confirm line hands a released confirm an advisor off another confirm's read of
 * the rung, and the released confirm reads that rung again for that advisor alone
 * before booking anybody. It must be the pool's REAL resolver that decides, not the
 * named link shortcut (`namedAgentResolver`, #2073), which answers the advisor whatever
 * the pool holds: right for an advisor's own link, and wrong here, where a pool
 * grouping up to a minute old can put two pools in one line. The advisor is kept only
 * when the inner resolver keeps them, so every rule it applies (the bookable roster,
 * the Low exclusion of a top tier lead's cascade) still applies; a failed read throws
 * through, never an empty pool.
 *
 * Pure, no `@/` imports, so the node suite reads it directly.
 */
export function narrowedTo<B, E extends { ids: string[] }>(inner: (bucket: B) => Promise<E>, userId: string): (bucket: B) => Promise<E> {
  return async (bucket) => {
    const pool = await inner(bucket);
    return { ...pool, ids: pool.ids.includes(userId) ? [userId] : [] };
  };
}
