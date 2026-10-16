/**
 * The smoke canary's failure, posted by the Worker on the workflow's behalf (#3801).
 *
 * The canary's alert step used to post straight to Slack on every failing run, with
 * no memory of its last post: about 31 times in a week for one slow availability read
 * (#3652, #3713 track the slowness itself). Now the step hands the failure here first,
 * and this posts it through the alert throttle like every other condition: at once
 * when a check is newly failing, again once a day while the same checks fail, and an
 * all-clear when a clean run reports in. If the handoff fails the step posts directly
 * as it always did (`scripts/lib/smoke-failure-handoff.ts`).
 *
 * The message itself is built by the alerter (`scripts/lib/smoke-failure-message.ts`),
 * so there is one builder whether the Worker or the workflow posts it.
 *
 * One key per pass (`smoke_canary_failed:dry`, `:full`), because they are cleared by
 * different runs: the 30 minute dry tick cannot speak for the six hourly full pass's
 * reschedule or embed checks, so a clean dry run clearing a full pass failure would
 * post an all-clear and the same failure again every six hours. A clean FULL run
 * clears both, since it runs everything the dry tick does and more.
 */
import { normalizeSignatureLine } from "@/lib/notify/repeat-policy";

export const SMOKE_CANARY_FAILED_PREFIX = "smoke_canary_failed";
export const SMOKE_MODES = ["dry", "full"] as const;
export type SmokeMode = (typeof SMOKE_MODES)[number];

export const smokeCanaryFailedKey = (mode: SmokeMode) => `${SMOKE_CANARY_FAILED_PREFIX}:${mode}`;

/** Bounds on what a report may carry, so a bad caller cannot post a wall of text. */
export const SMOKE_REPORT_LIMITS = { textChars: 4000, checks: 50, checkChars: 400 } as const;

export type SmokeReport =
  | { outcome: "failed"; mode: SmokeMode; text: string; checks: string[] }
  | { outcome: "passed"; mode: SmokeMode };

/** Parse a report body, refusing anything outside the shape the workflow sends. */
export function parseSmokeReport(body: unknown): { ok: true; report: SmokeReport } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const mode = b.mode;
  if (mode !== "dry" && mode !== "full") return { ok: false, error: "mode must be dry or full" };
  if (b.outcome === "passed") return { ok: true, report: { outcome: "passed", mode } };
  if (b.outcome !== "failed") return { ok: false, error: "outcome must be failed or passed" };
  if (typeof b.text !== "string" || b.text.trim() === "") return { ok: false, error: "a failure needs its text" };
  if (b.text.length > SMOKE_REPORT_LIMITS.textChars) return { ok: false, error: "text is too long" };
  const checks = Array.isArray(b.checks) ? b.checks : [];
  if (checks.length > SMOKE_REPORT_LIMITS.checks) return { ok: false, error: "too many checks" };
  if (!checks.every((c) => typeof c === "string" && c.length <= SMOKE_REPORT_LIMITS.checkChars)) {
    return { ok: false, error: "each check must be a short string" };
  }
  return { ok: true, report: { outcome: "failed", mode, text: b.text, checks: checks as string[] } };
}

/**
 * Slack reads `<!channel>`, `<!here>` and `<!subteam...>` in message text as a mention
 * of everybody. The text comes from a caller holding the canary key, so it is not
 * trusted to page a whole channel: the marker is broken so it renders as text.
 */
export function withoutBroadcastMentions(text: string): string {
  return text.replace(/<!/g, "< !");
}

/**
 * The subjects of a canary failure: its checks with every number stripped, so a slow
 * read reported at 4,210ms and then at 4,380ms is the same failing check, and only a
 * check that was not failing at the last post is a change.
 */
export function smokeFailureSubjects(checks: readonly string[]): string[] {
  return checks.map(normalizeSignatureLine).filter((s) => s !== "");
}

/** The all-clear, posted when a clean run of that pass reports in. */
export function formatSmokeCanaryRecovery(mode: SmokeMode): string {
  return mode === "full"
    ? "The booking canary's full end to end pass is passing again: a real booking was made, " +
        "rescheduled and cancelled against production with every check green, so the earlier " +
        "failure is cleared. No action is needed."
    : "The booking canary's health check is passing again against production, so the earlier " +
        "failure is cleared. No action is needed.";
}

/** The keys a clean run of `mode` measured healthy: a full pass covers the dry tick too. */
export function keysClearedBy(mode: SmokeMode): string[] {
  return mode === "full" ? SMOKE_MODES.map(smokeCanaryFailedKey) : [smokeCanaryFailedKey("dry")];
}
