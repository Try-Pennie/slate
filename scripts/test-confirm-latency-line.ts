// One line per confirm saying how long the lead waited for the answer (#3221).
//
// Confirm latency was only measurable inside a load test (the confirm profile is
// SLATE_LOADTEST only) or as the invocation's wall time, which includes the work
// deferred past the response that no lead waits for. This line is the time from
// the handler starting to the response being handed back, and nothing else.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-latency-line.ts
import { answerTimed, CONFIRM_PROFILE_SLOW_MS, noteRefusal, type ConfirmLineFacts } from "../src/lib/booking/confirm-latency.ts";
import { DependencyTimeoutError } from "../src/lib/booking/orchestration.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { makeWaitMarks } from "../src/lib/booking/wait-marks.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

function captureInfo() {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.info = original) };
}

async function main() {
  // --- an answered confirm: one line, the wait, the status ---------------------
  {
    const cap = captureInfo();
    let t = 1_000;
    const res = await answerTimed(
      "booking-api",
      async () => {
        t += 2_345; // the confirm's own I/O
        return new Response("{}", { status: 409 });
      },
      { now: () => t },
    );
    cap.restore();
    assert(res.status === 409, "answered: the response is passed through untouched");
    const ours = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    assert(ours.length === 1, `answered: exactly one line per confirm (got ${ours.length})`);
    assert(ours[0]?.includes("tag=booking-api"), "answered: under the route's existing tag");
    assert(ours[0]?.includes("response_ms=2345"), `answered: the time from start to response (got ${ours[0]})`);
    assert(ours[0]?.includes("status=409"), "answered: the status the lead got");
  }

  // --- #3325: which confirm line served it, why, and what the line cost ---------
  {
    const cap = captureInfo();
    const facts: ConfirmLineFacts = {};
    await answerTimed(
      "booking",
      async () => {
        facts.line = { line: "fallback", reason: "reach-timeout", key: "ladder", lineMs: 1_512 };
        return new Response("{}", { status: 200 });
      },
      { now: () => 0, facts },
    );
    const plain = await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: {} });
    cap.restore();
    void plain;
    const lines = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    assert(
      (lines[0] ?? "").includes('line="fallback"') && lines[0]!.includes('line_reason="reach-timeout"') && lines[0]!.includes('line_key="ladder"') && lines[0]!.includes("line_ms=1512"),
      `line: the line, its reason, its key kind and its cost are on the confirm's line (got ${lines[0]})`,
    );
    assert(!(lines[1] ?? "x").includes("line_"), `line: a confirm that recorded none carries no line fields (got ${lines[1]})`);
  }

  // --- #3354: the wait before the profile, split by the request's own marks -----
  {
    const cap = captureInfo();
    let t = 10_000;
    const marks = makeWaitMarks(() => t, 9_900);
    const facts: ConfirmLineFacts = { marks };
    await answerTimed(
      "booking-api",
      async () => {
        marks.mark("handler");
        t = 10_150; marks.mark("authed");
        t = 10_160; marks.mark("line_start");
        t = 10_400; marks.mark("line_turn");
        t = 10_700; marks.mark("decided");
        t = 10_710; marks.mark("profile");
        t = 12_000;
        return new Response("{}", { status: 200 });
      },
      { now: () => t, facts },
    );
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: {} });
    cap.restore();
    const lines = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    const marked = lines[0] ?? "";
    for (const want of ["wait_route_ms=100", "wait_auth_ms=150", "wait_pre_line_ms=10", "wait_line_ms=240", "wait_decide_ms=300", "wait_to_profile_ms=10", "wait_total_ms=810"]) {
      assert(marked.includes(want), `marks: ${want} is on the confirm's own line (got ${marked})`);
    }
    assert(!(lines[1] ?? "x").includes("wait_"), `marks: a confirm that carried no marks carries no wait fields (got ${lines[1]})`);
  }

  // --- #3354: which fetch of its isolate this was, counted at the Worker ---------
  {
    const cap = captureInfo();
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: { isolateInvocationIndex: 0 } });
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: { isolateInvocationIndex: 12 } });
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: { isolateInvocationIndex: null } });
    cap.restore();
    const lines = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    assert((lines[0] ?? "").includes("isolate_invocation_index=0"), `invocation index: a fresh isolate's first request says 0 (got ${lines[0]})`);
    assert((lines[1] ?? "").includes("isolate_invocation_index=12"), `invocation index: a warm one says how many came before it (got ${lines[1]})`);
    assert(!(lines[2] ?? "x").includes("isolate_invocation_index"), `invocation index: an unknown one is absent, never 0 (got ${lines[2]})`);
  }

  // --- #3354: the trace its line calls carried, and the leg that sent it ---------
  {
    const cap = captureInfo();
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: { lineTrace: "t-9", loadtestLeg: "burst" } });
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: { loadtestLeg: "unreadable" } });
    await answerTimed("booking-api", async () => new Response("{}", { status: 200 }), { now: () => 0, facts: {} });
    cap.restore();
    const lines = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    assert((lines[0] ?? "").includes('line_trace="t-9"') && (lines[0] ?? "").includes('loadtest_leg="burst"'), `trace and leg: both are on the confirm's own line (got ${lines[0]})`);
    assert((lines[1] ?? "").includes('loadtest_leg="unreadable"'), `trace and leg: a leg the route could not read says so (got ${lines[1]})`);
    assert(!(lines[2] ?? "x").includes("line_trace") && !(lines[2] ?? "x").includes("loadtest_leg"), `trace and leg: a production confirm carries neither (got ${lines[2]})`);
  }

  // --- a dry run says so, so it never mixes into the confirm latency -----------
  {
    const cap = captureInfo();
    const facts = { dryRun: false };
    await answerTimed(
      "booking-api",
      async () => {
        facts.dryRun = true;
        return new Response("{}", { status: 200 });
      },
      { now: () => 0, facts },
    );
    cap.restore();
    const line = cap.lines.find((l) => l.includes('msg="confirm answered"')) ?? "";
    assert(line.includes("dry_run=true"), `dry run: flagged on the line (got ${line})`);
  }

  // --- a handler that throws still leaves the line, and the throw ---------------
  {
    const cap = captureInfo();
    let t = 0;
    let thrown: unknown = null;
    try {
      await answerTimed(
        "booking",
        async () => {
          t = 50;
          throw new Error("boom");
        },
        { now: () => t },
      );
    } catch (err) {
      thrown = err;
    }
    cap.restore();
    assert(thrown instanceof Error && thrown.message === "boom", "threw: the error reaches the runtime unchanged");
    const line = cap.lines.find((l) => l.includes('msg="confirm answered"')) ?? "";
    assert(line.includes("status=500") && line.includes("response_ms=50"), `threw: recorded as the 500 the runtime sends (got ${line})`);
  }

  // --- #3300: where a slow or timed out confirm's time went ---------------------
  //
  // Production logged only the total, so a confirm that ran out of its 12 second
  // budget could not say whether the time went to a dependency, to the ladder or to
  // the isolate. The profile is collected on every confirm and put on the line only
  // when it is worth its length: a deadline, or a confirm past the slow threshold.
  const fieldsOf = (line: string) => new Map([...line.matchAll(/ (\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2]]));
  const answered = (lines: string[]) => lines.filter((l) => l.includes('msg="confirm answered"'));

  // An ordinary fast confirm carries nothing, however many stages it timed.
  {
    const cap = captureInfo();
    let t = 1_000;
    const facts: ConfirmLineFacts = {};
    await answerTimed(
      "booking",
      async () => {
        await facts.profile!.time("assign-and-verify", async () => { t += 1_200; });
        return new Response("{}", { status: 200 });
      },
      { now: () => t, facts },
    );
    cap.restore();
    const line = answered(cap.lines)[0] ?? "";
    const fields = [...fieldsOf(line).keys()].sort();
    assert(
      JSON.stringify(fields) === JSON.stringify(["confirm_kind", "msg", "response_ms", "status", "tag"]),
      `fast: an ordinary confirm's line is only the timing and the status (got ${line})`,
    );
  }

  // A success past the threshold carries the profile, and it adds up to the wall.
  {
    const cap = captureInfo();
    let t = 1_000;
    const facts: ConfirmLineFacts = { leadId: "00QUi00000zhEUP" };
    await answerTimed(
      "booking",
      async () => {
        const end = facts.profile!.begin("route-checks");
        t += 300;
        end();
        t += 2_000; // nothing named in flight: the isolate, or our own computing
        await facts.profile!.time("assign-and-verify", async () => {
          await facts.profile!.rung("411", async () => {
            facts.profile!.call("supabase", t, t + 400);
            t += 5_000;
          });
          await facts.profile!.rung("311", async () => { t += 1_000; });
        });
        t += 100;
        return new Response("{}", { status: 200 });
      },
      { now: () => t, facts },
    );
    cap.restore();
    const f = fieldsOf(answered(cap.lines)[0] ?? "");
    assert(Number(f.get("response_ms")) >= CONFIRM_PROFILE_SLOW_MS, `slow: past the threshold (got ${f.get("response_ms")})`);
    assert(f.get("stages_run") === "2", `slow: how many stages ran (got ${f.get("stages_run")})`);
    assert(f.get("stages") === '"assign-and-verify:6000/1,route-checks:300/1"', `slow: each stage, dearest first (got ${f.get("stages")})`);
    assert(f.get("staged_ms") === "6300", `slow: the time a stage was running (got ${f.get("staged_ms")})`);
    assert(f.get("unattributed_ms") === "2100", `slow: the wall no stage covers, named (got ${f.get("unattributed_ms")})`);
    assert(
      f.get("unattributed_before_ms") === "0" && f.get("unattributed_between_ms") === "2000" && f.get("unattributed_after_ms") === "100",
      `slow: and where it fell (got ${f.get("unattributed_before_ms")}/${f.get("unattributed_between_ms")}/${f.get("unattributed_after_ms")})`,
    );
    assert(
      Number(f.get("staged_ms")) + Number(f.get("unattributed_ms")) === Number(f.get("response_ms")),
      "slow: the stages and the remainder are the whole of response_ms, the same clock and the same instants",
    );
    assert(f.get("rungs_walked") === "2" && f.get("rung_ms") === '"411:5000,311:1000"', `slow: the rungs walked, in order (got ${f.get("rung_ms")})`);
    assert(f.get("calls_made") === "1" && f.get("calls_by") === '"supabase:400/1/400"', `slow: the dependency calls (got ${f.get("calls_by")})`);
    assert(!f.has("lead_id") && !f.has("timed_out"), "slow: a confirm that answered carries no lead id and is not a timeout");
  }

  // A deadline 503 always carries the profile, however fast, and the lead's id.
  for (const [what, err] of [
    ["a deadline", new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 })],
    ["the confirm line timing out", new DependencyTimeoutError({ label: "the confirm ahead of it in line", timeoutMs: 9_000, budget: null }, null)],
  ] as const) {
    const cap = captureInfo();
    let t = 0;
    const facts: ConfirmLineFacts = { leadId: "00QUi00000zhEUP" };
    await answerTimed(
      "booking",
      async () => {
        await facts.profile!.time("assign-and-verify", async () => { t += 600; });
        noteRefusal(facts, err);
        return new Response("{}", { status: 503 });
      },
      { now: () => t, facts },
    );
    cap.restore();
    const f = fieldsOf(answered(cap.lines)[0] ?? "");
    assert(f.get("status") === "503" && f.get("timed_out") === "true", `deadline (${what}): said to be a timeout (got ${answered(cap.lines)[0]})`);
    assert(f.get("lead_id") === '"00QUi00000zhEUP"', `deadline (${what}): the lead's Salesforce id, so a rebooking can be matched (got ${f.get("lead_id")})`);
    assert(f.get("stages") === '"assign-and-verify:600/1"' && f.get("rungs_walked") === "0", `deadline (${what}): the profile, though it was quick (got ${f.get("stages")})`);
  }

  // A 503 that is not a deadline (the booker paused) and is quick stays short.
  {
    const cap = captureInfo();
    const facts: ConfirmLineFacts = {};
    await answerTimed("booking", async () => new Response("{}", { status: 503 }), { now: () => 0, facts });
    cap.restore();
    const f = fieldsOf(answered(cap.lines)[0] ?? "");
    assert(!f.has("stages_run") && !f.has("timed_out") && !f.has("lead_id"), `not a deadline: no profile (got ${answered(cap.lines)[0]})`);
  }

  // L748: two confirms interleaved in one isolate each log only their own stages.
  {
    const cap = captureInfo();
    let t = 0;
    let openA!: () => void;
    let openB!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    const gateB = new Promise<void>((r) => (openB = r));
    const factsA: ConfirmLineFacts = { leadId: "00QUi00000aaaaa" };
    const factsB: ConfirmLineFacts = { leadId: "00QUi00000bbbbb" };
    const a = answerTimed(
      "booking",
      async () => {
        await factsA.profile!.time("assign-and-verify", () => factsA.profile!.rung("411", () => gateA));
        noteRefusal(factsA, new DeadlineExceededError("supabase", 0, null));
        return new Response("{}", { status: 503 });
      },
      { now: () => t, facts: factsA },
    );
    const b = answerTimed(
      "booking",
      async () => {
        await factsB.profile!.time("reserve", () => gateB);
        return new Response("{}", { status: 200 });
      },
      { now: () => t, facts: factsB },
    );
    t = 9_000;
    openB();
    await b;
    t = 13_000;
    openA();
    await a;
    cap.restore();
    const lines = answered(cap.lines).map(fieldsOf);
    const fb = lines.find((f) => f.get("status") === "200");
    const fa = lines.find((f) => f.get("status") === "503");
    assert(fa?.get("stages") === '"assign-and-verify:13000/1"' && fa.get("rung_ms") === '"411:13000"', `interleaved: the timed out confirm has only its own stages (got ${fa?.get("stages")})`);
    assert(fa?.get("lead_id") === '"00QUi00000aaaaa"', `interleaved: and its own lead (got ${fa?.get("lead_id")})`);
    assert(fb?.get("stages") === '"reserve:9000/1"' && fb.get("rungs_walked") === "0", `interleaved: the slow one has only its own (got ${fb?.get("stages")})`);
    assert(!fb?.has("lead_id"), "interleaved: the one that answered carries no lead id");
  }

  // --- nothing about the lead -------------------------------------------------
  {
    const cap = captureInfo();
    await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0 });
    cap.restore();
    const line = cap.lines.find((l) => l.includes('msg="confirm answered"')) ?? "";
    const fields = [...line.matchAll(/ (\w+)=/g)].map((m) => m[1]).sort();
    assert(
      JSON.stringify(fields) === JSON.stringify(["confirm_kind", "msg", "response_ms", "status", "tag"]),
      `no lead data: the line carries only the timing, the status and its kind (got ${JSON.stringify(fields)})`,
    );
  }

  // --- #3401: which kind of confirm it was, new or a time change ----------------
  {
    const cap = captureInfo();
    await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0 });
    await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0, kind: "move" });
    await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0, kind: "admin_move" });
    cap.restore();
    const lines = cap.lines.filter((l) => l.includes('msg="confirm answered"'));
    assert((lines[0] ?? "").includes('confirm_kind="new"'), `kind: a booking confirm says new (got ${lines[0]})`);
    assert((lines[1] ?? "").includes('confirm_kind="move"'), `kind: a lead's time change says move (got ${lines[1]})`);
    assert((lines[2] ?? "").includes('confirm_kind="admin_move"'), `kind: a staff time change says admin_move (got ${lines[2]})`);
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
