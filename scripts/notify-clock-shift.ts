// Say what the shifted test run found (#2503).
//
// Invoked by .github/workflows/clock-shift.yml after every shift has run, whatever
// those steps exited with. A red run in the Actions tab of a scheduled workflow is
// a detector nobody is looking at, so this is the part that reaches a person, and
// it is also the part that refuses to call a run clean when the run measured
// nothing (L98).
//
// Bare node, no dependency install and no alias hook, like its siblings: an alerter
// carrying an install is another way for it to be unavailable exactly when it is
// needed (#1598). The DECISION and the wording are in `lib/clock-shift-report.ts`,
// pinned offline; only the HTTP call and the file reading are here.
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAlerter } from "./lib/run-alerter.ts";
import { postToAlertsChannel } from "./lib/slack-post.ts";
import {
  decideClockShiftReport,
  expectedSuiteCount,
  readShiftLog,
  type ShiftVerdict,
} from "./lib/clock-shift-report.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * One log per shift, named after the shift EXACTLY as the workflow's own list
 * spells it, so the association between a verdict and the shift it belongs to is
 * the shift itself rather than a slug kept in step by hand (L41). A file that is
 * absent reads as a step that never ran, which the decision reports rather than
 * skipping over, so a dropped shift cannot shorten the list in silence.
 */
export function collectVerdicts(
  dir: string,
  askedFor: string[],
  expectedSuites: number,
): ShiftVerdict[] {
  if (!dir.trim() || !existsSync(dir)) return [];
  const files = new Set(readdirSync(dir));
  const out: ShiftVerdict[] = [];
  for (const spec of askedFor) {
    if (!files.has(`${spec}.log`)) continue;
    out.push(readShiftLog(spec, readFileSync(join(dir, `${spec}.log`), "utf8"), expectedSuites));
  }
  return out;
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
  io: { dir: string; scriptsDir: string },
): Promise<{ ok: boolean; reason: string; detail: string }> {
  const askedFor = (env.CLOCK_SHIFTS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const expectedSuites = expectedSuiteCount(io.scriptsDir);
  const decision = decideClockShiftReport(
    askedFor,
    collectVerdicts(io.dir, askedFor, expectedSuites),
    env.RUN_URL ?? "",
  );

  if (decision.alert === null) {
    return { ok: true, reason: "nothing to say", detail: decision.detail };
  }
  const res = await postToAlertsChannel(post, decision.alert, env);
  return { ok: false, reason: res.reason, detail: decision.detail };
}

runAlerter(import.meta.url, async (post, env) => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const res = await run(post, env, {
    dir: process.env.CLOCK_SHIFT_LOG_DIR ?? "",
    scriptsDir: here,
  });
  console.log(`clock shift: ${res.detail} (${res.reason})`);
  // A finding and an undelivered message are both red, and the message says
  // which: an unsent alert is not evidence that the suite is date independent.
  if (!res.ok) {
    console.error(`::error title=Shifted test run::${res.detail} (${res.reason})`);
    return 1;
  }
  return 0;
});
