// One line per confirm saying how long the lead waited for the answer (#3221).
//
// Confirm latency was only measurable inside a load test (the confirm profile is
// SLATE_LOADTEST only) or as the invocation's wall time, which includes the work
// deferred past the response that no lead waits for. This line is the time from
// the handler starting to the response being handed back, and nothing else.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-latency-line.ts
import { answerTimed } from "../src/lib/booking/confirm-latency.ts";
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

  // --- nothing about the lead -------------------------------------------------
  {
    const cap = captureInfo();
    await answerTimed("booking", async () => new Response("{}", { status: 200 }), { now: () => 0 });
    cap.restore();
    const line = cap.lines.find((l) => l.includes('msg="confirm answered"')) ?? "";
    const fields = [...line.matchAll(/ (\w+)=/g)].map((m) => m[1]).sort();
    assert(
      JSON.stringify(fields) === JSON.stringify(["msg", "response_ms", "status", "tag"]),
      `no lead data: the line carries only the timing and the status (got ${JSON.stringify(fields)})`,
    );
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
