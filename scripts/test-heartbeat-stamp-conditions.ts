/**
 * Every heartbeat stamp step states its own status condition (#2478).
 *
 * GitHub ANDs an implicit `success()` into any custom `if:` that carries no status
 * function of its own. So a step written as
 *
 *     if: steps.pre.outputs.configured == '1' && steps.report.outputs.concluded == '1'
 *
 * does NOT mean what it says. It means that AND the whole job having succeeded so
 * far, which folds two independent questions into one status field (L53): whether
 * the detector CONCLUDED is a fact about the thing under test, and whether anybody
 * was told is a fact about Slack. `router-replay.yml` had exactly that shape while
 * `notify-router-replay.ts` deliberately wrote `concluded=1` BEFORE exiting non-zero
 * so the stamp could still read it, which made that care unreachable: a failed Slack
 * post skipped the stamp, the router-replay heartbeat went stale, and nine days later
 * the lane watchdog paged saying the replay had stopped concluding when it had not.
 * A page that claims something its check never measured is L11.
 *
 * THE RULE IS NOT "every stamp carries always()". Two of these workflows want
 * different things and both are right:
 *   - `burst-counter.yml` wants `always()`: the run measured a verdict, and whether
 *     Slack heard about it is somebody else's problem.
 *   - `schedule-parity.yml` wants `success()`: a sweep that reached nobody genuinely
 *     has not done its job, so not stamping is correct.
 * What neither may do is leave the choice to GitHub's implicit AND, where the
 * behaviour is identical to a deliberate `success()` and the author's intent is
 * invisible. So this guard demands an EXPLICIT status function, whichever one, and
 * says nothing about which. A wrong explicit choice is a decision somebody can find
 * and argue with; an absent one is not a decision at all.
 *
 * Subjects are ENUMERATED from what a step DOES (it posts to the heartbeat endpoint),
 * never from a hand written list of workflows, so a new lane is covered by
 * construction rather than by somebody remembering (L96).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, eq, finish } from "./lib/harness.ts";

const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");
const HEARTBEAT_POST = "/api/smoke/heartbeat";
const STATUS_FUNCTION = /\b(always|success|failure|cancelled)\s*\(\s*\)/;

export interface StampStep {
  workflow: string;
  name: string;
  ifLine: string | null;
}

/**
 * Every step in `yaml` whose body posts to the heartbeat endpoint.
 *
 * Steps are split on the `- name:` marker at step indentation. A step carrying no
 * `if:` at all is returned with `ifLine: null`, which is a different state from an
 * `if:` that omits a status function: the first runs on success only by default and
 * the second LOOKS like it states a condition. Both fail here, with their own words.
 */
export function heartbeatStampSteps(yaml: string, workflow: string): StampStep[] {
  const steps = yaml.split(/^ {6}- name:/m).slice(1);
  const found: StampStep[] = [];
  for (const body of steps) {
    if (!body.includes(HEARTBEAT_POST)) continue;
    const name = (body.split("\n", 1)[0] ?? "").trim();
    const ifMatch = body.match(/^ {8}if:(.*)$/m);
    found.push({ workflow, name, ifLine: ifMatch ? ifMatch[1].trim() : null });
  }
  return found;
}

// --- fixtures, both directions, before the real tree -------------------------
{
  const noStatus = `
      - name: Stamp it
        if: steps.pre.outputs.configured == '1' && steps.report.outputs.concluded == '1'
        run: |
          curl -fsS -X POST "\${base%/}/api/smoke/heartbeat?lane=x"
`;
  const [step] = heartbeatStampSteps(noStatus, "fixture.yml");
  assert(step !== undefined, "a step posting to the heartbeat endpoint is found");
  assert(
    step !== undefined && !STATUS_FUNCTION.test(step.ifLine ?? ""),
    "and a condition with no status function is recognised as stating none",
  );

  const withAlways = noStatus.replace("if: steps.pre", "if: always() && steps.pre");
  const [ok1] = heartbeatStampSteps(withAlways, "fixture.yml");
  assert(STATUS_FUNCTION.test(ok1?.ifLine ?? ""), "always() satisfies it");

  const withSuccess = noStatus.replace("if: steps.pre", "if: success() && steps.pre");
  const [ok2] = heartbeatStampSteps(withSuccess, "fixture.yml");
  assert(
    STATUS_FUNCTION.test(ok2?.ifLine ?? ""),
    "and so does an explicit success(), because this guard demands a stated choice, not a particular one",
  );

  const noIf = noStatus.replace(/^ {8}if:.*$/m, "");
  const [bare] = heartbeatStampSteps(noIf, "fixture.yml");
  assert(bare !== undefined && bare.ifLine === null, "a step with no if: at all is its own state");

  const unrelated = `
      - name: Install
        run: pnpm install --frozen-lockfile
`;
  assert(
    heartbeatStampSteps(unrelated, "fixture.yml").length === 0,
    "a step that does not post a heartbeat is not a subject",
  );
}

// --- the real tree -----------------------------------------------------------
{
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const all: StampStep[] = [];
  for (const file of files) {
    all.push(...heartbeatStampSteps(readFileSync(join(WORKFLOW_DIR, file), "utf8"), file));
  }

  // Positive control: a scan that read nothing and a tree with no defect produce the
  // same empty list, so the count is asserted before the verdict (L98).
  assert(
    all.length >= 3,
    `the real workflows were read: ${all.length} heartbeat stamp step(s) examined (floor 3)`,
  );
  eq(
    all.filter((s2) => s2.ifLine === null).length,
    0,
    "no heartbeat stamp step is left with no condition at all",
  );

  for (const step of all) {
    if (step.ifLine === null) {
      assert(false, `${step.workflow}: "${step.name}" carries no if: at all, so it silently runs on success only`);
      continue;
    }
    assert(
      STATUS_FUNCTION.test(step.ifLine),
      `${step.workflow}: "${step.name}" states its own status condition rather than inheriting ` +
        `GitHub's implicit success(), which folds "did it conclude" and "was anybody told" into one field (L53)`,
    );
  }
}

finish();
