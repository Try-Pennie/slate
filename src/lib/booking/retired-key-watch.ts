import { afterResponse } from "@/lib/after-response";
import { bookingApiRetiredKeyHashes } from "@/lib/env";
import { log } from "@/lib/log";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { makeRetiredKeyWatcher } from "@/lib/booking/retired-keys";

/**
 * The watcher the booking API's authorizer calls on a refused request that carried a
 * token (#2879), wired to the real setting, cooldown, dispatcher and scheduler. The
 * decisions live in the pure `retired-keys.ts`, driven by
 * scripts/test-retired-booking-keys.ts.
 *
 * The record is a log line (`tag=booking-api msg="retired key presented"`), one per
 * presentation, carrying the retired key's label, the host kind, the origin and the
 * route, so a person can find every call a holder made, not only the one that paged.
 */
export const watchRetiredKey = makeRetiredKeyWatcher({
  rawHashes: () => bookingApiRetiredKeyHashes(),
  cooldownMs: async () => (await loadMonitorCooldowns("booking-api")).retired_booking_key,
  // alert-key: retired_booking_key:*
  notify: (key, cooldownMs, text) => sendThrottledAlert(key, cooldownMs, text),
  report: (event) => {
    if (event.kind === "config-unreadable") {
      log.error("booking-api", { msg: "retired key hashes unreadable, so a retired key cannot be noticed" }, event.error);
      return;
    }
    log.warn("booking-api", {
      msg: "retired key presented",
      retired_key: event.label,
      host_kind: event.hostKind,
      origin: event.origin,
      route: event.route,
    });
  },
  defer: (work) => afterResponse("retired-key-watch", work),
  now: () => Date.now(),
});
