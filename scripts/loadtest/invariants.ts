// Cap-safe invariant checks for the #440 load/soak, extracted from run.ts so the
// logic is unit-testable and can't silently pass on a truncated result set.
//
// The live #440 soak surfaced two defects in the old inline check:
//   1. It fetched `busy_blocks?source=eq.slate` and filtered client-side, but a
//      PostgREST list caps at 1000 rows. With a large seed (~17k blocks) it sampled
//      a clean subset and FALSE-PASSED while 333 cancelled bookings still held a
//      slate busy_block. Fix: count on the server (HEAD + Content-Range), never
//      count a capped client-side list.
//   2. It drove selfheal a fixed number of ticks, so it read the stuck-slot
//      invariant before the batch-limited (200/tick) #428 reconcile had converged.
//      Fix: drive selfheal to convergence (freed=0) first, mirroring the outbox
//      drain-to-empty loop. The stuck-slot invariant relies on the outbox drain AND
//      the #401/#428 backstops together (see RUNBOOK.md).

export interface InvariantDeps {
  /** Uncapped exact row count (PostgREST HEAD + Content-Range: count=exact). */
  count: (pathAndFilter: string) => Promise<number>;
  /** Every row of a (possibly >1000) result set, paginated so nothing is truncated. */
  listAll: (pathAndFilter: string) => Promise<Record<string, unknown>[]>;
  /** One selfheal tick: how many stuck blocks it freed / missing blocks it recreated. */
  driveSelfheal: () => Promise<{ freed: number; recreated: number }>;
  log?: (msg: string) => void;
}

export interface SoakInvariantResult {
  pass: boolean;
  failures: string[];
  selfhealTicks: number;
  deliveries: number;
}

export interface FreshnessResult {
  /** How many bucket_slots rows were read. */
  total: number;
  /** How many were computed more than staleMs ago. */
  stale6m: number;
  /** Seconds between the oldest and newest computed_at across the set. */
  spreadSec: number;
}

/**
 * Recompute-freshness readout over EVERY bucket_slots row. Fetches through the
 * paginating listAll so a set larger than PostgREST's 1000-row cap can't be
 * silently truncated into an under-reported stale count / spread (#725) the way
 * the old capped `rows()` fetch could.
 */
export async function computeFreshness(
  listAll: (pathAndFilter: string) => Promise<Record<string, unknown>[]>,
  now: number,
  staleMs = 6 * 60_000,
): Promise<FreshnessResult> {
  const ts = (await listAll("bucket_slots?select=computed_at"))
    .map((r) => Date.parse(r.computed_at as string))
    .sort((a, b) => a - b);
  return {
    total: ts.length,
    stale6m: ts.filter((t) => now - t > staleMs).length,
    spreadSec: ts.length ? Math.round((ts[ts.length - 1] - ts[0]) / 1000) : 0,
  };
}

/**
 * Drive selfheal until a tick frees nothing new (freed === 0 && recreated === 0),
 * or maxTicks is reached. #428 reconcile is capped at 200 blocks/tick, so a large
 * orphan backlog needs many ticks to fully clear.
 */
export async function driveSelfhealToConvergence(
  driveSelfheal: () => Promise<{ freed: number; recreated: number }>,
  maxTicks: number,
  log: (msg: string) => void = () => {},
): Promise<{ ticks: number; converged: boolean; freedTotal: number }> {
  let ticks = 0;
  let freedTotal = 0;
  while (ticks < maxTicks) {
    const { freed, recreated } = await driveSelfheal();
    ticks++;
    freedTotal += freed;
    log(`  selfheal tick ${ticks}: freed ${freed}, recreated ${recreated}`);
    if (freed === 0 && recreated === 0) return { ticks, converged: true, freedTotal };
  }
  return { ticks, converged: false, freedTotal };
}

/**
 * Verify the #440 post-soak invariants against fully-drained state. Reads every
 * count from the server (uncapped) and paginates the delivery list, so a large
 * soak can never truncate into a false pass.
 */
export async function checkSoakInvariants(
  deps: InvariantDeps,
  maxSelfhealTicks = 40,
): Promise<SoakInvariantResult> {
  const log = deps.log ?? (() => {});
  const failures: string[] = [];

  // Drive selfheal to convergence BEFORE reading the stuck-slot invariant, else we
  // would check before the batch-limited reconcile has cleared its backlog.
  const conv = await driveSelfhealToConvergence(deps.driveSelfheal, maxSelfhealTicks, log);
  if (!conv.converged) {
    failures.push(`selfheal did not converge within ${maxSelfhealTicks} ticks (still freeing rows)`);
  }

  // Every outbox row delivered. neq.delivered catches pending AND any given-up/failed
  // row, so a stuck crash row can't hide.
  const notDelivered = await deps.count("booking_outbox?status=neq.delivered");
  if (notDelivered !== 0) failures.push(`${notDelivered} outbox rows not delivered (drain did not converge)`);

  // No cancelled booking retains a slate busy_block. Uncapped server-side count via
  // the busy_blocks->bookings FK embed; NEVER a client-side filter over a capped list.
  const stuck = await deps.count(
    "busy_blocks?source=eq.slate&select=id,bookings!inner(status)&bookings.status=eq.cancelled",
  );
  if (stuck !== 0) failures.push(`${stuck} slate busy_blocks still held by a cancelled booking`);

  // The other half of the stuck-slot window: orphan slate blocks with no booking.
  const orphans = await deps.count("busy_blocks?source=eq.slate&booking_id=is.null");
  if (orphans !== 0) failures.push(`${orphans} orphan slate busy_blocks (null booking_id)`);

  // Exactly-once webhooks: no (endpoint,event,dedupe_key) appears twice. Paginate the
  // full delivery set so a >1000-delivery soak can't truncate into a false pass.
  const deliveries = await deps.listAll("webhook_deliveries?select=endpoint_id,event,dedupe_key");
  const seen = new Set<string>();
  let dupes = 0;
  for (const d of deliveries) {
    if (d.dedupe_key == null) continue;
    const k = `${d.endpoint_id}|${d.event}|${d.dedupe_key}`;
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }
  if (dupes !== 0) failures.push(`${dupes} duplicate webhook deliveries (dedupe index did not hold)`);

  return { pass: failures.length === 0, failures, selfhealTicks: conv.ticks, deliveries: deliveries.length };
}
