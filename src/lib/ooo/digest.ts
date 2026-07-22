import { DateTime } from "luxon";
import { approvalBlocks } from "../notify/ooo-slack-blocks.ts";

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

/** One pending request in a manager's digest. `line` is the pre-rendered mrkdwn
 *  describing it (agent + when + reason), built by the route so this module stays
 *  pure; `id` wires the Approve/Decline buttons back to the right request. */
export interface DigestPendingRequest {
  id: string;
  manager_id: string | null;
  line: string;
}

export interface ManagerDigest {
  managerId: string;
  email: string;
  count: number;
  /** Fallback text: the notification preview and the accessible summary. */
  text: string;
  /** Interactive Block Kit body: greeting header, then one Approve/Decline row
   *  per request (#194), then a review link. */
  blocks: unknown[];
}

/** Max requests rendered with buttons in one digest message. Slack caps a
 *  message at 50 blocks; each request is 2 blocks (line + actions) plus a header
 *  and a footer, so this stays well under. A larger backlog is disclosed via an
 *  "And N more" line rather than silently truncated. */
export const DIGEST_MAX_INTERACTIVE = 15;

/**
 * One digest per manager who has pending requests and resolves to a real user.
 * Sorted by count (busiest first). Each request gets an Approve/Decline row
 * (reusing the same `approvalBlocks` the per-request notification uses, so the
 * interactions endpoint already handles the clicks). Copy is warm and plain with
 * a verb-phrase CTA and no em dashes, per the Slate voice rules.
 */
export function buildManagerDigests(
  pending: DigestPendingRequest[],
  managers: Map<string, DigestManager>,
  reviewUrl: string,
): ManagerDigest[] {
  const byManager = new Map<string, DigestPendingRequest[]>();
  for (const r of pending) {
    if (!r.manager_id) continue;
    const list = byManager.get(r.manager_id) ?? [];
    list.push(r);
    byManager.set(r.manager_id, list);
  }

  const out: ManagerDigest[] = [];
  for (const [managerId, requests] of byManager) {
    const manager = managers.get(managerId);
    if (!manager) continue;
    const count = requests.length;
    const greeting = manager.name ? `Good morning, ${manager.name}.` : "Good morning.";
    const noun = count === 1 ? "request" : "requests";
    const summary = `${greeting} You have *${count}* time off ${noun} waiting for your approval.`;
    const text = `${summary} Review them here: ${reviewUrl}`;

    const shown = requests.slice(0, DIGEST_MAX_INTERACTIVE);
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: summary } },
      { type: "divider" },
    ];
    for (const r of shown) blocks.push(...approvalBlocks(r.line, r.id));
    const remaining = count - shown.length;
    const footer =
      remaining > 0
        ? `And ${remaining} more. Review them all here: ${reviewUrl}`
        : `Review them here: ${reviewUrl}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: footer } });

    out.push({ managerId, email: manager.email, count, text, blocks });
  }
  return out.sort((a, b) => b.count - a.count);
}
