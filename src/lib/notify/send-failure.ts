import { log } from "../log.ts";

/**
 * Catch handlers for an alert send that must not break its caller (#3098).
 *
 * A failed send is still caught, because a monitoring failure must never become a
 * booking failure. What changed is that it is RECORDED. `sendThrottledAlert`
 * throws on purpose when a key has no usable cooldown (#2656), and a database
 * error inside its cooldown read throws the same way; a `.catch(() => {})` dropped
 * both with no line anywhere, so a broken alert was as silent as a healthy quiet
 * one. `scripts/test-alert-send-catches.ts` refuses the bare form.
 *
 * A module of its own, importing nothing but the logger (relatively, so the pure
 * monitor checks can use it too), so a test that mocks `@/lib/notify/dispatch`
 * does not also have to supply these: the handler is built eagerly at every call
 * site, and a missing export would throw there.
 *
 * A send ends in `.catch(logAlertSendFailure(key))`, a single all-clear in
 * `.catch(logResolveFailure(key))`, and a batched one in
 * `.catch(logAllClearFailure(keys))`. Injected seams (`deps.notify`,
 * `deps.resolve`) take the same handlers.
 */
export function logAlertSendFailure(key: string): (err: unknown) => void {
  return (err) => {
    log.error("alert-dispatch", { msg: "alert send failed", key }, err);
  };
}

/** A single all-clear's form (`resolveAlert`, or an injected `AlertResolve` seam).
 *  Resolves to false, the answer `resolveAlert` gives when it cleared nothing,
 *  which is what a failed clear did. */
export function logResolveFailure(key: string): (err: unknown) => false {
  return (err) => {
    log.error("alert-dispatch", { msg: "all-clear send failed", key }, err);
    return false;
  };
}

/** The batched all-clear's form. Resolves to the empty list `resolveRecovered`
 *  answers when it cleared nothing, which is what a failed clear did. */
export function logAllClearFailure(keys: string | readonly string[]): (err: unknown) => string[] {
  const key = typeof keys === "string" ? keys : keys.join(",");
  return (err) => {
    log.error("alert-dispatch", { msg: "all-clear send failed", key }, err);
    return [];
  };
}
