/**
 * The production rollback's decisions (#3094), pure and dependency free so they are
 * driven offline by `scripts/test-rollback-plan.ts`. The I/O is
 * `scripts/rollback-production.ts`, run by `.github/workflows/rollback.yml`.
 *
 * `wrangler rollback <id>` re-points 100% of traffic at an already uploaded version. It
 * does not rebuild. It does NOT revert the database or any bound store (Cloudflare:
 * "resources connected to your Worker will not be changed during a rollback",
 * developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), nor the cron
 * triggers, which are not part of a version at all, and nothing here relies on it
 * reverting a secret or var changed since the target was uploaded. It refuses to cross
 * a Durable Object class lifecycle change.
 *
 * The target choice is the part that matters. Since #3095 every release leaves three
 * deployments behind (old at 100%, the 10/90 split, new at 100%), so "the deployment
 * before this one" is the split, and the version beside the old one in it is a canary
 * uploaded in cron standby. Rolling back to a canary would restore the code and switch
 * every cron lane off. So the default is the newest version that served 100% ON ITS OWN,
 * and a version whose annotation marks it a canary is refused even when named.
 */

import { CANARY_MESSAGE_PREFIX, readDeploymentStatus, type VersionShare } from "./gradual-deploy.ts";
import type { ProbeOutcome } from "./post-deploy-probe.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Deployment {
  createdOn: string;
  versions: VersionShare[];
}

/** `wrangler deployments list --json`, newest LAST; null when it is not that shape. */
export function readDeploymentsList(text: string): Deployment[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const out: Deployment[] = [];
  for (const d of parsed) {
    const createdOn = (d as { created_on?: unknown })?.created_on;
    const versions = readDeploymentStatus(JSON.stringify(d));
    if (typeof createdOn !== "string" || versions === null) return null;
    out.push({ createdOn, versions });
  }
  return out.sort((a, b) => a.createdOn.localeCompare(b.createdOn));
}

export type RollbackTarget =
  /** `named`: the operator named it, so it is honoured as is. Otherwise it is the
   *  newest candidate, and `runRollback` may move past it to a tagged one. */
  | { kind: "target"; versionId: string; current: string; named: boolean; candidates: string[] }
  /** `unreadable`: the deployments could not be read. `refused`: they were read, and no
   *  target is acceptable. Two endings, two exit codes, decided here, never by
   *  re-reading the reason text (L199). */
  | { kind: "refuse"; why: "unreadable" | "refused"; reason: string };

function whole(d: Deployment): string | null {
  return d.versions.length === 1 && d.versions[0].percentage === 100 ? d.versions[0].versionId : null;
}

/** Every version that served 100% on its own before the current deployment, newest
 *  first, each once, the version serving now excluded. Null for an unreadable list. */
export function rollbackCandidates(list: Deployment[] | null): string[] {
  if (list === null) return [];
  const currentWhole = whole(list[list.length - 1]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = list.length - 2; i >= 0; i--) {
    const id = whole(list[i]);
    if (id === null || id === currentWhole || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Which version to go back to: the one named, or the newest that served alone before
 *  the current deployment (which `runRollback` moves past while it is untagged). */
export function chooseRollbackTarget(list: Deployment[] | null, requested: string): RollbackTarget {
  if (list === null) return { kind: "refuse", why: "unreadable", reason: "could not read the Worker's deployments" };
  const current = list[list.length - 1];
  const currentLabel = current.versions.map((v) => `${v.versionId}@${v.percentage}%`).join(", ");
  const currentWhole = whole(current);
  const req = requested.trim();
  if (req) {
    if (!UUID.test(req)) return { kind: "refuse", why: "refused", reason: `"${req}" is not a version id` };
    if (currentWhole === req) return { kind: "refuse", why: "refused", reason: `${req} is already serving 100%` };
    return { kind: "target", versionId: req, current: currentLabel, named: true, candidates: [req] };
  }
  const candidates = rollbackCandidates(list);
  if (candidates.length > 0) {
    return { kind: "target", versionId: candidates[0], current: currentLabel, named: false, candidates };
  }
  return {
    kind: "refuse",
    why: "refused",
    reason: "no earlier deployment served a single version at 100%, so there is nothing known good to go back to; name a version id",
  };
}

export interface VersionView {
  id: string;
  tag: string | null;
  message: string | null;
}

/** `wrangler versions view <id> --json`; null when it is not that shape. */
export function readVersionView(text: string): VersionView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const id = (parsed as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const ann = ((parsed as { annotations?: unknown }).annotations ?? {}) as Record<string, unknown>;
  const tag = typeof ann["workers/tag"] === "string" ? (ann["workers/tag"] as string) : null;
  const message = typeof ann["workers/message"] === "string" ? (ann["workers/message"] as string) : null;
  return { id, tag, message };
}

/** Whether a version is a gradual deploy canary (uploaded in cron standby), read from
 *  its annotation. Null when the view could not be read, which every caller treats as
 *  "might be": serving an unknown version at 100% could switch every cron lane off. */
export function isCanaryView(view: VersionView | null): boolean | null {
  if (view === null) return null;
  return view.message?.startsWith(CANARY_MESSAGE_PREFIX) ?? false;
}

function commitOf(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  return /^[0-9a-f]{7,40}$/.test(t) ? t.slice(0, 12) : null;
}

/** The commit the target should report once it serves: its own tag (every version the
 *  gradual deploy uploads carries one), else what the operator supplied, else unknown. */
export function expectedCommitFor(view: VersionView | null, supplied: string): string | null {
  return commitOf(view?.tag) ?? commitOf(supplied);
}

export const ROLLBACK_EXIT = {
  /** Rolled back, serving the target's commit, probe passed. */
  rolledBack: 0,
  /** Could not read the deployments or the target. Nothing changed. */
  unreadable: 30,
  /** No target, or the target is refused (a canary, the current version). Nothing changed. */
  refused: 31,
  /** `wrangler rollback` failed. */
  rollbackFailed: 32,
  /** Rolled back, and the target failed its probe. */
  probeFailed: 33,
  /** Rolled back, and which commit serves cannot be confirmed (an untagged target). */
  unconfirmed: 34,
  /** Rolled back, and health reports a stale cron lane. */
  fleetCondition: 35,
} as const;

export interface RollbackResult {
  exit: number;
  message: string;
}

export interface RollbackOps {
  list(): Promise<string | null>;
  view(versionId: string): Promise<string | null>;
  rollback(versionId: string): Promise<boolean>;
  probe(expectedCommit: string): Promise<ProbeOutcome>;
  log(line: string): void;
}

const NOT_REVERTED =
  "A rollback re-points code only: the database and the cron triggers are NOT reverted, and a secret or var changed since that version should be assumed still in force and set back by hand.";

export async function runRollback(
  ops: RollbackOps,
  input: { requestedVersionId: string; expectedCommit: string },
): Promise<RollbackResult> {
  let target = chooseRollbackTarget(readDeploymentsList((await ops.list()) ?? ""), input.requestedVersionId);
  if (target.kind === "refuse") {
    return {
      exit: target.why === "unreadable" ? ROLLBACK_EXIT.unreadable : ROLLBACK_EXIT.refused,
      message: `Not rolled back: ${target.reason}. Nothing changed.`,
    };
  }
  // The default target is the newest TAGGED candidate, so the probe can confirm what
  // serves. `wrangler secret put` makes an untagged version at 100% per secret, and
  // those are skipped and named. With nothing tagged at all (history from before the
  // gradual deploy) the newest untagged one is the fallback, rolled back unconfirmed:
  // an emergency must not wait for a tag. A named target is honoured as is.
  let chosen: { id: string; view: VersionView } | null = null;
  let fallback: { id: string; view: VersionView } | null = null;
  const skipped: string[] = [];
  for (const id of target.candidates) {
    const view = readVersionView((await ops.view(id)) ?? "");
    if (view === null) {
      return {
        exit: ROLLBACK_EXIT.unreadable,
        message: `Not rolled back: could not read version ${id}, so it could not be checked for being a canary. Nothing changed.`,
      };
    }
    if (isCanaryView(view)) {
      if (target.named) {
        return {
          exit: ROLLBACK_EXIT.refused,
          message: `Not rolled back: ${id} is a gradual deploy canary, uploaded in cron standby, so serving it at 100% would switch every cron lane off. Name the release version instead. Nothing changed.`,
        };
      }
      skipped.push(`${id} (a canary)`);
      continue;
    }
    if (target.named || view.tag !== null) {
      chosen = { id, view };
      break;
    }
    fallback ??= { id, view };
    skipped.push(`${id} (no commit tag, most likely made by a secret change)`);
  }
  const pick = chosen ?? fallback;
  if (pick === null) {
    return {
      exit: ROLLBACK_EXIT.refused,
      message: `Not rolled back: every earlier version that served alone is a canary (${skipped.join(", ")}), and a canary runs no cron lane, so serving one at 100% would switch every lane off. Name a version id. Nothing changed.`,
    };
  }
  const view = pick.view;
  const skippedNote =
    chosen !== null && skipped.length > 0 ? ` Skipped, newest first: ${skipped.join(", ")}.` : "";
  target = { ...target, versionId: pick.id };
  ops.log(`rolling back from ${target.current} to ${target.versionId}${view.tag ? ` (commit ${view.tag})` : ""}`);
  if (!(await ops.rollback(target.versionId))) {
    return {
      exit: ROLLBACK_EXIT.rollbackFailed,
      message: `The rollback to ${target.versionId} FAILED, so production is most likely still on ${target.current}. Read the run log; \`wrangler rollback\` refuses to cross a Durable Object class change.`,
    };
  }
  const commit = expectedCommitFor(view, input.expectedCommit);
  if (commit === null) {
    return {
      exit: ROLLBACK_EXIT.unconfirmed,
      message: `Rolled back to ${target.versionId}, but it carries no commit tag (it predates the gradual deploy) and none was supplied, so which commit is serving could not be confirmed. Check /api/smoke/version and /api/health by hand. ${NOT_REVERTED}`,
    };
  }
  const probe = await ops.probe(commit);
  if (probe.fault === "fleet") {
    return {
      exit: ROLLBACK_EXIT.fleetCondition,
      message: `Rolled back to ${target.versionId} (commit ${commit}), and health reports a stale cron lane (${probe.summary}); that is read from the shared database and a rollback does not change it. ${NOT_REVERTED}`,
    };
  }
  if (probe.fault !== "none") {
    return {
      exit: ROLLBACK_EXIT.probeFailed,
      message: `Rolled back to ${target.versionId}, and it FAILED its probe (${probe.summary}). Production is serving it anyway; pick another version or fix forward. ${NOT_REVERTED}`,
    };
  }
  return {
    exit: ROLLBACK_EXIT.rolledBack,
    message: `Rolled back to ${target.versionId}: it is serving commit ${commit} and passed its probe.${skippedNote} ${NOT_REVERTED}`,
  };
}
