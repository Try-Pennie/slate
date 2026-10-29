// #4391: who may move a call ONTO the placeholder advisor.
//
// #4203 holds that a move never keeps or puts a call on the placeholder: the manage page,
// the booker's Move panel, Marcia's MCP channel, an admin move and the direct API all move
// it to a real advisor or refuse. Two exceptions exist, each by design: the coordinator's
// confirmed move when nobody real is free (#4202), and a program lead's own move from the
// lead facing reschedule route (#4391). Both reach the shared `rescheduleBooking` through
// its `ontoPlaceholder` option, and nothing in the type system stops a third caller
// passing it. So the names that carry the exception are held to the files that own it,
// and any new file naming one fails here until somebody decides it belongs.
//
// What it cannot see: a caller that reaches the option under another name (a spread of
// an options object built elsewhere). Every such object is built in a listed file today.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-onto-placeholder-callers.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

/** Each name that carries the exception, and every non test file allowed to name it, with why. */
const OWNERS: Record<string, Record<string, string>> = {
  ontoPlaceholder: {
    "src/lib/booking/orchestration.ts": "defines the option on rescheduleBooking",
    "src/lib/booking/placed-booking.ts": "the coordinator's confirmed move (#4202)",
    "src/lib/booking/placed-booking-service.ts": "wires the coordinator's move",
    "src/lib/booking/service.ts": "rescheduleProgramLeadOntoPlaceholder hands it on",
    "src/lib/booking/program-lead-booking.ts": "a program lead's own move (#4391)",
    "src/lib/booking/program-lead-booking-service.ts": "wires the program lead's move",
  },
  rescheduleProgramLeadOntoPlaceholder: {
    "src/lib/booking/service.ts": "defines it",
    "src/lib/booking/program-lead-booking-service.ts": "its one caller",
  },
  moveProgramLeadLive: {
    "src/lib/booking/program-lead-booking-service.ts": "defines it",
    "src/app/api/bookings/[token]/reschedule/route.ts": "the lead facing reschedule route, the one place the exception lives",
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The files among `sources` naming `identifier` as a whole word. */
export function filesNaming(identifier: string, sources: { path: string; text: string }[]): string[] {
  const word = new RegExp(`\\b${identifier}\\b`);
  return sources.filter((s) => word.test(s.text)).map((s) => s.path).sort();
}

const sources = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
assert(sources.length > 100, `the scan read the source tree (${sources.length} files)`);

for (const [identifier, owners] of Object.entries(OWNERS)) {
  eq(filesNaming(identifier, sources), Object.keys(owners).sort(), `only the files that own it name ${identifier}`);
}

// Positive control: a planted caller in any other file is named.
{
  const planted = [...sources, { path: "src/app/api/admin/bookings/[id]/reschedule/route.ts", text: "rescheduleBooking(t, s, r, i, d, n, a, c, { ontoPlaceholder: p })" }];
  const found = filesNaming("ontoPlaceholder", planted);
  assert(found.includes("src/app/api/admin/bookings/[id]/reschedule/route.ts"), "control: an admin move passing ontoPlaceholder is caught");
  assert(filesNaming("ontoPlaceholder", [{ path: "x.ts", text: "const notOntoPlaceholderAtAll = 1;" }]).length === 0, "control: a longer name containing it is not");
}

finish();
