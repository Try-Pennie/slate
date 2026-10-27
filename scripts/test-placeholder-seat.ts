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
//      with the switch off it says nothing and an open page closes as switched off;
//   5. the seat's Gmail auto reply (#4265): off, restricted or no longer the decided text
//      pages as a definitive failure, a failed read is classified like any Google read,
//      and a read permission not granted yet is its own outcome, said in its own words
//      on the page and the all clear, never a seat failure and never a page by itself.
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
  type AutoReplyProbe,
  type VacationSettings,
  judgeAutoReply,
  isScopeNotGranted,
  formatPlaceholderSeatRecovery,
  PLACEHOLDER_SEAT_AUTO_REPLY,
  AUTO_REPLY_UNCHECKED,
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
  autoReply?: AutoReplyProbe;
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
    probeAutoReply: async (email) => {
      out.probed.push(`auto-reply:${email}`);
      return w.autoReply ?? "matches";
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

// --- 5. the seat's Gmail auto reply (#4265) -------------------------------------------------

const DECIDED = PLACEHOLDER_SEAT_AUTO_REPLY;
const NOW_MS = Date.UTC(2026, 9, 27, 15, 0, 0);
const on = (over: Partial<VacationSettings> = {}): VacationSettings => ({
  enableAutoReply: true,
  responseBodyPlainText: DECIDED,
  restrictToContacts: false,
  restrictToDomain: false,
  ...over,
});
{
  eq(
    DECIDED,
    "Hi, thanks for writing. Nobody reads this inbox, so we won't see your email. To change your call or ask a question, " +
      "reply to one of our texts and someone will answer you there. Thank you, the Pennie team",
    "the decided text is Dan's, word for word (#4206, 2026-10-26)",
  );
  eq(judgeAutoReply(on(), NOW_MS), "matches", "on, unrestricted and the decided text: it matches");
  eq(judgeAutoReply(on({ enableAutoReply: false }), NOW_MS), "off", "switched off is off");
  eq(judgeAutoReply({}, NOW_MS), "off", "a responder Gmail reports nothing about is off, never assumed on");
  eq(judgeAutoReply(on({ endTime: String(NOW_MS - 1) }), NOW_MS), "off", "past its end date it is off");
  eq(judgeAutoReply(on({ startTime: String(NOW_MS + 60_000) }), NOW_MS), "off", "before its start date it is off");
  eq(judgeAutoReply(on({ startTime: String(NOW_MS - 1), endTime: String(NOW_MS + 60_000) }), NOW_MS), "matches", "inside its dates it is on");
  eq(judgeAutoReply(on({ restrictToContacts: true }), NOW_MS), "restricted", "answering only contacts misses every customer");
  eq(judgeAutoReply(on({ restrictToDomain: true }), NOW_MS), "restricted", "answering only the Workspace misses every customer");
  eq(judgeAutoReply(on({ responseBodyPlainText: "Out of office until Monday." }), NOW_MS), "text-changed", "another text is changed");
  eq(judgeAutoReply(on({ responseBodyPlainText: "" }), NOW_MS), "text-changed", "an empty text is changed");
  // What Gmail's own settings page saves: HTML, line breaks, a curly apostrophe.
  const typed =
    '<div dir="ltr">Hi, thanks for writing. Nobody reads this inbox, so we won’t see your email.<br><br>' +
    "To change your call or ask a question, reply to one of our texts and someone will answer you there.<br><br>" +
    "Thank you,<br>the Pennie team&nbsp;</div>";
  eq(
    judgeAutoReply(on({ responseBodyPlainText: undefined, responseBodyHtml: typed }), NOW_MS),
    "matches",
    "the same words typed into Gmail's editor match: markup, breaks and a curly apostrophe are not a change",
  );
  eq(
    judgeAutoReply(on({ responseBodyPlainText: undefined, responseBodyHtml: typed.replace("texts", "emails") }), NOW_MS),
    "text-changed",
    "control: one word changed in that same HTML is a change (L1)",
  );
}
{
  eq(isScopeNotGranted(401, "unauthorized_client"), true, "the token endpoint's refusal of an ungranted scope is not granted");
  eq(isScopeNotGranted(400, "unauthorized_client"), true, "whichever status it comes with");
  eq(isScopeNotGranted(400, "invalid_grant"), false, "a removed account is not a missing permission");
  eq(isScopeNotGranted(401, undefined), false, "nor is a bare 401");
  eq(isScopeNotGranted(undefined, undefined), false, "nor a timeout");
}
for (const problem of ["off", "restricted", "text-changed"] as const) {
  const w: World = { autoReply: problem, streak: { count: 0 } };
  const first = fresh();
  await runPlaceholderSeatCheck(deps(w, first));
  eq(seatPages(first).length, 0, `a first ${problem} tick is held for the next one`);
  const second = fresh();
  const r = await runPlaceholderSeatCheck(deps(w, second));
  const page = seatPages(second)[0];
  eq(seatPages(second).length, 1, `${problem}: a second tick in a row pages, as definitive`);
  eq(page?.band, 2, `${problem}: the worse band`);
  eq(page?.subjects, [`marcia@trypennie.com:auto-reply:${problem}`], `${problem}: its own subject`);
  assert(/auto reply/.test(page?.text ?? ""), `${problem}: the page names the auto reply`);
  assert(!/repair the account/.test(page?.text ?? ""), `${problem}: and does not send the reader to repair the account`);
  assert(!/may get neither/.test(page?.text ?? ""), `${problem}: nor claim invites and reminders are at risk`);
  eq(r.status === "checked" && r.seat, "failing", `${problem}: the seat reads as failing`);
}
{
  const texts = (["off", "restricted", "text-changed"] as const).map((problem) =>
    formatPlaceholderSeatAlert([{ email: "m@x", surface: "auto-reply", problem }], { autoReplyUnchecked: false }),
  );
  eq(new Set(texts).size, 3, "each auto reply problem in its own words (L11)");
}
{
  // A failed READ of the responder is a Google read failing, judged like the others.
  const w: World = { autoReply: "transient", streak: { count: 0 } };
  const pages: number[] = [];
  for (let i = 0; i < PLACEHOLDER_SEAT_TRANSIENT_TICKS; i++) {
    const o = fresh();
    await runPlaceholderSeatCheck(deps(w, o));
    pages.push(seatPages(o).length);
  }
  eq(pages, [0, 0, 0, 1], "a transient read of the auto reply pages only on the fourth tick");
}
{
  // NOT GRANTED YET: Dan decided to grant gmail.settings.basic (2026-10-26), and until
  // he does every read is refused. That is not the seat failing.
  const w: World = { autoReply: "not-granted", calendar: "gone", streak: { count: 3 } };
  const healed = fresh();
  w.calendar = "reachable";
  const r = await runPlaceholderSeatCheck(deps(w, healed));
  eq(r.status === "checked" && r.seat, "healthy", "an ungranted read with both other probes answering is a healthy seat");
  eq(r.status === "checked" && r.autoReplyUnchecked, ["marcia@trypennie.com"], "and the result names the seat whose auto reply went unread");
  eq(seatPages(healed).length, 0, "it pages nothing on its own");
  eq(seatClears(healed).length, 1, "the measured recovery still clears an open page");
  assert(seatClears(healed)[0]!.text.includes(AUTO_REPLY_UNCHECKED), "and says, in its own words, that the auto reply was not checked");
  assert(!/auto reply is on/.test(seatClears(healed)[0]!.text), "never that the auto reply is fine");
  eq(w.streak.count, 0, "and the streak clears");

  const quiet = fresh();
  for (let i = 0; i < 5; i++) await runPlaceholderSeatCheck(deps({ autoReply: "not-granted", streak: { count: 0 } }, quiet));
  eq(seatPages(quiet).length, 0, "five ungranted ticks in a row page nothing");

  const both = fresh();
  await runPlaceholderSeatCheck(deps({ autoReply: "not-granted", gmail: "gone", streak: { count: 1 } }, both));
  assert(seatPages(both)[0]!.text.includes(AUTO_REPLY_UNCHECKED), "a seat page while the read is ungranted says the auto reply went unchecked");
  eq(seatPages(both)[0]!.subjects, ["marcia@trypennie.com:gmail:gone"], "and the ungranted read is no subject of it");
}
{
  const checked = fresh();
  await runPlaceholderSeatCheck(deps({ calendar: "reachable", streak: { count: 2 } }, checked));
  assert(/auto reply is on/.test(seatClears(checked)[0]!.text), "a measured matching auto reply is named in the all clear");
  eq(AUTO_REPLY_UNCHECKED.includes("gmail.settings.basic"), true, "the unchecked sentence names the permission to grant");
}
{
  const o = fresh();
  await runPlaceholderSeatCheck(deps({ switchOn: false, futureCalls: 0, streak: { count: 0 } }, o));
  eq(o.probed, [], "a seat not in use has its auto reply left unread too");
}

// --- classification and copy -------------------------------------------------------------------

eq(alertKindOf(PLACEHOLDER_SEAT_KEY), "condition", "the seat page is a condition");
eq(alertKindOf(PLACEHOLDER_MISSING_KEY), "condition", "the missing page is a condition");
for (const t of [
  formatPlaceholderSeatAlert([{ email: "m@x", surface: "calendar", kind: "transient" }], { autoReplyUnchecked: false }),
  formatPlaceholderSeatAlert([{ email: "m@x", surface: "auto-reply", problem: "off" }], { autoReplyUnchecked: false }),
  formatPlaceholderSeatAlert([{ email: "m@x", surface: "gmail", kind: "gone" }], { autoReplyUnchecked: true }),
  formatPlaceholderSeatRecovery(["m@x"], { autoReplyUnchecked: false }),
  formatPlaceholderSeatRecovery(["m@x"], { autoReplyUnchecked: true }),
  formatPlaceholderMissingAlert("no-row"),
  PLACEHOLDER_SEAT_STOOD_DOWN,
  PLACEHOLDER_MISSING_RECOVERY,
  PLACEHOLDER_MISSING_SWITCHED_OFF,
]) {
  assert(!DASHES.test(t), `no dash as punctuation: ${t.slice(0, 40)}`);
  assert(!t.toLowerCase().startsWith("slate"), "never opens with the word Slate");
}

finish();
