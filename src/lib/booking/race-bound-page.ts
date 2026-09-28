/**
 * The production dispatcher for the race bound hit page (#2838), wired into
 * `realDeps` as `pageRaceBoundHit`.
 *
 * The confirm path never calls the alert dispatcher itself: it hands the page to
 * `deps.pageRaceBoundHit`, so every suite that drives a refusal at the reassign
 * bound supplies a fake and cannot reach alert_state or Slack (L2), and a fake
 * that forgets it fails the refusal loudly rather than paging for real.
 *
 * Here the send runs AFTER the response, so the lead's 409 never waits on an
 * alert_state read and a Slack post (up to its 8s timeout). A failed send is
 * logged and the refusal stands.
 */
import { afterResponse } from "@/lib/after-response";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

export function pageRaceBoundHitAfterResponse(page: { key: string; cooldownMs: number; text: string }): void {
  afterResponse("race-bound-hit-page", () =>
    // alert-key: booking_race_bound_hit
    // alert-text-ok: our own copy from race-contention.ts, built from a bucket
    // code, the requested time and a count; no error text reaches it.
    sendThrottledAlert(page.key, page.cooldownMs, page.text).catch((pageErr) =>
      log.warn("booking", { msg: "could not page a race bound hit; the refusal stands" }, pageErr),
    ),
  );
}
