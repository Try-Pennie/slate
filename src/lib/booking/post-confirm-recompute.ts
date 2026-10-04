/**
 * The load test switch for the slot recompute a booking schedules after its
 * response (#3258).
 *
 * Every confirm on a user facing path recomputes the booked bucket's slots under
 * `afterResponse`, so the booked time stops being offered. The 2026-10-04 load run
 * measured the confirm's "assign and verify" stage about 1.7s slower at the median
 * than a same day control on the 09-15 code, while that stage's own database reads
 * had not changed. The recompute is the suspect: about three seconds of reads and
 * compute per booking, sixty a minute, beside the next confirms. That is inferred,
 * so this switch lets three back to back runs measure it:
 *
 *   - `on` (the default, and the ONLY value production ever reads): the recompute.
 *   - `off`: nothing is scheduled; the recompute lane keeps the slots fresh, as it
 *     already does for any recompute that is missed.
 *   - `reads-only`: the recompute's reads, with no compute and no write, under its
 *     own job name. It separates the database half of the cost from the CPU half.
 *     Nothing is written, because a row built without the compute would be a lie
 *     every booker then serves.
 *
 * **Production cannot reach it.** The setting is read only when `isLoadtest()` is
 * true; otherwise every value, a typo included, is `on` and goes unreported. The
 * variable is committed nowhere (`scripts/test-wrangler-loadtest-env.ts` refuses it
 * at the top level and in env.loadtest). The load workflow's `arm` job, and the
 * fault leg after it, deploy it with `wrangler deploy --var` for the arm the run
 * was dispatched with; the preflight only asks `/api/smoke/version` which arm the
 * deployment runs, and refuses a mismatch.
 *
 * **An unknown value fails loud**, the way an unknown fault target does: it is
 * logged at error once per isolate, treated as `on`, and reported by
 * `/api/smoke/version`, where the preflight refuses it before anything is driven.
 * Treated as `on` rather than `off`, because the safe reading of a setting nobody
 * can read is the behaviour production has.
 */
import { isLoadtest } from "@/lib/loadtest-guard";
import { log } from "@/lib/log";
import {
  POST_CONFIRM_RECOMPUTE_MODES,
  POST_CONFIRM_RECOMPUTE_VAR,
  parsePostConfirmRecompute,
  type PostConfirmRecomputeMode,
  type PostConfirmRecomputeSetting,
} from "./post-confirm-recompute-modes.ts";

export {
  POST_CONFIRM_RECOMPUTE_MODES,
  POST_CONFIRM_RECOMPUTE_VAR,
  parsePostConfirmRecompute,
  type PostConfirmRecomputeMode,
  type PostConfirmRecomputeSetting,
};

/**
 * The setting this deployment runs with, read at CALL time like `isLoadtest()`,
 * because on Workers the vars reach `process.env` through the OpenNext wrapper and
 * a module scope read can run before that. Outside a load test it is always `on`
 * with nothing to report, whatever the variable says.
 */
export function postConfirmRecomputeSetting(
  env: Record<string, string | undefined> = process.env,
  loadtest: boolean = env === process.env ? isLoadtest() : env.SLATE_LOADTEST === "true",
): PostConfirmRecomputeSetting {
  if (!loadtest) return { mode: "on", unknown: null };
  return parsePostConfirmRecompute(env[POST_CONFIRM_RECOMPUTE_VAR]);
}

let warned = false;

/** For tests: forget that this isolate already reported an unknown value. */
export function resetPostConfirmRecomputeWarning(): void {
  warned = false;
}

/** The mode a booking acts on, reporting an unknown value once per isolate. */
export function postConfirmRecomputeMode(
  env: Record<string, string | undefined> = process.env,
  loadtest?: boolean,
  report: (msg: string) => void = (msg) => log.error("post-confirm-recompute", { msg }),
): PostConfirmRecomputeMode {
  const setting = loadtest === undefined ? postConfirmRecomputeSetting(env) : postConfirmRecomputeSetting(env, loadtest);
  if (setting.unknown !== null && !warned) {
    warned = true;
    report(
      `${POST_CONFIRM_RECOMPUTE_VAR} is "${setting.unknown}", which is not one of ` +
        `${POST_CONFIRM_RECOMPUTE_MODES.join(", ")}, so the recompute runs as if it were on`,
    );
  }
  return setting.mode;
}

/** The work a booking schedules after its response for `mode`, or null for none. */
export function postConfirmRefresh(
  mode: PostConfirmRecomputeMode,
  bucketCode: string,
  deps: {
    recompute: (code: string) => Promise<unknown>;
    readsOnly: (code: string) => Promise<unknown>;
  },
): { context: string; work: () => Promise<unknown> } | null {
  if (mode === "off") return null;
  if (mode === "reads-only") {
    return { context: "post-confirm-recompute-reads-only", work: () => deps.readsOnly(bucketCode) };
  }
  return { context: "post-confirm-recompute", work: () => deps.recompute(bucketCode) };
}
