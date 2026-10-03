import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which alerts a piece of code actually raised, recorded by the code that raises
 * them (#3133 follow-up).
 *
 * Dan, 2026-10-03, on a lane failure paging twice (once from the lane's own alert,
 * once from the dispatcher's generic `cron_lane_failed`): "I only want one alert.
 * neither should page two." So the dispatcher has to know, for THIS failure,
 * whether the lane already spoke about it. A hand kept list of "lanes that alert on
 * their own" would be a second copy of what the code does (L41) and would exempt
 * the next lane nobody added to it (L96); this records it instead, at the two
 * places every alert decision passes through:
 *
 *   - `sendThrottledAlert` / `sendThrottledInfo` note their key when they RETURN,
 *     which covers a page that went out, one its cooldown held back (the reader was
 *     already told) and one an unconfigured Slack dropped. A send that THROWS is not
 *     noted, so a lane whose own alert failed still gets the generic page.
 *   - `recordConsecutiveStreak` notes its key when the streak was actually
 *     TRACKED. A lane that deliberately stays quiet on a first failure (#486) has
 *     made its own alerting decision, and the generic page must not overrule it. A
 *     streak that could not be tracked is not noted.
 *
 * Outside a `recordingAlerts` scope noting does nothing, so the dispatcher is
 * unchanged for every caller that never asks.
 */
const scope = new AsyncLocalStorage<Set<string>>();

/** Note that `key` was raised (or deliberately held back) by its owner. */
export function noteAlertKey(key: string): void {
  scope.getStore()?.add(key);
}

export type Recorded<T> = { keys: string[] } & (
  | { ok: true; value: T }
  | { ok: false; error: unknown }
);

/**
 * Run `fn` and report every alert key it noted, in the order first noted. Never
 * throws: a throw is returned with the keys noted BEFORE it, because "it threw
 * after paging" and "it threw before it could page" need opposite handling.
 */
export async function recordingAlerts<T>(fn: () => Promise<T>): Promise<Recorded<T>> {
  const keys = new Set<string>();
  try {
    const value = await scope.run(keys, fn);
    return { ok: true, value, keys: [...keys] };
  } catch (error) {
    return { ok: false, error, keys: [...keys] };
  }
}
