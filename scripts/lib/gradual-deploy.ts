/**
 * The gradual deploy's decisions (#3095), kept pure and dependency free so every one of
 * them is driven offline by `scripts/test-gradual-deploy.ts`. The I/O (wrangler, the
 * probe's HTTP reads, the clock) lives in `scripts/deploy-gradual.ts` and is handed in.
 *
 * THE SHAPE, decided by Dan on 2026-10-03: upload the new version, send 10% of real
 * traffic to it, probe it through the version override header, then promote it to 100%
 * if the probes pass, or leave the old version serving and page if they fail.
 *
 * Three facts about the platform shape everything below. Each is cited where it is used.
 *
 *   1. A deployment holds at most two versions, each with a percentage, and a request
 *      carrying `Cloudflare-Workers-Version-Overrides: slate="<id>"` is served by that
 *      version only if it is IN the current deployment; otherwise the override is
 *      silently ignored and the request is routed by the split
 *      (developers.cloudflare.com/workers/versions-and-deployments/version-overrides/).
 *      So a single matching answer proves nothing: the probe demands a run of them.
 *   2. Cron triggers are not part of a version. `wrangler versions upload` does not
 *      change them and `wrangler triggers deploy` is what applies them (wrangler 4.147
 *      says so after every upload). Cloudflare does NOT document which version a
 *      scheduled event is handed to while two versions serve, so nothing here relies on
 *      it: the canary is uploaded with SLATE_CRON_STANDBY=1 and its scheduled() handler
 *      runs no lane at all (worker/cron-standby.ts). Whatever Cloudflare does, only the
 *      OLD version runs cron lanes during the split, and a tick that happens to be handed
 *      to the canary is dropped rather than run twice or run by unproven code.
 *   3. Durable Objects: each object is assigned ONE version per deployment by the same
 *      percentages, and requests to it use that version for the life of the deployment
 *      (developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/).
 *      BurstLimiter keeps its count in storage, so the one reset an object takes when its
 *      version changes loses nothing. A version that changes a Durable Object CLASS
 *      LIFECYCLE (a migration) cannot be uploaded at all; the upload refuses, nothing
 *      has changed, and that release ships by hand (DEPLOY.md).
 *
 * The dropped tick in (2) is why the split is never opened across a schedule that runs
 * rarely: `msUntilSplitWindowClear` waits until no hourly or daily instant falls inside
 * the window, so the only ticks the canary can ever be handed are lanes that run again
 * within fifteen minutes.
 */

import type { ProbeOutcome } from "./post-deploy-probe.ts";

/** The Worker's name in wrangler.jsonc, and the key in the version override header. */
export const WORKER_NAME = "slate";
/** The share of real traffic the new version takes while it is probed. Dan, 2026-10-03. */
export const CANARY_PERCENT = 10;
/** The variable that puts a version's scheduled() handler into standby. */
export const CRON_STANDBY_VAR = "SLATE_CRON_STANDBY";
/** Consecutive matching version answers that confirm which version is answering. At
 *  10% per stray request, five in a row from the wrong version is 1 in 100,000. */
export const CONFIRMATIONS = 5;
/**
 * How long the canary probe waits for the override to reach the new version. An
 * override is applied once the deployment has propagated, which Cloudflare puts at "up
 * to a couple of seconds"; two minutes is ample, and it bounds how long real traffic is
 * split. The promotion probe keeps the plain probe's own four minute window, measured
 * against a real propagation (scripts/lib/post-deploy-probe.ts).
 */
export const CANARY_VERSION_TIMEOUT_MS = 120_000;
/**
 * The longest the split can stand, from the call that opens it to the call that ends
 * it: the canary probe at its worst (the two minutes above, then its health and
 * availability reads) and the promote or restore call with its retries. The cron
 * window below is sized from this, so a longer probe has to move it.
 */
export const SPLIT_BUDGET_MS = 6 * 60_000;
/** After a protected cron instant, how long before the split may open: the tick has to
 *  have been handed out first, and Cloudflare fires a cron up to a minute late. */
export const CRON_MARGIN_MS = 90_000;
/** How many times a restore of the old version is attempted before giving up. */
export const RESTORE_ATTEMPTS = 3;

// --- the deployment Cloudflare reports ------------------------------------------------

export interface VersionShare {
  versionId: string;
  percentage: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The versions in `wrangler deployments status --json`, or null when the output is not
 * that shape. Null is never read as "no deployment": a deploy that cannot see what is
 * serving cannot know what to restore, so it refuses before changing anything.
 */
export function readDeploymentStatus(text: string): VersionShare[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const versions = (parsed as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const out: VersionShare[] = [];
  for (const v of versions) {
    const id = (v as { version_id?: unknown })?.version_id;
    const pct = (v as { percentage?: unknown })?.percentage;
    if (typeof id !== "string" || !UUID.test(id) || typeof pct !== "number" || !Number.isFinite(pct)) {
      return null;
    }
    out.push({ versionId: id, percentage: pct });
  }
  return out;
}

export type StartPlan =
  | { kind: "stable"; versionId: string }
  /** A split left behind by a run that died: the larger share is the old version our own
   *  runs keep at 90%, so it is the one restored. */
  | { kind: "heal"; versionId: string; from: VersionShare[] }
  | { kind: "refuse"; reason: string };

/** What is serving now, and therefore what a failure restores. */
export function planStart(status: VersionShare[] | null): StartPlan {
  if (status === null) {
    return {
      kind: "refuse",
      reason:
        "could not read which version production is serving, so there would be nothing known to restore if the new version failed",
    };
  }
  if (status.length === 1 && status[0].percentage === 100) {
    return { kind: "stable", versionId: status[0].versionId };
  }
  if (status.length === 2) {
    const [a, b] = [...status].sort((x, y) => y.percentage - x.percentage);
    if (a.percentage > b.percentage && a.percentage + b.percentage === 100) {
      return { kind: "heal", versionId: a.versionId, from: status };
    }
    return {
      kind: "refuse",
      reason: `production is split ${a.percentage}/${b.percentage} with no larger share to call the serving version; settle it by hand (DEPLOY.md, Rollback) before deploying`,
    };
  }
  return {
    kind: "refuse",
    reason: `production reports a deployment this does not recognise (${status.map((s) => `${s.versionId}@${s.percentage}%`).join(", ")})`,
  };
}

/** The positional specs `wrangler versions deploy` takes: `<id>@<percent>%`. */
export function splitSpecs(stable: string, canary: string): string[] {
  if (stable === canary) throw new Error("the canary and the serving version are the same version");
  return [`${canary}@${CANARY_PERCENT}%`, `${stable}@${100 - CANARY_PERCENT}%`];
}

export function wholeSpecs(versionId: string): string[] {
  return [`${versionId}@100%`];
}

/** The Worker a wrangler environment deploys: wrangler names it `<name>-<env>`, so the
 *  load test rehearsal's override header must name `slate-loadtest`, not `slate`. An
 *  override naming the wrong Worker is silently ignored. */
export function workerNameFor(wranglerEnv: string | undefined): string {
  const e = (wranglerEnv ?? "").trim();
  return e ? `${WORKER_NAME}-${e}` : WORKER_NAME;
}

/** The override header's value, a structured-header dictionary: `slate="<id>"`. */
export function overrideValue(versionId: string, workerName = WORKER_NAME): string {
  if (!UUID.test(versionId)) throw new Error(`not a version id: ${versionId}`);
  return `${workerName}="${versionId}"`;
}

// --- the uploads -------------------------------------------------------------------

export type UploadKind = "canary" | "release";

/** Annotation prefixes, so a version's role is readable later from `versions view`. The
 *  rollback refuses a canary as a target, because a canary runs no cron lane. */
export const CANARY_MESSAGE_PREFIX = "slate-canary-";
export const RELEASE_MESSAGE_PREFIX = "slate-release-";

/**
 * The flags handed through `opennextjs-cloudflare upload` to `wrangler versions upload`.
 *
 * No value carries a space or a quote, deliberately: the adapter runs wrangler through a
 * shell with the arguments joined, so anything that needed quoting would be split. The
 * tag is the commit, which is what the rollback reads to know what the version should
 * report once it serves.
 */
export function uploadArgs(kind: UploadKind, commit: string): string[] {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  const prefix = kind === "canary" ? CANARY_MESSAGE_PREFIX : RELEASE_MESSAGE_PREFIX;
  return [
    "--tag",
    commit,
    "--message",
    `${prefix}${commit}`,
    ...(kind === "canary" ? ["--var", `${CRON_STANDBY_VAR}:1`] : []),
  ];
}

/**
 * The version id from wrangler's output file (WRANGLER_OUTPUT_FILE_PATH), which is one
 * JSON object per line. Null when no `version-upload` record names a valid id: the run
 * then cannot address the version it uploaded and must not guess at one.
 */
export function versionIdFromUploadOutput(ndjson: string): string | null {
  let found: string | null = null;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; version_id?: unknown };
      if (rec.type === "version-upload" && typeof rec.version_id === "string" && UUID.test(rec.version_id)) {
        found = rec.version_id;
      }
    } catch {
      // A line that is not JSON is not a record; the others still count.
    }
  }
  return found;
}

// --- the cron window -----------------------------------------------------------------

/** Strip `//` and block comments from JSONC, leaving string contents untouched. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The top level cron expressions in wrangler.jsonc, or null when they cannot be read. */
export function cronsFromWranglerConfig(text: string): string[] | null {
  try {
    // Trailing commas are legal JSONC and not JSON.
    const json = JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1")) as {
      triggers?: { crons?: unknown };
    };
    const crons = json.triggers?.crons;
    if (!Array.isArray(crons) || crons.length === 0 || !crons.every((c) => typeof c === "string")) return null;
    return crons as string[];
  } catch {
    return null;
  }
}

/** A cron lane that runs again within this long can lose one tick to the canary. */
export const FREQUENT_CRON_MAX_MINUTES = 15;

/**
 * True when the expression fires at least every fifteen minutes around the clock. Only
 * those may fall inside the split: a tick of theirs handed to the canary is made good by
 * the next one, within the bound every one of their heartbeats already allows. Anything
 * rarer (hourly, daily, the two-slot digests whose route lets exactly one slot fire) is
 * PROTECTED, because losing its tick loses the hour or the day.
 */
export function isFrequentCron(expr: string): boolean {
  const [minute, hour] = expr.trim().split(/\s+/);
  if (hour !== "*") return false;
  if (minute === "*") return true;
  const step = /^\*\/(\d+)$/.exec(minute ?? "");
  return step !== null && Number(step[1]) <= FREQUENT_CRON_MAX_MINUTES;
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return value % Number(step[1]) === 0;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return /^\d+$/.test(part) && Number(part) === value;
  });
}

/**
 * Whether a protected expression fires in the UTC minute starting at `minuteMs`.
 *
 * Minute and hour only. The day fields are ignored, which can only make it fire MORE
 * often than the real schedule (a weekday slot is treated as daily), so it errs toward
 * waiting, never toward opening the split across a real tick.
 */
export function cronFiresAt(expr: string, minuteMs: number): boolean {
  const [minute, hour] = expr.trim().split(/\s+/);
  if (minute === undefined || hour === undefined) return true;
  const d = new Date(minuteMs);
  return fieldMatches(minute, d.getUTCMinutes()) && fieldMatches(hour, d.getUTCHours());
}

/**
 * How long to wait before opening the split so that no protected cron instant falls
 * inside it, counting `marginMs` after each instant for its tick to have been handed
 * out. Zero when the window is already clear.
 */
export function msUntilSplitWindowClear(
  nowMs: number,
  crons: string[],
  budgetMs = SPLIT_BUDGET_MS,
  marginMs = CRON_MARGIN_MS,
): number {
  const protectedCrons = crons.filter((c) => !isFrequentCron(c));
  let start = nowMs;
  // Each pass either returns or moves the start past one instant, and instants are
  // at most one a minute, so a day of passes is far more than any schedule needs.
  for (let pass = 0; pass < 1440; pass++) {
    const firstMinute = Math.floor((start - marginMs) / 60_000) * 60_000;
    let conflict: number | null = null;
    for (let m = firstMinute; m <= start + budgetMs; m += 60_000) {
      if (m + marginMs < start) continue;
      if (protectedCrons.some((c) => cronFiresAt(c, m))) {
        conflict = m;
        break;
      }
    }
    if (conflict === null) return start - nowMs;
    start = conflict + marginMs + 1;
  }
  throw new Error("no clear window in a day: the protected cron schedule leaves no room for a split");
}

/** The longest any deploy can be made to wait, scanned over a whole day at second steps
 *  past each minute boundary. What the job's own timeout is sized against. */
export function maxCronWaitMs(crons: string[], budgetMs = SPLIT_BUDGET_MS, marginMs = CRON_MARGIN_MS): number {
  let worst = 0;
  const day0 = Date.UTC(2026, 0, 5); // a Monday, though the day fields are ignored anyway
  for (let s = 0; s < 86_400; s += 15) {
    worst = Math.max(worst, msUntilSplitWindowClear(day0 + s * 1000, crons, budgetMs, marginMs));
  }
  return worst;
}

// --- the run itself ----------------------------------------------------------------

/** How a run ended, as a process exit code. Each one is its own message and its own
 *  remedy, so none of them may share a number (scripts/test-gradual-deploy.ts). */
export const EXIT = {
  /** Promoted, probed and healthy. */
  promoted: 0,
  /** Could not read what production serves. Nothing changed. */
  unreadable: 10,
  /** An upload failed. Nothing changed. */
  uploadFailed: 11,
  /** The split could not be opened. The old version was restored. */
  splitFailed: 12,
  /** The new version failed its probe at 10%. The old version was restored. */
  canaryFailed: 13,
  /** The promotion call failed. The old version was restored. */
  promoteFailed: 14,
  /** The new version failed its probe at 100%. The old version was restored. */
  promotedFailed: 15,
  /** Promoted, and health reports a stale cron lane this release is not answerable for. */
  promotedFleetCondition: 16,
  /** Promoted, and the cron triggers could not be applied. */
  triggersFailed: 17,
  /** A restore failed: production may still be split. */
  restoreFailed: 20,
} as const;

export type EndState = "new" | "old" | "unchanged" | "unknown";

export interface GradualResult {
  exit: number;
  end: EndState;
  message: string;
}

export interface GradualOps {
  /** `wrangler deployments status --json`, parsed; null when unreadable. */
  status(): Promise<VersionShare[] | null>;
  /** Upload one version; its id, or null when the upload failed. */
  upload(kind: UploadKind): Promise<string | null>;
  /** `wrangler versions deploy <specs> -y`; true when it succeeded. */
  deploy(specs: string[], message: string): Promise<boolean>;
  /** Probe the canary through the override header, or production as a whole. */
  probe(stage: "canary" | "promoted", canaryId: string | null): Promise<ProbeOutcome>;
  /** `wrangler triggers deploy`; true when it succeeded. */
  triggers(): Promise<boolean>;
  /** Wait before opening the split until the cron window is clear. */
  waitForCronWindow(): Promise<void>;
  log(line: string): void;
}

function probeLines(o: ProbeOutcome): string {
  return o.steps.map((s) => `${s.ok ? "ok" : "FAIL"}: ${s.name} (${s.detail})`).join("; ");
}

/**
 * Put the old version back at 100%, retrying. The one call whose failure leaves
 * production split, so it is the only one retried, and its failure is its own ending.
 */
async function restore(ops: GradualOps, stable: string, why: string): Promise<boolean> {
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    ops.log(`restoring ${stable} at 100% (${why}), attempt ${attempt} of ${RESTORE_ATTEMPTS}`);
    if (await ops.deploy(wholeSpecs(stable), `slate-restore-${stable.slice(0, 8)}`)) return true;
  }
  return false;
}

function restored(ok: boolean, exit: number, stable: string, message: string): GradualResult {
  return ok
    ? { exit, end: "old", message: `${message} The previous version ${stable} is serving 100% again.` }
    : {
        exit: EXIT.restoreFailed,
        end: "unknown",
        message: `${message} Restoring the previous version ${stable} FAILED ${RESTORE_ATTEMPTS} times, so production may still be split. Run the Rollback workflow (or \`wrangler versions deploy ${stable}@100% -y\`) now.`,
      };
}

/**
 * The whole deploy, as decisions. Every path that opens the split ends it, at 100% of the
 * old version or 100% of the new one, before returning, and says which.
 */
export async function runGradualDeploy(ops: GradualOps): Promise<GradualResult> {
  const start = planStart(await ops.status());
  if (start.kind === "refuse") {
    return { exit: EXIT.unreadable, end: "unchanged", message: `Not deploying: ${start.reason}.` };
  }
  const stable = start.versionId;
  if (start.kind === "heal") {
    // A split left by a run that died. Settling it first is what keeps the rule that no
    // run starts or ends on a split; the larger share is the version that was serving.
    ops.log(`production was left split (${start.from.map((s) => `${s.versionId}@${s.percentage}%`).join(", ")}); settling it on ${stable} first`);
    if (!(await restore(ops, stable, "a previous run left production split"))) {
      return restored(false, EXIT.restoreFailed, stable, "Production was already split when this run started.");
    }
  }
  ops.log(`production is serving ${stable} at 100%`);

  // Both versions are uploaded BEFORE the split opens, so the split lasts only as long as
  // the probe, and a failed upload has changed nothing anybody is served.
  const canary = await ops.upload("canary");
  if (canary === null) {
    return {
      exit: EXIT.uploadFailed,
      end: "unchanged",
      message:
        "Not deployed: the canary version could not be uploaded, so nothing changed and the previous version is still serving 100%. If this release changes a Durable Object class (a `migrations` entry in wrangler.jsonc), Cloudflare refuses to upload it as a version at all and it has to ship by hand with `pnpm cf:deploy:verified` (DEPLOY.md).",
    };
  }
  const release = await ops.upload("release");
  if (release === null) {
    return {
      exit: EXIT.uploadFailed,
      end: "unchanged",
      message: "Not deployed: the release version could not be uploaded, so nothing changed and the previous version is still serving 100%.",
    };
  }
  if (canary === stable || release === stable || canary === release) {
    return {
      exit: EXIT.uploadFailed,
      end: "unchanged",
      message: `Not deployed: the uploads reported version ids that are not new (serving ${stable}, canary ${canary}, release ${release}), so there is nothing distinct to split to. Nothing changed.`,
    };
  }

  await ops.waitForCronWindow();

  ops.log(`opening the split: ${canary} (canary, cron standby) at ${CANARY_PERCENT}%, ${stable} at ${100 - CANARY_PERCENT}%`);
  if (!(await ops.deploy(splitSpecs(stable, canary), `slate-canary-split`))) {
    // The call failed, but whether Cloudflare applied it is not known, so the restore is
    // made either way: restoring a deployment that never changed is harmless.
    const ok = await restore(ops, stable, "the split call failed");
    return restored(ok, EXIT.splitFailed, stable, "Not deployed: the split could not be opened.");
  }

  const canaryProbe = await ops.probe("canary", canary);
  ops.log(`canary probe: ${probeLines(canaryProbe)}`);
  if (canaryProbe.fault === "version" || canaryProbe.fault === "release") {
    const ok = await restore(ops, stable, "the canary failed its probe");
    return restored(
      ok,
      EXIT.canaryFailed,
      stable,
      `Not deployed: the new version failed its probe while serving ${CANARY_PERCENT}% (${canaryProbe.summary}).`,
    );
  }
  if (canaryProbe.fault === "fleet") {
    ops.log("health reports a stale cron lane; that is read from the shared database, the same from either version, so it does not hold back the release");
  }

  ops.log(`promoting ${release} (the same build, without cron standby) to 100%`);
  if (!(await ops.deploy(wholeSpecs(release), `slate-release`))) {
    const ok = await restore(ops, stable, "the promotion call failed");
    return restored(ok, EXIT.promoteFailed, stable, "Not deployed: the new version passed its probe but could not be promoted.");
  }

  const finalProbe = await ops.probe("promoted", null);
  ops.log(`promotion probe: ${probeLines(finalProbe)}`);
  if (finalProbe.fault === "version" || finalProbe.fault === "release") {
    const ok = await restore(ops, stable, "the promoted version failed its probe");
    return restored(
      ok,
      EXIT.promotedFailed,
      stable,
      `Rolled back: the new version passed at ${CANARY_PERCENT}% and failed its probe at 100% (${finalProbe.summary}).`,
    );
  }

  // Only now: cron triggers belong to the code that will run them, and a restore above
  // would have left new triggers driving old code.
  if (!(await ops.triggers())) {
    return {
      exit: EXIT.triggersFailed,
      end: "new",
      message: `Deployed ${release} at 100%, but \`wrangler triggers deploy\` failed, so the cron schedule may still be the previous one. Re-run this job, or run \`pnpm exec wrangler triggers deploy\`. The code is NOT rolled back for this: it passed its probes, and the triggers call is safe to repeat.`,
    };
  }

  if (finalProbe.fault === "fleet") {
    return {
      exit: EXIT.promotedFleetCondition,
      end: "new",
      message: `Deployed ${release} at 100%, and health reports a stale cron lane (${finalProbe.summary}). That is a fact about the fleet, read from the shared database, not about this release, so it was not rolled back. Look at the lane.`,
    };
  }
  return { exit: EXIT.promoted, end: "new", message: `Deployed ${release} at 100%: it passed at ${CANARY_PERCENT}% and again at 100%.` };
}

/** What the after-the-fact settle step should do: nothing, or put the larger share back
 *  at 100%. For a job that was cancelled or timed out between opening and ending the split. */
export function planSettle(status: VersionShare[] | null): { action: "none" } | { action: "deploy"; specs: string[] } | { action: "refuse"; reason: string } {
  const plan = planStart(status);
  if (plan.kind === "stable") return { action: "none" };
  if (plan.kind === "heal") return { action: "deploy", specs: wholeSpecs(plan.versionId) };
  return { action: "refuse", reason: plan.reason };
}
