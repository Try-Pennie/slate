// Report the daily cal.com parity sweep to Slate (#2031).
//
// Invoked by .github/workflows/schedule-parity.yml after
// `pnpm verify:calcom-parity` has written its summary. Slate turns the summary into
// an alert with a cooldown and, when the drift goes away, an all clear: a GitHub
// runner has nowhere to remember what it said yesterday, and drift is a condition
// rather than an event.
//
// Bare node, no alias hook and no dependency on the install having WORKED, for the
// same reason the three alerters run that way: this is the step that speaks after
// the expensive part of the job, and every dependency is another way for it to be
// unavailable exactly then.
//
// Exit codes are in `lib/parity-report.ts`. Zero means Slate accepted a MEASURED
// sweep, and the workflow stamps the parity heartbeat on that and nothing else.
import { readFileSync } from "node:fs";
import {
  reportOutcome,
  REPORT_EXIT,
  type ParitySummary,
  type ParityCorrectionSummary,
} from "./lib/parity-report.ts";

/** `??` would not catch an empty string, and an unset repo variable arrives as one. */
function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}

const baseUrl = envOr("SLATE_BASE_URL", "https://slate.trypennie.app");
const apiKey = envOr("BOOKING_API_KEY_CANARY", "");
const summaryPath = envOr("PARITY_SUMMARY_FILE", "parity-summary.json");
const runUrl = envOr("RUN_URL", "https://github.com/Try-Pennie/slate/actions");
const appliedPath = envOr("PARITY_APPLY_FILE", "");

const result = await reportOutcome({
  baseUrl,
  apiKey,
  runUrl,
  readSummary: () => {
    let raw: string;
    try {
      raw = readFileSync(summaryPath, "utf8");
    } catch {
      // An ABSENT file is a real outcome, not an error: the sweep stopped before it
      // judged anything, which is a different thing from a file it could not parse.
      return null;
    }
    // A file that parses to something other than an object is a CORRUPT summary,
    // not an absent one, and the two send different people to different places
    // (L11): absent means the sweep stopped early, corrupt means this side has a
    // fault. Throwing here is what separates them, since the caller reads a throw
    // as unreadable and a null as never written.
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("the summary file does not hold an object");
    }
    return parsed as ParitySummary;
  },
  /**
   * What the lane's apply step corrected, or null when no apply ran (#2092).
   *
   * An ABSENT file means the import step did not get as far as deciding, so the
   * alert keeps its "re-import the hours" instruction. A file holding a zero means
   * the import ran and found nothing to write, which is the ordinary healthy
   * morning and a different message entirely. `PARITY_APPLY_FILE` unset means this
   * is a hand run, which is also absent.
   */
  readApplied: appliedPath
    ? () => {
        let raw: string;
        try {
          raw = readFileSync(appliedPath, "utf8");
        } catch {
          return null;
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("the apply summary file does not hold an object");
        }
        return parsed as ParityCorrectionSummary;
      }
    : undefined,
  post: async (url, body, key) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  },
});

console.log(`schedule-parity report: ${result.reason}`);
process.exit(result.exit === REPORT_EXIT.reported ? 0 : result.exit);
