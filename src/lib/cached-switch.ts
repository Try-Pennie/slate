/**
 * A stored on/off switch, read on a hot path through a per isolate cache (#3325).
 *
 * Generalised from the frame lock's reader (#3137) so the shared confirm line reads its
 * switch through the same code rather than a second copy (L613, L655). One
 * implementation of the things both need: a TTL, a read deadline, and at most one read
 * in flight. What they need DIFFERENTLY is what a failed read does, so that is an
 * option, `onFailure`, and each caller states its own:
 *
 * - `{ kind: "hold" }`: the failed read's answer stands for the whole TTL, like a good
 *   one. An outage then costs one failing call per isolate per TTL rather than one per
 *   request. Right for the frame lock, whose default (unlocked) is how the booker has
 *   always run, so standing on it for fifteen seconds harms nobody.
 * - `{ kind: "retry", backoffMs }`: a failed read is NEVER cached as the answer. It
 *   answers the last good value, or the default when there is none, and the next read
 *   is tried after `backoffMs` rather than after the TTL. Right for a switch where a
 *   burst of cold isolates on a saturated database must not all sit on the default for
 *   a whole TTL because their first read happened to fail.
 *
 * Under both, a hung read is cut at `readDeadlineMs` and treated as failed, every
 * failure goes to `onError`, and the default is asked for at the moment it is needed
 * (never captured at construction, because a deployment's vars are assigned after
 * module load on Workers).
 *
 * Every answer says where it came from (`source`), so a caller can log which it was:
 * `read` (a read in this isolate, possibly cached), `last-known` (a failed read,
 * answered with the last good value), or `default` (a failed read with no good value
 * ever read here).
 *
 * Pure apart from its injected read, clock and timer, so scripts/test-cached-switch.ts
 * drives it. No imports, so a client component may import a module built on it.
 */

/** Starts a timer and returns the function that clears it. Injected in tests. */
export type SwitchTimer = (ms: number, fire: () => void) => () => void;

/** Where an answer came from. */
export type SwitchSource = "read" | "last-known" | "default";

export interface SwitchReading {
  on: boolean;
  source: SwitchSource;
}

/** What a failed read does. See the module comment. */
export type SwitchFailurePolicy = { kind: "hold" } | { kind: "retry"; backoffMs: number };

export interface CachedSwitchOptions {
  /** Names the switch in the deadline failure, e.g. "frame lock". */
  label: string;
  /** One read of the stored switch. Rejects (or throws) on a failed read. */
  read: () => Promise<boolean>;
  now: () => number;
  onError: (err: unknown) => void;
  timer?: SwitchTimer;
  /** How long one good read stands in an isolate. */
  ttlMs: number;
  /** How long a read may take before it is treated as failed. */
  readDeadlineMs: number;
  /** The answer when a read fails and nothing good has been read here yet. */
  fallback: () => boolean;
  onFailure: SwitchFailurePolicy;
}

const realTimer: SwitchTimer = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

export function makeCachedSwitchReader(opts: CachedSwitchOptions): () => Promise<SwitchReading> {
  const timer = opts.timer ?? realTimer;
  /** The last good read, and when it was made. */
  let lastGood: { on: boolean; atMs: number } | null = null;
  /** The answer standing in for a failed read, and until when it stands. */
  let standIn: { reading: SwitchReading; untilMs: number } | null = null;
  let inFlight: Promise<SwitchReading> | null = null;

  /**
   * The read, raced against the deadline; a timeout rejects like any failed read. The
   * read is called SYNCHRONOUSLY here, so a caller arriving in the same tick finds the
   * read already in flight and joins it.
   */
  const readWithinDeadline = () =>
    new Promise<boolean>((resolve, reject) => {
      const cancel = timer(opts.readDeadlineMs, () =>
        reject(new Error(`${opts.label} read did not answer within ${opts.readDeadlineMs}ms`)),
      );
      let pending: Promise<boolean>;
      try {
        pending = opts.read();
      } catch (err) {
        cancel();
        reject(err);
        return;
      }
      pending.then(
        (v) => {
          cancel();
          resolve(v);
        },
        (err: unknown) => {
          cancel();
          reject(err);
        },
      );
    });

  return async () => {
    const now = opts.now();
    if (standIn && now < standIn.untilMs) return standIn.reading;
    if (lastGood && now - lastGood.atMs < opts.ttlMs) return { on: lastGood.on, source: "read" };
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<SwitchReading> => {
      try {
        const on = await readWithinDeadline();
        lastGood = { on, atMs: opts.now() };
        standIn = null;
        return { on, source: "read" };
      } catch (err) {
        opts.onError(err);
        const reading: SwitchReading = lastGood
          ? { on: lastGood.on, source: "last-known" }
          : { on: opts.fallback(), source: "default" };
        const standsFor = opts.onFailure.kind === "hold" ? opts.ttlMs : opts.onFailure.backoffMs;
        standIn = { reading, untilMs: opts.now() + standsFor };
        return reading;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
