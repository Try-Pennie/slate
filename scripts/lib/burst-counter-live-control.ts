// The decision logic behind `pnpm verify:burst-counter` (#1564), kept apart from the live IO so
// every refusal it can reach is driven offline by scripts/test-burst-counter-live-control.ts.
//
// The command reports a fixed monitor key to the real `BURST_LIMITER` Durable Object, reads the
// count back, reports it again, and requires the count to have RISEN. Nothing else counts as a
// pass: a counter hard wired to a single answer, or one that replies without counting, satisfies
// a check that only asks whether it replied (L1). Finding nothing to check is never a pass
// either (L98), so every way of learning nothing exits non-zero on its own code.
import { BURST_PROBE_REASON } from "@/lib/monitor/burst-counter-probe";

/**
 * Every way the command can end, and the exit code it ends on.
 *
 * One code per cause, never a shared "it failed" (L11). These are what a caller in a shell
 * script branches on, and each one names a different thing to go and do: a key to fix, a
 * deployment to ship, a binding to restore, Cloudflare to ask about, or a counter that is
 * genuinely not counting.
 */
export const VERIFY_EXIT = {
  /** The count rose. The only zero. */
  passed: 0,
  /** This machine is missing the base URL or the API key, so nothing was attempted. */
  misconfigured: 1,
  /** The request never got a reply at all: DNS, TLS, a timeout, no network. */
  noAnswer: 2,
  /** Something replied with a shape this endpoint never produces (a platform error page). */
  unreadableReply: 3,
  /** The deployment rejected the key. */
  unauthorized: 4,
  /** The deployment has no booking API key configured, so the endpoint is disabled. */
  notConfigured: 5,
  /** The deployment does not carry the endpoint: it is older than this change. */
  endpointMissing: 6,
  /** The running Worker could not read its own request context. */
  contextUnreadable: 7,
  /** `BURST_LIMITER` is absent from the running deployment. */
  bindingMissing: 8,
  /** The namespace resolved and the object did not answer. The gap this command exists for. */
  objectUnreachable: 9,
  /** The object answered without a count, so there was nothing to compare. */
  noCount: 10,
  /** The fixed window rolled between the readings, so the two numbers are different counts. */
  windowRolled: 11,
  /** Two readings inside one window, and the second was not greater than the first. */
  didNotRise: 12,
} as const;

/** What one call to the endpoint produced. */
export type ProbeOutcome =
  | { kind: "counted"; count: number; windowStartMs: number }
  | { kind: "no-answer"; detail: string }
  | { kind: "unreadable-reply"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "not-configured" }
  | { kind: "endpoint-missing" }
  | { kind: "context-unreadable" }
  | { kind: "binding-missing" }
  | { kind: "object-unreachable"; detail: string }
  | { kind: "no-count"; detail: string };

export type Verdict =
  | { ok: true; first: number; second: number; message: string }
  | { ok: false; exitCode: number; message: string };

function detailOf(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

/**
 * Turn one HTTP reply into an outcome.
 *
 * The parse lives here rather than at the call site so an unreadable body is a tested decision
 * rather than a catch block nothing drives. Judged by the reason field and the status, never by
 * looking for words in the text: three of the failures below quote the binding name that the
 * success case also names, so a check that matched on it would pass on all of them (L156, L184).
 */
export function readProbeOutcome(status: number, bodyText: string): ProbeOutcome {
  let parsed: unknown;
  let readable = true;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    // Not fatal on its own. A 404 or a platform error page is HTML, and the status still says
    // something worth acting on, so the status cases below get their turn before this is called
    // unreadable.
    readable = false;
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    reason?: unknown;
    count?: unknown;
    windowStartMs?: unknown;
    detail?: unknown;
  };

  switch (body.reason) {
    case BURST_PROBE_REASON.contextUnreadable:
      return { kind: "context-unreadable" };
    case BURST_PROBE_REASON.bindingMissing:
      return { kind: "binding-missing" };
    case BURST_PROBE_REASON.objectUnreachable:
      return {
        kind: "object-unreachable",
        detail: detailOf(body.detail, "no detail given"),
      };
    case BURST_PROBE_REASON.noCount:
      return { kind: "no-count", detail: detailOf(body.detail, "no detail given") };
    case BURST_PROBE_REASON.counted: {
      // The endpoint says it counted; whether it did is decided on the numbers, not on the
      // word. A missing or unreadable number here is the same finding as the object answering
      // without one, so it lands on the same outcome rather than on a guess.
      if (typeof body.count !== "number" || !Number.isFinite(body.count)) {
        return { kind: "no-count", detail: "the endpoint reported a count that is not a number" };
      }
      if (typeof body.windowStartMs !== "number" || !Number.isFinite(body.windowStartMs)) {
        return {
          kind: "no-count",
          detail: "the endpoint reported a window that is not a number, so nothing can be compared",
        };
      }
      return { kind: "counted", count: body.count, windowStartMs: body.windowStartMs };
    }
  }

  if (status === 401 || status === 403) return { kind: "unauthorized" };
  // A 503 with no reason of its own is the shared auth refusal for an endpoint with no key
  // configured. It shares a status with the missing binding and nothing else, so it is told
  // apart by the reason field above rather than by the status.
  if (status === 503) return { kind: "not-configured" };
  if (status === 404) return { kind: "endpoint-missing" };
  return {
    kind: "unreadable-reply",
    detail: readable
      ? `HTTP ${status} with no reason this command recognises`
      : `HTTP ${status} with a body that is not JSON`,
  };
}

/** What one failed reading means, and what to do about it. */
function refuse(outcome: ProbeOutcome, which: "first" | "second"): { exitCode: number; message: string } {
  switch (outcome.kind) {
    case "no-answer":
      return {
        exitCode: VERIFY_EXIT.noAnswer,
        message:
          `The ${which} report never got a reply, so nothing about the counter was learned: ` +
          `${outcome.detail}. Check the base URL and that the deployment is serving at all.`,
      };
    case "unreadable-reply":
      return {
        exitCode: VERIFY_EXIT.unreadableReply,
        message:
          `The ${which} report got an answer this command cannot read (${outcome.detail}), so it ` +
          "came from something other than the endpoint: a platform error page or a proxy in front " +
          "of the Worker.",
      };
    case "unauthorized":
      return {
        exitCode: VERIFY_EXIT.unauthorized,
        message:
          `The ${which} report was refused: the deployment did not accept this key. Set ` +
          "BOOKING_API_KEY to the key the running deployment holds, and check it has not been " +
          "rotated since.",
      };
    case "not-configured":
      return {
        exitCode: VERIFY_EXIT.notConfigured,
        message:
          `The ${which} report reached the endpoint and it is disabled: the running deployment ` +
          "has no booking API key configured, so it refuses every caller. Nothing was measured " +
          "about the counter.",
      };
    case "endpoint-missing":
      return {
        exitCode: VERIFY_EXIT.endpointMissing,
        message:
          `The ${which} report got a not-found, so the running deployment does not carry this ` +
          "endpoint. It is older than the change that added it: deploy the current build and run " +
          "this again.",
      };
    case "context-unreadable":
      return {
        exitCode: VERIFY_EXIT.contextUnreadable,
        message:
          `On the ${which} report the running Worker could not read its own request context, so ` +
          "it never looked for the counter. This is not a missing binding and redeploying the " +
          "same build will not fix it. Pointing this command at a local dev server rather than a " +
          "deployed Worker reads exactly like this.",
      };
    case "binding-missing":
      return {
        exitCode: VERIFY_EXIT.bindingMissing,
        message:
          `On the ${which} report the running deployment does not have the burst counter bound, ` +
          "so the ceiling a concurrent burst cannot spread across is OFF. It is declared in the " +
          "durable_objects block of wrangler.jsonc: compare that against the deployed version and " +
          "redeploy.",
      };
    case "object-unreachable":
      return {
        exitCode: VERIFY_EXIT.objectUnreachable,
        message:
          `On the ${which} report the counter is bound and did not answer when called ` +
          `(${outcome.detail}). This is exactly the state the monitor lane cannot see, because a ` +
          "binding that resolves reads as healthy there. The ceiling is failing open right now.",
      };
    case "no-count":
      return {
        exitCode: VERIFY_EXIT.noCount,
        message:
          `On the ${which} report the counter answered without a count (${outcome.detail}), so ` +
          "there is nothing to compare. The object is reachable and its reply shape is wrong, " +
          "which is a code fault rather than a deploy one.",
      };
    case "counted":
      // Unreachable: the caller only refuses an outcome that is not a count. Kept so a new
      // outcome added to the union fails the build here rather than falling through to a pass.
      return {
        exitCode: VERIFY_EXIT.didNotRise,
        message: `The ${which} report counted, so there is nothing to refuse.`,
      };
  }
}

/**
 * The verdict over the pair.
 *
 * The rise has to be STRICT, and it has to be inside ONE window. It is not required to be
 * exactly one, because a second run overlapping this one, or the retry after a rolled window,
 * would each add a report: what is under test is that a report LANDS in a count that everything
 * else can see, not that this command is the only thing talking to it.
 */
export function judgeBurstCounterProbe(first: ProbeOutcome, second: ProbeOutcome): Verdict {
  // The first cause met is the one to act on. Reporting the second would send the reader to a
  // problem that is usually a consequence of the first (L11).
  if (first.kind !== "counted") return { ok: false, ...refuse(first, "first") };
  if (second.kind !== "counted") return { ok: false, ...refuse(second, "second") };

  if (first.windowStartMs !== second.windowStartMs) {
    return {
      ok: false,
      exitCode: VERIFY_EXIT.windowRolled,
      message:
        "The two readings fell in different one minute windows, so they are two separate counts " +
        "and comparing them would prove nothing either way. Nothing is wrong with the counter " +
        "here. Run it again: the command waits out the end of a window before it starts, so this " +
        "should not repeat.",
    };
  }

  if (second.count <= first.count) {
    return {
      ok: false,
      exitCode: VERIFY_EXIT.didNotRise,
      message:
        `Two reports inside one window read ${first.count} and then ${second.count}, so the ` +
        "second report did not raise the count. The object is answering and it is not counting, " +
        "which means the burst ceiling is measuring nothing while reading as healthy everywhere " +
        "else.",
    };
  }

  return {
    ok: true,
    first: first.count,
    second: second.count,
    message:
      `Two reports inside one window read ${first.count} and then ${second.count}: the shared ` +
      "counter took the report and answered with the count it now holds.",
  };
}

/**
 * Milliseconds to wait before starting, so both reports land inside one window.
 *
 * A fixed window rolls on the minute, and a run that begins in its last moments gets two
 * readings from two different counts. That is not a fault and the command says so, but a
 * refusal nobody can act on is still a refusal, so the cheap thing is not to start there.
 * Waiting is honest in a way a tolerance would not be: treating a fallen count as "probably a
 * rollover" would excuse the exact failure this command exists to catch (L253).
 */
export function msToWaitForWindow(nowMs: number, windowMs: number, marginMs: number): number {
  const msLeft = windowMs - (nowMs % windowMs);
  return msLeft < marginMs ? msLeft : 0;
}
