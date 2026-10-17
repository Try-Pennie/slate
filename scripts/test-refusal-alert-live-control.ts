// #1726: the decision logic of `scripts/verify-refusal-alerts-live.ts`, pinned offline. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-refusal-alert-live-control.ts
//
// The live command writes the booking refusal tally under a monitor only key, reads
// the row back, and requires every refusal alert's verdict to move from a measured
// clear to paging and its message to render. Every way of learning nothing exits on
// its own code. A fake cannot stand in for the live store (L52), which is why that
// half is a command; what it DECIDES from what it read is driven here with fixtures,
// so a live run is only ever spent on the question a fixture cannot answer.
import {
  PROBE_BUCKET,
  PROBE_SIGNALS,
  VERIFY_EXIT,
  bumpsForInterval,
  judgeProbeRun,
  probeNames,
  renderable,
  type ProbeRun,
  type ProbeSignal,
} from "./lib/refusal-alert-live-control.ts";
import { INPUT_LIMITS } from "../src/lib/booking/input-limits.ts";
import { bucketCodeSchema } from "../src/lib/booking/input-schema.ts";
import {
  CEILING_ALERT_KEY,
  CREDENTIAL_ALERT_KEY,
  EMBED_CONTACT_CAP_ALERT_KEY,
  EMBED_HONEYPOT_ALERT_KEY,
  EMBED_IP_CAP_ALERT_KEY,
  LIST_ALERT_KEY,
  SHIPPED_REFUSAL_THRESHOLDS,
} from "../src/lib/monitor/api-refusal-signals.ts";
import { SHIPPED_EMBED_REFUSAL_THRESHOLDS } from "../src/lib/monitor/embed-refusal-thresholds.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const START = Date.UTC(2026, 9, 16, 15, 0, 0);

/** What a healthy run reads: the row rising by exactly what was written. */
function healthyRun(base = 0): ProbeRun {
  const names = probeNames();
  const at = (extra: Record<string, number>) => Object.fromEntries(names.map((n) => [n, base + (extra[n] ?? 0)]));
  const cum: Record<string, number> = {};
  const readings = [at({}), at({})];
  for (const k of [0, 1, 2]) {
    for (const [n, c] of Object.entries(bumpsForInterval(k))) cum[n] = (cum[n] ?? 0) + c;
    readings.push(at({ ...cum }));
  }
  return {
    day: "2026-10-16",
    startMs: START,
    readings,
    mixCarried: Object.fromEntries(names.map((n) => [n, true])),
    lockouts: { addresses: 0, contactKeys: 0 },
  };
}

// --------------------------------------------- the key no caller can produce

{
  assert(PROBE_BUCKET.length > INPUT_LIMITS.code, "the probe bucket is longer than any bucket code a request may carry");
  assert(PROBE_BUCKET.length > 16, "and longer than the raw body code the booker records, which is cut to sixteen");
  eq(bucketCodeSchema.safeParse(PROBE_BUCKET).success, false, "the bucket code schema itself refuses it");
  // Positive control: the schema does accept a real code, so the refusal above is
  // about the probe's key and not a schema that refuses everything.
  eq(bucketCodeSchema.safeParse("411").success, true, "positive control: a real code passes the same schema");
}

// ------------------------------------------- every refusal alert is covered

{
  eq(
    [...new Set(PROBE_SIGNALS.map((s) => s.alertKey))].sort(),
    [
      CEILING_ALERT_KEY,
      CREDENTIAL_ALERT_KEY,
      EMBED_CONTACT_CAP_ALERT_KEY,
      EMBED_HONEYPOT_ALERT_KEY,
      EMBED_IP_CAP_ALERT_KEY,
      LIST_ALERT_KEY,
    ].sort(),
    "the probe exercises every booking refusal alert, the API's three and the booker's three",
  );
  // The writes reach each SHIPPED floor, so a raised floor fails here rather than
  // turning the live run into a verdict that can never page.
  const total = (id: string) => PROBE_SIGNALS.find((s) => s.id === id)!.bumps.reduce((a, b) => a + b, 0);
  const spreadOf = (id: string) => PROBE_SIGNALS.find((s) => s.id === id)!.bumps.filter((b) => b > 0).length;
  assert(total("ceiling") >= SHIPPED_REFUSAL_THRESHOLDS.ceilingMinRefusals, "the ceiling probe reaches its refusal floor");
  assert(spreadOf("credential rejected") >= SHIPPED_REFUSAL_THRESHOLDS.credentialMinSamples, "the credential probe spans its intervals");
  assert(spreadOf("list read") >= SHIPPED_REFUSAL_THRESHOLDS.listMinSamples, "the list probe spans its intervals");
  assert(total("embed honeypot") >= SHIPPED_EMBED_REFUSAL_THRESHOLDS.honeypotMinTrips, "the honeypot probe reaches its trip floor");
  assert(spreadOf("embed honeypot") >= SHIPPED_EMBED_REFUSAL_THRESHOLDS.honeypotMinIntervals, "and spans its intervals");
}

// ---------------------------------------------------------- a healthy run

{
  const v = judgeProbeRun(healthyRun());
  assert(v.ok, `a run whose row rose by what was written and whose verdicts moved passes${v.ok ? "" : `: ${v.message}`}`);
  const leftover = judgeProbeRun(healthyRun(40));
  assert(leftover.ok, "rows left by an earlier run are a baseline, not a failure: only the delta is judged");
}

// ------------------------------------------- each way of learning nothing

{
  const short = healthyRun();
  short.readings[3]!.refused_list_read = (short.readings[3]!.refused_list_read ?? 0) - 1;
  const a = judgeProbeRun(short);
  eq(a.ok ? 0 : a.exitCode, VERIFY_EXIT.counterDidNotRise, "a write that did not land in the row read back exits 5");
  assert(!a.ok && a.message.includes("not looking at the same row"), "and says the write and the read disagree");

  const over = healthyRun();
  over.readings[4]!.refused_ceiling_key = (over.readings[4]!.refused_ceiling_key ?? 0) + 3;
  const b = judgeProbeRun(over);
  eq(b.ok ? 0 : b.exitCode, VERIFY_EXIT.counterDidNotRise, "a row that rose by MORE exits 5 too");
  assert(!b.ok && b.message.includes("another run"), "and names the other writer as the likely cause");

  const dropped = healthyRun();
  dropped.mixCarried.refused_embed_honeypot = false;
  const c = judgeProbeRun(dropped);
  eq(c.ok ? 0 : c.exitCode, VERIFY_EXIT.mixDropsName, "a name the mix RPC drops exits 6");

  const blind = healthyRun();
  blind.lockouts = null;
  const d = judgeProbeRun(blind);
  eq(d.ok ? 0 : d.exitCode, VERIFY_EXIT.lockoutReadFailed, "an unreadable locked out count exits 9");

  // Nothing written at all: every reading equal. The row "rose by what was written"
  // trivially only if nothing was planned, so plan the real writes and read none.
  const nothing = healthyRun();
  for (let k = 2; k < 5; k++) nothing.readings[k] = { ...nothing.readings[1]! };
  const f = judgeProbeRun(nothing);
  eq(f.ok ? 0 : f.exitCode, VERIFY_EXIT.counterDidNotRise, "a run whose writes never landed cannot pass on a quiet verdict");

  eq(judgeProbeRun({ ...healthyRun(), readings: [] }).ok, false, "a run with no readings never passes");
}

// ------------------------------- the verdict must MOVE, and the page must render

{
  const base = PROBE_SIGNALS.find((s) => s.id === "list read")!;
  // A judge stuck on paging: the baseline is not a measured clear.
  const stuck: ProbeSignal = { ...base, judge: () => ({ status: "paging", text: "x".repeat(60) }) };
  const g = judgeProbeRun(healthyRun(), [stuck]);
  eq(g.ok ? 0 : g.exitCode, VERIFY_EXIT.verdictUnchanged, "a verdict that pages before anything was written exits 7");

  // A judge that never pages: the probe's refusals changed nothing.
  const deaf: ProbeSignal = { ...base, judge: () => ({ status: "clear", text: null }) };
  const h = judgeProbeRun(healthyRun(), [deaf]);
  eq(h.ok ? 0 : h.exitCode, VERIFY_EXIT.verdictUnchanged, "a verdict that never moves exits 7");

  // Pages, but the message leaks a value it was not given.
  let calls = 0;
  const leaky: ProbeSignal = {
    ...base,
    judge: () => (calls++ === 0 ? { status: "clear", text: null } : { status: "paging", text: `The list failed undefined times ${"x".repeat(40)}` }),
  };
  const i = judgeProbeRun(healthyRun(), [leaky]);
  eq(i.ok ? 0 : i.exitCode, VERIFY_EXIT.messageUnrendered, "a page whose message leaks a value exits 8");

  assert(!renderable(null), "no message is not renderable");
  assert(!renderable("short"), "nor is a stub");
  assert(renderable("The bookings list could not be read 3 times across 3 separate intervals in the last 60 minutes."), "a real sentence is");
}

// ---------------------------------------------------- distinct exit codes

{
  const codes = Object.values(VERIFY_EXIT);
  eq(new Set(codes).size, codes.length, "every ending has its own exit code");
  eq(VERIFY_EXIT.passed, 0, "and only agreement is zero");
  assert(!codes.includes(1 as never), "none is 1, which node uses for an uncaught throw");
}

finish();
