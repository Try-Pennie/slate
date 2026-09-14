// What the scheduled router replay says, and when it says nothing (#2263).
//
// `pnpm verify:router-replay` was hand run, so it found what it found on the day
// somebody remembered. On a schedule two things have to be decided that a hand run
// decides by somebody reading the terminal:
//
//   - WHETHER THE DETECTOR CONCLUDED, which is what the heartbeat records. A run
//     that reached a verdict, agreement or disagreement alike, concluded; a run
//     cal.com refused did not. A detector that has stopped concluding looks exactly
//     like one finding nothing wrong (#1394), and that is what the stale heartbeat
//     exists to catch.
//   - WHAT TO SAY. A disagreement and a run that never happened send two different
//     people to two different places (L11), and agreement says nothing at all,
//     because a weekly message reporting that nothing is wrong is how the ones that
//     matter stop being read (L36).
//
// The summary FILE is how the two are told apart. The command writes it when it
// reaches a verdict, so an absent file means the run died before deciding, and the
// absence is the evidence rather than an inference from an exit code (L98).
//
// Run: node --experimental-strip-types scripts/test-router-replay-report.ts
import { decideReplayReport, writeReplaySummary } from "./lib/router-replay-report.ts";
import { readSummary, run } from "./notify-router-replay.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert, eq, finish } from "./lib/harness.ts";

const RUN_URL = "https://github.com/Try-Pennie/slate/actions/runs/1";

// --- agreement: it concluded, and nobody is told --------------------------------
{
  const d = decideReplayReport(
    { outcome: "agree", exit: 0, detail: "AGREE: 100 percent of 119 leads" },
    RUN_URL,
  );
  assert(d.concluded, "a run that agreed reached a verdict, so the heartbeat is stamped");
  eq(d.alert, null, "and nobody is told, because a weekly all is well is what stops being read");
}

// --- a disagreement: it concluded, and it is reported ----------------------------
{
  const d = decideReplayReport(
    {
      outcome: "disagreement",
      exit: 7,
      detail: "LADDER agreement is 71 percent of 140 leads, under 90 percent.",
    },
    RUN_URL,
  );
  assert(d.concluded, "a disagreement is a MEASURED verdict, so the detector concluded");
  assert(d.alert !== null, "and it is reported");
  assert(
    d.alert!.includes("71 percent"),
    "carrying the command's OWN sentence, so the numbers are the ones it measured (L41)",
  );
  assert(d.alert!.includes(RUN_URL), "and where to look");
}

// --- a run that never reached a verdict ------------------------------------------
{
  // No file: cal.com refused, the key was wrong, the job died. The command's own
  // refusals each exit on their own code, and this must not claim to know which.
  const d = decideReplayReport(null, RUN_URL);
  assert(!d.concluded, "a run that never decided has NOT concluded, so no heartbeat is stamped");
  assert(d.alert !== null, "and it is reported, or it would sit non-zero in a tab nobody watches");
  assert(
    !/agreement is|percent of/.test(d.alert!),
    "without claiming a rate nothing measured (L11)",
  );
  assert(d.alert!.includes(RUN_URL), "and says where to look");
}

// --- the three messages are three different messages ------------------------------
{
  const disagree = decideReplayReport(
    { outcome: "disagreement", exit: 7, detail: "LADDER agreement is 71 percent." },
    RUN_URL,
  ).alert;
  const stuck = decideReplayReport(null, RUN_URL).alert;
  assert(disagree !== stuck, "a disagreement and a run that never happened do not share a sentence");
}

// --- every non agreeing verdict is reported, not just the disagreement -------------
{
  // `nothing-judged`, `resolution-too-low` and `catchall-too-high` are the shapes
  // of a run that looked and could not conclude usefully. Each is a finding: a
  // sample too thin to judge is exactly how a detector goes blind while reading as
  // healthy (#1394), which is the reason this is on a schedule at all.
  for (const outcome of ["nothing-judged", "resolution-too-low", "catchall-too-high"] as const) {
    const d = decideReplayReport({ outcome, exit: 2, detail: `detail for ${outcome}` }, RUN_URL);
    assert(d.alert !== null, `${outcome} is reported`);
    assert(d.alert!.includes(`detail for ${outcome}`), `${outcome} carries its own detail`);
    assert(
      d.concluded === false,
      `${outcome} did not reach a usable verdict, so it must not stamp the heartbeat: a blind ` +
        "detector that keeps its heartbeat fresh is the exact state #1394 exists to notice",
    );
  }
}

// --- a summary file this cannot read is not a verdict --------------------------------
{
  // A truncated or reshaped file must not be read as agreement, which is what an
  // unknown outcome falling through to the quiet branch would do.
  const d = decideReplayReport({ outcome: "who-knows", exit: 0, detail: "" } as never, RUN_URL);
  assert(!d.concluded, "an outcome this does not recognise never counts as concluding");
  assert(d.alert !== null, "and it says so rather than passing in silence");
}

// =============================================================================
// THE HANDOFF: the file the command writes, and what the alerter does with it.
//
// The decision above is only half of it. What the lane actually rests on is the
// command writing a verdict where the alerter can read it, and the alerter turning
// that into a Slack post and a heartbeat answer. An unreadable file must reach the
// SAME place an absent one does, because a truncated write that fell through to
// the quiet branch would report agreement about a run nobody judged (L98).
// =============================================================================

const DIR = mkdtempSync(join(tmpdir(), "replay-report-"));

function fileWith(name: string, body: string): string {
  const path = join(DIR, name);
  writeFileSync(path, body, "utf8");
  return path;
}

/** A Slack poster that records rather than posts, and can be told to fail. */
function poster(opts: { fail?: string } = {}) {
  const posts: { text: string; channel?: string }[] = [];
  return {
    posts,
    post: async (msg: { text: string; channel?: string }) => {
      posts.push(msg);
      return opts.fail ? { ok: false, error: opts.fail } : { ok: true };
    },
  };
}

// --- reading the file the command wrote ------------------------------------------
{
  const path = fileWith(
    "ok.json",
    JSON.stringify({ outcome: "disagreement", exit: 7, detail: "71 percent" }),
  );
  const got = readSummary(path);
  eq(got?.outcome, "disagreement", "a verdict the command wrote is read back");
  eq(got?.exit, 7, "with its exit code");
  eq(got?.detail, "71 percent", "and its own sentence");
}

// --- every way there is no verdict lands in ONE place ------------------------------
{
  // Absent, unreadable, and the wrong shape all mean the same fact: no verdict got
  // here. Any of them falling through to "agree" would report a clean week about a
  // run that never decided.
  eq(readSummary(join(DIR, "not-there.json")), null, "an absent file is no verdict");
  eq(readSummary(fileWith("torn.json", '{"outcome":')), null, "a truncated file is no verdict");
  eq(readSummary(fileWith("shape.json", '{"exit":0}')), null, "a file with no outcome is no verdict");
  eq(readSummary(fileWith("list.json", "[]")), null, "a file that is not an object is no verdict");
  eq(readSummary(""), null, "and an unset path is no verdict");
}

// --- the command's own write, which is the other half of the contract -------------
{
  const path = join(DIR, "round-trip.json");
  const wrote = writeReplaySummary(path, {
    outcome: "disagreement",
    exit: 7,
    detail: "LADDER agreement is 71 percent.",
  });
  assert(wrote.written, "the verdict is written where the lane can read it");
  const back = readSummary(path);
  eq(back?.outcome, "disagreement", "and reads back as the same verdict");
  eq(back?.detail, "LADDER agreement is 71 percent.", "with the same sentence");
}
{
  // A hand run sets no path and reads the terminal instead. It must not read as a
  // failed write, which is a different thing entirely.
  const none = writeReplaySummary("   ", { outcome: "agree", exit: 0, detail: "x" });
  assert(!none.written, "no path, nothing written");
  assert(/no summary path/.test(none.why), "and it says which of the two it was");
}
{
  // An unwritable path REPORTS rather than throwing. The command has already
  // measured what it measured, and throwing here would turn a reported verdict
  // into a run that looks as though it never happened. The failure direction is
  // the safe one: with no file the lane says "did not complete" and leaves the
  // heartbeat unstamped, which is louder than the truth rather than quieter.
  const bad = writeReplaySummary(join(DIR, "no-such-dir", "x.json"), {
    outcome: "agree",
    exit: 0,
    detail: "x",
  });
  assert(!bad.written, "an unwritable path is reported as not written");
  assert(!/no summary path/.test(bad.why), "distinctly from a path nobody set (L11)");
  eq(readSummary(join(DIR, "no-such-dir", "x.json")), null, "and the lane then reads no verdict");
}

// --- agreement posts nothing and stamps ---------------------------------------------
{
  const p = poster();
  const path = fileWith("agree.json", JSON.stringify({ outcome: "agree", exit: 0, detail: "AGREE: 100 percent" }));
  const res = await run(p.post, { REPLAY_SUMMARY_FILE: path, RUN_URL: RUN_URL });
  assert(res.ok, "a week that agreed is not a failure");
  eq(p.posts.length, 0, "and posts nothing at all");
  assert(res.concluded, "while still recording that the detector reached a verdict");
}

// --- a finding posts, into the configured channel ------------------------------------
{
  const p = poster();
  const path = fileWith(
    "dis.json",
    JSON.stringify({ outcome: "disagreement", exit: 7, detail: "LADDER agreement is 71 percent." }),
  );
  const res = await run(p.post, {
    REPLAY_SUMMARY_FILE: path,
    RUN_URL,
    SLACK_ALERTS_CHANNEL: "C123",
  });
  assert(res.ok, "a posted finding is a successful report");
  eq(p.posts.length, 1, "one message");
  eq(p.posts[0]?.channel, "C123", "into the channel the workflow named");
  assert(p.posts[0]!.text.includes("71 percent"), "carrying the command's own numbers");
  assert(res.concluded, "and a disagreement is a measured verdict");
}

// --- an unset channel is never posted into nowhere -------------------------------------
{
  // An unset repo variable interpolates to the EMPTY STRING, so passing it through
  // would ask Slack to post to a channel named "" (#1598).
  const p = poster();
  const path = fileWith("nochan.json", JSON.stringify({ outcome: "disagreement", exit: 7, detail: "x" }));
  await run(p.post, { REPLAY_SUMMARY_FILE: path, RUN_URL, SLACK_ALERTS_CHANNEL: "  " });
  assert(!("channel" in p.posts[0]!), "an empty channel is left off rather than sent as empty");
}

// --- a run that never decided is reported, and does NOT stamp ----------------------------
{
  const p = poster();
  const res = await run(p.post, { REPLAY_SUMMARY_FILE: join(DIR, "gone.json"), RUN_URL });
  eq(p.posts.length, 1, "a run that never decided is reported");
  assert(!res.concluded, "and must not stamp the heartbeat, or it would look alive while blind");
}

// --- Slack failing is a failure of the REPORT, never of the verdict -------------------------
{
  // The two are separate facts and must not share one status (L53). Losing the
  // fact that the replay concluded because Slack was misconfigured would leave the
  // heartbeat unstamped for a reason that has nothing to do with the replay.
  const p = poster({ fail: "channel_not_found" });
  const path = fileWith(
    "slackdown.json",
    JSON.stringify({ outcome: "disagreement", exit: 7, detail: "x" }),
  );
  const res = await run(p.post, { REPLAY_SUMMARY_FILE: path, RUN_URL });
  assert(!res.ok, "a Slack post that failed is reported as a failure, never as delivered");
  eq(res.reason, "channel_not_found", "carrying Slack's own reason");
  assert(res.concluded, "and the verdict it reached is unchanged by Slack being unreachable");
}

finish();
