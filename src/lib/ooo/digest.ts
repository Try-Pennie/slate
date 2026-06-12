import { DateTime } from "luxon";

/**
 * Pure core of the daily pending-OOO digest (port of the Pipedream "morning
 * nudge" flow): decide whether it's send time and build each manager's message.
 * Side-effect-free for `scripts/test-ooo-digest.ts`; the route does the IO.
 */

const DIGEST_ZONE = "America/New_York";
export const DIGEST_HOUR_ET = 9;

/**
 * True at 9am ET on a weekday. The Cloudflare cron fires at both 13:00 and
 * 14:00 UTC Mon-Fri (one of which is 9am ET depending on DST); this guard lets
 * exactly one through and no-ops the other.
 */
export function isDigestTime(nowMs: number): boolean {
  const et = DateTime.fromMillis(nowMs, { zone: DIGEST_ZONE });
  return et.weekday >= 1 && et.weekday <= 5 && et.hour === DIGEST_HOUR_ET;
}

export interface DigestManager {
  id: string;
  email: string;
  name: string | null;
}

export interface ManagerDigest {
  managerId: string;
  email: string;
  count: number;
  text: string;
}

/**
 * One digest per manager who has pending requests and resolves to a real user.
 * Sorted by count (busiest first). Copy is warm and plain with a verb-phrase
 * CTA and no em dashes, per the Slate voice rules.
 */
export function buildManagerDigests(
  pending: { manager_id: string | null }[],
  managers: Map<string, DigestManager>,
  reviewUrl: string,
): ManagerDigest[] {
  const counts = new Map<string, number>();
  for (const r of pending) {
    if (!r.manager_id) continue;
    counts.set(r.manager_id, (counts.get(r.manager_id) ?? 0) + 1);
  }

  const out: ManagerDigest[] = [];
  for (const [managerId, count] of counts) {
    const manager = managers.get(managerId);
    if (!manager) continue;
    const greeting = manager.name ? `Good morning, ${manager.name}.` : "Good morning.";
    const noun = count === 1 ? "request" : "requests";
    const text =
      `${greeting} You have *${count}* time off ${noun} waiting for your approval. ` +
      `Review them here: ${reviewUrl}`;
    out.push({ managerId, email: manager.email, count, text });
  }
  return out.sort((a, b) => b.count - a.count);
}
