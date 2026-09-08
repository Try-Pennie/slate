// The two pages a signed-in person has of their own, and the guard that they
// both exist. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-me-nav.ts
//
// /me used to be ONE page carrying two unrelated jobs: the hours that decide
// when somebody can be booked, and the time off they are asking for. Splitting
// them creates the failure L619 describes: a nav entry is written once and then
// read by everyone afterwards as proof its destination exists, so a tab pointing
// at a route nobody built is invisible until somebody clicks it.
//
// So the list is enumerated FROM the nav rather than from the pages, and each
// destination is resolved to a real file. Enumerating from the pages would pass
// happily while a tab pointed at nothing, which is the direction that breaks.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { ME_TABS } from "@/lib/me/nav";

// --- the two tabs, in the order they are read ---
//
// Availability FIRST, and it is not cosmetic: /me lands here, so this is the tab
// that opens when somebody signs in or clicks their own name. Dan's call
// (2026-09-08): the hours are what decide whether an agent gets calls, so they
// go in front of them every visit rather than one click away.
eq(ME_TABS.length, 2, "a person has exactly two pages of their own");
eq(
  ME_TABS[0].href,
  "/me/my-availability",
  "availability has its own address, in the same shape as every other page",
);
eq(ME_TABS[0].label, "My Availability", "the landing tab is named for the hours it holds");
eq(ME_TABS[1].href, "/me/time-off", "time off has its own route");

// "My Requests" said nothing about what was being requested, which is why it is
// gone (Dan, 2026-09-08). The manager-side twin moves with it, and that pairing
// is asserted where the header builds its tabs.
eq(ME_TABS[1].label, "My Time Off", "the time off tab says what it is for");

// --- every tab reaches a page that exists (L619) ---
for (const tab of ME_TABS) {
  const page = `src/app${tab.href}/page.tsx`;
  assert(existsSync(page), `${tab.label} points at a real screen (${page})`);
}

// --- /me keeps working, as a redirect rather than a second copy (#2107) ---
//
// Dan asked for the new address and for the old one to keep working. A redirect
// rather than rendering the page at both, so there is ONE canonical address: the
// header's current-tab highlight matches a tab by path, so a page served at an
// address no tab names would draw with nothing highlighted.
{
  const landing = stripComments(readFileSync("src/app/me/page.tsx", "utf8"));
  assert(
    /redirect\(\s*ME_TABS\[0\]\.href\s*\)/.test(landing),
    "/me redirects to the availability page, and takes the address from the tab list rather than restating it",
  );
  assert(
    !/WorkingHoursForm|availability_schedules/.test(landing),
    "/me does not render a second copy of the page it redirects to",
  );
}

// --- nothing redirects to /me carrying an outcome (L586) ---
//
// A redirect whose target is itself a redirect DROPS the query string, so a save
// that redirected to `/me?saved=...` would land on the availability page with no
// notice at all: the form would look like it did nothing, which is the exact
// failure the saved notice exists to prevent. Every outcome carrying redirect has
// to name the page it is actually on.
{
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const code = stripComments(readFileSync(file, "utf8"));
    // `/me?` or a template that appends to a bare `/me`, in a redirect or a
    // revalidate. `/me/time-off?...` is fine: that page is not a redirect.
    if (/(redirect|revalidatePath)\(\s*[`"']\/me[`"']?\s*(\?|\$\{)/.test(code)) {
      offenders.push(file);
    }
  }
  eq(offenders.join(", "), "", "no outcome is sent to /me, which would drop it on the way through");
}

// --- one label, one route ---
eq(
  new Set(ME_TABS.map((t) => t.href)).size,
  ME_TABS.length,
  "no route is offered twice",
);
eq(
  new Set(ME_TABS.map((t) => t.label)).size,
  ME_TABS.length,
  "no label is used twice",
);

// --- nothing here consults the launch flag ---
//
// The point of the split is that an agent's own hours stopped being governed by
// AGENT_SCHEDULING_LIVE, which only ever hid them because the tool was not
// finished. A flag reaching this list would put that back, and it would be
// invisible: the tabs would simply be absent for the people they are for.
// Comments are stripped first, because the docstring in that file EXPLAINS why
// the flag does not reach it and would otherwise satisfy the very check written
// to catch the flag arriving (L103). Caught by this test failing on its own
// first draft, which is the only reason anyone would know.
const navCode = readFileSync("src/lib/me/nav.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");
assert(
  !/consoleHiddenFor|agentSchedulingLive|AGENT_SCHEDULING_LIVE/.test(navCode),
  "a person's own pages are never gated by the console launch flag",
);
// The positive control: with the flag put back into the code the guard has to
// fire, or a scanner that reads nothing and a clean file look identical (L98).
assert(
  /consoleHiddenFor/.test(`${navCode}\nif (consoleHiddenFor(role)) return [];`),
  "the control: the guard does see the flag when it is actually there",
);

// --- the header READS the list rather than restating it (L613) ---
//
// Consolidation is the component plus the guard, in one change. Without this the
// list above is one source of truth that nothing is obliged to use, and the next
// person adds a tab by typing a label into the header, which is exactly how the
// page and its tab drift apart.
const headerCode = stripComments(readFileSync("src/components/AppHeader.tsx", "utf8"));
assert(
  /import \{ ME_TABS \} from "@\/lib\/me\/nav"/.test(headerCode),
  "the header takes a person's own tabs from the shared list",
);
for (const tab of ME_TABS) {
  assert(
    !headerCode.includes(`"${tab.label}"`),
    `the header does not restate the label "${tab.label}"`,
  );
}

// --- the two time off tabs are ONE vocabulary (L118) ---
//
// The agent's own page and the manager's approval queue name the same unit, so
// they move together or the product has two words for one thing. "Requests"
// named the mechanism and not the subject, and both said it.
assert(
  headerCode.includes('label: "Team Time Off"'),
  "the manager's queue is named for time off, matching the agent's own tab",
);
assert(
  !/Team Requests|My Requests/.test(headerCode),
  "no tab is still called Requests",
);
// The control: this guard has to SEE the retired wording when it is there, or a
// scanner that read nothing and a clean file look the same (L98).
assert(
  /Team Requests/.test(`${headerCode}\nlabel: "Team Requests",`),
  "the control: the guard does see the retired label when it is actually there",
);

/** Every .ts/.tsx under a directory, so the scan cannot miss a file (L96). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

finish();
