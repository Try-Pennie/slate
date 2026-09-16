// Reads the `schedule:` cron lines and the `workflow_dispatch:` inputs out of a
// GitHub Actions workflow file (#2414).
//
// Two questions live here, and both are answered from the FILE rather than from a
// number typed beside the thing that depends on it:
//
//   - how often is this workflow SUPPOSED to run? That is the producing cadence a
//     heartbeat staleness bound has to be derived from (L614). A bound written as a
//     literal stops meaning anything the day somebody edits the cron.
//   - what inputs does its `workflow_dispatch` accept? GitHub answers 422 to a
//     dispatch carrying an input the workflow does not declare, so the Worker's
//     gap filler has to send exactly the ones the file declares and no others. That
//     failure is invisible from inside the Worker: the dispatch simply never runs,
//     and the only symptom is the same stale heartbeat the gap filler exists to
//     prevent.
//
// Line based rather than a YAML parse, for the same reason `scan-workflow-jobs.ts`
// is: this repo carries no yaml package as a direct dependency.

/**
 * The cron expressions under a workflow's `schedule:` trigger, in file order.
 *
 * An empty array means the workflow has no schedule at all, which a caller must
 * tell apart from a parse that read nothing: a scanner that parsed nothing and a
 * workflow with no cron line give the same answer (L98), so every guard here
 * asserts the list is non empty before drawing a conclusion from it.
 */
export function parseWorkflowSchedules(source: string): string[] {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => /^ {2}schedule:\s*(?:#.*)?$/.test(l));
  if (at < 0) return [];

  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    // A comment or a blank line inside the block is skipped, never treated as the
    // end of it: every cron line in this repo carries a paragraph above it saying
    // why that minute was chosen, and a parser that stopped at the first comment
    // would report the workflow as having no schedule.
    if (/^\s*#/.test(line) || line.trim().length === 0) continue;
    const m = line.match(/^ {4}-\s*cron:\s*(?:"([^"]+)"|'([^']+)'|([^#\s][^#]*?))\s*(?:#.*)?$/);
    if (!m) break;
    out.push(((m[1] ?? m[2] ?? m[3]) as string).trim());
  }
  return out;
}

/**
 * How long one cron expression leaves between two consecutive fires, in ms.
 *
 * Deliberately narrow: it reads the shapes this repo actually uses and returns
 * null for everything else rather than guessing. A cadence reader that fell back
 * to a plausible default would hand every bound derived from it a number nobody
 * measured, and the bound would still look derived (L214).
 */
export function cronCadenceMs(expr: string): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  // A day of month or month restriction makes the gap between fires depend on the
  // calendar, which is out of scope here.
  if (dayOfMonth !== "*" || month !== "*") return null;

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const isFixed = (v: string) => /^\d+$/.test(v);
  const stepOf = (v: string): number | null => {
    const m = v.match(/^\*\/(\d+)$/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (dayOfWeek !== "*") {
    // One named weekday at a fixed time: weekly. Anything looser (a list, a range,
    // a step) is refused rather than collapsed to seven days.
    if (!isFixed(dayOfWeek) || !isFixed(minute) || !isFixed(hour)) return null;
    return 7 * DAY;
  }
  if (minute === "*") return MINUTE;
  const minuteStep = stepOf(minute);
  if (minuteStep !== null) return minuteStep * MINUTE;
  if (!isFixed(minute)) return null;
  if (hour === "*") return HOUR;
  const hourStep = stepOf(hour);
  if (hourStep !== null) return hourStep * HOUR;
  if (!isFixed(hour)) return null;
  return DAY;
}

/**
 * The input names a workflow's `workflow_dispatch` trigger declares, in file
 * order. An EMPTY array means the trigger exists and takes no inputs, which is a
 * different fact from `null`, meaning the workflow cannot be dispatched by hand or
 * by API at all. A caller that folded the two together would send inputs to a
 * workflow that takes none and read GitHub's 422 as a transient failure.
 */
export function parseWorkflowDispatchInputs(source: string): string[] | null {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => /^ {2}workflow_dispatch:\s*(?:#.*)?$/.test(l));
  if (at < 0) return null;

  const out: string[] = [];
  let inInputs = false;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*#/.test(line) || line.trim().length === 0) continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= 2) break;
    if (lead === 4) {
      inInputs = /^ {4}inputs:\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (inInputs && lead === 6) {
      const m = line.match(/^ {6}([\w-]+):\s*(?:#.*)?$/);
      if (m) out.push(m[1] as string);
    }
  }
  return out;
}
