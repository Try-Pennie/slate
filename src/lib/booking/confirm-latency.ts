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
import type { LineServed } from "@/lib/booking/shared-confirm-line";
import type { LoadtestLeg, WaitMarks } from "@/lib/booking/wait-marks";

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
  /**
   * #3325: which confirm line served it (shared, its own isolate's, or a fallback),
   * why, which kind of key it joined, and the milliseconds the line added. Recorded
   * by the line's client, so a fallback rate and the line's cost can be counted.
   */
  line?: LineServed;
  /**
   * #3354: the wait before the confirm's profile, as marks at fixed points of this
   * request (`wait-marks.ts`). Set by the route under SLATE_LOADTEST only, so a
   * production confirm reads no extra clock; absent means no wait fields.
   */
  marks?: WaitMarks;
  /**
   * #3354: how many requests this isolate had served before this one, counted at
   * the Worker (0 is a fresh isolate's first). Null or absent when unknown, which is
   * never read as a first request.
   */
  isolateInvocationIndex?: number | null;
  /**
   * #3354: the trace every call this confirm made to the shared line carried, so the
   * run can join the object's own log of those calls to this line. Load test only.
   */
  lineTrace?: string;
  /** #3354: which leg of the load run sent this confirm, as its driver named it. */
  loadtestLeg?: LoadtestLeg | "unreadable";
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
      ...(opts.facts?.line
        ? {
            line: opts.facts.line.line,
            line_reason: opts.facts.line.reason,
            line_key: opts.facts.line.key,
            line_ms: Math.round(opts.facts.line.lineMs),
          }
        : {}),
      ...(opts.facts?.marks ? opts.facts.marks.fields() : {}),
      ...(typeof opts.facts?.isolateInvocationIndex === "number" ? { isolate_invocation_index: opts.facts.isolateInvocationIndex } : {}),
      ...(opts.facts?.lineTrace ? { line_trace: opts.facts.lineTrace } : {}),
      ...(opts.facts?.loadtestLeg ? { loadtest_leg: opts.facts.loadtestLeg } : {}),
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
