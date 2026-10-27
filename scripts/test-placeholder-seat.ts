// The placeholder advisor's Google seat, and no usable placeholder while the switch is
// on (#4206). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-placeholder-seat.ts
//
// This file pins:
//   1. a definitive failure (gone, not-provisioned) pages on the second failing tick, a
//      transient one only on the fourth, and the kinds are split by
//      `isDefinitiveFailure`, never a comparison with "gone";
//   2. only a measured healthy tick, both probes answering, clears the page and the
//      streak; a failed read, an unreadable switch or a missing seat clears nothing;
//   3. a seat in use by neither the switch nor any call is not probed, and an open page
//      closes as a stand down, never a recovery (L11);
//   4. no usable placeholder with the switch on pages, each cause in its own words, and
//      with the switch off it says nothing and an open page closes as switched off.
import {
  runPlaceholderSeatCheck,
  missingReason,
  formatPlaceholderSeatAlert,
  formatPlaceholderMissingAlert,
  PLACEHOLDER_SEAT_KEY,
  PLACEHOLDER_MISSING_KEY,
  PLACEHOLDER_SEAT_DEFINITIVE_TICKS,
  PLACEHOLDER_SEAT_TRANSIENT_TICKS,
  PLACEHOLDER_SEAT_STOOD_DOWN,
  PLACEHOLDER_MISSING_RECOVERY,
  PLACEHOLDER_MISSING_SWITCHED_OFF,
  type PlaceholderSeatDeps,
  type PlaceholderSeatRow,
  type SeatProbe,
} from "@/lib/monitor/placeholder-seat";
import { alertKindOf } from "@/lib/notify/alert-catalog";
import { MONITOR_STEP_FAILING_TICKS } from "@/lib/monitor/step-failure";
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const MARCIA: PlaceholderSeatRow = { id: "u-marcia", name: "Marcia", email: "marcia@trypennie.com", deactivated_at: null };

interface World {
  switchOn?: boolean | null;
  rows?: PlaceholderSeatRow[];
  futureCalls?: number;
  calendar?: SeatProbe;
  gmail?: SeatProbe;
  /** Shared across ticks, like the real rate limit row. */
  streak: { count: number; unreadable?: boolean };
}
interface Out {
  sent: { key: string; text: string; subjects?: readonly string[]; band?: number }[];
  resolved: { key: string; text: string }[];
  probed: string[];
}

function deps(w: World, out: Out): PlaceholderSeatDeps {
  return {
    readSwitch: async () => (w.switchOn === undefined ? true : w.switchOn),
    loadPlaceholders: async () => w.rows ?? [MARCIA],
    countFutureCalls: async (ids) => {
      eq(ids, (w.rows ?? [MARCIA]).map((r) => r.id), "the future calls are counted on the real placeholders' ids");
      return w.futureCalls ?? 0;
    },
    probeCalendar: async (email) => {
      out.probed.push(`calendar:${email}`);
      return w.calendar ?? "reachable";
    },
    probeGmail: async (email) => {
      out.probed.push(`gmail:${email}`);
      return w.gmail ?? "reachable";
    },
    bumpStreak: async (alertAt) => {
      if (w.streak.unreadable) return "unknown";
      w.streak.count += 1;
      return w.streak.count >= alertAt ? "reached" : "below";
    },
    clearStreak: async () => {
      w.streak.count = 0;
    },
    notify: async (key, _ms, text, repeat) => {
      out.sent.push({ key, text, subjects: repeat?.subjects, band: repeat?.band });
    },
    resolve: async (key, text) => {
      out.resolved.push({ key, text });
      return true;
    },
    cooldownMs: 24 * 60 * 60_000,
  };
}
const fresh = (): Out => ({ sent: [], resolved: [], probed: [] });
const seatPages = (o: Out) => o.sent.filter((s) => s.key === PLACEHOLDER_SEAT_KEY);
const seatClears = (o: Out) => o.resolved.filter((s) => s.key === PLACEHOLDER_SEAT_KEY);

// --- 1. when it speaks ------------------------------------------------------------

for (const kind of ["gone", "not-provisioned"] as const) {
  const w: World = { calendar: kind, streak: { count: 0 } };
  const first = fresh();
  await runPlaceholderSeatCheck(deps(w, first));
  eq(seatPages(first).length, 0, `a first ${kind} tick is held for the next one`);
  const second = fresh();
  const r = await runPlaceholderSeatCheck(deps(w, second));
  eq(seatPages(second).length, 1, `a second ${kind} tick in a row pages (L1)`);
  eq(r.status === "checked" && r.paged, true, "and says it paged");
  assert(seatPages(second)[0]!.text.includes("Retrying will not fix it"), `${kind} is told as definitive`);
  eq(seatPages(second)[0]!.band, 2, "a definitive failure is the worse band");
}
eq(PLACEHOLDER_SEAT_DEFINITIVE_TICKS, 2, "definitive: two ticks");
eq(PLACEHOLDER_SEAT_TRANSIENT_TICKS, MONITOR_STEP_FAILING_TICKS, "transient: the lane's own step failure bound");
{
  const w: World = { gmail: "transient", streak: { count: 0 } };
  const pages: number[] = [];
  for (let i = 0; i < PLACEHOLDER_SEAT_TRANSIENT_TICKS; i++) {
    const o = fresh();
    await runPlaceholderSeatCheck(deps(w, o));
    pages.push(seatPages(o).length);
  }
  eq(pages, [0, 0, 0, 1], "a transient failure pages only on the fourth tick in a row");
}
{
  // A transient tick then a definitive one: the run is one streak, and the definitive
  // threshold is already met.
  const w: World = { calendar: "transient", streak: { count: 0 } };
  await runPlaceholderSeatCheck(deps(w, fresh()));
  w.calendar = "gone";
  const o = fresh();
  await runPlaceholderSeatCheck(deps(w, o));
  eq(seatPages(o).length, 1, "a definitive failure after a transient one pages at once");
}
{
  // An unreadable streak: a definitive failure speaks, a transient one stays quiet.
  const gone = fresh();
  await runPlaceholderSeatCheck(deps({ calendar: "gone", streak: { count: 0, unreadable: true } }, gone));
  eq(seatPages(gone).length, 1, "a definitive failure speaks when its streak cannot be counted");
  const blip = fresh();
  await runPlaceholderSeatCheck(deps({ calendar: "transient", streak: { count: 0, unreadable: true } }, blip));
  eq(seatPages(blip).length, 0, "a transient one stays quiet");
}
{
  const both = fresh();
  const w: World = { calendar: "not-provisioned", gmail: "gone", streak: { count: 1 } };
  await runPlaceholderSeatCheck(deps(w, both));
  const page = seatPages(both)[0]!;
  assert(page.text.includes("Google Calendar") && page.text.includes("Gmail"), "both surfaces are named");
  assert(page.text.includes("has no Calendar") && page.text.includes("was refused (a credential"), "each with its own kind");
  eq(
    page.subjects,
    ["marcia@trypennie.com:calendar:not-provisioned", "marcia@trypennie.com:gmail:gone"],
    "each failing surface and kind is a subject, so a new one posts at once",
  );
}
{
  // The source never compares a kind with "gone" (AGENTS.md).
  const src = readFileSync("src/lib/monitor/placeholder-seat.ts", "utf8");
  assert(!/===\s*"gone"|"gone"\s*===/.test(src), "the seat check branches on isDefinitiveFailure, never on gone");
}

// --- 2. what clears it ------------------------------------------------------------------

{
  const w: World = { calendar: "gone", streak: { count: 3 } };
  const o = fresh();
  w.calendar = "reachable";
  await runPlaceholderSeatCheck(deps(w, o));
  eq(seatClears(o).length, 1, "a measured healthy tick clears the page");
  assert(seatClears(o)[0]!.text.includes("answers again"), "as a recovery");
  eq(w.streak.count, 0, "and the streak");
}
for (const which of ["loadPlaceholders", "countFutureCalls"] as const) {
  const w: World = { calendar: "gone", streak: { count: 5 } };
  const o = fresh();
  const d = deps(w, o);
  (d as unknown as Record<string, unknown>)[which] = async () => {
    throw new Error(`${which} failed`);
  };
  const r = await runPlaceholderSeatCheck(d);
  eq(r.status, "unreadable", `an unreadable ${which} is unmeasured`);
  eq(o.resolved.length, 0, `an unreadable ${which} clears nothing`);
  eq([o.sent.length, o.probed.length, w.streak.count], [0, 0, 5], `and sends, probes and counts nothing (${which})`);
}
{
  const w: World = { switchOn: null, streak: { count: 5 } };
  const o = fresh();
  const r = await runPlaceholderSeatCheck(deps(w, o));
  eq(r.status, "unreadable", "an unreadable switch is never read as off");
  eq(o.resolved.length, 0, "so it stands nothing down and clears nothing");
  eq([o.sent.length, w.streak.count], [0, 5], "and sends and counts nothing");
}
{
  const w: World = { rows: [{ ...MARCIA, deactivated_at: "2026-10-20T00:00:00Z" }], futureCalls: 2, streak: { count: 1 } };
  const o = fresh();
  const r = await runPlaceholderSeatCheck(deps(w, o));
  eq(r.status === "checked" && r.seat, "no-seat", "no usable seat is not probed");
  eq(seatClears(o).length, 0, "and is no measurement of the seat, so its page stays");
}

// --- 3. not in use --------------------------------------------------------------------------

{
  const w: World = { switchOn: false, futureCalls: 0, calendar: "gone", streak: { count: 1 } };
  const o = fresh();
  const r = await runPlaceholderSeatCheck(deps(w, o));
  eq(r.status === "checked" && r.seat, "not-in-use", "switched off with no call on it: not in use");
  eq(o.probed, [], "and not probed");
  eq(seatClears(o).map((c) => c.text), [PLACEHOLDER_SEAT_STOOD_DOWN], "an open page closes as a stand down");
  assert(PLACEHOLDER_SEAT_STOOD_DOWN.includes("Nothing was fixed"), "which says nothing was fixed");
}
{
  const w: World = { switchOn: false, futureCalls: 3, calendar: "gone", streak: { count: 1 } };
  const o = fresh();
  await runPlaceholderSeatCheck(deps(w, o));
  eq(seatPages(o).length, 1, "switched off but with calls still on it, the seat is checked and pages");
}

// --- 4. no usable placeholder ---------------------------------------------------------------

{
  eq(missingReason([]), "no-row", "no row");
  eq(missingReason([{ ...MARCIA, deactivated_at: "2026-10-20T00:00:00Z" }]), "deactivated", "a deactivated row");
  eq(missingReason([{ ...MARCIA, email: null }]), "no-address", "a row with no address");
  eq(missingReason([MARCIA]), null, "a usable row");
  const texts = (["no-row", "deactivated", "no-address"] as const).map(formatPlaceholderMissingAlert);
  eq(new Set(texts).size, 3, "each cause in its own words (L11)");
}
{
  const o = fresh();
  await runPlaceholderSeatCheck(deps({ rows: [], streak: { count: 0 } }, o));
  const missing = o.sent.filter((s) => s.key === PLACEHOLDER_MISSING_KEY);
  eq(missing.length, 1, "switch on and no placeholder pages (L1)");
  eq(missing[0]!.subjects, ["no-row"], "naming the cause as its subject");
}
{
  const o = fresh();
  await runPlaceholderSeatCheck(deps({ switchOn: false, rows: [], streak: { count: 0 } }, o));
  eq(o.sent.length, 0, "switch off and no placeholder says nothing");
  eq(o.resolved.find((r) => r.key === PLACEHOLDER_MISSING_KEY)?.text, PLACEHOLDER_MISSING_SWITCHED_OFF, "and an open page closes as switched off");
  const healthy = fresh();
  await runPlaceholderSeatCheck(deps({ streak: { count: 0 } }, healthy));
  eq(healthy.resolved.find((r) => r.key === PLACEHOLDER_MISSING_KEY)?.text, PLACEHOLDER_MISSING_RECOVERY, "a usable placeholder is the recovery");
}

// --- classification and copy -------------------------------------------------------------------

eq(alertKindOf(PLACEHOLDER_SEAT_KEY), "condition", "the seat page is a condition");
eq(alertKindOf(PLACEHOLDER_MISSING_KEY), "condition", "the missing page is a condition");
for (const t of [
  formatPlaceholderSeatAlert([{ email: "m@x", surface: "calendar", kind: "transient" }]),
  formatPlaceholderMissingAlert("no-row"),
  PLACEHOLDER_SEAT_STOOD_DOWN,
  PLACEHOLDER_MISSING_RECOVERY,
  PLACEHOLDER_MISSING_SWITCHED_OFF,
]) {
  assert(!DASHES.test(t), `no dash as punctuation: ${t.slice(0, 40)}`);
  assert(!t.toLowerCase().startsWith("slate"), "never opens with the word Slate");
}

finish();
