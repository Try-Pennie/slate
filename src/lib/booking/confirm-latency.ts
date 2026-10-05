/**
 * How long a lead waited for a confirm's answer, one line per confirm (#3221).
 *
 * The invocation's wall time is not that number: it runs on through the work
 * deferred past the response (the post confirm recompute, the outcome tally),
 * which takes seconds and which no lead waits for. And the confirm profile that
 * splits the time by stage is written under SLATE_LOADTEST only. So outside a
 * load test there was no way to read what a lead actually waits, and the
 * 2026-10-04 burst could only be judged from the client's side.
 *
 * This is the time from the handler starting to the response being handed back,
 * under the route's own tag, with the status. On a refusal it also carries the
 * refusal's stage, instant, bucket and per rung counts (#3272), and the refused
 * lead's Salesforce lead id (`lead_id`, 15 characters), an external id that is safe
 * to log and lets a run of refusals be counted in people (#3276). Nothing else about
 * the lead: never a name, email or phone.
 * A Worker's clock moves at I/O, so it measures the waiting the confirm did, and
 * a response is always handed back after I/O, so the end is never early.
 */
import { log } from "@/lib/log";
import { refusalLogFields, refusalTraceOf } from "@/lib/booking/refusal-trace";

/** What a route learns while handling the request that the line should say. */
export interface ConfirmLineFacts {
  /** A direct booking API dry run, which books nothing and answers fast. */
  dryRun?: boolean;
  /**
   * #3272: on a refused confirm, the instant and bucket it asked for, the stage
   * that refused it and what each stage left, so a refusal in the logs can be
   * looked up by time and traced. Counts and codes only.
   */
  refusal?: Record<string, string | number>;
}

/**
 * Note a refusal on the line, from the trace the refused error carries. A route
 * calls this where it turns a booking error into its response; an error with no
 * trace (an outage before any stage measured anything) adds nothing.
 */
export function noteRefusal(facts: ConfirmLineFacts, err: unknown): void {
  const trace = refusalTraceOf(err);
  if (trace) facts.refusal = refusalLogFields(trace);
}

export async function answerTimed(
  tag: string,
  handle: () => Promise<Response>,
  opts: { now?: () => number; facts?: ConfirmLineFacts } = {},
): Promise<Response> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const line = (status: number) =>
    log.info(tag, {
      msg: "confirm answered",
      response_ms: Math.max(0, now() - startedAt),
      status,
      ...(opts.facts?.dryRun ? { dry_run: true } : {}),
      ...(opts.facts?.refusal ?? {}),
    });
  try {
    const res = await handle();
    line(res.status);
    return res;
  } catch (err) {
    // Unhandled here means the runtime answers 500, so that is what the lead got.
    line(500);
    throw err;
  }
}
