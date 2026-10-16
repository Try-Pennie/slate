// Every Google call the booking path can make is stubbed under SLATE_LOADTEST
// (#2241).
//
// The behavioural half is `src/lib/google/loadtest-confirm-stubs.test.ts`, which
// makes the network throw and drives each call. It can only cover the calls that
// exist today. This is the half that covers the NEXT one: the list of calls is
// derived from `realDeps`, so a Google call added to the booking path is measured
// by this guard on the commit that adds it rather than by somebody remembering
// the stub exists.
//
// Run: node --experimental-strip-types scripts/test-loadtest-stub-coverage.ts
import { readFileSync } from "node:fs";
import { stubCoverage, calendarExports, calendarImports } from "./lib/scan-loadtest-stub-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SERVICE = "src/lib/booking/service.ts";
const CALENDAR = "src/lib/google/calendar.ts";
const service = readFileSync(SERVICE, "utf8");
const calendar = readFileSync(CALENDAR, "utf8");

// --- The scan reached something, before any verdict it produces is believed ---

const exports = calendarExports(calendar);
assert(exports.length > 5, `parsed ${exports.length} calendar exports, expected the real module`);
assert(
  calendarImports(service).length > 0,
  "service.ts imports nothing from the calendar module, so the parse is wrong",
);

const real = stubCoverage(service, calendar);
assert(
  real.reached.length >= 5,
  `realDeps reaches ${real.reached.length} calendar exports; an empty or tiny list means the ` +
    `parse broke, and a broken parse reads exactly like a fully covered tree (L98)`,
);

// A body must never swallow the rest of the file: if one did, its single gate
// would answer for every function below it.
for (const e of exports) {
  assert(
    e.body.length < calendar.length / 2,
    `${e.name}'s parsed body is half the module, so the brace matching is wrong`,
  );
}

// The parser itself, positively (L1). The first version took "the next brace
// after the signature", which on `deleteEvent(…, opts?: { notifyAttendee?:
// boolean })` is an object TYPE inside the parameter list: it holds neither the
// gate nor the request, so the function read as doing nothing and its verdict was
// a parse artefact. Each case below names a function whose body must be its OWN
// and must not be its neighbour's.
const bodyOf = (name: string) => exports.find((e) => e.name === name)?.body ?? "";
for (const [name, mine] of [
  ["deleteEvent", "events.delete failed"],
  ["updateEventContact", "events.patch.description"],
  ["createEvent", "events.insert"],
  ["getEventOnPrimary", "events.get"],
] as const) {
  assert(bodyOf(name).includes(mine), `${name}'s parsed body does not contain its own code`);
}
// And no body may run past its own closing brace into the next declaration,
// which is the other direction of the same parse (L159).
for (const e of exports) {
  assert(
    !/export\s+(?:async\s+)?function\s/.test(e.body),
    `${e.name}'s parsed body contains another export's declaration`,
  );
}

// --- The tree itself ---

eq(
  real.uncovered.map((r) => `${r.name} (${r.reason})`).join(", "),
  "",
  "every calendar export the booking path reaches is stubbed under SLATE_LOADTEST",
);

// The confirm path's own calls, named, so a future change that stopped reaching
// one of these through realDeps is visible here rather than silently shrinking
// the list this guard checks.
for (const name of ["createEvent", "deleteEvent", "updateEventTime", "eventExists"]) {
  assert(real.reached.includes(name), `realDeps no longer reaches ${name}; has the path moved?`);
}

// --- Positive controls: the guard must still catch each way this can break ---

// 1. A gate removed from the real module. `freeBusy` is chosen because `isFree`
//    delegates to it, so this also proves the delegation propagates FAILURE and
//    not just success: a fixpoint that only ever grows would report isFree clean.
{
  const broken = calendar.replace(
    '  if (LOADTEST) {\n    // #3490: a read of no calendars asks Google nothing in production, so it waits nothing here.\n    if (calendarIds.length > 0) await loadtestGoogleDelay("read", GOOGLE_CONFIRM_TIMEOUT_MS);\n    return stubFreeBusy(email);\n  }\n',
    "",
  );
  assert(broken !== calendar, "the freeBusy gate is where this control expects it");
  const res = stubCoverage(service, broken);
  const by = new Map(res.all.map((r) => [r.name, r.reason]));
  eq(by.get("freeBusy"), "ungated", "removing the freeBusy gate must be caught");
  // Judged through `all` rather than `uncovered`, because `isFree` is reached
  // from elsewhere in service.ts and not from `realDeps`. The point of the case
  // is the fixpoint, which only ever adds: it must not report a delegate clean
  // once the thing it delegates to has lost its gate.
  eq(
    by.get("isFree"),
    "delegates-to-ungated",
    "isFree delegates to freeBusy, so it must go uncovered with it rather than staying clean",
  );
  // And the same run, unmodified, must call both covered: a control that only
  // ever produces one answer proves nothing.
  const clean = new Map(stubCoverage(service, calendar).all.map((r) => [r.name, r.reason]));
  eq(clean.get("freeBusy"), "gated", "freeBusy is gated in the real tree");
  eq(clean.get("isFree"), "delegates", "isFree is covered through freeBusy in the real tree");
}

// 2. A NEW Google call added to the booking path. This is the whole point: the
//    next one is covered by construction rather than by anybody's memory.
{
  const withCall =
    calendar +
    `\nexport async function bumpEventColour(email: string, id: string): Promise<void> {\n` +
    `  await gfetch(email, "/x/" + id, { method: "PATCH" });\n}\n`;
  const wired = service
    .replace('} from "@/lib/google/calendar";', '  bumpEventColour,\n} from "@/lib/google/calendar";')
    .replace("    createEvent,\n", "    createEvent,\n    bumpEventColour,\n");
  assert(wired !== service, "the new-call fixture really patched realDeps");
  const res = stubCoverage(wired, withCall);
  assert(res.reached.includes("bumpEventColour"), "a new call in realDeps must be reached");
  assert(
    res.uncovered.some((r) => r.name === "bumpEventColour" && r.reason === "ungated"),
    "an ungated new Google call must be reported as ungated",
  );
}

// 3. A delegating wrapper that ALSO makes its own request is not covered by its
//    callee's gate. Without this, adding one line to `eventExists` would ship a
//    live call under a green guard.
{
  const leaky = calendar.replace(
    "export async function eventExists(email: string, eventId: string): Promise<boolean> {\n",
    "export async function eventExists(email: string, eventId: string): Promise<boolean> {\n" +
      '  await gfetch(email, "/audit");\n',
  );
  assert(leaky !== calendar, "the leaky-wrapper fixture really patched eventExists");
  const res = stubCoverage(service, leaky);
  assert(
    res.uncovered.some((r) => r.name === "eventExists" && r.reason === "ungated"),
    "a wrapper that makes its own request must not be covered by the callee's gate",
  );
}

// 4. A rename of realDeps must break the scan loudly rather than report a clean
//    empty list.
{
  const res = stubCoverage(service, calendar, "noSuchFunction");
  eq(res.reached.length, 0, "an unknown entry point reaches nothing");
}

finish();
