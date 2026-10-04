/**
 * The reset between load run arms (#3258), as a plan over an injected client so
 * `scripts/test-loadtest-reset.ts` drives every step with no database.
 *
 * Why it exists: the three arms of the post confirm recompute experiment share one
 * branch and one deployment, which saves a fresh environment's secrets and its
 * wait for the first cron delivery per arm. That is only a fair comparison if each
 * arm starts where the first did. The previous arm's bookings make agents busier
 * (busy blocks, daily caps) and widen every candidate read; its leftover outbox
 * rows and reservations are drained by the lanes during the next arm; and its rate
 * limit rows can refuse the next arm's drivers, which run at the per address
 * ceiling.
 *
 * DELETE, never TRUNCATE. `busy_blocks.booking_id` cascades on delete, so deleting
 * bookings removes only the busy time a booking wrote; a TRUNCATE ... CASCADE would
 * empty the whole table, the seeded calendar busy time with it, and the next arm
 * would run against a different calendar. Bookings go first because the other
 * booking tables only null their reference when a booking is deleted
 * (booking_outbox, pending_event_deletions, routing_decisions) or carry none
 * (booking_reservations, rate_limits).
 *
 * `bulk_reassign_items.booking_id` references bookings with NO delete rule, so a
 * row there would make the bookings delete fail half way. The bulk reassign lane is
 * disabled in the load test environment, so a row means something unexpected
 * happened on this branch: the reset refuses, naming it, before deleting anything,
 * rather than deleting evidence nobody has looked at.
 */

import {
  productionRefusal,
  SEED_AGENT_EMAIL_DOMAIN,
  SEED_ORG_ID,
  SEED_ORG_NAME,
} from "./seed-guards.ts";

/** The tables the reset empties, in the order it empties them. */
export const RESET_ORDER = [
  "bookings",
  "booking_outbox",
  "booking_reservations",
  "pending_event_deletions",
  "routing_decisions",
  "rate_limits",
] as const;
export type ResetTable = (typeof RESET_ORDER)[number];

/** What the database says about the seed's marker, read before anything is deleted. */
export interface SeedMarker {
  /** Every organization in the project. A seeded branch holds the load test org alone. */
  orgs: { id: string; name: string }[];
  /** How many users carry the seed's agent address (`loadtest-agent-<n>@loadtest.local`). */
  seedAgents: number;
}

/** The database calls the reset makes, injected so a test can stand in for them. */
export interface ResetClient {
  readSeedMarker(): Promise<SeedMarker>;
  /** The first bulk reassign row on the branch (item or job), or null when none. */
  firstBulkReassignRow(): Promise<{ table: string; id: string } | null>;
  /** Delete every row of `table`, answering how many were deleted. Throws on failure. */
  deleteAll(table: ResetTable): Promise<number>;
}

/** Where the reset is pointed, and the branch ref recorded for this run. */
export interface ResetTarget {
  url: string;
  /** From RESET_BRANCH_REF; undefined when nothing was recorded. */
  expectedRef: string | undefined;
  productionRef: string;
}

export type ResetResult =
  | { ok: true; deleted: { table: ResetTable; rows: number }[] }
  | { ok: false; why: string };

/** The project ref in a Supabase address (`https://<ref>.supabase.co`), or null. */
export function projectRefOf(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim());
  return m ? m[1]! : null;
}

/**
 * Whether the target is positively a seeded load test branch, or why not (#3258,
 * #3269 review). NOT a blocklist: "anything but production" would empty staging or
 * a dev project the first time somebody pointed it at one. Two independent proofs,
 * both required:
 *
 *   1. the URL's ref EQUALS the ref recorded for this run (RESET_BRANCH_REF), so the
 *      reset acts only on the branch somebody wrote down for this experiment;
 *   2. the database carries the seed's own marker: the load test org as its ONLY
 *      organization, under the seed's name, with the seed's agents in it. A real
 *      project holds its own org; a project the seed was once run into still does.
 */
export function targetRefusal(target: ResetTarget, marker?: SeedMarker): string | null {
  const prod = productionRefusal(target.url, target.productionRef, { force: false, action: "reset" });
  if (prod) return prod;
  if (marker === undefined) {
    const expected = target.expectedRef?.trim() ?? "";
    if (expected === "") {
      return "RESET_BRANCH_REF is not set, so which branch this run recorded cannot be established. Set it to the branch's ref.";
    }
    const got = projectRefOf(target.url);
    if (got === null) return `SUPABASE_URL (${target.url}) is not a Supabase project address, so it cannot be the recorded branch ${expected}.`;
    if (got !== expected) return `SUPABASE_URL names project ${got}, and the branch recorded for this run is ${expected}.`;
    return null;
  }
  const seedOrg = marker.orgs.find((o) => o.id === SEED_ORG_ID && o.name === SEED_ORG_NAME);
  if (!seedOrg) {
    return `this project has no "${SEED_ORG_NAME}" organization (${SEED_ORG_ID}), so it was never seeded by scripts/loadtest/seed.ts.`;
  }
  const others = marker.orgs.filter((o) => o !== seedOrg);
  if (others.length > 0) {
    return (
      `this project holds ${others.length} organization(s) besides the load test one ` +
      `(${others.slice(0, 3).map((o) => `"${o.name}"`).join(", ")}), so it carries data that is not the seed's.`
    );
  }
  if (marker.seedAgents === 0) {
    return `this project holds no seeded agents (loadtest-agent-<n>@${SEED_AGENT_EMAIL_DOMAIN}), so it is not a seeded load test branch.`;
  }
  return null;
}

export async function resetBranch(client: ResetClient, target: ResetTarget): Promise<ResetResult> {
  const before = targetRefusal(target);
  if (before) return { ok: false, why: before };
  const marker = await client.readSeedMarker();
  const notSeeded = targetRefusal(target, marker);
  if (notSeeded) return { ok: false, why: notSeeded };
  const bulk = await client.firstBulkReassignRow();
  if (bulk) {
    return {
      ok: false,
      why:
        `${bulk.table} holds row ${bulk.id}. The bulk reassign lane is off in the load test ` +
        `environment, so this row is unexpected; nothing was deleted. Find out where it came ` +
        `from before resetting.`,
    };
  }
  const deleted: { table: ResetTable; rows: number }[] = [];
  for (const table of RESET_ORDER) deleted.push({ table, rows: await client.deleteAll(table) });
  return { ok: true, deleted };
}
