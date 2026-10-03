// Repo invariant (#3133 follow-up): a cron lane failure produces exactly ONE
// message. Dan, 2026-10-03: "I only want one alert. neither should page two."
//
// The dispatcher's generic `cron_lane_failed:<lane>` page stands down only for a
// 500 that carries the header saying the lane already raised its own alert, and
// only `laneFailure` / `laneFailedResponse` write that header, from what the
// lane's code actually raised. So every lane route must answer a deliberate
// failure through them, and raise its own alert inside `laneFailure`'s callback.
// The lanes are DERIVED from the schedule, so a new lane is covered by
// construction rather than by being listed here (L96).
//
// Run: node --experimental-strip-types scripts/test-lane-failure-ownership.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { scanLaneFailureOwnership } from "./lib/scan-lane-failure-ownership.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the scanner, both directions -------------------------------------------
eq(
  scanLaneFailureOwnership(`return NextResponse.json({ error }, { status: 500 });`).map((f) => f.kind),
  ["raw"],
  "a hand built 500 is refused",
);
eq(
  scanLaneFailureOwnership(`return NextResponse.json(r, { status: r.failed ? 500 : 200 });`).map((f) => f.kind),
  ["raw"],
  "a conditional 500 is refused",
);
eq(
  scanLaneFailureOwnership(`return new NextResponse("unauthorized", { status: 401 });`).length,
  0,
  "a 401 is not a lane failure",
);
eq(
  scanLaneFailureOwnership(`
  } catch (err) {
    const consecutive = await recordFailureStreak(KEY, W);
    if (consecutive) await sendThrottledAlert("k", 1, copy("a {b}")).catch(h);
    return laneFailure("agents", message);
  }`).map((f) => f.kind),
  ["outside", "outside"],
  "a streak and a send in the catch but outside laneFailure are refused",
);
eq(
  scanLaneFailureOwnership(`
  } catch (err) {
    log.error("agents", { msg: "cron failed" });
    return laneFailure("agents", message, async () => {
      const consecutive = await recordFailureStreak(KEY, W);
      if (consecutive) await sendThrottledAlert("k", 1, copy("a {b}")).catch(h);
    });
  }`).length,
  0,
  "the same alerting inside laneFailure's callback is accepted",
);
eq(
  scanLaneFailureOwnership(`
  try {
    await sendThrottledAlert("k", 1, "t").catch((err) => { log.warn("x", {}, err); });
  } finally {}`).length,
  0,
  "a send on the healthy path, with a .catch handler, is not in a catch block",
);

eq(
  scanLaneFailureOwnership(`
  const run = await recordingAlerts(() => runAdvisorPhotoLane("cron"));
  if (run.ok && run.value.status === "failed") return laneFailedResponse(run.value, run.keys);`).map(
    (f) => f.kind,
  ),
  ["whole-run"],
  "recording a whole run in a lane route is refused: an earlier unrelated alert would silence the failure",
);

// --- the real lanes ---------------------------------------------------------
const paths = [...new Set(Object.values(CRON_ROUTES).flatMap((v) => (Array.isArray(v) ? v : [v])))];
assert(paths.length > 15, `the lanes come from the schedule (${paths.length})`);
let raisedOwnAlert = 0;
for (const path of paths) {
  const file = join(ROOT, "src/app", path.replace(/^\//, ""), "route.ts");
  assert(existsSync(file), `${path} has a route file`);
  const source = readFileSync(file, "utf8");
  if (/\blaneFailure\s*\(\s*[^)]*async\s*\(/.test(source)) raisedOwnAlert++;
  for (const f of scanLaneFailureOwnership(source)) {
    assert(
      false,
      f.kind === "raw"
        ? `${path}:${f.line} answers a 5xx by hand, which can never say the lane already alerted. Use laneFailure or laneFailedResponse from @/lib/monitor/lane-failure-response.`
        : f.kind === "outside"
          ? `${path}:${f.line} raises its own alert in a catch outside laneFailure, so the generic page goes out too. Move it into laneFailure's callback.`
          : `${path}:${f.line} records alerts across a whole run, so an unrelated earlier alert would silence the failure. Record the failure's own page where it is raised.`,
    );
  }
}
// Positive control on the real tree: at least one lane really raises its own
// alert through the callback, so a clean result is not a scan that matched nothing.
assert(raisedOwnAlert > 0, `at least one lane raises its own failure alert through laneFailure (${raisedOwnAlert})`);

finish();
