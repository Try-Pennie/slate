/**
 * What the Google Calendar breaker says when it opens and closes (#3134), wired
 * into the breaker `gfetch` uses as its transition listener.
 *
 * A condition, not an incident: an open breaker is true until a probe call gets an
 * answer, and the reader needs to hear when it is over. The all-clear hangs off
 * that MEASURED answer and nothing else, because the breaker only announces a
 * close when its probe was answered: a probe that failed, or that was cut short by
 * a confirm's budget, announces nothing.
 *
 * Both sends run after the response, so a lead's 503 never waits on an
 * alert_state read and a Slack post, and they run outside the call budget, whose
 * confirm may already be spent. The state is per isolate, so several isolates can
 * each open on one outage: the shared cooldown on `alert_state` is what turns them
 * into one page.
 */
import { afterResponse } from "@/lib/after-response";
import { resolveAlert, sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { googleBreakerClosedAlert, googleBreakerOpenAlert } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";
import { recentStall } from "@/lib/dependency-stall";
import { GOOGLE_BREAKER_OPEN_MS, type BreakerTransition } from "@/lib/google/breaker";

export const GOOGLE_BREAKER_ALERT_KEY = "google_calendar_breaker_open";
export const GOOGLE_BREAKER_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export function announceGoogleBreaker(t: BreakerTransition, now: () => number = () => Date.now()): void {
  if (t.to === "open") {
    // #3784: Supabase stalling in this isolate in the same minutes means both services
    // were failing from one location, and the page suspects the location first.
    const supabaseStall = recentStall("supabase", now());
    log.warn("google-breaker", {
      msg: "opened: holding Google Calendar calls back",
      failures: t.failures,
      last_failure: t.lastFailure,
      open_ms: GOOGLE_BREAKER_OPEN_MS,
      ...(supabaseStall ? { supabase_stall_ms: supabaseStall.ms, supabase_edge_colo: supabaseStall.colo } : {}),
    });
    afterResponse("google-breaker-open", () =>
      sendThrottledAlert(
        GOOGLE_BREAKER_ALERT_KEY,
        GOOGLE_BREAKER_ALERT_COOLDOWN_MS,
        // alert-text-ok: the last failure is already short, from shortErrorReason
        // or a status plus the call's own label; no error body reaches it.
        googleBreakerOpenAlert(t.failures, t.lastFailure, GOOGLE_BREAKER_OPEN_MS, supabaseStall),
      ).catch(logAlertSendFailure(GOOGLE_BREAKER_ALERT_KEY)),
    );
    return;
  }
  log.info("google-breaker", { msg: "closed: a probe call was answered", open_for_ms: t.openForMs });
  afterResponse("google-breaker-closed", () =>
    resolveAlert(GOOGLE_BREAKER_ALERT_KEY, googleBreakerClosedAlert(t.openForMs)).catch(
      logResolveFailure(GOOGLE_BREAKER_ALERT_KEY),
    ),
  );
}
