// Booking times render in the VIEWER's zone, labelled, and nothing hard codes
// Eastern back in (#1916).
//
// Six surfaces rendered booking times in America/New_York with no zone on
// screen, five of them citing "the whole roster is Eastern" as the reason. #1739
// measured that false (74 of 103 bookable agents are elsewhere, across seven
// zones). Dan's decision, 2026-09-24: the viewer's zone, labelled, through ONE
// shared formatter (`formatViewerTime`) rendered by ONE client component
// (`ViewerTime`). This guard is the other half of that consolidation: it fails
// the next hand rolled Eastern formatter, so the class does not come back.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-time-zone-guard.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { scanHardCodedZone, scanServerFormatted } from "./lib/scan-booking-time-zone.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

/**
 * The booking view model modules. They build what the staff surfaces render, on
 * the server, so they must carry instants and never formatted times. Declared by
 * name because "a module that builds a booking view" is not a shape a scanner
 * can recognise; the rendering layer below is DERIVED, so a new component is
 * covered by construction (L96).
 */
const VIEW_MODELS = [
  "src/lib/booking/event-display.ts",
  "src/lib/booking/history.ts",
  "src/lib/booking/detail.ts",
];

/** The six sites #1916 named, which must each render through the shared component. */
const SURFACES_USING_VIEWER_TIME = [
  "src/components/RecentRoutingTable.tsx",
  "src/components/BookingHistory.tsx",
  "src/components/BookingLookup.tsx",
  "src/app/admin/bookings/[id]/page.tsx",
];

// --- positive controls: each shape the six sites shipped must be caught ---
{
  const shapes: [string, string][] = [
    ["RecentRoutingTable", `  return new Date(iso).toLocaleString("en-US", {\n    timeZone: "America/New_York",\n  });`],
    ["BookingHistory", `const ROSTER_ZONE = "America/New_York";`],
    ["typed const", `const ZONE: string = "America/New_York";`],
    ["direct call", `const t = formatSlotTime(iso, "America/New_York");`],
    ["luxon option", `DateTime.fromISO(iso, { zone: "America/New_York" })`],
    ["setZone", `DateTime.now().setZone('America/New_York')`],
  ];
  for (const [name, text] of shapes) {
    assert(scanHardCodedZone("fixture.tsx", text).length === 1, `control: the ${name} shape is caught`);
  }

  // Negative controls: a stored setting's fallback, a comment, and an opted out
  // line are not display zones.
  eq(
    scanHardCodedZone("f.tsx", `const tz = sched?.timezone ?? "America/New_York";`).length,
    0,
    "a fallback for a stored setting is not flagged",
  );
  eq(
    scanHardCodedZone("f.tsx", `// the old code used timeZone: "America/New_York"`).length,
    0,
    "a comment about the old code is not flagged",
  );
  eq(
    scanHardCodedZone(
      "f.tsx",
      `// zone-ok: the org's business day, which is Eastern by definition\nconst BUSINESS = "America/New_York";`,
    ).length,
    0,
    "an opt out with a reason is honoured",
  );
  eq(
    scanHardCodedZone("f.tsx", `// zone-ok: \nconst BUSINESS = "America/New_York";`).length,
    1,
    "an opt out with no reason is not",
  );

  // Rule two: a server side view model that formats a time.
  eq(
    scanServerFormatted("detail.ts", "  return `${formatSlotDay(iso, tz)}, ${formatSlotTime(iso, tz)}`;").length,
    1,
    "control: a view model formatting a time is caught",
  );
  eq(scanServerFormatted("detail.ts", `import { formatSlotDay } from "./slot-label.ts";`).length, 0, "an import is not a call");
}

// --- overlay controls on the REAL tree: re-plant the shipped defect in memory ---
{
  const real = readFileSync("src/components/RecentRoutingTable.tsx", "utf8");
  const planted = `${real}\nexport const x = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });\n`;
  assert(
    scanHardCodedZone("src/components/RecentRoutingTable.tsx", planted).length >= 1,
    "control: an Eastern formatter planted into the real routing table is caught",
  );
  const detail = readFileSync("src/lib/booking/detail.ts", "utf8");
  const plantedDetail = `${detail}\nexport const y = (iso: string) => formatSlotTime(iso, "UTC");\n`;
  assert(
    scanServerFormatted("src/lib/booking/detail.ts", plantedDetail).length >= 1,
    "control: a server formatted time planted into the real detail view model is caught",
  );
}

// --- the tree: every rendering file, derived ---
{
  const files = sourceFiles({ match: /\.tsx$/, exclude: (f) => /\.test\.tsx$/.test(f) });
  assert(files.length > 100, `the scan really read the rendering layer (${files.length} files)`);
  const offenders = files.flatMap((f) => scanHardCodedZone(f, readFileSync(f, "utf8")));
  if (offenders.length === 0) assert(true, "no rendering file formats a time in a hard coded Eastern zone");
  for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
}

// --- the view models: carry instants, never formatted times ---
for (const f of VIEW_MODELS) {
  const text = readFileSync(f, "utf8");
  const offenders = [...scanHardCodedZone(f, text), ...scanServerFormatted(f, text)];
  if (offenders.length === 0) assert(true, `${f} carries instants, not formatted times`);
  for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
  assert(!/ROSTER_ZONE/.test(text), `${f} has no ROSTER_ZONE`);
}

// --- the named surfaces render through the ONE shared component ---
for (const f of SURFACES_USING_VIEWER_TIME) {
  const text = readFileSync(f, "utf8");
  assert(/from "@\/components\/ViewerTime"/.test(text), `${f} renders booking times through ViewerTime`);
  assert(!/ROSTER_ZONE/.test(text), `${f} has no ROSTER_ZONE`);
}

// --- the false premise is gone from every file that stated it ---
{
  const files = sourceFiles({ match: /\.tsx?$/ });
  const stating = files.filter((f) => /whole roster is Eastern/i.test(readFileSync(f, "utf8")));
  eq(stating.join(", "), "", "no file still says the whole roster is Eastern");
}

finish();
