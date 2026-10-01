/**
 * The override sweep's per tick cap, in a module that imports nothing (#2890), so
 * the put back copy a client component renders can name the pace without pulling
 * the sweep, or anything server side, into the client bundle.
 */

/** Retries per tick. The set is normally 0 to 2 rows; the cap exists so a bad day
 *  cannot turn one monitor tick into hundreds of outbound cal.com calls. */
export const MAX_RETRIES_PER_TICK = 10;
