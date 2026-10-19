/**
 * The shared confirm line's switch, as a confirm reads it (#3325): the pure half.
 *
 * The switch is `booking_settings.shared_confirm_line` (migration 0169), flipped on the
 * admin Hours page beside the public booking pause, with no deploy. When it is on,
 * confirms for one time wait in one line shared by every isolate, so a crowd for one
 * slot gets one winner per free advisor and every other confirm a fast "taken"; when it
 * is off, each isolate keeps its own line, as before. It is read once per isolate per
 * `SHARED_LINE_SWITCH_TTL_MS` rather than per confirm.
 *
 * WHICH WAY IT FAILS, and why it is not the frame lock's way. A failed read is NEVER
 * cached as the answer. It answers the last good value this isolate read, or, with
 * none, the DEPLOYMENT DEFAULT, and the read is tried again after
 * `SHARED_LINE_SWITCH_RETRY_MS` rather than after the TTL. The case this exists for is
 * a burst of cold isolates on a saturated database: under the frame lock's policy every
 * one of them would stand on a guessed value for fifteen seconds because its first read
 * happened to fail, which is exactly the moment the line matters. The default comes
 * from the deployment (`SHARED_CONFIRM_LINE_DEFAULT`: on in the load test, and on in
 * production since #3339), so a cold isolate does not silently read OFF.
 * A default that is missing, or not exactly `on` or `off`, means off and is reported
 * once per isolate, on the first read rather than only when it is first needed, so a
 * misconfigured deployment says so on an ordinary day.
 *
 * No server imports, and no code here reads that setting by name (this comment's
 * mention is stripped from the build): the admin control and the save copy import the
 * TTL constant from this module into the browser bundle, and a deployment setting
 * named in a client chunk fails `pnpm cf:build` (scripts/check-bundle-env.ts). The production instance, which reads
 * the database and the deployment's vars, is in `shared-line-switch.ts`.
 *
 * Pure apart from its injected read, clock and timer, so
 * scripts/test-shared-line-switch.ts drives it.
 */

import { makeCachedSwitchReader, type SwitchReading, type SwitchTimer } from "@/lib/cached-switch";

/** How long one good read of the switch stands in an isolate. */
export const SHARED_LINE_SWITCH_TTL_MS = 15_000;

/** The same, in the whole seconds the admin copy quotes, so the copy cannot drift. */
export const SHARED_LINE_SWITCH_TTL_SECONDS = Math.ceil(SHARED_LINE_SWITCH_TTL_MS / 1000);

/**
 * How long a confirm waits for the switch before treating the read as failed. It is
 * awaited on the confirm path, so a hung database must cost a lead no more than this,
 * once per isolate, rather than the general Supabase deadline.
 */
export const SHARED_LINE_SWITCH_READ_DEADLINE_MS = 500;

/**
 * How long after a failed read the next one may be tried. Short, because a failed read
 * is not an answer; long enough that an isolate on a struggling database asks it at
 * most once per this interval rather than once per confirm.
 */
export const SHARED_LINE_SWITCH_RETRY_MS = 5_000;

/** Why the deployment default could not be taken at its word. */
export type SharedLineDefaultProblem = { kind: "missing" } | { kind: "unrecognised"; raw: string };

/**
 * The deployment default as a value. Exactly `on` is on and exactly `off` is off;
 * anything else is off with the reason. Case and spaces are not forgiven, so the value
 * reported is the value somebody typed.
 */
export function parseSharedLineDefault(raw: string | undefined): {
  on: boolean;
  problem: SharedLineDefaultProblem | null;
} {
  if (raw === "on") return { on: true, problem: null };
  if (raw === "off") return { on: false, problem: null };
  if (raw === undefined || raw === "") return { on: false, problem: { kind: "missing" } };
  return { on: false, problem: { kind: "unrecognised", raw } };
}

export function makeSharedLineSwitchReader(deps: {
  /** One read of the stored switch. Rejects on a failed read; an absent row is off. */
  read: () => Promise<boolean>;
  now: () => number;
  /** The deployment default's raw value, read when asked (never at module load). */
  rawDefault: () => string | undefined;
  onReadError: (err: unknown) => void;
  /** Called at most once per reader, the first time the default is found wanting. */
  onDefaultProblem: (problem: SharedLineDefaultProblem) => void;
  timer?: SwitchTimer;
}): () => Promise<SwitchReading> {
  let reported = false;
  const deploymentDefault = (): boolean => {
    const parsed = parseSharedLineDefault(deps.rawDefault());
    if (parsed.problem && !reported) {
      reported = true;
      deps.onDefaultProblem(parsed.problem);
    }
    return parsed.on;
  };
  const read = makeCachedSwitchReader({
    label: "shared confirm line switch",
    read: deps.read,
    now: deps.now,
    onError: deps.onReadError,
    timer: deps.timer,
    ttlMs: SHARED_LINE_SWITCH_TTL_MS,
    readDeadlineMs: SHARED_LINE_SWITCH_READ_DEADLINE_MS,
    fallback: deploymentDefault,
    onFailure: { kind: "retry", backoffMs: SHARED_LINE_SWITCH_RETRY_MS },
  });
  let checked = false;
  return () => {
    if (!checked) {
      checked = true;
      deploymentDefault();
    }
    return read();
  };
}
