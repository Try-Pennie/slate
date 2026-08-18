// #1529 / #1525: the monitor lane's edge-limiter health check.
//
// WHY THIS EXISTS, since it looks like a duplicate of the hot-path alert and is not.
//
// The hot path (src/lib/rate-limit.ts) reports a fail-open on a REQUEST: per IP, per
// datacenter, throttled, and classified as an incident because a single colo having a bad
// moment is a finished event. It cannot answer "is the limiter usable right now", because
// it only ever speaks when something failed, and its silence is produced by three
// different things at once (a cooldown, a swallowed alert, and no traffic).
//
// So `rate_limit_broken:availability` fired on 2026-08-17 at 14:44 UTC and stayed silent,
// and that silence was worth nothing: a recovered limiter and a permanently broken one
// looked identical from outside. This check is the half that can say. It runs inside the
// deployed Worker every minute, measures the bindings, and owns a CONDITION with a real
// all-clear hanging off a MEASURED success (#1151).
//
// The three-outcome shape is the whole point (L11, L98, #1134, #1152):
//
//   healthy   - measured, every binding resolves, the service answered. CLEARS.
//   unusable  - measured, something is genuinely off in production. PAGES.
//   unmeasured- we learned nothing this tick. Neither pages NOR clears.
//
// "Unmeasured" is not a courtesy. This check is also the second route behind the hot
// path's runtime gate: if `isWorkersRuntime()` ever answered wrongly in production, the
// fail-open alert would go quiet and this is what would still notice. So a tick that
// could not measure must never be scored as health, and it must never be scored as a
// fault either, because that would page every time a node script touched the module.
//
// Run: node --experimental-strip-types scripts/test-edge-limiter-health.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  EDGE_LIMITER_KEY,
  edgeLimiterHealth,
  formatEdgeLimiterUnusableAlert,
  formatEdgeLimiterRecovery,
  runEdgeLimiterCheck,
  type EdgeLimiterReading,
} from "@/lib/monitor/edge-limiter-health";
import { EDGE_LIMITER_BINDINGS } from "@/lib/rate-limit-core";

const EXPECTED = EDGE_LIMITER_BINDINGS;

const healthyReading = (): EdgeLimiterReading => ({
  onWorkersRuntime: true,
  runtime: "Cloudflare-Workers",
  presentBindings: [...EXPECTED],
  serviceAnswered: true,
  burstNamespacePresent: true,
});

// ---------------------------------------------------------------- the verdict

{
  const h = edgeLimiterHealth({ expected: EXPECTED, reading: healthyReading() });
  eq(h.status, "healthy", "every binding present and the service answering is healthy");
  eq(
    h.status === "healthy" ? h.bindingCount : -1,
    EXPECTED.length,
    "a healthy verdict reports how many bindings it actually saw",
  );
}

{
  // A binding blocking the monitor's own key is still a WORKING limiter. Scoring a block
  // as a fault would page hardest on the limiter doing its job.
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: { ...healthyReading(), serviceAnswered: true },
  });
  eq(h.status, "healthy", "a limiter that answers is healthy whether or not it allowed the call");
}

{
  const reading = healthyReading();
  reading.presentBindings = [...EXPECTED].filter((b) => b !== "AVAIL_RATE_LIMITER");
  const h = edgeLimiterHealth({ expected: EXPECTED, reading });
  eq(h.status, "unusable", "a missing binding is unusable");
  eq(
    h.status === "unusable" ? h.missing.join(",") : "",
    "AVAIL_RATE_LIMITER",
    "the missing binding is named",
  );
}

{
  // EVERY missing binding, not just the first: a deploy that dropped the ratelimits block
  // drops all six, and naming one sends the reader back for a second look (the
  // monitorSetupGates rule).
  const reading = healthyReading();
  reading.presentBindings = [];
  const h = edgeLimiterHealth({ expected: EXPECTED, reading });
  eq(h.status, "unusable", "no bindings at all is unusable");
  eq(
    h.status === "unusable" ? h.missing.length : -1,
    EXPECTED.length,
    "all missing bindings are named, not just the first",
  );
}

{
  // On the platform, in a request handler, and the env could not be read. That is not
  // "we could not tell": it means no limiter is reachable for any request being served.
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: { ...healthyReading(), presentBindings: null, serviceAnswered: null },
  });
  eq(h.status, "unusable", "an unreadable request context ON the platform is a measured fault");
  assert(
    h.status === "unusable" && h.contextUnreadable,
    "the unreadable context is reported as its own cause, not as a missing binding",
  );
}

{
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: { ...healthyReading(), serviceAnswered: false },
  });
  eq(h.status, "unusable", "a limiter that threw when called is unusable");
  assert(
    h.status === "unusable" && h.serviceUnreachable && h.missing.length === 0,
    "a throwing service is its own cause, distinct from a missing binding",
  );
}

// --- the burst ceiling (#1558) ----------------------------------------------
//
// The ceiling added in #1536 and generalised in #1556 is a Durable Object binding, not a
// rate-limit binding, so it sat outside the walk above entirely. If it vanished from a
// deploy the backstop would be OFF, and the only signal is the fail-open alert raised the
// first time one address gets hot enough to be counted properly, which before cutover
// could be months away. That is the same shape #1529 already fixed once for the other
// bindings: a protective control that is off, with the absence indistinguishable from
// nothing needing protection.

{
  const reading = healthyReading();
  reading.burstNamespacePresent = false;
  const h = edgeLimiterHealth({ expected: EXPECTED, reading });
  eq(h.status, "unusable", "the burst counter missing from the deployment is unusable");
  assert(
    h.status === "unusable" && h.burstCeilingMissing,
    "and is reported as its OWN cause",
  );
  assert(
    h.status === "unusable" && h.missing.length === 0,
    "not as a missing request ceiling: the sustained ceilings are all still there",
  );
}

{
  // The distinction the issue insists on. An unreadable context means we could not LOOK
  // for the burst counter, which is not the same finding as having looked and not found it,
  // and a verdict that conflated them would send the reader to redeploy a durable_objects
  // block that is perfectly fine (L11).
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: {
      ...healthyReading(),
      presentBindings: null,
      serviceAnswered: null,
      burstNamespacePresent: null,
    },
  });
  eq(h.status, "unusable", "an unreadable context is still a measured fault");
  assert(
    h.status === "unusable" && h.contextUnreadable,
    "reported as an unreadable context",
  );
  assert(
    h.status === "unusable" && !h.burstCeilingMissing,
    "and NOT as the burst counter being missing, because nothing looked for it",
  );
}

{
  // Both at once, which is what a deploy carrying a truncated config produces.
  const reading = healthyReading();
  reading.presentBindings = [...EXPECTED].filter((b) => b !== "BOOKING_RATE_LIMITER");
  reading.burstNamespacePresent = false;
  const h = edgeLimiterHealth({ expected: EXPECTED, reading });
  eq(h.status, "unusable", "both missing is unusable");
  assert(
    h.status === "unusable" && h.burstCeilingMissing && h.missing.length === 1,
    "and both are named, because a reader told about one will fix one and stop",
  );
}

{
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: {
      onWorkersRuntime: false,
      runtime: "Node.js/24",
      presentBindings: null,
      serviceAnswered: null,
      burstNamespacePresent: null,
    },
  });
  eq(
    h.status,
    "unmeasured",
    "off the Workers runtime there is no burst binding to be missing either",
  );
}

{
  // The completeness half: a healthy verdict must require the burst counter, or the check
  // would report health while the backstop was absent, which is the exact defect (L98).
  const reading = healthyReading();
  reading.burstNamespacePresent = false;
  assert(
    edgeLimiterHealth({ expected: EXPECTED, reading }).status !== "healthy",
    "a deployment without the burst counter is never scored as healthy",
  );
}

{
  const reading = healthyReading();
  reading.burstNamespacePresent = false;
  const text = formatEdgeLimiterUnusableAlert(
    edgeLimiterHealth({ expected: EXPECTED, reading }),
  );
  assert(text.length > 0, "the burst-counter fault produces copy");
  // The impact has to AGREE with what is actually off. The sustained per-minute ceilings
  // are still enforced, so copy saying an endpoint "has no ceiling at all" would overstate
  // it and get this treated as an open door (L21).
  assert(
    !/no ceiling at all|unlimited traffic/i.test(text),
    "it does not claim the endpoints are uncapped, because they are not",
  );
  assert(
    /burst|simultaneous|at once|flood/i.test(text),
    "it says what IS off: the backstop a burst cannot spread across",
  );
  assert(
    /deploy|redeploy|wrangler/i.test(text),
    "and names an action that changes the state the reader is in (L111)",
  );
  assert(!text.startsWith("Slate"), "and does not open with the word Slate");
}

{
  // A reader told about the request ceiling and not the backstop fixes one and stops.
  const reading = healthyReading();
  reading.presentBindings = [...EXPECTED].filter((b) => b !== "BOOKING_RATE_LIMITER");
  reading.burstNamespacePresent = false;
  const text = formatEdgeLimiterUnusableAlert(
    edgeLimiterHealth({ expected: EXPECTED, reading }),
  );
  assert(/confirm/i.test(text), "the combined copy names the endpoint whose ceiling is gone");
  assert(/burst|simultaneous|at once|flood/i.test(text), "and the backstop as well");
}

{
  // The all-clear may claim only what was measured. It must not say the counter answered,
  // because presence is all this check looks at.
  const text = formatEdgeLimiterRecovery();
  assert(/present|in the running deployment/i.test(text), "the all-clear says what it saw");
  assert(
    !/burst counter answered|counter is answering/i.test(text),
    "and never claims the burst counter answered a call, which nothing here measures",
  );
}

{
  const reading = healthyReading();
  reading.burstNamespacePresent = false;
  const { deps, notified, resolved } = stubDepsFwd(reading);
  await runEdgeLimiterCheck(deps);
  eq(notified.length, 1, "the step pages when the burst counter is missing");
  eq(resolved.length, 0, "and clears nothing");
}

{
  // The gate that stops a node script or a `next dev` tick from either paging or, worse,
  // clearing a real page.
  const h = edgeLimiterHealth({
    expected: EXPECTED,
    reading: {
      onWorkersRuntime: false,
      runtime: "Node.js/24",
      presentBindings: null,
      serviceAnswered: null,
    },
  });
  eq(h.status, "unmeasured", "off the Workers runtime the check measured nothing");
  assert(
    h.status === "unmeasured" && h.why.length > 0,
    "an unmeasured tick says WHY, so a skip is never mistaken for a clean run",
  );
}

// ------------------------------------------------------------------- the copy

{
  const reading = healthyReading();
  reading.presentBindings = [...EXPECTED].filter((b) => b !== "AVAIL_RATE_LIMITER");
  const text = formatEdgeLimiterUnusableAlert(
    edgeLimiterHealth({ expected: EXPECTED, reading }),
  );
  assert(text.length > 0, "an unusable verdict produces alert copy");
  assert(
    /availability/i.test(text),
    "the copy names the endpoint in plain language, not only the binding",
  );
  assert(
    /deploy|redeploy|wrangler/i.test(text),
    "the copy names an action that changes the state the reader is in (L111)",
  );
  assert(!text.startsWith("Slate"), "the copy does not open with the word Slate");
}

{
  for (const h of [
    edgeLimiterHealth({ expected: EXPECTED, reading: healthyReading() }),
    edgeLimiterHealth({
      expected: EXPECTED,
      reading: {
        onWorkersRuntime: false,
        runtime: null,
        presentBindings: null,
        serviceAnswered: null,
      },
    }),
  ]) {
    eq(
      formatEdgeLimiterUnusableAlert(h),
      "",
      `${h.status} produces no alert copy at all`,
    );
  }
}

{
  const all = [
    formatEdgeLimiterRecovery(),
    formatEdgeLimiterUnusableAlert(
      edgeLimiterHealth({
        expected: EXPECTED,
        reading: { ...healthyReading(), presentBindings: [], serviceAnswered: null },
      }),
    ),
    formatEdgeLimiterUnusableAlert(
      edgeLimiterHealth({
        expected: EXPECTED,
        reading: { ...healthyReading(), presentBindings: null, serviceAnswered: null },
      }),
    ),
    formatEdgeLimiterUnusableAlert(
      edgeLimiterHealth({ expected: EXPECTED, reading: { ...healthyReading(), serviceAnswered: false } }),
    ),
  ];
  for (const text of all) {
    assert(text.length > 0, "every rendered state produces real copy");
    // Written as escapes so this file holds no literal dash of its own: the pre-push
    // style gate cannot tell the line BANNING the character from a line using it.
    assert(!/[\u2014\u2013]/.test(text), "no dash punctuation in the copy");
    assert(
      !/undefined|NaN|\[object Object\]/.test(text),
      "no leaked placeholder in the copy",
    );
  }
  // The three faults must not share one sentence: the remedy for each is different.
  eq(new Set(all).size, all.length, "each cause renders its own distinct message (L11)");
}

// -------------------------------------------------------------- the step

function stubDepsFwd(reading: EdgeLimiterReading | (() => Promise<EdgeLimiterReading>)) {
  return stubDeps(reading);
}

function stubDeps(reading: EdgeLimiterReading | (() => Promise<EdgeLimiterReading>)) {
  const notified: string[] = [];
  const resolved: string[] = [];
  return {
    notified,
    resolved,
    deps: {
      expected: EXPECTED,
      read: typeof reading === "function" ? reading : async () => reading,
      notify: async (key: string, _ms: number, text: string) => {
        notified.push(`${key}|${text}`);
      },
      resolve: async (key: string, text: string) => {
        resolved.push(`${key}|${text}`);
      },
      cooldownMs: 60_000,
    },
  };
}

{
  const { deps, notified, resolved } = stubDeps(healthyReading());
  const h = await runEdgeLimiterCheck(deps);
  eq(h.status, "healthy", "the step reports healthy");
  eq(notified.length, 0, "a healthy tick pages nobody");
  eq(resolved.length, 1, "a healthy tick CLEARS, which is the whole point of #1529");
  assert(resolved[0]!.startsWith(`${EDGE_LIMITER_KEY}|`), "it clears the condition's own key");
}

{
  const reading = healthyReading();
  reading.presentBindings = [];
  const { deps, notified, resolved } = stubDeps(reading);
  await runEdgeLimiterCheck(deps);
  eq(notified.length, 1, "an unusable tick pages");
  eq(resolved.length, 0, "an unusable tick clears nothing");
}

{
  const { deps, notified, resolved } = stubDeps({
    onWorkersRuntime: false,
    runtime: "Node.js/24",
    presentBindings: null,
    serviceAnswered: null,
    burstNamespacePresent: null,
  });
  await runEdgeLimiterCheck(deps);
  eq(notified.length, 0, "an unmeasured tick pages nobody");
  // The half that keeps biting: a run that learned nothing must not send an all-clear,
  // or a laptop importing this module clears a live production page (#1134, #1152).
  eq(resolved.length, 0, "an unmeasured tick CLEARS NOTHING");
}

{
  // A throwing read is unmeasured, not healthy and not a fault, and it must not take the
  // step down with it.
  const { deps, notified, resolved } = stubDeps(async () => {
    throw new Error("could not inspect the request context");
  });
  const h = await runEdgeLimiterCheck(deps);
  eq(h.status, "unmeasured", "a throwing read is unmeasured");
  eq(notified.length + resolved.length, 0, "a throwing read neither pages nor clears");
}

{
  // Neither send may break the lane: both are best effort, like every other check here.
  const reading = healthyReading();
  reading.presentBindings = [];
  let threw = false;
  try {
    await runEdgeLimiterCheck({
      expected: EXPECTED,
      read: async () => reading,
      notify: async () => {
        throw new Error("alert store unreachable");
      },
      resolve: async () => {},
      cooldownMs: 60_000,
    });
  } catch {
    threw = true;
  }
  assert(!threw, "a failing alert does not throw out of the step");

  threw = false;
  try {
    await runEdgeLimiterCheck({
      expected: EXPECTED,
      read: async () => healthyReading(),
      notify: async () => {},
      resolve: async () => {
        throw new Error("alert store unreachable");
      },
      cooldownMs: 60_000,
    });
  } catch {
    threw = true;
  }
  assert(!threw, "a failing all-clear does not throw out of the step");
}

finish();
