/**
 * How long a lead waited for a confirm's answer, one line per confirm (#3221).
 *
 * The invocation's wall time is not that number: it runs on through the work
 * deferred past the response (the post confirm recompute, the outcome tally),
 * which takes seconds and which no lead waits for. So outside a load test there
 * was no way to read what a lead actually waits, and the 2026-10-04 burst could
 * only be judged from the client's side.
 *
 * This is the time from the handler starting to the response being handed back,
 * under the route's own tag, with the status and which kind of confirm it was
 * (`confirm_kind`: a booking, or a lead's or staff time change, #3401). On a
 * refusal it also carries the refusal's stage, instant, bucket and per rung counts
 * (#3272).
 *
 * **Where the time went (#3300).** Every confirm collects its stage profile
 * (`confirm-profile.ts`), opened on the same clock reading this line's timer starts
 * from, so its wall IS `response_ms`. It goes on this line only for a confirm that
 * timed out (`timed_out`, a deadline answered as the retryable 503) or that took
 * `CONFIRM_PROFILE_SLOW_MS` or longer: the stages that ran and their time, the
 * wall no stage covers (`unattributed_ms`, split by whether it fell before, between
 * or after the stages), the ladder rungs walked, and the Supabase and Google calls.
 * An ordinary fast confirm's line stays the timing and the status. This line is
 * where a slow confirm page sends its reader.
 *
 * **What it says about the lead.** One fact, the lead's Salesforce lead id
 * (`lead_id`, the 15 character key of the 00Q id), which is an external id and safe
 * to log: on a refusal, so a run of refusals can be counted in people (#3276), and
 * on a timeout, so the same lead booking again a minute later can be matched to the
 * attempt that failed them (#3300). Nothing else, ever: never a name, email or phone.
 *
 * A Worker's clock moves at I/O, so it measures the waiting the confirm did, and
 * a response is always handed back after I/O, so the end is never early.
 */
import { log } from "@/lib/log";
import { refusalLogFields, refusalTraceOf } from "@/lib/booking/refusal-trace";
import { confirmProfileFields, makeConfirmProfile, type ConfirmProfile } from "@/lib/booking/confirm-profile";
import { DependencyTimeoutError } from "@/lib/booking/orchestration";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import type { LineServed } from "@/lib/booking/shared-confirm-line";
import type { LoadtestLeg, WaitMarks } from "@/lib/booking/wait-marks";

/**
 * How long a confirm may take before its line carries the profile anyway (#3300).
 *
 * Two thirds of the 12 second confirm budget (`BOOKING_CONFIRM_BUDGET_MS`): a
 * confirm this slow came within a few seconds of timing out, so it is the one that
 * says why the next one will, while ordinary confirms (a second or two) stay
 * short and the log volume small. A literal rather than derived from the budget:
 * the budget module imports the orchestration, and this threshold is a judgement
 * about what is worth reading, not a share anything enforces.
 */
export const CONFIRM_PROFILE_SLOW_MS = 8_000;

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
   * #3354: how many times this isolate had run the app before this request, counted
   * at the Worker over HTTP requests, cron ticks and log shipping receipts alike
   * (`worker/app-invocations.ts`; 0 is a fresh isolate's first run). Null or absent
   * when unknown, which is never read as a first request.
   */
  isolateInvocationIndex?: number | null;
  /**
   * #3354: the trace every call this confirm made to the shared line carried, so the
   * run can join the object's own log of those calls to this line. Load test only.
   */
  lineTrace?: string;
  /** #3354: which leg of the load run sent this confirm, as its driver named it. */
  loadtestLeg?: LoadtestLeg | "unreadable";
  /**
   * #3300: this request's stage profile, opened by `answerTimed` before the handler
   * runs, so every stage and call the request makes is charged to it and to no
   * other request. The route hands it to the confirm budget (for the calls) and to
   * the service (for the stages and rungs).
   */
  profile?: ConfirmProfile;
  /**
   * #3300: the lead's Salesforce lead id as a 15 character key (`refusedLeadId`),
   * set by the route once the body is read. Logged only on a timeout.
   */
  leadId?: string | null;
  /** #3300: the confirm was answered as a timeout, a deadline it could not meet. */
  timedOut?: boolean;
}

/**
 * Note a refusal on the line, from the trace the refused error carries. A route
 * calls this where it turns a booking error into its response; an error with no
 * trace (an outage before any stage measured anything) adds no refusal fields.
 *
 * #3300: and notes a TIMEOUT, whatever shape it reached the route in: the
 * classified outage (`DependencyTimeoutError`, which the confirm line's own wait
 * throws with no cause) or a deadline carried inside another error.
 */
export function noteRefusal(facts: ConfirmLineFacts, err: unknown): void {
  const trace = refusalTraceOf(err);
  if (trace) facts.refusal = refusalLogFields(trace);
  if (err instanceof DependencyTimeoutError || isDeadlineExceeded(err)) facts.timedOut = true;
}

/**
 * #3401: which kind of confirm a line describes, since a lead's time change and a
 * staff one write the same line under the booker's tag: `new` is a booking (the
 * booker or the direct booking API, which the tag tells apart), `move` a lead
 * moving their own call from the manage page or the booker's panel, `admin_move`
 * staff moving one from the admin screen.
 */
export type ConfirmKind = "new" | "move" | "admin_move";

export async function answerTimed(
  tag: string,
  handle: () => Promise<Response>,
  /** `kind` is `new` unless a time change says otherwise. */
  opts: { now?: () => number; facts?: ConfirmLineFacts; kind?: ConfirmKind } = {},
): Promise<Response> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const facts = opts.facts;
  // #3300: opened on the same reading as `startedAt`, so the profile's wall and
  // `response_ms` are one number. Per request: it lives on this request's facts.
  if (facts && !facts.profile) facts.profile = makeConfirmProfile({ now, startedAt });
  const line = (status: number) => {
    // One reading for the end too, shared by `response_ms` and the profile.
    const endedAt = now();
    const responseMs = Math.max(0, endedAt - startedAt);
    const profiled = facts?.profile && (facts.timedOut || responseMs >= CONFIRM_PROFILE_SLOW_MS) ? facts.profile : null;
    log.info(tag, {
      msg: "confirm answered",
      confirm_kind: opts.kind ?? "new",
      response_ms: responseMs,
      status,
      ...(facts?.timedOut ? { timed_out: true } : {}),
      ...(facts?.timedOut && facts.leadId ? { lead_id: facts.leadId } : {}),
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
      ...(profiled ? confirmProfileFields(profiled.read(endedAt)) : {}),
    });
  };
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
