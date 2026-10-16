// The alert dispatcher's shape as an injected seam, in one place (#2572).
//
// Every monitor check takes the dispatcher as a dependency so a test can hand it a
// fake, and 26 files spelled that dependency's type by hand, two lines each. The copies
// were identical except where a check deliberately declined to read the answer
// (`Promise<unknown>`), which the type parameter carries, so that difference stays a
// decision a reader can see rather than a drift nobody chose.
//
// The seam is NARROWER than the real functions on purpose. `sendThrottledAlert` takes
// a `SendOptions` object whose fields beyond `AlertRepeat` (a channel, #3303's page
// news, an outcome callback) a check is not given, and `resolveAlert` an optional
// channel: a check that could name a channel would be choosing where its page lands,
// which belongs to the alert settings. The one thing a check may say is what its
// condition names (`AlertRepeat`, #3801). A fake needs only the arguments a check
// actually passes. `scripts/test-alert-deps-type.ts` fails
// on the next hand written copy.
//
// That the real dispatcher FITS these seams is asserted in `src/lib/notify/dispatch.ts`
// (`dispatcherFitsSeams`), not here: naming `typeof sendThrottledAlert` in this file
// reads to the alert recovery coverage guard as a wiring site with no key, and the
// dispatcher's own file is the one place that guard deliberately does not scan.

import type { AlertRepeat } from "@/lib/notify/repeat-policy";

/**
 * Sends a throttled page or whisper: the shape of `sendThrottledAlert` and
 * `sendThrottledInfo`, which resolve to nothing. A check whose fake returns
 * something else declares what, as `ThrottledNotify<unknown>`.
 *
 * `repeat` (#3801) is what a CONDITION names, so the dispatcher can post a change at
 * once and an unchanged fact once a day. Optional: a check that omits it is judged on
 * its message's own lines, and a fake may ignore it.
 */
export type ThrottledNotify<Result = void> = (key: string, cooldownMs: number, text: string, repeat?: AlertRepeat) => Promise<Result>;

/**
 * Settles an outstanding alert: the shape of `resolveAlert`, which answers whether it
 * actually settled anything. A check that does not branch on that answer declares
 * `AlertResolve<unknown>`, so its fake may return nothing at all.
 */
export type AlertResolve<Result = boolean> = (key: string, text: string) => Promise<Result>;
