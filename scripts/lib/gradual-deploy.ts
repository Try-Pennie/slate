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
 *      to the canary is dropped rather than run twice or run by unproven code. Since
 *      #3693 the old version sends each lane over its binding to itself, and a binding
 *      call is routed by the split like any request, so the canary's fetch handler
 *      refuses a placed lane before the app (`placedLaneStandbyRefusal`) and the old
 *      version runs it in process instead.
 *   3. Durable Objects: Slate's own Worker hosts none since #4025 (every object lives in
 *      a small Worker of its own, OBJECT_WORKER_CONFIGS, deployed whole before the
 *      uploads), so the split never runs two versions of an object. A version that changes a Durable Object CLASS
 *      LIFECYCLE (a migration) cannot be uploaded at all; the upload refuses, nothing
 *      has changed, and that release ships by hand (DEPLOY.md).
 *
 * The dropped tick in (2) is why the split is never opened across a schedule that runs
 * rarely: `msUntilSplitWindowClear` waits until no hourly or daily instant falls inside
 * the window, so the only ticks the canary can ever be handed are lanes that run again
 * within fifteen minutes.
 */

import type { ProbeOutcome } from "./post-deploy-probe.ts";
import { deployObjectWorkers, uncheckedLineWarning, uncomparedLineWarning, type LiveAppProtocol, type ObjectWorkerFacts } from "./object-worker-skip.ts";

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

/** Whether a run deploys the log tail worker. Only production has one: the load test
 *  environment sets `tail_consumers: []`, and a rehearsal there must never redeploy the
 *  production tail worker. */
export function shouldDeployTailWorker(wranglerEnv: string | undefined): boolean {
  return (wranglerEnv ?? "").trim() === "";
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

/**
 * Why an upload was refused, read from the same output file: the `command-failed`
 * record wrangler writes when a command fails (#3352). A release that changes a Durable
 * Object class is refused with "This Worker has a pending Durable Object migration"
 * (measured in run 37389636410, the #3344 merge). Anything else, or a file that does not
 * read, is no recognised refusal, and the run reports a plain failed upload, whose own
 * message still names this case as the likely one.
 */
export function uploadRefusalFromOutput(ndjson: string): "pending-do-migration" | null {
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; message?: unknown };
      if (rec.type === "command-failed" && typeof rec.message === "string" && /pending Durable Object migration/i.test(rec.message)) {
        return "pending-do-migration";
      }
    } catch {
      // A line that is not JSON is not a record.
    }
  }
  return null;
}

/** An upload Cloudflare refused for a reason the run can name. */
export interface UploadRefusal {
  refused: "pending-do-migration";
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
  // A step of 0 is not a schedule anybody can read, so it is protected, never frequent.
  return step !== null && Number(step[1]) >= 1 && Number(step[1]) <= FREQUENT_CRON_MAX_MINUTES;
}

/** Whether every part of a cron field is a form `fieldMatches` understands. */
export function fieldReadable(field: string): boolean {
  return field.split(",").every((part) => {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    return m !== null && (m[2] === undefined || Number(m[2]) >= 1);
  });
}

/**
 * Whether one cron field admits `value`. Understands `*`, `n`, `a-b`, and a `/step` on
 * any of them. Anything else it cannot read answers TRUE, "may fire": the only cost of
 * that is a wait (or, for a field that admits every minute, a deploy that refuses to
 * open the split at all), while answering false would open the split across a rare
 * tick the canary then drops.
 */
export function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!m) return true;
    const [base, stepText] = [m[1], m[2]];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!(step >= 1)) return true;
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = 0;
      hi = Number.MAX_SAFE_INTEGER;
    } else if (base.includes("-")) {
      [lo, hi] = base.split("-").map(Number) as [number, number];
    } else {
      lo = Number(base);
      // `n/step` means from n to the end of the range in cron; `n` alone is just n.
      hi = stepText === undefined ? lo : Number.MAX_SAFE_INTEGER;
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
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
  const fields = expr.trim().split(/\s+/);
  // Not a five field expression: nothing about it can be read, so it may fire at any time.
  if (fields.length !== 5) return true;
  const [minute, hour] = fields;
  // One field it cannot read makes the whole expression unknowable: "0 foo * * *"
  // must not be read as "minute 0 of no hour", which would never wait for it.
  if (!fieldReadable(minute) || !fieldReadable(hour)) return true;
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

/**
 * #3500, #3555, #3512: the small workers that host Slate's Durable Objects, each deployed whole
 * before Slate on every path that deploys it (this gradual deploy, the hand deploy, the
 * load run), because Slate binds its objects to them by script name. #3561: each only
 * when its bundle or config differs from the version serving, since a Worker deploy
 * restarts its objects (scripts/lib/object-worker-skip.ts).
 */
export const OBJECT_WORKER_CONFIGS = ["wrangler.confirm-line.jsonc", "wrangler.burst-limiter.jsonc", "wrangler.token-holder.jsonc"] as const;

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
  /** Something THREW after the split opened. The old version was restored. */
  threw: 18,
  /** Something THREW before the split opened (an upload, the cron window, a read).
   *  Nothing changed. */
  threwBeforeSplit: 19,
  /** A leftover split's larger share is a cron standby canary, or could not be read.
   *  Nothing changed: healing would serve it at 100% with every cron lane off. */
  healRefused: 21,
  /** Production was changed by something else mid-run (the Rollback workflow, a hand
   *  deploy). This run stopped and left it exactly as it found it. */
  interfered: 22,
  /** Slate promoted and healthy, and the log tail worker (slate-log-tail) could not be
   *  deployed after it. Slate is NOT rolled back for this. */
  tailWorkerFailed: 23,
  /** The deploy script itself failed outside the run's own handling. What production
   *  is serving is not known to it; the settle step reads what was recorded. */
  scriptFailed: 24,
  /** A restore failed: production may still be split. */
  restoreFailed: 20,
  /** The release changes a Durable Object class, which Cloudflare refuses to upload as a
   *  version (#3352). Nothing changed; it ships by hand, and until it does every later
   *  deploy ends here too. */
  classChange: 25,
  /** #3500, #3555, #3512: an object worker (the confirm line's, the burst limiter's or the
   *  token holder's) that needed deploying (#3561: it changed, or could not be proved
   *  unchanged) failed to deploy or threw, so nothing of Slate's was uploaded: Slate's
   *  bindings name them. Nothing of Slate's changed. */
  objectWorkerFailed: 26,
  /** #3560: the confirm line build speaks an older protocol than the live app, so
   *  deploying it would put a line object older than the app in front of it, where a
   *  crowd books one advisor or none. Nothing was deployed. */
  lineOlderThanApp: 27,
} as const;

export type EndState = "new" | "old" | "unchanged" | "unknown";

/**
 * Where production ends for each exit code. One table, so a result can never pair an
 * exit with the wrong end state, and DEPLOY.md's table is checked against it
 * (scripts/test-gradual-deploy.ts).
 */
export const EXIT_END: Record<keyof typeof EXIT, EndState> = {
  promoted: "new",
  unreadable: "unchanged",
  uploadFailed: "unchanged",
  splitFailed: "old",
  canaryFailed: "old",
  promoteFailed: "old",
  promotedFailed: "old",
  promotedFleetCondition: "new",
  triggersFailed: "new",
  threw: "old",
  threwBeforeSplit: "unchanged",
  restoreFailed: "unknown",
  healRefused: "unchanged",
  interfered: "unknown",
  tailWorkerFailed: "new",
  scriptFailed: "unknown",
  classChange: "unchanged",
  objectWorkerFailed: "unchanged",
  lineOlderThanApp: "unchanged",
};

export interface GradualResult {
  exit: number;
  end: EndState;
  message: string;
}

export interface GradualOps {
  /** `wrangler deployments status --json`, parsed; null when unreadable. */
  status(): Promise<VersionShare[] | null>;
  /** Upload one version; its id, a refusal the run can name, or null when it failed otherwise. */
  upload(kind: UploadKind): Promise<string | UploadRefusal | null>;
  /** `wrangler versions deploy <specs> -y`; true when it succeeded. */
  deploy(specs: string[], message: string): Promise<boolean>;
  /** Probe the canary through the override header, or production as a whole. */
  probe(stage: "canary" | "promoted", canaryId: string | null): Promise<ProbeOutcome>;
  /** `wrangler triggers deploy`; true when it succeeded. */
  triggers(): Promise<boolean>;
  /**
   * Deploy the log tail worker (`wrangler deploy -c wrangler.log-tail.jsonc`) whole,
   * AFTER Slate is promoted and has passed its probe: the tail worker binds to an
   * entrypoint of Slate's (#3191), which must exist before it does. True when it
   * succeeded, or when this run targets an environment that has no tail worker
   * (`shouldDeployTailWorker`).
   */
  tailWorker(): Promise<boolean>;
  /**
   * #3500, #3555: deploy one object worker (`wrangler deploy -c <config>`) whole, BEFORE
   * anything of Slate's is uploaded: Slate binds its objects to them by script name. True
   * when it succeeded. #3561: called only for one whose bundle differs from the version
   * serving (or could not be proved the same), with the stamp to write as the version's
   * message, null when the bundle's hash is not known.
   */
  objectWorker(config: string, message: string | null): Promise<boolean>;
  /** #3561: what decides whether an object worker needs deploying: its local bundle's
   *  hash and the version serving. May throw; a throw deploys. */
  objectWorkerFacts(config: string): Promise<ObjectWorkerFacts>;
  /** #3561: after a stamped deploy, the hash the serving version reads back as carrying,
   *  so a stamp that never lands is said. Null when none or unreadable. */
  objectWorkerStamp(config: string): Promise<string | null>;
  /** #3560: the confirm line protocol the app serving now speaks, read from its commit.
   *  Asked on every run, before the line Worker is deployed or skipped as unchanged
   *  (#3854: report only when skipped). May throw. */
  liveAppProtocol(): Promise<LiveAppProtocol>;
  /** Whether a version was uploaded in cron standby (a canary): read from its
   *  annotation. Null when it could not be read. */
  isCronStandby(versionId: string): Promise<boolean | null>;
  /**
   * Record, durably, what this run did to the deployment: `split-attempted` just
   * BEFORE the split call (the call can apply and still report failure), and `ended`
   * once production is whole again on a known version. The settle step decides from
   * this record whether it has anything to look at (`settleDecision`).
   */
  record(event: SplitRecord): void;
  /** Wait before opening the split until the cron window is clear. */
  waitForCronWindow(): Promise<void>;
  log(line: string): void;
  /**
   * #3854: something the run did that does not fail it but must not stay buried in the
   * log: printed as a `::warning` annotation and as a line in the job summary.
   */
  warn(line: string): void;
  /** Where this run deploys, as its messages name it (`deployTargetLabel`): production, or
   *  the load test rehearsal's environment, so a warning never says production for it. */
  readonly target: string;
}

function probeLines(o: ProbeOutcome): string {
  return o.steps.map((s) => `${s.ok ? "ok" : "FAIL"}: ${s.name} (${s.detail})`).join("; ");
}

/**
 * Put the old version back at 100%, retrying. The one call whose failure leaves
 * production split, so it is the only one retried, and its failure is its own ending.
 */
async function restore(
  ops: GradualOps,
  stable: string,
  why: string,
  ours: VersionShare[][],
): Promise<RestoreOutcome> {
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    // Never undo somebody else's change: a rollback that landed mid-run wins. A read
    // that throws is a read that could not tell, the same as null: restore anyway.
    let now: VersionShare[] | null = null;
    try {
      now = await ops.status();
    } catch (err) {
      ops.log(`reading the deployment before the restore threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (now !== null && sameDeployment(now, [{ versionId: stable, percentage: 100 }])) return "restored";
    if (now !== null && !ours.some((o) => sameDeployment(now, o))) return "interfered";
    ops.log(`restoring ${stable} at 100% (${why}), attempt ${attempt} of ${RESTORE_ATTEMPTS}`);
    try {
      if (await ops.deploy(wholeSpecs(stable), `slate-restore-${stable.slice(0, 8)}`)) return "restored";
    } catch (err) {
      // A restore that throws is a failed attempt, never an escape from the run: the
      // split would then be left standing with nothing saying so.
      ops.log(`the restore threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return "failed";
}

type RestoreOutcome = "restored" | "failed" | "interfered";

/** Two deployments are the same when they hold the same versions at the same shares. */
export function sameDeployment(a: VersionShare[], b: VersionShare[]): boolean {
  const key = (d: VersionShare[]) =>
    [...d].sort((x, y) => x.versionId.localeCompare(y.versionId)).map((v) => `${v.versionId}@${v.percentage}`).join(",");
  return key(a) === key(b);
}

function interfered(where: string): GradualResult {
  return {
    exit: EXIT.interfered,
    end: "unknown",
    message: `Stopped ${where}: production was changed by something other than this run (most likely the Rollback workflow, or a hand deploy), so this run left it exactly as it found it rather than undo that change. Check what is serving (\`wrangler deployments status\`).`,
  };
}

function restored(outcome: RestoreOutcome, exit: number, stable: string, message: string): GradualResult {
  if (outcome === "interfered") return interfered(`while restoring ${stable}`);
  return outcome === "restored"
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
  // Anything thrown before the split is attempted changed nothing, and is caught here
  // into its own ending rather than escaping as an unhandled rejection. Throws after
  // the split is attempted are caught where they can restore (below).
  // `splitOpen` is whether a split this run made is standing NOW, read from the LAST
  // event: a heal records `split-attempted` and then `ended`, so a throw after a
  // finished heal, before this run opens its own split, is a throw before the split.
  let splitOpen = false;
  let healed = false;
  const tracked: GradualOps = {
    ...ops,
    record: (event) => {
      if (event === "ended" && splitOpen) healed = true;
      splitOpen = event === "split-attempted";
      ops.record(event);
    },
  };
  try {
    return await runUntilSplit(tracked);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (splitOpen) throw err; // unreachable: everything after the attempt catches its own
    if (healed) {
      return {
        exit: EXIT.threwBeforeSplit,
        end: "unchanged",
        message: `Not deployed: an error was thrown before the split opened (${why}). The split an earlier run left was settled first, so the serving version is whole at 100%; nothing else changed.`,
      };
    }
    return { exit: EXIT.threwBeforeSplit, end: "unchanged", message: `Not deployed: an error was thrown before the split opened (${why}). Nothing changed.` };
  }
}

const isRefusal = (u: string | UploadRefusal | null): u is UploadRefusal => typeof u === "object" && u !== null;

/** #3352: the release changes a Durable Object class, so it cannot ship gradually at all. */
function classChangeResult(): GradualResult {
  return {
    exit: EXIT.classChange,
    end: "unchanged",
    message:
      "Not deployed: this release changes a Durable Object class (wrangler reported a pending Durable Object migration), which Cloudflare refuses to upload as a version, so nothing changed and the previous version is still serving 100%. Ship it by hand with `pnpm cf:deploy:verified` (DEPLOY.md, Deploying by hand, verified). Until it ships, every later deploy stops here the same way.",
  };
}

async function runUntilSplit(ops: GradualOps): Promise<GradualResult> {
  const start = planStart(await ops.status());
  if (start.kind === "refuse") {
    return { exit: EXIT.unreadable, end: "unchanged", message: `Not deploying: ${start.reason}.` };
  }
  const stable = start.versionId;
  if (start.kind === "heal") {
    // Healing serves the larger share at 100%. A cron standby canary there would run
    // no cron lane for anybody, so it is refused, and so is one that cannot be read.
    const standby = await ops.isCronStandby(stable);
    if (standby !== false) {
      return {
        exit: EXIT.healRefused,
        end: "unchanged",
        message: `Not deploying: production was left split (${start.from.map((s) => `${s.versionId}@${s.percentage}%`).join(", ")}) and its larger share ${stable} ${standby === null ? "could not be checked for cron standby" : "is a cron standby canary"}, so it cannot be put back at 100% without switching every cron lane off. Nothing changed. Put the release version back by hand (DEPLOY.md, Rollback: ending a split by hand).`,
      };
    }
    // A split left by a run that died. Settling it first is what keeps the rule that no
    // run starts or ends on a split; the larger share is the version that was serving.
    ops.log(`production was left split (${start.from.map((s) => `${s.versionId}@${s.percentage}%`).join(", ")}); settling it on ${stable} first`);
    // Recorded first: a heal is a change to a split, and if every attempt fails the
    // settle step must know there is a split to look at.
    ops.record("split-attempted");
    const healed = await restore(ops, stable, "a previous run left production split", [start.from]);
    if (healed !== "restored") {
      // Somebody else changed it while this run was healing: production is theirs, so
      // the settle step is told to leave it, as it is for every interference.
      if (healed === "interfered") ops.record("ended");
      return restored(healed, EXIT.restoreFailed, stable, "Production was already split when this run started.");
    }
    ops.record("ended");
  }
  ops.log(`production is serving ${stable} at 100%`);

  // #3500, #3555: the object workers Slate's bindings name, before any version of Slate
  // exists. #3561: each only when it changed, since a deploy restarts its objects.
  const objects = await deployObjectWorkers(
    {
      facts: (config) => ops.objectWorkerFacts(config),
      deploy: (config, message) => ops.objectWorker(config, message),
      servingStamp: (config) => ops.objectWorkerStamp(config),
      liveAppProtocol: () => ops.liveAppProtocol(),
      log: (line) => ops.log(line),
    },
    OBJECT_WORKER_CONFIGS,
  );
  if (!objects.ok && objects.kind === "refused") {
    return {
      exit: EXIT.lineOlderThanApp,
      end: "unchanged",
      message: `Not deployed: ${objects.reason}. Nothing was deployed and the previous version is still serving 100%. A newer app beside an older line object puts every confirm on its isolate's own line, where a crowd for one slot books one advisor or none. If this release lowers the protocol on purpose (a revert), deploy the app alone at this commit first (\`pnpm cf:deploy\`, then confirm it on /api/smoke/version), then re-run so the line follows it; otherwise deploy the line from a build at least as new as the app.`,
    };
  }
  if (!objects.ok) {
    return {
      exit: EXIT.objectWorkerFailed,
      end: "unchanged",
      message: `Not deployed: the object worker in ${objects.config} could not be deployed (${objects.reason}), and Slate's bindings name it, so nothing of Slate's was uploaded and the previous version is still serving 100%. Deploy it by hand with \`node --experimental-strip-types scripts/deploy-object-workers.ts\`, then re-run the deploy.`,
    };
  }

  // #3854: the line went out without the older line refusal having run. The deploy goes
  // on (the check fails open by design), but a check skipped on every deploy must be
  // visible where the job is read, or it reads as checked for ever.
  if (objects.unchecked.length > 0) ops.warn(uncheckedLineWarning(objects.unchecked, ops.target));
  // And when the line did not change but could not be compared: nothing went out unchecked,
  // but the read the refusal depends on is not working, which only a run that says so shows.
  if (objects.uncompared.length > 0) ops.warn(uncomparedLineWarning(objects.uncompared, ops.target));

  // Both versions are uploaded BEFORE the split opens, so the split lasts only as long as
  // the probe, and a failed upload has changed nothing anybody is served.
  const canary = await ops.upload("canary");
  if (isRefusal(canary)) return classChangeResult();
  if (canary === null) {
    return {
      exit: EXIT.uploadFailed,
      end: "unchanged",
      message:
        "Not deployed: the canary version could not be uploaded, so nothing changed and the previous version is still serving 100%. If this release changes a Durable Object class (a `migrations` entry in wrangler.jsonc), Cloudflare refuses to upload it as a version at all and it has to ship by hand with `pnpm cf:deploy:verified` (DEPLOY.md).",
    };
  }
  const release = await ops.upload("release");
  if (isRefusal(release)) return classChangeResult();
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

  // The uploads and the wait take minutes. If production changed meanwhile (a rollback,
  // a hand deploy), splitting it now would undo that, so stop and leave it as it is.
  const before = await ops.status();
  if (before !== null && !sameDeployment(before, [{ versionId: stable, percentage: 100 }])) {
    return interfered("before opening the split");
  }

  // From the split call on, production may be split, so every way out of this run,
  // a throw included, ends it here rather than leaving it for the settle step.
  ops.record("split-attempted");
  let result: GradualResult;
  try {
    result = await afterSplit(ops, stable, canary, release);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const ok = await restore(ops, stable, `an error was thrown after the split opened: ${why}`, ownStates(stable, canary, release));
    result = restored(ok, EXIT.threw, stable, `Not deployed: an error was thrown after the split opened (${why}).`);
  }
  // `ended` also when this run stopped for somebody else's change: production is then
  // theirs, and the settle step must not "heal" it back.
  if (result.end === "new" || result.end === "old" || result.exit === EXIT.interfered) ops.record("ended");
  return result;
}

/** Every deployment this run itself can have produced after opening the split. */
function ownStates(stable: string, canary: string, release: string): VersionShare[][] {
  return [
    parseSpecList(splitSpecs(stable, canary)),
    [{ versionId: release, percentage: 100 }],
  ];
}

function parseSpecList(specs: string[]): VersionShare[] {
  return specs.map((sp) => {
    const [versionId, pct] = sp.split("@");
    return { versionId, percentage: Number(pct.replace("%", "")) };
  });
}

/** Everything from opening the split on. Each return leaves production whole, or says
 *  it could not; a throw is caught by the caller, which restores. */
async function afterSplit(ops: GradualOps, stable: string, canary: string, release: string): Promise<GradualResult> {
  ops.log(`opening the split: ${canary} (canary, cron standby) at ${CANARY_PERCENT}%, ${stable} at ${100 - CANARY_PERCENT}%`);
  if (!(await ops.deploy(splitSpecs(stable, canary), `slate-canary-split`))) {
    // The call failed, but whether Cloudflare applied it is not known, so the restore is
    // made either way: restoring a deployment that never changed is harmless.
    const ok = await restore(ops, stable, "the split call failed", ownStates(stable, canary, release));
    return restored(ok, EXIT.splitFailed, stable, "Not deployed: the split could not be opened.");
  }

  const canaryProbe = await ops.probe("canary", canary);
  ops.log(`canary probe: ${probeLines(canaryProbe)}`);
  if (canaryProbe.fault === "version" || canaryProbe.fault === "release") {
    const ok = await restore(ops, stable, "the canary failed its probe", ownStates(stable, canary, release));
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

  // The probe takes up to two minutes; a rollback in that time must not be overwritten.
  const beforePromote = await ops.status();
  if (beforePromote !== null && !sameDeployment(beforePromote, parseSpecList(splitSpecs(stable, canary)))) {
    return interfered("before promoting");
  }

  ops.log(`promoting ${release} (the same build, without cron standby) to 100%`);
  if (!(await ops.deploy(wholeSpecs(release), `slate-release`))) {
    const ok = await restore(ops, stable, "the promotion call failed", ownStates(stable, canary, release));
    return restored(ok, EXIT.promoteFailed, stable, "Not deployed: the new version passed its probe but could not be promoted.");
  }

  const finalProbe = await ops.probe("promoted", null);
  ops.log(`promotion probe: ${probeLines(finalProbe)}`);
  if (finalProbe.fault === "version" || finalProbe.fault === "release") {
    const ok = await restore(ops, stable, "the promoted version failed its probe", ownStates(stable, canary, release));
    return restored(
      ok,
      EXIT.promotedFailed,
      stable,
      `Rolled back: the new version passed at ${CANARY_PERCENT}% and failed its probe at 100% (${finalProbe.summary}).`,
    );
  }

  // Only now: cron triggers belong to the code that will run them, and a restore above
  // would have left new triggers driving old code.
  let triggered = false;
  try {
    triggered = await ops.triggers();
  } catch (err) {
    ops.log(`wrangler triggers deploy threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The log tail worker, whole and last (#3191): it binds to an entrypoint of Slate's
  // (LogShippingReceipt, through a service binding), so it may only be deployed once
  // that version is serving 100% and healthy. A failure or a throw here never restores
  // Slate, which has already passed, and is caught here so the caller's restore on a
  // throw cannot reach it. Attempted even when the triggers failed: both are safe to
  // repeat, and the run reports every one that failed.
  let tailed = false;
  try {
    tailed = await ops.tailWorker();
  } catch (err) {
    ops.log(`the log tail worker deploy threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tailNote = tailed
    ? ""
    : " The log tail worker (slate-log-tail) could not be deployed either: re-run `pnpm exec wrangler deploy -c wrangler.log-tail.jsonc`.";
  if (!triggered) {
    return {
      exit: EXIT.triggersFailed,
      end: "new",
      message: `Deployed ${release} at 100%, but \`wrangler triggers deploy\` failed, so the cron schedule may still be the previous one. Re-run this job, or run \`pnpm exec wrangler triggers deploy\`. The code is NOT rolled back for this: it passed its probes, and the triggers call is safe to repeat.${tailNote}`,
    };
  }
  if (!tailed) {
    return {
      exit: EXIT.tailWorkerFailed,
      end: "new",
      message: `Deployed ${release} at 100% and it passed its probes, but the log tail worker (slate-log-tail) could not be deployed after it, so log shipping still runs the previous tail worker. Slate is NOT rolled back for this. Re-run this job, or run \`pnpm exec wrangler deploy -c wrangler.log-tail.jsonc\`.`,
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

export type SplitRecord = "split-attempted" | "ended";

/** The events a run appended to its state file, one per line. Null when there is no
 *  file at all (the run never recorded anything). A line that is not a known event is
 *  dropped rather than guessed at; `settleDecision` then reads only what is certain. */
export function readSplitRecords(text: string | null): SplitRecord[] | null {
  if (text === null) return null;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l): l is SplitRecord => l === "split-attempted" || l === "ended");
}

/**
 * Whether the settle step has anything to look at, decided from what the run RECORDED
 * rather than from a deployment read. A run that never attempted the split (a ci gate
 * refusal, a failed build or upload) never touched production, and reading the
 * deployment then could only produce a false "production may be split" when the read
 * fails. Only an attempted split with no recorded end makes it read.
 */
export function settleDecision(records: SplitRecord[] | null): { action: "none" } | { action: "read" } {
  // The LAST event decides: a run can heal a leftover split (attempted, ended) and then
  // open its own (attempted again), and only the latest says where it stands.
  const last = records?.[records.length - 1];
  return last === "split-attempted" ? { action: "read" } : { action: "none" };
}

/** What the after-the-fact settle step should do: nothing, or put the larger share back
 *  at 100%. For a job that was cancelled or timed out between opening and ending the split. */
export function planSettle(status: VersionShare[] | null): { action: "none" } | { action: "deploy"; specs: string[] } | { action: "refuse"; reason: string } {
  const plan = planStart(status);
  if (plan.kind === "stable") return { action: "none" };
  if (plan.kind === "heal") return { action: "deploy", specs: wholeSpecs(plan.versionId) };
  return { action: "refuse", reason: plan.reason };
}
