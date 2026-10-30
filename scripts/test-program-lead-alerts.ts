// The program leads alerts (#4392). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-program-lead-alerts.ts
//
// This file pins:
//   1. FALLBACKS TO REAL TIMES: a condition per Eastern day. It pages at
//      PROGRAM_LEAD_FALLBACK_DAY_LIMIT fallbacks on one day and not one below (L1), names
//      the day as its subject so a new day posts at once, bands the count so a much worse
//      day posts at once too, and clears only on a MEASURED count under the line. A failed
//      read pages nothing and clears nothing.
//   2. ZERO REGISTRATIONS on a business day: a condition shipped DISARMED. Disarmed, it
//      reads nothing, sends nothing and clears nothing. Armed (as #4393 will), it pages
//      when no program lead was registered from the open of the last whole business day
//      until now, clears on a measured registration, ends in its own words when the program
//      is switched off, and measures nothing on an unreadable switch, week or count.
import {
  PROGRAM_LEAD_FALLBACKS_KEY,
  PROGRAM_LEAD_FALLBACK_DAY_LIMIT,
  PROGRAM_LEAD_REGISTRATIONS_ALERT_ARMED,
  PROGRAM_LEAD_REGISTRATIONS_KEY,
  fallbackBand,
  formatProgramLeadFallbacksAlert,
  formatProgramLeadFallbacksRecovery,
  formatProgramLeadRegistrationsAlert,
  formatProgramLeadRegistrationsRecovery,
  formatProgramLeadRegistrationsSwitchedOff,
  runProgramLeadFallbackCheck,
  runProgramLeadRegistrationsCheck,
  type ProgramLeadRegistrationsDeps,
} from "@/lib/monitor/program-lead-alerts";
import { alertKindOf } from "@/lib/notify/alert-catalog";
import type { BusinessWindow } from "@/lib/booking/business-hours";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
// Thursday 2026-10-29, 15:00 ET.
const NOW = Date.UTC(2026, 9, 29, 19, 0);
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

interface Sent {
  key: string;
  text: string;
  subjects?: readonly string[];
  band?: number;
}

// --- 1. fallbacks ---------------------------------------------------------------------

function fallbacks(count: number | Error) {
  const sent: Sent[] = [];
  const resolved: Sent[] = [];
  const asked: string[] = [];
  return {
    sent,
    resolved,
    asked,
    run: () =>
      runProgramLeadFallbackCheck({
        readDayCount: async (day) => {
          asked.push(day);
          if (count instanceof Error) throw count;
          return count;
        },
        notify: async (key, _ms, text, repeat) => {
          sent.push({ key, text, subjects: repeat?.subjects, band: repeat?.band });
        },
        resolve: async (key, text) => {
          resolved.push({ key, text });
          return true;
        },
        cooldownMs: 24 * 60 * MIN,
        nowMs: NOW,
      }),
  };
}

eq(PROGRAM_LEAD_FALLBACK_DAY_LIMIT, 5, "five fallbacks on one Eastern day pages");
eq(alertKindOf(PROGRAM_LEAD_FALLBACKS_KEY), "condition", "a condition, so it resolves");
{
  const h = fallbacks(PROGRAM_LEAD_FALLBACK_DAY_LIMIT);
  const r = await h.run();
  eq(h.asked, ["2026-10-29"], "it reads today's Eastern day");
  eq(r.status, "paged", "at the line it pages (L1)");
  eq(h.sent.length, 1, "one page");
  eq(h.sent[0]!.key, PROGRAM_LEAD_FALLBACKS_KEY, "on its key");
  eq(h.sent[0]!.subjects, ["2026-10-29"], "the day is the subject, so a new day posts at once");
  eq(h.sent[0]!.band, 1, "and the count is banded");
  assert(h.sent[0]!.text.includes("5 program leads"), "it says how many");
  eq(h.resolved.length, 0, "a paging day clears nothing");
}
{
  const h = fallbacks(PROGRAM_LEAD_FALLBACK_DAY_LIMIT - 1);
  const r = await h.run();
  eq(r.status, "healthy", "one under the line is healthy");
  eq(h.sent.length, 0, "and pages nobody");
  eq(h.resolved.map((x) => x.key), [PROGRAM_LEAD_FALLBACKS_KEY], "a measured count under the line is what clears it");
}
{
  const h = fallbacks(new Error("program_lead_outcomes read failed"));
  const r = await h.run();
  eq(r.status, "unreadable", "a failed read is unmeasured, never zero");
  eq(h.sent.length + h.resolved.length, 0, "and sends and clears nothing");
}
eq([0, 4, 5, 24, 25, 99, 100, 400].map(fallbackBand), [0, 0, 1, 1, 2, 2, 3, 3], "bands: 5, 25 and 100 a day");

// --- 2. zero registrations -------------------------------------------------------------

eq(PROGRAM_LEAD_REGISTRATIONS_ALERT_ARMED, false, "shipped DISARMED: #4393 arms it once the program is switched on");
eq(alertKindOf(PROGRAM_LEAD_REGISTRATIONS_KEY), "condition", "a condition, so it resolves");

// Monday to Friday, 09:00 to 18:00 Eastern.
const WEEK: BusinessWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 18 * 60 }));
function registrations(over: Partial<ProgramLeadRegistrationsDeps> & { count?: number | Error; on?: boolean | null } = {}) {
  const sent: Sent[] = [];
  const resolved: Sent[] = [];
  const asked: string[] = [];
  const reads = { switch: 0, count: 0 };
  const deps: ProgramLeadRegistrationsDeps = {
    armed: true,
    hours: { zone: "America/New_York", rules: WEEK, exceptions: [] },
    readSwitch: async () => {
      reads.switch += 1;
      return over.on === undefined ? true : over.on;
    },
    countRegisteredSince: async (iso) => {
      reads.count += 1;
      asked.push(iso);
      const c = over.count ?? 0;
      if (c instanceof Error) throw c;
      return c;
    },
    notify: async (key, _ms, text, repeat) => {
      sent.push({ key, text, subjects: repeat?.subjects });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 24 * 60 * MIN,
    nowMs: NOW,
    ...over,
  };
  return { deps, sent, resolved, asked, reads };
}
{
  const h = registrations({ armed: false });
  const r = await runProgramLeadRegistrationsCheck(h.deps);
  eq(r.status, "disarmed", "disarmed, it says so");
  eq(h.reads, { switch: 0, count: 0 }, "and reads nothing");
  eq(h.sent.length + h.resolved.length, 0, "and sends and clears nothing");
}
{
  const h = registrations({ count: 0 });
  const r = await runProgramLeadRegistrationsCheck(h.deps);
  eq(r.status, "paged", "armed, switched on, no registration since the last business day opened: it pages (L1)");
  // Mid Thursday, the last WHOLE business day is Wednesday the 28th, open at 09:00 ET.
  eq(h.asked, [new Date(Date.UTC(2026, 9, 28, 13, 0)).toISOString()], "counted from the open of the last whole business day");
  eq(h.sent[0]!.key, PROGRAM_LEAD_REGISTRATIONS_KEY, "on its key");
  eq(h.sent[0]!.subjects, ["2026-10-28"], "the business day is the subject");
  assert(h.sent[0]!.text.includes("Wednesday, October 28"), "and is named in words");
}
{
  const h = registrations({ count: 3 });
  const r = await runProgramLeadRegistrationsCheck(h.deps);
  eq(r.status, "healthy", "a registration since then is healthy");
  eq(h.resolved.map((x) => x.key), [PROGRAM_LEAD_REGISTRATIONS_KEY], "and is what clears it");
  eq(h.sent.length, 0, "and pages nobody");
}
{
  const h = registrations({ on: false });
  const r = await runProgramLeadRegistrationsCheck(h.deps);
  eq(r.status, "switched-off", "the program switched off is its own answer");
  eq(h.reads.count, 0, "nothing is counted");
  eq(h.resolved.map((x) => x.text), [formatProgramLeadRegistrationsSwitchedOff()], "and ends a page in its own words, not as a recovery");
}
for (const [label, over, status] of [
  // A failed read is "unreadable", which the monitor step throws so its failing streak pages it.
  ["an unreadable switch", { on: null }, "unreadable"],
  ["an unreadable count", { count: new Error("count failed") }, "unreadable"],
  // No whole business day to judge is not a fault, so it is merely unmeasured.
  ["no business day in the last two weeks", { hours: { zone: "America/New_York", rules: [], exceptions: [] } }, "unmeasured"],
] as const) {
  const h = registrations(over as Partial<ProgramLeadRegistrationsDeps> & { count?: number | Error; on?: boolean | null });
  const r = await runProgramLeadRegistrationsCheck(h.deps);
  eq(r.status, status, `${label} measures nothing, as ${status}`);
  eq(h.sent.length + h.resolved.length, 0, `${label} sends and clears nothing`);
}

// --- copy -------------------------------------------------------------------------------

for (const t of [
  formatProgramLeadFallbacksAlert("2026-10-29", 7),
  formatProgramLeadFallbacksRecovery(2),
  formatProgramLeadRegistrationsAlert({ isoDate: "2026-10-28", openMs: Date.UTC(2026, 9, 28, 13, 0) }, "America/New_York"),
  formatProgramLeadRegistrationsRecovery(4),
  formatProgramLeadRegistrationsSwitchedOff(),
]) {
  assert(!DASHES.test(t), `no dash as punctuation: ${t.slice(0, 40)}`);
  assert(!t.toLowerCase().startsWith("slate"), "an alert never opens with the word Slate");
}
assert(formatProgramLeadFallbacksAlert("2026-10-29", 1).includes("1 program lead was"), "one is said in the singular");
// The all clear claims only what the count measured: it mostly fires when the day turns,
// so it must not say the failing read recovered or that the extra times are back (L11).
{
  const clear = formatProgramLeadFallbacksRecovery(2).toLowerCase();
  assert(!clear.includes("again"), "the fallbacks all clear does not claim the extra times are back");
  assert(clear.includes("so far today") && clear.includes("not say the failing read recovered"), "it says what it measured and what it did not");
  assert(formatProgramLeadFallbacksRecovery(1).includes("1 program lead has"), "the all clear says one in the singular");
}

finish();
