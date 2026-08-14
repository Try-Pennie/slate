import { DateTime } from "luxon";
import { approvalBlocks } from "../notify/ooo-slack-blocks.ts";
import {
  canHoldManagerOfRecord,
  NO_MANAGER_REVIEWER,
  noManagerReviewerCapitalized,
} from "./core.ts";
import type { Role } from "@/lib/db/types";

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

/**
 * Somebody the digest can name: a recipient (a manager of record) or the agent
 * whose request is being described. `role` is required because whether a request
 * is ROUTED is decided by `canHoldManagerOfRecord`, the same predicate the
 * approve action and the per-request notification read, so the digest cannot
 * nudge someone the buttons would then refuse (#1475, L109).
 */
export interface DigestPerson {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

/** One pending request in a manager's digest. `line` is the pre-rendered mrkdwn
 *  describing it (agent + when + reason), built by the route so this module stays
 *  pure; `id` wires the Approve/Decline buttons back to the right request. */
export interface DigestPendingRequest {
  id: string;
  manager_id: string | null;
  line: string;
}

/** Why a pending request has nobody to nudge (#1499). */
export type UnroutedReason =
  /** No manager of record at all. Nine active people are in this state. */
  | "no-manager"
  /** A manager of record who does not hold a manager role (#1475). */
  | "manager-cannot-approve"
  /** A manager of record id that reads back as nobody (offboarded, or stale). */
  | "manager-missing";

/**
 * The daily nudge for requests no manager digest covers, posted to the shared
 * fallback channel where team leads and up see it.
 *
 * It is not a `ManagerDigest`: there is no recipient id or email to key delivery
 * tracking on, and modelling it as one would mean inventing a manager that does
 * not exist.
 */
export interface UnroutedDigest {
  count: number;
  text: string;
  blocks: unknown[];
}

/** Both halves of one digest run. Together they cover every pending request. */
export interface OooDigests {
  managers: ManagerDigest[];
  /** Null when every pending request has a manager who can act on it. */
  unrouted: UnroutedDigest | null;
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
 * The sentence explaining why one request has nobody to nudge.
 *
 * A builder rather than three inline strings, for the same reason the alert copy
 * lives in builders: it is the only way the words can be read and tested without
 * a Slack workspace. Three distinct causes get three distinct sentences (L11):
 * a missing link is nobody's fault, a wrong link is a roster repair, and an
 * unreadable link is a third thing again. None of them may repeat the refusal
 * this replaced, which told the reader to have an admin set their manager: that
 * field is read only because Salesforce owns it (L111).
 */
export function unroutedReasonNote(
  reason: UnroutedReason,
  managerName: string | null,
): string {
  switch (reason) {
    case "no-manager":
      return `No manager of record, so nobody was nudged. ${noManagerReviewerCapitalized()} can approve it.`;
    case "manager-cannot-approve":
      return (
        `${managerName ?? "Their manager of record"} ` +
        `is their manager of record but cannot approve time off, so nobody was nudged. ` +
        `Approve it here, and correct their Agent Manager in Salesforce.`
      );
    case "manager-missing":
      return (
        `Their manager of record could not be found, so nobody was nudged. ` +
        `${noManagerReviewerCapitalized()} can approve it, and their Agent Manager should be corrected in Salesforce.`
      );
  }
}

/**
 * Split the pending queue into per-manager digests plus one post for everything
 * nobody can be nudged about, and build each message.
 *
 * The split is EXHAUSTIVE by construction: a request is routed when its
 * `manager_id` resolves to somebody who `canHoldManagerOfRecord`, and everything
 * else is unrouted. Before #1499 the route filtered out null managers and this
 * builder additionally dropped any it could not resolve, so three shapes fell
 * through both views and were never nudged again after the day they were
 * submitted (L45: no record may sit in a state that matches no view).
 *
 * Sorted by count (busiest first). Each request gets an Approve/Decline row
 * (reusing the same `approvalBlocks` the per-request notification uses, so the
 * interactions endpoint already handles the clicks). Copy is warm and plain with
 * a verb-phrase CTA and no em dashes, per the Slate voice rules.
 */
export function buildOooDigests(
  pending: DigestPendingRequest[],
  people: Map<string, DigestPerson>,
  reviewUrl: string,
): OooDigests {
  const byManager = new Map<string, DigestPendingRequest[]>();
  const unroutedRequests: { request: DigestPendingRequest; note: string }[] = [];
  for (const r of pending) {
    const named = r.manager_id ? people.get(r.manager_id) : null;
    if (named && canHoldManagerOfRecord(named.role)) {
      const list = byManager.get(named.id) ?? [];
      list.push(r);
      byManager.set(named.id, list);
      continue;
    }
    const reason: UnroutedReason = !r.manager_id
      ? "no-manager"
      : named
        ? "manager-cannot-approve"
        : "manager-missing";
    unroutedRequests.push({
      request: r,
      note: unroutedReasonNote(reason, named ? (named.name ?? named.email) : null),
    });
  }

  const out: ManagerDigest[] = [];
  for (const [managerId, requests] of byManager) {
    const manager = people.get(managerId);
    if (!manager) continue;
    const count = requests.length;
    const greeting = manager.name ? `Good morning, ${manager.name}.` : "Good morning.";
    const noun = count === 1 ? "request" : "requests";
    const summary = `${greeting} You have *${count}* time off ${noun} waiting for your approval.`;
    const text = `${summary} Review them here: ${reviewUrl}`;
    out.push({
      managerId,
      email: manager.email,
      count,
      text,
      blocks: digestBlocks(
        summary,
        requests.map((r) => ({ id: r.id, line: r.line })),
        count,
        reviewUrl,
      ),
    });
  }

  return {
    managers: out.sort((a, b) => b.count - a.count),
    unrouted: buildUnroutedDigest(unroutedRequests, reviewUrl),
  };
}

function buildUnroutedDigest(
  items: { request: DigestPendingRequest; note: string }[],
  reviewUrl: string,
): UnroutedDigest | null {
  if (items.length === 0) return null;
  const count = items.length;
  const noun = count === 1 ? "request" : "requests";
  const verb = count === 1 ? "is" : "are";
  const summary =
    `Good morning. *${count}* time off ${noun} ${verb} waiting with nobody to nudge, ` +
    `so ${NO_MANAGER_REVIEWER} needs to take a look.`;
  return {
    count,
    text: `${summary} Review them here: ${reviewUrl}`,
    blocks: digestBlocks(
      summary,
      items.map((i) => ({ id: i.request.id, line: `${i.request.line}\n_${i.note}_` })),
      count,
      reviewUrl,
    ),
  };
}

/** The shared Block Kit body: header, one Approve/Decline row per request, footer. */
function digestBlocks(
  summary: string,
  requests: { id: string; line: string }[],
  count: number,
  reviewUrl: string,
): unknown[] {
  const shown = requests.slice(0, DIGEST_MAX_INTERACTIVE);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: summary } },
    { type: "divider" },
  ];
  for (const r of shown) blocks.push(...approvalBlocks(r.line, r.id));
  const remaining = count - shown.length;
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        remaining > 0
          ? `And ${remaining} more. Review them all here: ${reviewUrl}`
          : `Review them here: ${reviewUrl}`,
    },
  });
  return blocks;
}
