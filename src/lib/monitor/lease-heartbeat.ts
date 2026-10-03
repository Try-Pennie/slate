import { log } from "@/lib/log";
import type { LockLease } from "@/lib/locks";

/**
 * Whether a FENCED lane may stamp its dead man's switch (#3120).
 *
 * A fenced lane stops working the moment its lease is not provably its own, and
 * leaves the rest of the tick undone. Stamping the heartbeat after that read a
 * partly abandoned tick as a healthy one, so a lane that kept losing its lease every
 * tick would never go stale and never page. So the stamp is withheld whenever the
 * lease stopped, for either reason, and the lane watchdog sees the gap.
 *
 * One predicate for every fenced lane, so no lane decides on its own terms. Each
 * lane still names its stamp literally (`recordHeartbeat("sync")`), which is what
 * the heartbeat coverage guards read.
 */
export function leaseHeldThroughout(lease: LockLease, lane: string): boolean {
  const why = lease.stopReason();
  if (why === null) return true;
  log.warn("locks", { msg: "heartbeat withheld: the lane lost its lease part way", lane, why });
  return false;
}
