// scripts/post-design-score.py: CI's design-score job posts a score only on a pull request in a
// design milestone, and fails only when nothing was measured or posting failed (#3954).
//
// Driven in process through python with a stand in for gh and for the copied score's `post`, so it
// runs wherever python3 does with no network. The two ways it could go wrong quietly are the ones
// pinned here: a comment on every pull request (posting outside a design milestone), and a run that
// measured nothing passing green.
//
// Run: node --experimental-strip-types scripts/test-post-design-score.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPT = fileURLToPath(new URL("./post-design-score.py", import.meta.url));
const DESIGN = "docs/design/team-capacity.html";
const dir = mkdtempSync(join(tmpdir(), "post-design-score-"));

type Verdict = "matched" | "not-matched" | "unmeasured";
function score(verdict: Verdict, design = DESIGN) {
  const met = verdict === "matched";
  return {
    format: "design-score", version: 1, verdict, design,
    unmeasured: verdict === "unmeasured" ? ["the capture folder held no capture.json"] : [],
    decisions: { met: met ? 1 : 0, of: 1, rows: [{ id: "D1", status: met ? "met" : "unmet" }] },
    pictures: { score: 1, frames: [{ id: "f1", status: "measured", matched: 10, compared: 10 }] },
  };
}
const matchIssue = (design: string) => ({ number: 7, title: "Match the settled design", body: `<!-- design-score-issue ${JSON.stringify({ design })} -->` });

interface Case { score?: object | null; milestone?: number | null; issues?: object[]; postRc?: number; ghFails?: boolean }
let n = 0;
/** Runs the script's main with the case's world; returns its exit code, whether it posted, and what it said. */
function run(c: Case): { rc: number; posted: boolean; out: string } {
  const folder = join(dir, `case-${++n}`);
  mkdirSync(folder);
  if (c.score) writeFileSync(join(folder, "score.json"), JSON.stringify(c.score));
  const driver = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("post_design_score", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
world = json.loads(sys.argv[2])
class Gh:
    def call(self, args, repo):
        if world.get("ghFails"): raise m.sg.GitHubError("HTTP 502")
        return json.dumps({"milestone": {"number": world["milestone"], "title": "Team capacity"} if world.get("milestone") else None})
    def api(self, endpoint, repo, paginate=False):
        return world.get("issues", [])
posted = []
def post(path, repo, pr):
    posted.append(path); return world.get("postRc", 0)
rc = m.main(["post-design-score.py", sys.argv[3], "--repo", "Try-Pennie/slate", "--pr", "12"], gh=Gh(), post=post)
print("RESULT " + json.dumps({"rc": rc, "posted": bool(posted)}))
`;
  const p = spawnSync("python3", ["-B", "-c", driver, SCRIPT, JSON.stringify(c), folder], { encoding: "utf8" });
  const out = `${p.stdout}${p.stderr}`;
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`the driver gave no result: ${out}`);
  return { ...JSON.parse(line.slice(7)), out };
}

{
  const r = run({ score: score("matched"), milestone: 41, issues: [matchIssue(DESIGN)] });
  eq([r.rc, r.posted], [0, true], "a matched score on a pull request in a design milestone is posted");
}
{
  const r = run({ score: score("not-matched"), milestone: 41, issues: [matchIssue(DESIGN)] });
  eq([r.rc, r.posted], [0, true], "a not matched score is posted without failing the job: expected while a milestone is under way");
}
{
  const r = run({ score: score("unmeasured"), milestone: 41, issues: [matchIssue(DESIGN)] });
  eq([r.rc, r.posted], [2, true], "a score that measured nothing is posted and fails the job");
}
{
  const r = run({ score: score("matched"), milestone: null });
  eq([r.rc, r.posted], [0, false], "a pull request in no milestone gets no comment");
  assert(/not in a design milestone \(it is in no milestone\)/.test(r.out), "and says why nothing was posted");
}
{
  const r = run({ score: score("matched"), milestone: 41, issues: [{ number: 3, title: "Something else", body: "" }, matchIssue("docs/design/other.html")] });
  eq([r.rc, r.posted], [0, false], "a milestone whose Match issue is for another design is not this design's milestone");
  assert(/holds no Match the settled design issue for docs\/design\/team-capacity.html/.test(r.out), "and it names the design it looked for");
}
{
  const r = run({ score: score("unmeasured"), milestone: null });
  eq([r.rc, r.posted], [2, false], "outside a design milestone a score that measured nothing still fails");
}
{
  const r = run({ score: null, milestone: 41, issues: [matchIssue(DESIGN)] });
  eq([r.rc, r.posted], [2, false], "no score.json is no score, never a quiet pass");
}
{
  const r = run({ score: { ...score("matched"), verdict: "not-matched" }, milestone: 41, issues: [matchIssue(DESIGN)] });
  eq([r.rc, r.posted], [2, false], "a score file whose rows contradict its verdict is refused, not posted");
}
{
  const r = run({ score: score("matched"), milestone: 41, issues: [matchIssue(DESIGN)], postRc: 2 });
  eq(r.rc, 2, "a comment GitHub refused fails the job");
}
{
  const r = run({ score: score("matched"), ghFails: true });
  eq([r.rc, r.posted], [2, false], "a milestone that could not be read fails, rather than reading as not a design milestone");
}

rmSync(dir, { recursive: true, force: true });
finish();
