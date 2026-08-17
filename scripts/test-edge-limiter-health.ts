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
