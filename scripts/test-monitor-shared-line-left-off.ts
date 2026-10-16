// The shared confirm line switched on, and then left OFF (#3339). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-monitor-shared-line-left-off.ts
//
// THE FAILURE THIS WATCHES. The shared confirm line (#3325) is a switch on the admin
// Hours page. Once it is on, turning it off is the lever for containing a line problem,
// and the ordinary failure is that nobody turns it back: every server then keeps its own
// line again, and the next crowd for one time saturates the database the way load run
// 37333201026 did, with every other signal reading healthy (L523).
//
// WHAT MUST NOT PAGE. Production has never had the switch on. Until somebody has turned
// it on, off is the expected state and not a finding, so the check reads WHEN it was
// activated from the audit trail the admin action already writes (`booking.settings`,
// `{ shared_confirm_line: true }`), which is immutable, rather than from a new column.
//
// WHY IT IS A CONDITION. It stays true until a person turns the line back on, so it
// carries an all clear, hung off a tick that READ the switch as on, never off a tick
// that said nothing (#1134, #1152).
//
// No clock, no network, no database: every instant is passed in.
import {
  SHARED_LINE_LEFT_OFF_KEY,
  SHARED_LINE_OFF_NOTICE_AFTER_MS,
  sharedLineLeftOffAction,
  formatSharedLineLeftOffAlert,
  formatSharedLineBackOnRecovery,
  runSharedLineLeftOffCheck,
  type SharedLineSwitchHistory,
} from "../src/lib/monitor/shared-line-left-off.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { alertFamily } from "../src/lib/notify/alert-runbook.ts";
import { ALERT_KEYS, ALERT_FIELDS, MONITOR_DEFAULTS } from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Printable ASCII only: catches an em dash, an en dash and an emoji in one read. */
const PLAIN = /^[\x20-\x7E\n]*$/;

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// --- the threshold is Dan's "more than a day" ------------------------------------
eq(SHARED_LINE_OFF_NOTICE_AFTER_MS, DAY, "the notice waits a day after the switch was turned off (#3339)");

// --- what the judge does with each state ----------------------------------------
{
  const judge = (reading: SharedLineSwitchHistory, open: boolean | null = true, nowMs = NOW) =>
    sharedLineLeftOffAction({ reading, nowMs, open, thresholdMs: SHARED_LINE_OFF_NOTICE_AFTER_MS });

  eq(judge({ on: true, lastOnAtMs: null, offSinceMs: null }).act, "clear", "the line switched on is the measured healthy result that ends the notice");
  eq(judge({ on: true, lastOnAtMs: null, offSinceMs: null }, false).act, "clear", "and it clears outside business hours too");

  // Never activated: production today. Off is the expected state, so nothing is said,
  // whatever the hours and however long it has been.
  const dormant = judge({ on: false, lastOnAtMs: null, offSinceMs: null });
  eq(dormant.act, "dormant", "a switch nobody has ever turned on is NOT left off: it is the expected state, and says nothing");
  eq(judge({ on: false, lastOnAtMs: null, offSinceMs: null }, null).act, "dormant", "with the week unreadable too");

  const fresh = judge({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - 2 * HOUR });
  eq(fresh.act, "hold", "turned off two hours ago: the lever is being used as intended, nothing is said");
  eq(fresh.act === "hold" ? fresh.elapsedMs : null, 2 * HOUR, "and the span is measured from when it was turned OFF");

  const edge = judge({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - DAY + 1 });
  eq(edge.act, "hold", "a millisecond under a day is still under it");

  const over = judge({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - DAY });
  eq(over.act, "speak", "a day after it was turned off, with the org open, it speaks");
  eq(over.act === "speak" ? over.elapsedMs : null, DAY, "carrying the span it measured");

  const shut = judge({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - 2 * DAY }, false);
  eq(shut.act, "hold", "past a day while the org is shut it waits for the day to start");
  assert(shut.act === "hold" && shut.why.trim().length > 0, "and the hold says why");
  eq(judge({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - 2 * DAY }, null).act, "speak", "an unreadable week errs toward speaking");

  // On, and then off with nothing recording when (hand SQL, or an audit write that
  // failed). The last time it was turned on bounds how long it can have been off.
  const recent = judge({ on: false, lastOnAtMs: NOW - 5 * HOUR, offSinceMs: null });
  eq(recent.act, "hold", "turned on five hours ago and off since, unrecorded: it cannot have been off for a day yet");
  const unrecorded = judge({ on: false, lastOnAtMs: NOW - 2 * DAY, offSinceMs: null });
  eq(unrecorded.act, "speak", "turned on two days ago and off with no record of when: it may have stood a day, so it speaks");
  eq(unrecorded.act === "speak" ? unrecorded.elapsedMs : 0, null, "without inventing a span it never measured");

  // Clock skew between two machines must not render a negative age.
  const skew = judge({ on: false, lastOnAtMs: NOW - DAY, offSinceMs: NOW + 5_000 });
  eq(skew.act === "hold" ? skew.elapsedMs : -1, 0, "a stamp ahead of the reader's clock is clamped to zero");
}

// --- the copy ---------------------------------------------------------------------
{
  const measured = formatSharedLineLeftOffAlert(DAY + 3 * HOUR);
  const unknown = formatSharedLineLeftOffAlert(null);
  const back = formatSharedLineBackOnRecovery();
  for (const [name, text] of [["measured", measured], ["unrecorded", unknown], ["recovery", back]] as const) {
    assert(PLAIN.test(text) && text.length > 60, `${name}: plain words, long enough to act on`);
    assert(!/^Slate/.test(text), `${name}: does not open with Slate, which Slack already shows`);
  }
  assert(/27 hours/.test(measured), `the notice says how long it has stood (${measured})`);
  assert(/business hours page/.test(measured) && /business hours page/.test(unknown), "and names the one place it is switched back on");
  assert(/own line/.test(measured), "and what it costs: every server back on its own line");
  assert(/nothing recorded when/i.test(unknown), `the unrecorded notice says it does not know when (${unknown})`);
  assert(!/\d+ (hour|day|minute)/.test(unknown), "and quotes no span it never measured");
}

// --- the runner: speaks, holds, clears ONLY off a measured on -------------------
async function main() {
  const run = async (reading: SharedLineSwitchHistory, open: boolean | null = true) => {
    const sent: { key: string; cooldownMs: number; text: string }[] = [];
    const resolved: { key: string; text: string }[] = [];
    const verdict = await runSharedLineLeftOffCheck({
      reading,
      nowMs: NOW,
      open,
      thresholdMs: SHARED_LINE_OFF_NOTICE_AFTER_MS,
      notify: async (key, cooldownMs, text) => {
        sent.push({ key, cooldownMs, text });
        return true;
      },
      resolve: async (key, text) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 777,
    });
    return { verdict, sent, resolved };
  };

  {
    const r = await run({ on: true, lastOnAtMs: null, offSinceMs: null });
    eq(r.verdict.status, "on", "a tick that read the switch on reports it on");
    eq(r.resolved.map((x) => x.key).join(), SHARED_LINE_LEFT_OFF_KEY, "and it, alone, clears the notice");
    eq(r.sent.length, 0, "and says nothing else");
  }
  {
    const r = await run({ on: false, lastOnAtMs: null, offSinceMs: null });
    eq(r.verdict.status, "never-activated", "a switch never turned on is reported as such, never as off or on");
    eq(r.sent.length + r.resolved.length, 0, "and neither speaks nor clears: nothing could have paged, and nothing healthy was measured");
  }
  {
    const r = await run({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - 2 * DAY });
    eq(r.verdict.status, "off", "a switch left off is reported off");
    eq(r.sent.length, 1, "and speaks once");
    eq(r.sent[0]?.key, SHARED_LINE_LEFT_OFF_KEY, "under its own key");
    eq(r.sent[0]?.cooldownMs, 777, "on the cooldown it was handed");
    eq(r.resolved.length, 0, "and a tick reporting the switch off clears NOTHING (#1134)");
  }
  {
    const r = await run({ on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - HOUR });
    eq(r.verdict.status, "off", "a switch turned off an hour ago is off");
    eq(r.sent.length + r.resolved.length, 0, "and the tick holding under the threshold neither speaks nor clears");
  }
  {
    // A notify that throws must not fail the tick or misreport what it did.
    const verdict = await runSharedLineLeftOffCheck({
      reading: { on: false, lastOnAtMs: NOW - 3 * DAY, offSinceMs: NOW - 2 * DAY },
      nowMs: NOW,
      open: true,
      thresholdMs: SHARED_LINE_OFF_NOTICE_AFTER_MS,
      notify: async () => {
        throw new Error("slack is down");
      },
      resolve: async () => true,
      cooldownMs: 1,
    });
    eq(verdict.status, "off", "a Slack failure still reports the measured state");
  }

  // --- the key is catalogued as a condition, previewable and configurable ----------
  const entry = ALERT_CATALOG.find((e) => e.key === SHARED_LINE_LEFT_OFF_KEY);
  eq(entry?.kind, "condition", "the notice is a CONDITION in the catalog, so it must carry an all clear");
  assert(alertFamily(SHARED_LINE_LEFT_OFF_KEY) !== undefined, "it has a runbook family");
  assert((ALERT_KEYS as readonly string[]).includes(SHARED_LINE_LEFT_OFF_KEY), "it is on the monitor settings screen");
  assert(ALERT_FIELDS.some((f) => f.key === SHARED_LINE_LEFT_OFF_KEY), "with a label and help text");
  assert(typeof (MONITOR_DEFAULTS.cooldownMs as Record<string, number>)[SHARED_LINE_LEFT_OFF_KEY] === "number", "and a default cooldown");

  finish();
}

void main();
