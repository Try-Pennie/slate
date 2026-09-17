// Pure logic for the burst counter LIVE positive control (#1564). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-burst-counter-live-control.ts
//
// Why this exists. #1558 made the monitor lane report the burst counter missing
// from a deployment, and it stops at a PRESENCE read on purpose: asking the
// object whether it answers would create it, spend a subrequest out of the
// invocation four lanes share, and give it an alarm to clean up on every tick
// forever. The cost of that correct choice is that a counter which is bound but
// unreachable reads as fine, and stays that way until one caller crosses the
// escalation threshold, which before cutover could be months away. That is the
// #1394 family: a detector that has never once concluded.
//
// So the proof is out of band, on the `pnpm verify:availability-truth` precedent
// (#1315): report a fixed monitor key to the real Durable Object, read the count
// back, report it again, and require the count to have RISEN. Both directions or
// it proves nothing (L1): a counter hard wired to one answer satisfies a check
// that only asks whether it replied.
//
// This file drives the decision logic offline through hand written replies, so
// every refusal the live command can reach is exercised without the platform.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERIFY_EXIT,
  readProbeOutcome,
  judgeBurstCounterProbe,
  msToWaitForWindow,
  type ProbeOutcome,
} from "./lib/burst-counter-live-control.ts";
import {
  BURST_PROBE_REASON,
  BURST_VERIFY_AREA,
  BURST_VERIFY_KEY,
  readBurstCountReply,
} from "@/lib/monitor/burst-counter-probe";
import { burstKey } from "@/lib/rate-limit-burst";
import { EDGE_LIMITERS } from "@/lib/rate-limit-core";
import { assert, eq, finish } from "./lib/harness.ts";

const WINDOW = 1_760_000_000_000;
const counted = (count: number, windowStartMs = WINDOW): ProbeOutcome => ({
  kind: "counted",
  count,
  windowStartMs,
});

const body = (value: unknown) => JSON.stringify(value);

// --- the monitor key cannot collide with a real caller's --------------------
{
  // The command WRITES, so the one thing it must never do is land on a count a
  // real lead's traffic is judged against: an inflated count is a lead refused.
  // The key is `area:caller` (`burstKey`), and the area prefix is the whole
  // separation, so the only way to collide is an edge limiter adopting this
  // area. Enumerated from the shipped table rather than restated here, because a
  // hand kept list cannot see an area added later (L41, L96).
  assert(EDGE_LIMITERS.length > 0, "there are edge limiters to compare against");
  for (const spec of EDGE_LIMITERS) {
    assert(
      spec.area !== BURST_VERIFY_AREA,
      `${spec.binding}'s key space (${spec.area}) is not the verification key space`,
    );
    assert(
      !BURST_VERIFY_KEY.startsWith(`${spec.area}:`),
      `the verification key is not inside ${spec.binding}'s key space`,
    );
  }
  assert(
    BURST_VERIFY_KEY.startsWith(`${BURST_VERIFY_AREA}:`),
    "the verification key really is built by burstKey, so the argument above applies to it",
  );
  eq(
    BURST_VERIFY_KEY,
    burstKey(BURST_VERIFY_AREA, BURST_VERIFY_KEY.slice(BURST_VERIFY_AREA.length + 1)),
    "and it is the shared builder's output, not a literal that could drift from it",
  );
}

// --- what the object answered, read at the endpoint -------------------------
{
  // The endpoint's own half of the same rule. Both fields are required and neither is
  // defaulted: a count defaulted to 0 makes an object that answered nothing look like one that
  // has counted nothing, and a window defaulted to now lets two readings from different counts
  // be compared as though they were one.
  const good = readBurstCountReply({ count: 2, windowStartMs: WINDOW });
  assert(good.ok, "a reply with both fields is read");
  if (good.ok) eq(good.count, 2, "and carries the count");

  assert(!readBurstCountReply(null).ok, "a reply that is not an object is refused");
  assert(!readBurstCountReply("3").ok, "and so is one that is not JSON at all");
  assert(!readBurstCountReply({ windowStartMs: WINDOW }).ok, "a reply with no count is refused");
  assert(!readBurstCountReply({ count: 2 }).ok, "a reply with no window is refused");
  assert(
    !readBurstCountReply({ count: Number.NaN, windowStartMs: WINDOW }).ok,
    "and a count that is not a finite number is not a count",
  );
  const noCount = readBurstCountReply({ windowStartMs: WINDOW });
  assert(
    !noCount.ok && /count/i.test(noCount.detail),
    "each refusal says which field it could not read",
  );
}

// --- every exit code is its own, and none of them is zero -------------------
{
  const entries = Object.entries(VERIFY_EXIT).filter(([name]) => name !== "passed");
  const codes = entries.map(([, code]) => code);
  eq(new Set(codes).size, codes.length, "every refusal has its own exit code");
  assert(
    codes.every((c) => c > 0),
    "and none of them is zero, so no refusal can be read as a pass (L98)",
  );
  eq(VERIFY_EXIT.passed, 0, "only the rising case exits zero");
}

// --- reading one reply ------------------------------------------------------
{
  const out = readProbeOutcome(
    200,
    body({ reason: BURST_PROBE_REASON.counted, count: 4, windowStartMs: WINDOW }),
  );
  eq(out.kind, "counted", "a counted reply is read as a count");
  if (out.kind === "counted") {
    eq(out.count, 4, "and carries the count the object answered");
    eq(out.windowStartMs, WINDOW, "and the window it was counted in");
  }
}
{
  // Judged by the COUNT, never by a substring of the reply (L184, L156). Every
  // failure below quotes the binding name the success case also names, so a
  // check that grepped for it would pass on all of them.
  const out = readProbeOutcome(503, body({ reason: BURST_PROBE_REASON.bindingMissing }));
  eq(out.kind, "binding-missing", "a missing binding is its own outcome");
}
{
  const out = readProbeOutcome(
    502,
    body({ reason: BURST_PROBE_REASON.objectUnreachable, detail: "500 internal" }),
  );
  eq(out.kind, "object-unreachable", "an object that did not answer is its own outcome");
  assert(
    out.kind === "object-unreachable" && out.detail.includes("500"),
    "and keeps the detail the deployment reported",
  );
}
{
  const out = readProbeOutcome(
    502,
    body({ reason: BURST_PROBE_REASON.noCount, detail: "no count field" }),
  );
  eq(out.kind, "no-count", "an answer with no readable count is its own outcome");
}
{
  const out = readProbeOutcome(503, body({ reason: BURST_PROBE_REASON.contextUnreadable }));
  eq(
    out.kind,
    "context-unreadable",
    "a deployment that cannot read its own bindings is NOT reported as a missing binding",
  );
}
{
  const out = readProbeOutcome(401, body({ error: "unauthorized" }));
  eq(out.kind, "unauthorized", "a rejected key is its own outcome");
}
{
  const out = readProbeOutcome(503, body({ error: "booking api not configured" }));
  eq(
    out.kind,
    "not-configured",
    "a 503 with no reason is the endpoint being disabled, not a missing binding: they share a " +
      "status and nothing else",
  );
}
{
  const out = readProbeOutcome(404, "<html>not found</html>");
  eq(out.kind, "endpoint-missing", "a 404 says the deployment does not carry the endpoint");
}
{
  const out = readProbeOutcome(500, "<html>error 1101</html>");
  eq(out.kind, "unreadable-reply", "a reply this endpoint never produces is refused, not guessed at");
}
{
  const out = readProbeOutcome(200, body({ reason: BURST_PROBE_REASON.counted, count: "4" }));
  eq(out.kind, "no-count", "a count that is not a number is not a count");
}
{
  const out = readProbeOutcome(
    200,
    body({ reason: BURST_PROBE_REASON.counted, count: 4, windowStartMs: "soon" }),
  );
  eq(
    out.kind,
    "no-count",
    "and a window we cannot read is refused too, because the rise is only meaningful inside one",
  );
}

// --- judging the pair: it has to RISE ---------------------------------------
{
  const v = judgeBurstCounterProbe(counted(1), counted(2));
  assert(v.ok, "a count that rose between the two reports passes");
  if (v.ok) {
    eq(v.first, 1, "and reports what it read first");
    eq(v.second, 2, "and second");
  }
}
{
  const v = judgeBurstCounterProbe(counted(7), counted(8));
  assert(v.ok, "a counter that already held traffic from an earlier run still passes on the rise");
}
{
  const v = judgeBurstCounterProbe(counted(3), counted(3));
  assert(!v.ok, "a count that did not move is a FAILURE, never a pass");
  if (!v.ok) {
    eq(v.exitCode, VERIFY_EXIT.didNotRise, "with the did-not-rise code");
    assert(/3/.test(v.message), "and the message carries both readings so it can be argued with");
  }
}
{
  const v = judgeBurstCounterProbe(counted(9), counted(4));
  assert(!v.ok, "a count that FELL is a failure too");
  if (!v.ok) eq(v.exitCode, VERIFY_EXIT.didNotRise, "on the same code: the counter is not counting");
}
{
  // The one innocent explanation for a count that did not rise, and the only
  // reason it is safe to retry rather than report: the fixed window rolled
  // between the two reports, so the second reading is the start of a new count
  // rather than evidence of a broken one. It must NOT be reported as
  // did-not-rise, or a run at the top of a minute accuses a healthy counter.
  const v = judgeBurstCounterProbe(counted(5, WINDOW), counted(1, WINDOW + 60_000));
  assert(!v.ok, "two readings from different windows are not a pass");
  if (!v.ok) {
    eq(v.exitCode, VERIFY_EXIT.windowRolled, "they are the window rolling, which is its own outcome");
    assert(
      !/did not rise/i.test(v.message),
      "and the message never accuses the counter of failing to count",
    );
  }
}
{
  // Even a rise across a boundary is not a comparison: the two numbers belong to
  // different counts, so a rise between them proves nothing.
  const v = judgeBurstCounterProbe(counted(1, WINDOW), counted(2, WINDOW + 60_000));
  assert(!v.ok, "a rise measured across two windows is refused rather than believed");
  if (!v.ok) eq(v.exitCode, VERIFY_EXIT.windowRolled, "as a rolled window");
}

// --- a failure on either report is reported as ITSELF -----------------------
{
  const v = judgeBurstCounterProbe({ kind: "binding-missing" }, counted(1));
  assert(!v.ok, "a first report that never counted cannot pass");
  if (!v.ok) {
    eq(v.exitCode, VERIFY_EXIT.bindingMissing, "and exits on the cause it actually met");
    assert(/first/i.test(v.message), "and says which of the two reports failed");
  }
}
{
  const v = judgeBurstCounterProbe(counted(1), { kind: "object-unreachable", detail: "timeout" });
  assert(!v.ok, "a second report that never counted cannot pass either");
  if (!v.ok) {
    eq(v.exitCode, VERIFY_EXIT.objectUnreachable, "on its own cause, not the first report's");
    assert(/second/i.test(v.message), "and says which report failed");
    assert(/timeout/.test(v.message), "and carries the detail the deployment gave");
  }
}
{
  // Two different failures must not be collapsed into one: the FIRST cause met
  // is the one to act on, and answering with the second sends the reader to a
  // deployment problem that is only a consequence (L11).
  const v = judgeBurstCounterProbe({ kind: "unauthorized" }, { kind: "binding-missing" });
  assert(!v.ok, "two broken reports are a failure");
  if (!v.ok) eq(v.exitCode, VERIFY_EXIT.unauthorized, "reported as the first cause met");
}

// --- every outcome the reader can produce has a refusal that fires ----------
{
  // A verdict every outcome can reach means none of them can silently fall
  // through to a pass. Enumerated so an outcome added later is covered by
  // construction rather than by somebody remembering this block (L151).
  const outcomes: ProbeOutcome[] = [
    { kind: "no-answer", detail: "fetch failed" },
    { kind: "unreadable-reply", detail: "HTTP 500" },
    { kind: "unauthorized" },
    { kind: "not-configured" },
    { kind: "endpoint-missing" },
    { kind: "context-unreadable" },
    { kind: "binding-missing" },
    { kind: "object-unreachable", detail: "timeout" },
    { kind: "no-count", detail: "no count field" },
  ];
  const seen = new Set<number>();
  const messages = new Set<string>();
  for (const o of outcomes) {
    const v = judgeBurstCounterProbe(o, counted(2));
    assert(!v.ok, `a ${o.kind} first report is refused`);
    if (!v.ok) {
      seen.add(v.exitCode);
      messages.add(v.message);
      assert(v.message.trim().length > 20, `and ${o.kind} says something a reader can act on`);
    }
  }
  eq(seen.size, outcomes.length, "each outcome exits on its own code, none borrowing another's");
  eq(messages.size, outcomes.length, "and each says its own thing, so no message answers for another");
}

// --- not starting in the last moments of a window ---------------------------
{
  // The rolled window above is a refusal nobody can act on, so the cheap thing is not to walk
  // into it. Waiting is the honest fix: a tolerance that forgave a fallen count as "probably a
  // rollover" would forgive the exact failure this command exists to catch (L253).
  const window = 60_000;
  const margin = 5_000;
  eq(msToWaitForWindow(window * 10, window, margin), 0, "a window that has just begun is fine");
  eq(
    msToWaitForWindow(window * 10 + 30_000, window, margin),
    0,
    "and so is the middle of one",
  );
  eq(
    msToWaitForWindow(window * 10 + 57_000, window, margin),
    3_000,
    "three seconds from the boundary, it waits out the rest of the window",
  );
  eq(
    msToWaitForWindow(window * 10 + 55_001, window, margin),
    4_999,
    "and the wait always lands in the NEXT window rather than just inside this one",
  );
  assert(
    msToWaitForWindow(window * 10 + 55_000, window, margin) === 0,
    "exactly one margin of headroom is enough, so the wait is not paid on every run",
  );
}

// --- the documented exits are the shipped ones ------------------------------
{
  // docs/verify-commands.md tells a reader what each non-zero exit MEANS, which is the whole
  // reason the codes are worth having: a table nobody checks becomes more trusted the longer it
  // sits there, not less (L210, L244). Derived from the section itself rather than from "the only
  // table in the file", so a second table added later cannot answer for this one.
  // The section moved out of AGENTS.md in #2393, which is loaded into every session and pays for
  // an exit code table on every request; AGENTS.md keeps the rule and points here.
  const doc = readFileSync(join(import.meta.dirname, "..", "docs/verify-commands.md"), "utf8");
  const heading = "# Proving the burst counter answers";
  const start = doc.indexOf(heading);
  assert(start !== -1, "docs/verify-commands.md documents the command");
  const rest = doc.slice(start + heading.length);
  const nextHeading = rest.indexOf("\n# ");
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  assert(
    section.includes("pnpm verify:burst-counter"),
    "and says how to run it, by the name package.json actually wires",
  );
  // This used to assert the section told a READER to re-run the command after a burst path
  // change. That instruction is exactly what #2392 was about: it was here, in bold, and the
  // path moved five times with nobody running it, because a rule that lives only in a prompt
  // is a hope (L27). A scheduled lane does it now, so the guard asks for what actually holds.
  assert(
    /burst-counter\.yml/.test(section),
    "and names the scheduled workflow that runs it, since asking a person to remember did not work",
  );
  assert(
    /verdict:burst-counter/.test(section),
    "and names the verdict lane it stamps, which is what pages when the proof stops happening",
  );
  assert(
    /only a run that measured/i.test(section),
    "and says that only a MEASURED verdict may stamp, which is the difference between this and a " +
      "heartbeat recording that the workflow ran",
  );

  const documented = new Set<number>();
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) documented.add(Number(m[1]));
  }
  const shipped = new Set<number>(Object.values(VERIFY_EXIT));
  eq(
    [...documented].sort((a, b) => a - b).join(","),
    [...shipped].sort((a, b) => a - b).join(","),
    "every exit code the command can produce is documented, and nothing is documented that it " +
      "cannot produce",
  );

  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const wired = pkg.scripts?.["verify:burst-counter"] ?? "";
  assert(
    wired.includes("scripts/verify-burst-counter-live.ts"),
    "and the documented command really runs the live script (a doc naming a script nobody " +
      "wired is an instruction that silently does nothing)",
  );
  assert(
    !wired.includes("scripts/test-"),
    "which is deliberately not named test-*.ts: that glob is the offline suite, and this one " +
      "talks to a live deployment",
  );
}

finish();
