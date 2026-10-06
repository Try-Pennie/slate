// The shared confirm line LIVE positive control (#3340), driven offline. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-confirm-line-live-control.ts
//
// Why this exists. The confirm path falls back to the isolate's own line whenever the
// shared one cannot be used (#3325), so an object that is bound and does not answer
// reads as healthy until a crowd arrives and stampedes the database again, exactly as
// in load run 37333201026. Nothing between load runs asked the object anything (L557).
// `pnpm verify:confirm-line` does, through `POST /api/smoke/confirm-line`, which drives
// the PRODUCTION client (`makeSharedConfirmLine`) against the real object.
//
// This file drives that probe against the REAL object host (`makeConfirmLineHost`) on a
// virtual clock, and then against a planted defect for every outcome the probe can
// name, so no outcome in its contract is one nothing has ever produced (L151). The live
// run then has only one question left that a fixture cannot answer: does the deployed
// object behave like this one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIRM_LINE_VERIFY_GROUP,
  CONFIRM_LINE_PROBE_REASON,
  CONFIRM_LINE_CHECKS,
  CHECK_OUTCOMES,
  CHECK_CAN_END_ON,
  PROBE_FOLLOWER_WAIT_MS,
  ABANDONED_LEAD_FREED_WITHIN_MS,
  VERDICT_REACHES_FOLLOWER_WITHIN_MS,
  PROBE_SWITCH,
  runConfirmLineProbe,
  judgeHandOn,
  type ConfirmLineCheck,
  type CheckOutcome,
  type ProbeReport,
} from "../src/lib/monitor/confirm-line-probe.ts";
import {
  CONFIRM_LINE_EXIT,
  readConfirmLineOutcome,
  judgeConfirmLineProbe,
  type ProbeOutcome,
} from "./lib/confirm-line-live-control.ts";
import {
  makeConfirmLineHost,
  CONFIRM_LINE_ACK_MS,
  CONFIRM_LINE_LEASE_MS,
  CONFIRM_LINE_HEARTBEAT_MS,
  CONFIRM_LINE_PROTOCOL,
} from "../src/lib/booking/confirm-line-object.ts";
import { keyKindOf, CONFIRM_LINE_CALL_MS, type LineNamespace } from "../src/lib/booking/shared-confirm-line.ts";
import { ladderGroupOf } from "../src/lib/booking/line-key.ts";
import { confirmQueueKey } from "../src/lib/booking/orchestration.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
type Message = Record<string, unknown>;
type Send = (message: Message) => Promise<Message>;
const tick = () => new Promise((r) => setImmediate(r));
/** Printable ASCII only, so no dash or emoji can reach a message (written as a range, not a literal). */
const PLAIN = /^[\x20-\x7E\n]*$/;

/** A virtual clock, the real object host, and a transport that can be swapped for a defect. */
function world() {
  let now = 50_000;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  let ids = 0;
  const newId = () => `id${++ids}`;
  const newHost = () => makeConfirmLineHost({ now: () => now, timer, leaseTimer: timer, newId });
  const host = newHost();
  const handle = async (h: ReturnType<typeof newHost>, m: Message) => JSON.parse(await h.handle(m)) as Message;
  const groups: string[] = [];
  const instants = new Set<string>();
  let send: Send = (m) => handle(host, m);
  const namespace: LineNamespace = {
    stubFor(group) {
      groups.push(group);
      return {
        send(message) {
          if (message.op === "enter" && typeof message.line === "string") instants.add(message.line);
          return send(message);
        },
      };
    },
  };
  const run = async (ns: LineNamespace = namespace): Promise<ProbeReport | "unsettled"> => {
    let out: ProbeReport | "unsettled" = "unsettled";
    let settled = false;
    void runConfirmLineProbe({ namespace: ns, now: () => now, timer, newId }).then((r) => {
      out = r;
      settled = true;
    });
    for (let spent = 0; !settled && spent < 90_000; spent += 25) {
      const until = now + 25;
      for (;;) {
        await tick();
        const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.live = false;
        due.fire();
      }
      now = until;
    }
    await tick();
    return out;
  };
  return {
    host,
    newHost,
    handle,
    timer,
    newId,
    now: () => now,
    groups,
    instants,
    namespace,
    run,
    setSend(next: Send) {
      send = next;
    },
  };
}

const outcomes = (r: ProbeReport | "unsettled") =>
  r === "unsettled" ? "unsettled" : CONFIRM_LINE_CHECKS.map((c) => `${c}=${r[c].outcome}`).join(" ");

// --- the group the probe writes into cannot be a real line's ------------------------
{
  // The probe WRITES to a real object: it takes leads, queues and verdicts. Landing on
  // a real line would put a phantom leader in front of real confirms, or hand a real
  // follower a "taken" it never earned. A real group is `link:`, `code:` or `ladder:`
  // followed by something, and the Durable Object is named from the whole group, so the
  // prefix is the entire separation. `keyKindOf` is the production reading of exactly
  // those three prefixes, so the verification group must read as none of them.
  eq(keyKindOf(CONFIRM_LINE_VERIFY_GROUP), "none", "the verification group is none of the real line kinds");
  assert(CONFIRM_LINE_VERIFY_GROUP.startsWith("monitor:"), "and it is in the monitor space, which nothing in the booking path writes");

  // Walk the one constructor every real line key comes from (`confirmQueueKey`), with
  // inputs chosen to TRY to land on the verification group: the group itself as a code
  // and as an advisor id, a code that already starts with monitor:, and the ladder
  // grouping fed pool keys that spell it.
  const hostile = [CONFIRM_LINE_VERIFY_GROUP, "monitor:", "monitor:x", "", "521", "510", "100"];
  const peeks: ((code: string) => string | null | undefined)[] = [
    () => undefined,
    () => null,
    () => CONFIRM_LINE_VERIFY_GROUP,
    (code) => `pool:${code}`,
  ];
  let walked = 0;
  for (const code of hostile) {
    for (const link of [undefined, ...hostile]) {
      for (const peek of peeks) {
        for (const lineGroupOf of [undefined, (c: string) => ladderGroupOf(c, peek)]) {
          const key = confirmQueueKey(code, "2026-10-06T14:00:00.000Z", link, lineGroupOf);
          walked++;
          if (keyKindOf(key.group) === "none" || key.group === CONFIRM_LINE_VERIFY_GROUP) {
            assert(false, `confirmQueueKey(${JSON.stringify(code)}, ${JSON.stringify(link)}) built ${key.group}, which is not a real line kind`);
          }
        }
      }
    }
  }
  assert(walked > 300, `every real line key the walk built is a link, code or ladder group (${walked} built)`);
  {
    // Control: the walk would have noticed. A constructor that passed the code through
    // bare would build the verification group from the first hostile input.
    const bare = (code: string) => ({ group: code, instant: "1" });
    assert(keyKindOf(bare(CONFIRM_LINE_VERIFY_GROUP).group) === "none", "control: a group built without a kind prefix is caught by the same reading");
  }

  // The walk covers `confirmQueueKey` and the ladder grouping. What wires them in
  // production is read off the source, comments stripped so a comment ABOUT the wiring
  // cannot answer for it (L103).
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const service = strip(readFileSync(join(ROOT, "src/lib/booking/service.ts"), "utf8"));
  assert(/lineGroupOf:\s*lineGroupOfLive\b/.test(service), "the booking service groups lines with lineGroupOfLive");
  const live = strip(readFileSync(join(ROOT, "src/lib/booking/confirm-line-live.ts"), "utf8"));
  const body = live.slice(live.indexOf("export function lineGroupOfLive"));
  assert(/=\s*ladderGroupOf\(/.test(body) && /return group;/.test(body), "and lineGroupOfLive answers only what ladderGroupOf built, or null");
  const orchestration = strip(readFileSync(join(ROOT, "src/lib/booking/orchestration.ts"), "utf8"));
  const built = [...orchestration.matchAll(/\{\s*group\s*,\s*instant\s*:/g)].length;
  eq(built, 1, "and confirmQueueKey is the one place the booking path builds a line key, so the walk above covers them all");
}

// --- the timing constants the checks rest on, and why each sits where it does -------
{
  assert(
    ABANDONED_LEAD_FREED_WITHIN_MS > CONFIRM_LINE_ACK_MS,
    "an abandoned lead is judged after its acknowledgement window, never inside it",
  );
  assert(
    ABANDONED_LEAD_FREED_WITHIN_MS < CONFIRM_LINE_LEASE_MS,
    "and well before its lease, so a lead freed only by the lease is told apart from one freed by the window",
  );
  assert(
    PROBE_FOLLOWER_WAIT_MS > CONFIRM_LINE_LEASE_MS + CONFIRM_LINE_CALL_MS,
    "the follower waits past the lease, so a lead freed late is seen as late rather than as never",
  );
  // The leader's client retries a report once, so a verdict whose first send was lost
  // still hands on by the verdict, within two calls of that first send. Anything later is
  // a lease, and the earliest a lease can end after the report leaves is the lease less
  // one heartbeat (the last renewal can be up to a heartbeat before the report).
  eq(VERDICT_REACHES_FOLLOWER_WITHIN_MS, 2 * CONFIRM_LINE_CALL_MS, "a verdict reaches the follower within the report's own two calls");
  assert(
    VERDICT_REACHES_FOLLOWER_WITHIN_MS < CONFIRM_LINE_LEASE_MS - CONFIRM_LINE_HEARTBEAT_MS,
    "which is before the earliest a lease can end after the report leaves, so a hand on by the lease is never read as one by the verdict",
  );
  // The probe never reads the stored switch: the switch decides real confirms, and a
  // probe that stood down whenever it was off would prove nothing while the line is off.
  eq(PROBE_SWITCH.on, true, "the probe uses the shared line whatever the stored switch says");
}

async function main() {
  // --- the real host: every check passes, and the probe touches only its own group ---
  {
    const w = world();
    const report = await w.run();
    assert(report !== "unsettled", "the probe finishes against the real host");
    if (report !== "unsettled") {
      for (const check of CONFIRM_LINE_CHECKS) {
        eq(report[check].outcome, "passed", `real host: ${check} passes (${report[check].detail})`);
        assert(PLAIN.test(report[check].detail) && report[check].detail.length > 20, `real host: ${check} says what it saw, in plain words`);
      }
    }
    assert(w.groups.length > 0, "the probe reached the object");
    assert(
      w.groups.every((g) => g === CONFIRM_LINE_VERIFY_GROUP),
      `and every object it addressed is the verification group's (got ${[...new Set(w.groups)].join(", ")})`,
    );
    eq(w.instants.size, 3, "it used one instant per check, each its own");
    // Nothing left held, checked by THIS file against the host directly rather than by
    // the probe's own last check, which uses the same client it is checking (L345).
    for (const instant of w.instants) {
      const a = await w.handle(w.host, { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: w.newId(), line: instant, waitMs: 0 });
      eq(a.kind, "lead", `afterwards, ${instant} is idle on the host: a newcomer leads at once`);
      if (typeof a.turn === "string") await w.handle(w.host, { v: CONFIRM_LINE_PROTOCOL, op: "done", turn: a.turn, verdict: { full: false } });
    }
  }

  // --- a planted defect for every outcome the probe can name (L151) ------------------
  const produced = new Map<ConfirmLineCheck, Set<CheckOutcome>>(CONFIRM_LINE_CHECKS.map((c) => [c, new Set(["passed" as CheckOutcome])]));
  const plant = async (name: string, defect: (w: ReturnType<typeof world>) => Send | null, expect: Partial<Record<ConfirmLineCheck, CheckOutcome>>, ns?: LineNamespace) => {
    const w = world();
    const send = defect(w);
    if (send) w.setSend(send);
    const report = await w.run(ns);
    assert(report !== "unsettled", `${name}: the probe still finishes`);
    if (report === "unsettled") return;
    for (const [check, outcome] of Object.entries(expect) as [ConfirmLineCheck, CheckOutcome][]) {
      eq(report[check].outcome, outcome, `${name}: ${check} ends ${outcome} (${report[check].detail})`);
      assert(PLAIN.test(report[check].detail), `${name}: ${check}'s detail is plain words`);
    }
    for (const check of CONFIRM_LINE_CHECKS) produced.get(check)?.add(report[check].outcome);
    assert(!CONFIRM_LINE_CHECKS.every((c) => report[c].outcome === "passed"), `${name}: the defect is not reported as a healthy line (${outcomes(report)})`);
  };
  const v = CONFIRM_LINE_PROTOCOL;

  // Unreachable: the object refuses every call, so the client falls back to the isolate's
  // own line, which is the state the per isolate fallback hides in production.
  await plant(
    "unreachable",
    () => async () => {
      throw new Error("the object refused");
    },
    { full: "unreachable", notFull: "unreachable", abandoned: "unreachable", nothingHeld: "unreachable" },
  );

  // Every call reaches a DIFFERENT instance: the failure #3325 exists to end, one line
  // per isolate. Every second confirm leads beside the first.
  await plant("a new instance per call", (w) => (m) => w.handle(w.newHost(), m), { full: "led-beside", notFull: "led-beside", abandoned: "led-beside" });

  // A full verdict that does not settle the followers.
  await plant(
    "a full verdict read as not full",
    (w) => (m) => w.handle(w.host, m.op === "done" ? { ...m, verdict: { full: false } } : m),
    { full: "not-settled", notFull: "passed", abandoned: "passed", nothingHeld: "passed" },
  );

  // A not full verdict that settles them anyway.
  await plant(
    "a not full verdict read as full",
    (w) => (m) =>
      w.handle(w.host, m.op === "done" && (m.verdict as Message | undefined)?.full === false ? { ...m, verdict: { full: true, refusal: "taken", settled: null } } : m),
    { full: "passed", notFull: "not-handed-on", abandoned: "passed" },
  );

  // The verdict never arrives, so the follower is freed only by the leader's lease.
  await plant(
    "a report that never reaches the object",
    (w) => (m) => (m.op === "done" ? Promise.resolve({ ok: true }) : w.handle(w.host, m)),
    { full: "not-settled", notFull: "not-handed-on", nothingHeld: "held" },
  );

  // The same lost verdict, sent late in the lease. Every enter answers just inside its
  // deadline, so most of the leader's lease is spent before it reports, and the report
  // is lost both times the client tries it, which takes two call deadlines. The lease
  // then frees the follower moments after the report call gives up. The hand on is timed
  // from when the verdict was SENT: timed from the report call's RETURN, a lease running
  // out reads as a prompt hand on.
  await plant(
    "a lost verdict sent late in the lease",
    (w) => async (m) => {
      if (m.op === "done") return new Promise<Message>(() => {});
      const a = await w.handle(w.host, m);
      if (m.op === "enter") await new Promise<void>((r) => w.timer(CONFIRM_LINE_CALL_MS - 50, r));
      return a;
    },
    { notFull: "not-handed-on" },
  );

  // No acknowledgement window: something acks every lead on the caller's behalf, so an
  // abandoned leader holds the line for a whole lease.
  await plant(
    "a lead acknowledged by nobody's caller",
    (w) => async (m) => {
      const a = await w.handle(w.host, m);
      if (a.kind === "lead" && typeof a.turn === "string") await w.handle(w.host, { v, op: "ack", turn: a.turn });
      return a;
    },
    { full: "passed", notFull: "passed", abandoned: "freed-late" },
  );

  // A lead kept alive forever: every call renews every lead the object ever granted.
  await plant(
    "a lead nothing lets go of",
    (w) => {
      const granted = new Set<string>();
      return async (m) => {
        for (const turn of granted) {
          const r = await w.handle(w.host, { v, op: "renew", turn });
          if (r.kind === "gone") granted.delete(turn);
        }
        const a = await w.handle(w.host, m);
        if (a.kind === "lead" && typeof a.turn === "string") granted.add(a.turn);
        return a;
      };
    },
    { abandoned: "not-freed" },
  );

  // An instant nobody has used is already held, so the first confirm cannot lead.
  await plant(
    "a line already held",
    (w) => {
      const seen = new Set<string>();
      return async (m) => {
        if (m.op === "enter" && typeof m.line === "string" && !seen.has(m.line)) {
          seen.add(m.line);
          const p = await w.handle(w.host, { v, op: "enter", attempt: w.newId(), line: m.line, waitMs: 0 });
          if (typeof p.turn === "string") await w.handle(w.host, { v, op: "ack", turn: p.turn });
        }
        return w.handle(w.host, m);
      };
    },
    { full: "idle-not-led", notFull: "idle-not-led", abandoned: "idle-not-led" },
  );

  // The probe's own code throwing, which is never a finding about the object.
  await plant(
    "a transport that cannot be built",
    () => null,
    { full: "errored", notFull: "errored", abandoned: "errored", nothingHeld: "errored" },
    {
      stubFor() {
        throw new Error("no stub for that group");
      },
    },
  );

  for (const check of CONFIRM_LINE_CHECKS) {
    const declared = [...CHECK_CAN_END_ON[check]].sort();
    const seen = [...(produced.get(check) ?? [])].sort();
    eq(seen.join(","), declared.join(","), `${check}: every outcome it declares was produced by some planted defect, and it produced nothing it does not declare`);
  }
  eq(
    [...new Set(CONFIRM_LINE_CHECKS.flatMap((c) => [...CHECK_CAN_END_ON[c]]))].sort().join(","),
    [...CHECK_OUTCOMES].sort().join(","),
    "and every outcome in the vocabulary belongs to some check",
  );

  // --- the hand on is timed from when the report LEFT the leader ---------------------
  // The leader's client retries a report that is not answered within one call, so the
  // report can return long after the line was handed on. Timed from its return, a hand on
  // that took a second and a half reads as instant (review of #3340).
  const millis = (detail: string) => Number(detail.match(/(\d+)ms/)?.[1] ?? NaN);
  {
    // The first report reaches the object 1500ms after it was sent, past one call, so the
    // client gives up on it and sends a second; the follower leads at 1500ms, while the
    // report is still being awaited. That is the verdict handing on inside the report's own
    // two calls, so it passes, and it must be measured as the 1500ms it took.
    const w = world();
    const later = (ms: number) => new Promise<void>((resolve) => w.timer(ms, () => resolve()));
    w.setSend(async (m) => {
      if (m.op === "done") await later(1500);
      return w.handle(w.host, m);
    });
    const report = await w.run();
    assert(report !== "unsettled", "a slow report: the probe finishes");
    if (report !== "unsettled") {
      eq(report.notFull.outcome, "passed", `a slow report: a verdict that arrived late, inside the report's two calls, still handed the line on (${report.notFull.detail})`);
      const ms = millis(report.notFull.detail);
      assert(ms >= 1450 && ms <= 1600, `and the time it measures is the hand on's own, about 1500ms, not zero (measured ${ms}ms)`);
      eq(report.full.outcome, "passed", "a slow report: the full verdict still refuses the follower, since that check has no clock");
    }
  }
  {
    // The counterpart: the object acts on the report at once and only its ANSWER is late.
    // The hand on lands during the report await, and is measured as the instant it was.
    const w = world();
    const later = (ms: number) => new Promise<void>((resolve) => w.timer(ms, () => resolve()));
    w.setSend(async (m) => {
      const answer = await w.handle(w.host, m);
      if (m.op === "done") await later(600);
      return answer;
    });
    const report = await w.run();
    assert(report !== "unsettled", "a slow answer: the probe finishes");
    if (report !== "unsettled") {
      eq(report.notFull.outcome, "passed", `a slow ANSWER to a report the object acted on at once is a prompt hand on (${report.notFull.detail})`);
      const ms = millis(report.notFull.detail);
      assert(ms >= 0 && ms <= 50, `and it measures the hand on from the report leaving, not from the answer coming back (measured ${ms}ms)`);
    }
  }
  {
    // The decision itself, at its edges, including the one the probe's own sequencing makes
    // rare: a follower led BEFORE the report left, which no verdict can explain.
    eq(judgeHandOn(5_000, 5_000).outcome, "passed", "a hand on at the moment the report left is prompt");
    eq(judgeHandOn(5_000 + VERDICT_REACHES_FOLLOWER_WITHIN_MS, 5_000).outcome, "passed", "and so is one exactly the report's two calls after");
    eq(judgeHandOn(5_001 + VERDICT_REACHES_FOLLOWER_WITHIN_MS, 5_000).outcome, "not-handed-on", "one past that is a lease, not the verdict");
    const early = judgeHandOn(4_900, 5_000);
    eq(early.outcome, "led-beside", "a follower led before the report left was led beside a holder, never clamped to a prompt hand on");
    eq(millis(early.detail), 100, "and says by how much");
  }

  // --- reading the endpoint's reply ------------------------------------------------
  const allPassed = Object.fromEntries(CONFIRM_LINE_CHECKS.map((c) => [c, { outcome: "passed", detail: `${c} answered as the rules say` }]));
  const reply = (checks: unknown, reason: string = CONFIRM_LINE_PROBE_REASON.checked) => JSON.stringify({ reason, group: CONFIRM_LINE_VERIFY_GROUP, checks });
  {
    const out = readConfirmLineOutcome(200, reply(allPassed));
    eq(out.kind, "checked", "a checked reply is read as checked");
    const v0 = judgeConfirmLineProbe(out);
    assert(v0.ok, "and four passed checks are the one pass");
    eq(v0.ok ? 0 : v0.exitCode, CONFIRM_LINE_EXIT.passed, "on exit 0");
  }
  {
    const missing = { ...allPassed } as Record<string, unknown>;
    delete missing.abandoned;
    const out = readConfirmLineOutcome(200, reply(missing));
    eq(out.kind, "incomplete", "a reply missing a check is incomplete, never a pass on the three it carried (L98)");
    assert(out.kind === "incomplete" && out.detail.includes("abandoned"), "and names the check it is missing");
  }
  {
    const wrong = { ...allPassed, notFull: { outcome: "freed-late", detail: "x" } };
    eq(readConfirmLineOutcome(200, reply(wrong)).kind, "incomplete", "an outcome that check can never end on is not believed");
    const unknown = { ...allPassed, full: { outcome: "probably-fine", detail: "x" } };
    eq(readConfirmLineOutcome(200, reply(unknown)).kind, "incomplete", "nor is one this command does not know");
    const noDetail = { ...allPassed, full: { outcome: "passed" } };
    eq(readConfirmLineOutcome(200, reply(noDetail)).kind, "incomplete", "nor a check with no words about what it saw");
  }
  eq(readConfirmLineOutcome(503, JSON.stringify({ reason: CONFIRM_LINE_PROBE_REASON.bindingMissing })).kind, "binding-missing", "a missing binding is its own outcome");
  eq(readConfirmLineOutcome(503, JSON.stringify({ reason: CONFIRM_LINE_PROBE_REASON.contextUnreadable })).kind, "context-unreadable", "an unreadable context is not a missing binding");
  eq(readConfirmLineOutcome(503, JSON.stringify({ error: "booking api not configured" })).kind, "not-configured", "a 503 with no reason of ours is the endpoint disabled");
  eq(readConfirmLineOutcome(401, JSON.stringify({ error: "unauthorized" })).kind, "unauthorized", "a refused key is its own outcome");
  eq(readConfirmLineOutcome(404, "<html>not found</html>").kind, "endpoint-missing", "a 404 is a deployment older than the endpoint");
  eq(readConfirmLineOutcome(500, "<html>error 1101</html>").kind, "unreadable-reply", "a reply this endpoint never produces is refused, not guessed at");
  eq(readConfirmLineOutcome(200, JSON.stringify({ reason: "checked" })).kind, "incomplete", "a checked reply with no checks at all is incomplete");

  // --- judging: every ending on its own code and its own sentence (L11) -------------
  {
    const codes = Object.entries(CONFIRM_LINE_EXIT).filter(([n]) => n !== "passed").map(([, c]) => c);
    eq(new Set(codes).size, codes.length, "every refusal has its own exit code");
    assert(codes.every((c) => c > 0), "and none of them is zero, so no refusal can read as a pass");

    const failing = (check: ConfirmLineCheck, outcome: CheckOutcome): ProbeOutcome => ({
      kind: "checked",
      checks: { ...(allPassed as Record<ConfirmLineCheck, { outcome: CheckOutcome; detail: string }>), [check]: { outcome, detail: `what ${check} saw` } },
    });
    const endings: ProbeOutcome[] = [
      { kind: "no-answer", detail: "fetch failed" },
      { kind: "unreadable-reply", detail: "HTTP 500" },
      { kind: "unauthorized" },
      { kind: "not-configured" },
      { kind: "endpoint-missing" },
      { kind: "context-unreadable" },
      { kind: "binding-missing" },
      { kind: "incomplete", detail: "no abandoned check" },
    ];
    for (const check of CONFIRM_LINE_CHECKS) {
      for (const outcome of CHECK_CAN_END_ON[check]) if (outcome !== "passed") endings.push(failing(check, outcome));
    }
    const byCode = new Map<number, Set<string>>();
    const messages = new Set<string>();
    for (const e of endings) {
      const verdict = judgeConfirmLineProbe(e);
      assert(!verdict.ok, `${JSON.stringify(e).slice(0, 80)} is refused`);
      if (verdict.ok) continue;
      assert(verdict.message.trim().length > 40 && PLAIN.test(verdict.message), `exit ${verdict.exitCode} says something a reader can act on, in plain words`);
      if (!byCode.has(verdict.exitCode)) byCode.set(verdict.exitCode, new Set());
      byCode.get(verdict.exitCode)!.add(verdict.message.split("\n")[0] as string);
      messages.add(verdict.message.split("\n")[0] as string);
    }
    const reached = [...byCode.keys()].sort((a, b) => a - b);
    const declared = Object.values(CONFIRM_LINE_EXIT).filter((c) => c !== CONFIRM_LINE_EXIT.passed && c !== CONFIRM_LINE_EXIT.misconfigured).sort((a, b) => a - b);
    eq(reached.join(","), declared.join(","), "every exit code but the two decided before anything is asked is reached by some ending, and nothing else is");
    eq(messages.size, [...byCode.values()].reduce((n, s) => n + s.size, 0), "and no two codes share an opening sentence");
    for (const [code, firsts] of byCode) {
      eq(firsts.size, 1, `exit ${code} always opens with the same sentence, so a reader learns one meaning per code`);
    }

    // The worst finding names the run, and the others are still said.
    const two: ProbeOutcome = {
      kind: "checked",
      checks: {
        ...(allPassed as Record<ConfirmLineCheck, { outcome: CheckOutcome; detail: string }>),
        abandoned: { outcome: "freed-late", detail: "freed after 4100ms" },
        full: { outcome: "led-beside", detail: "led at once" },
      },
    };
    const both = judgeConfirmLineProbe(two);
    assert(!both.ok && both.exitCode === CONFIRM_LINE_EXIT.ledBeside, "a line that excludes nobody outranks a lead freed late");
    assert(!both.ok && both.message.includes("4100ms"), "and the lesser finding is still in the message, so it is not lost behind the worse one");
    const unreachableToo = judgeConfirmLineProbe({
      kind: "checked",
      checks: { ...two.checks, notFull: { outcome: "unreachable", detail: "reach-timeout" } },
    });
    assert(!unreachableToo.ok && unreachableToo.exitCode === CONFIRM_LINE_EXIT.objectUnreachable, "and an object that did not answer outranks everything it answered wrongly");
  }

  // --- the documented exits are the shipped ones (L210) --------------------------------
  {
    const doc = readFileSync(join(ROOT, "docs/verify-commands.md"), "utf8");
    const heading = "# Proving the shared confirm line answers";
    const start = doc.indexOf(heading);
    assert(start !== -1, "docs/verify-commands.md documents the command");
    const rest = doc.slice(start + heading.length);
    const next = rest.indexOf("\n# ");
    const section = next === -1 ? rest : rest.slice(0, next);
    assert(section.includes("pnpm verify:confirm-line"), "and says how to run it, by the name package.json wires");
    assert(/burst-counter\.yml/.test(section), "and names the scheduled workflow that runs it");
    assert(/verdict:confirm-line/.test(section), "and the verdict lane it stamps");
    assert(/only a run that measured/i.test(section), "and that only a MEASURED verdict may stamp");
    assert(/cannot prove/i.test(section) && /isolates/i.test(section) && /load run/i.test(section), "and says plainly that it cannot prove two isolates share one object, which only the load run can");
    const documented = new Set<number>();
    for (const line of section.split("\n")) {
      const m = line.match(/^\|\s*(\d+)\s*\|/);
      if (m) documented.add(Number(m[1]));
    }
    eq(
      [...documented].sort((a, b) => a - b).join(","),
      Object.values(CONFIRM_LINE_EXIT).sort((a, b) => a - b).join(","),
      "every exit code the command can end on is documented, and nothing it cannot end on",
    );
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    assert(/`verify:confirm-line`/.test(agents), "AGENTS.md lists the command beside the burst counter's");

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const wired = pkg.scripts?.["verify:confirm-line"] ?? "";
    assert(wired.includes("scripts/verify-confirm-line-live.ts"), "the documented command really runs the live script");
    assert(!wired.includes("scripts/test-"), "which is not named test-*.ts, because it talks to a live deployment");
  }

  // --- the route takes nothing from the request, and never asks the switch ------------
  {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip(readFileSync(join(ROOT, "src/app/api/smoke/confirm-line/route.ts"), "utf8"));
    assert(/runConfirmLineProbe\(/.test(route), "the route runs the probe this file drives");
    assert(/durableLineNamespace\(/.test(route), "through the production transport");
    assert(/CANARY_CALLERS/.test(route) && /authenticateBearer\(/.test(route), "behind the canary's own Bearer key, like the burst counter's endpoint");
    assert(!/\.json\(\)|searchParams|formData|req\.text/.test(route), "and reads nothing from the request, so no caller can name a group or an instant");
    assert(!/readSharedConfirmLine|shared-line-switch/.test(route), "and never reads the stored switch, which decides real confirms rather than this probe");
  }

  finish();
}

void main();
