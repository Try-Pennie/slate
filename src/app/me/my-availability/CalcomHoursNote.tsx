import { InfoIcon } from "@/components/icons";
import { proseCls } from "@/components/ui/styles";
import { readScheduleForImport, type ScheduleForImportRead } from "@/lib/calcom/client";
import { loadCalcomRetiredCached } from "@/lib/calcom/retirement";
import { CALCOM_CALL_TIMEOUT_MS } from "@/lib/bookable/activation-hours";
import {
  judgeCalcomHours,
  shouldCompareWithCalcom,
  type CalcomHoursJudgement,
} from "@/lib/calcom/hours-mismatch";
import type { HoursSource, SlateRule } from "@/lib/calcom/schedule-import";
import { log } from "@/lib/log";

type Slate = { timezone: string; rules: SlateRule[] };

/**
 * The reads and the judgement, outside the component so the clock is read in an
 * ordinary function rather than during render (react-hooks/purity, as #288 did on
 * the admin page). Null when the page should not ask at all.
 */
async function compareWithCalcom(
  email: string,
  hoursSource: HoursSource | null,
  slate: Slate,
): Promise<CalcomHoursJudgement | null> {
  const retired = await loadCalcomRetiredCached();
  if (!shouldCompareWithCalcom(hoursSource, slate.rules.length, retired)) return null;

  let read: ScheduleForImportRead;
  try {
    read = await readScheduleForImport(email, CALCOM_CALL_TIMEOUT_MS);
  } catch (err) {
    // It is documented never to throw; a throw is still a comparison not made.
    read = { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  const judgement = judgeCalcomHours(slate, read, Date.now());
  if (judgement.kind === "unchecked") {
    log.warn("calcom-hours-note", { msg: "could not compare with cal.com", read: read.kind });
  }
  return judgement;
}

/**
 * Tells an advisor who set their own hours when cal.com still holds a different
 * week (#3549). The page renders it only for a week the advisor wrote, inside a
 * Suspense boundary, so the cal.com read (two calls, each bounded by
 * `CALCOM_CALL_TIMEOUT_MS`) never holds up the form the advisor came to use.
 *
 * Draws nothing when the weeks agree or cal.com holds nobody here, and SAYS so when
 * the comparison could not be made, because the note is the only sign of a
 * difference and silence must keep meaning agreement (Dan, 2026-10-08).
 */

export async function CalcomHoursNote({
  email,
  hoursSource,
  slate,
}: {
  email: string;
  hoursSource: HoursSource | null;
  slate: Slate;
}) {
  const judgement = await compareWithCalcom(email, hoursSource, slate);
  if (!judgement) return null;
  if (judgement.kind === "unchecked") {
    return <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>{judgement.text}</p>;
  }
  if (judgement.kind !== "differs") return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-md bg-pennie-sky-soft p-4 text-sm text-fg dark:bg-accent/15"
    >
      <InfoIcon width={20} height={20} className="mt-0.5 shrink-0 text-pennie-blue dark:text-pennie-sky" />
      <p className={proseCls}>{judgement.text}</p>
    </div>
  );
}
