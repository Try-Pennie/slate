// How the scheduled sweep's reporter decides what happened (#2031). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-parity-report.ts
//
// It sits between a GitHub runner and the app, and it is the step that decides
// whether the heartbeat gets stamped. So every way of learning nothing has to exit
// on its OWN code: "the sweep never produced a summary", "Slate did not answer",
// "the key was refused" and "the sweep looked at nobody" send four different people
// to do four different things, and one message answering for another is how
// somebody spends an afternoon on a rate limit (L11, L98).
import { reportOutcome, buildParitySummary, REPORT_EXIT } from "./lib/parity-report.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const RUN = "https://github.com/x/y/actions/runs/1";

// --- the only pass ----------------------------------------------------------------
{
  const paged = await reportOutcome({
    baseUrl: "https://slate.example",
    apiKey: "k",
    runUrl: RUN,
    readSummary: () => ({ total: 2, compared: 2, findings: [{ verdict: "hours-differ", count: 1, agents: ["a@x"] }] }),
    post: async () => ({ status: 200, body: { action: "page", compared: 2, drifted: 1 } }),
  });
  eq(paged.exit, REPORT_EXIT.reported, "a sweep that paged is reported and stamps the heartbeat");

  const cleared = await reportOutcome({
    baseUrl: "https://slate.example",
    apiKey: "k",
    runUrl: RUN,
    readSummary: () => ({ total: 2, compared: 2, findings: [] }),
    post: async () => ({ status: 200, body: { action: "all-clear", compared: 2 } }),
  });
  eq(cleared.exit, REPORT_EXIT.reported, "so is one that cleared");
}

// --- a sweep that judged nothing is not a pass -------------------------------------
{
  const blind = await reportOutcome({
    baseUrl: "https://slate.example",
    apiKey: "k",
    runUrl: RUN,
    readSummary: () => ({ total: 102, compared: 0, findings: [] }),
    post: async () => ({ status: 200, body: { action: "unmeasured", compared: 0 } }),
  });
  eq(blind.exit, REPORT_EXIT.nothingJudged, "compared nobody, so the heartbeat is NOT stamped");
  assert(/compared/.test(blind.reason), "and it says so in its own words");
}

// --- each way of learning nothing, on its own code ---------------------------------
{
  const cases: [string, Parameters<typeof reportOutcome>[0], number][] = [
    [
      "no key here",
      { baseUrl: "https://s", apiKey: "", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 200, body: {} }) },
      REPORT_EXIT.notConfigured,
    ],
    [
      "the sweep left no summary",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => null, post: async () => ({ status: 200, body: {} }) },
      REPORT_EXIT.noSummary,
    ],
    [
      "Slate did not answer",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => { throw new Error("connect ECONNREFUSED"); } },
      REPORT_EXIT.noReply,
    ],
    [
      "the key was refused",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 401, body: { error: "bad key" } }) },
      REPORT_EXIT.keyRefused,
    ],
    [
      "no key on the deployment",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 503, body: { error: "not configured" } }) },
      REPORT_EXIT.endpointDisabled,
    ],
    [
      "the deployment predates this endpoint",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 404, body: {} }) },
      REPORT_EXIT.notFound,
    ],
    [
      "Slate refused the payload",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 400, body: { error: "unknown verdict: made-up" } }) },
      REPORT_EXIT.refused,
    ],
    [
      "an answer this cannot read",
      { baseUrl: "https://s", apiKey: "k", runUrl: RUN, readSummary: () => ({ total: 1, compared: 1, findings: [] }), post: async () => ({ status: 200, body: { hello: "world" } }) },
      REPORT_EXIT.unreadable,
    ],
  ];
  const seen = new Map<number, string>();
  for (const [what, input, expected] of cases) {
    const out = await reportOutcome(input);
    eq(out.exit, expected, `${what} exits on its own code`);
    assert(out.reason.trim().length > 0, `${what} says why`);
    const clash = seen.get(out.exit);
    assert(clash === undefined, `${what} does not share a code with ${clash ?? ""}`);
    seen.set(out.exit, what);
  }
  assert(!seen.has(REPORT_EXIT.reported), "and none of them reads as a successful report");
}

// --- no two outcomes share a code, including the pass -------------------------------
{
  const codes = Object.values(REPORT_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has a distinct exit code");
}

// --- shaping the sweep's own rows into what gets reported ---------------------------
{
  const schedule = [
    { email: "a@x", verdict: "agree" },
    { email: "b@x", verdict: "days-differ" },
    { email: "c@x", verdict: "days-differ" },
    { email: "d@x", verdict: "no-calcom-schedule" },
  ];
  const membership = [
    { email: "a@x", verdict: "agree" },
    { email: "e@x", verdict: "departed-still-hosting" },
  ];
  const out = buildParitySummary(schedule, membership, 3);

  eq(out.compared, 3, "compared is passed through, never re-derived here");
  // The union, not either side's length: a cal.com host with no Slate row at all is
  // somebody the sweep LOOKED at, and counting only Slate's roster could report more
  // agents differing than were looked at.
  eq(out.total, 5, "total is everybody either half formed a verdict about, counted once");

  const byVerdict = new Map(out.findings.map((f) => [f.verdict, f]));
  assert(!byVerdict.has("agree"), "agreement is not a finding");
  eq(byVerdict.get("days-differ")?.count, 2, "one entry per verdict, carrying its count");
  assert(byVerdict.get("days-differ")?.agents.includes("c@x") === true, "and who it was about");
  eq(byVerdict.get("departed-still-hosting")?.count, 1, "both halves are folded into one list");
}

// A hundred addresses in a file is a hundred addresses in a log, and the message
// names a handful anyway.
{
  const many = Array.from({ length: 40 }, (_, i) => ({ email: `a${i}@x`, verdict: "hours-differ" }));
  const out = buildParitySummary(many, [], 40);
  eq(out.findings[0].count, 40, "the count is the real one");
  assert(out.findings[0].agents.length <= 8, "the names are capped");
}

// A sweep that found nothing still reports, because "no findings" and "never ran" are
// the two things the endpoint has to be able to tell apart (L98).
{
  const out = buildParitySummary([{ email: "a@x", verdict: "agree" }], [], 1);
  eq(out.findings.length, 0, "no findings");
  eq(out.total, 1, "and it still says what it looked at");
}

// --- what the lane repaired travels with the sweep (#2092) -----------------------
//
// The apply step writes what it corrected and this carries it, so the alert can say
// what the lane fixed by itself rather than paging about drift that is already
// gone. Asserted on the BODY that actually goes over the wire, because a field the
// report shapes and never sends is indistinguishable from one it never shaped.
{
  let sent: Record<string, unknown> = {};
  const capture = async (_url: string, body: unknown) => {
    sent = body as Record<string, unknown>;
    return { status: 200, body: { action: "all-clear", compared: 2, drifted: 0 } };
  };
  const base = {
    baseUrl: "https://slate.example",
    apiKey: "k",
    runUrl: RUN,
    readSummary: () => ({ total: 2, compared: 2, findings: [] }),
    post: capture,
  };

  await reportOutcome({ ...base, readApplied: () => ({ count: 3, agents: ["a@x"] }) });
  eq((sent.corrected as { count: number })?.count, 3, "what the lane corrected reaches the app");

  // Zero is SENT, and that is the whole point of the field being optional rather
  // than defaulted: it says the import ran and had nothing to write, which is a
  // different message from nothing having run.
  await reportOutcome({ ...base, readApplied: () => ({ count: 0, agents: [] }) });
  eq((sent.corrected as { count: number })?.count, 0, "a lane that wrote nothing still says it ran");

  // No apply step at all, which is a hand run sweep and every deployment before
  // this shipped. The field must be ABSENT, not zero.
  await reportOutcome(base);
  eq(sent.corrected, undefined, "with no apply step the field is absent, not a zero standing in for it");

  // A note it cannot read must not cost the run its report: the findings are what
  // page somebody and they are already in hand.
  const survived = await reportOutcome({
    ...base,
    readApplied: () => {
      throw new Error("the apply summary is corrupt");
    },
  });
  eq(survived.exit, REPORT_EXIT.reported, "an unreadable apply note still reports the sweep");
  eq(sent.corrected, undefined, "and says nothing about a repair it could not read");
}

finish();
