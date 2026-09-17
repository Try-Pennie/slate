// Public booking has been STOPPED and left that way (#2366). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-monitor-booking-pause.ts
//
// THE FAILURE THIS WATCHES. #2297 gave Slate a kill switch and #2297 also made it
// visible, as a row on the admin Overview saying whether public booking is running.
// That helps whoever looks. The ordinary failure is that nobody does: somebody stops
// bookings at 2am to contain a problem, fixes the problem, and does not flip it back.
// Slate then takes zero bookings while every other signal reads healthy, because
// everything else IS healthy. What eventually notices is the low booking volume
// alarm, and it reports a drought, which sends a reader to the funnel, the embed and
// the availability cache, every one of which is fine.
//
// WHY IT IS A CONDITION AND NOT AN INCIDENT. It is true until a person turns booking
// back on, and the reader of the notice needs to know when that has happened, so it
// carries an all clear (src/lib/notify/alert-catalog.ts). The all clear hangs off a
// tick that READ the flag and found it false, never off a tick that said nothing
// (#1134, #1152), and that is the assertion this file spends most of its length on.
//
// WHY IT IS NOT A FAULT. Somebody pulled that switch deliberately. The message says
// how long it has stood and asks whether it is still meant to be off, rather than
// reporting a defect nobody caused.
//
// No clock, no network, no database: every instant is passed in.
import {
  PUBLIC_BOOKING_STOPPED_KEY,
  PAUSE_NOTICE_AFTER_MS,
  bookingPauseAction,
  formatPublicBookingStoppedAlert,
  formatPublicBookingRunningRecovery,
  runBookingPauseCheck,
} from "../src/lib/monitor/booking-pause.ts";
import { LOW_VOLUME_WINDOW_MINUTES } from "../src/lib/monitor/booking-volume.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { alertFamily } from "../src/lib/notify/alert-runbook.ts";
import { ALERT_KEYS, ALERT_FIELDS, MONITOR_DEFAULTS } from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Printable ASCII only: catches an em dash, an en dash and an emoji in one read,
 *  and this file holds no literal one of any of them to be caught by the style hook. */
const PLAIN = /^[\x20-\x7E\n]*$/;

const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const MIN = 60_000;

// --- the threshold is DERIVED, not preferred -----------------------------------
//
// How long is too long has to come from somewhere checkable. It is the LONGEST
// window Slate already treats as long enough to say something about bookings not
// happening: the low volume alarm's long window. Below that the product itself does
// not consider a quiet stretch worth a word, so a notice firing sooner would call a
// stretch too long while the alarm beside it called the same stretch ordinary.
{
  eq(
    PAUSE_NOTICE_AFTER_MS,
    LOW_VOLUME_WINDOW_MINUTES.long * MIN,
    "the notice waits exactly as long as the low volume alarm's long window, read from that " +
      "constant rather than restated here, so moving one moves the other (L41, L401)",
  );
  assert(
    PAUSE_NOTICE_AFTER_MS > 30 * MIN,
    "and it is far longer than the minutes the lever is meant to be held for, so containing an " +
      "incident never trips it",
  );
  assert(
    PAUSE_NOTICE_AFTER_MS <= 4 * 60 * MIN,
    "and short enough to land inside the same working day, rather than after a day of leads",
  );
}

// --- what the judge does with each state ---------------------------------------
{
  const judge = (
    reading: { paused: boolean; sinceMs: number | null },
    open: boolean | null,
    nowMs = NOW,
  ) => bookingPauseAction({ reading, nowMs, open, thresholdMs: PAUSE_NOTICE_AFTER_MS });

  eq(
    judge({ paused: false, sinceMs: null }, true).act,
    "clear",
    "booking running is a MEASURED healthy result, so it ends the notice",
  );
  eq(
    judge({ paused: false, sinceMs: null }, false).act,
    "clear",
    "and it clears outside business hours too: the hours decide when to SPEAK about a stopped " +
      "switch, never whether a running one is running",
  );
  eq(
    judge({ paused: false, sinceMs: null }, null).act,
    "clear",
    "and with the org's week unreadable, for the same reason",
  );

  const fresh = judge({ paused: true, sinceMs: NOW - 5 * MIN }, true);
  eq(fresh.act, "hold", "five minutes in, the lever is being used as intended and nothing is said");
  eq(fresh.elapsedMs, 5 * MIN, "and the elapsed time is measured from when the switch was SET");

  const edge = judge({ paused: true, sinceMs: NOW - PAUSE_NOTICE_AFTER_MS + 1 }, true);
  eq(edge.act, "hold", "a millisecond under the threshold is still under it");

  const over = judge({ paused: true, sinceMs: NOW - PAUSE_NOTICE_AFTER_MS }, true);
  eq(over.act, "speak", "at the threshold, with the org open, it speaks");
  eq(over.elapsedMs, PAUSE_NOTICE_AFTER_MS, "carrying the span it measured");

  const shut = judge({ paused: true, sinceMs: NOW - 9 * 60 * MIN }, false);
  eq(
    shut.act,
    "hold",
    "past the threshold while the org is SHUT it waits: nobody is being turned away at 3am and " +
      "nobody can act on it either, so the notice lands when the day starts (L112)",
  );
  assert(shut.why.trim().length > 0, "and the hold says why, so a silent tick is never a mystery");

  // The 2am case the issue is actually about, walked hour by hour.
  const stoppedAt2am = Date.UTC(2026, 8, 17, 6, 0, 0);
  eq(
    judge({ paused: true, sinceMs: stoppedAt2am }, false, stoppedAt2am + 3 * 60 * MIN).act,
    "hold",
    "5am, still shut, still quiet",
  );
  eq(
    judge({ paused: true, sinceMs: stoppedAt2am }, true, stoppedAt2am + 6 * 60 * MIN).act,
    "speak",
    "8am, the org opens, and the notice is waiting: the clock ran from the SET, so a night of " +
      "silence did not reset it",
  );

  // An unreadable week errs toward speaking. The fact being reported is fully
  // measured (bookings have been stopped for longer than the threshold); only the
  // courtesy of choosing a civil hour is unknown, and being silent for days is the
  // failure this whole check exists to end.
  eq(
    judge({ paused: true, sinceMs: NOW - 9 * 60 * MIN }, null).act,
    "speak",
    "with the org's week unreadable it speaks anyway, because the hours decide WHEN to speak and " +
      "never WHETHER there is something to say",
  );

  // Stopped with nothing recording when. It cannot be waited out, because there is
  // no clock to wait: a switch somebody set by hand SQL leaves no stamp, and silence
  // about it would be the same silence the issue was filed about.
  const unstamped = judge({ paused: true, sinceMs: null }, true);
  eq(unstamped.act, "speak", "stopped with no recorded start is spoken about rather than waited out");
  eq(unstamped.elapsedMs, null, "and claims no duration it never measured (L11)");

  // A stamp in the future is a clock skew, not a negative age.
  const skewed = judge({ paused: true, sinceMs: NOW + 10 * MIN }, true);
  eq(skewed.act, "hold", "a stamp in the future reads as just set, never as an enormous negative age");
  eq(skewed.elapsedMs, 0, "clamped at zero rather than rendered as a negative span");
}

// --- the runner: what is sent, and what is never sent ---------------------------
type Sent = { key: string; text: string };

function harness(over: Partial<Parameters<typeof runBookingPauseCheck>[0]> = {}) {
  const notified: Sent[] = [];
  const resolved: Sent[] = [];
  const logged: string[] = [];
  const deps = {
    reading: { paused: false, sinceMs: null },
    nowMs: NOW,
    open: true as boolean | null,
    thresholdMs: PAUSE_NOTICE_AFTER_MS,
    cooldownMs: 4 * 60 * MIN,
    notify: async (key: string, _cooldownMs: number, text: string) => {
      notified.push({ key, text });
    },
    resolve: async (key: string, text: string) => {
      resolved.push({ key, text });
      return true;
    },
    log: (msg: string) => logged.push(msg),
    ...over,
  };
  return { deps, notified, resolved, logged };
}

{
  const h = harness({ reading: { paused: false, sinceMs: null } });
  const v = await runBookingPauseCheck(h.deps);
  eq(v.status, "running", "a tick that read the flag and found it false measured health");
  eq(h.notified.length, 0, "and pages about nothing");
  eq(h.resolved.length, 1, "and offers the all clear");
  eq(h.resolved[0]?.key, PUBLIC_BOOKING_STOPPED_KEY, "on the key the notice was sent under");
}

{
  const h = harness({ reading: { paused: true, sinceMs: NOW - 9 * 60 * MIN } });
  const v = await runBookingPauseCheck(h.deps);
  eq(v.status, "stopped", "a tick that read the flag and found it true says so");
  assert(v.status === "stopped" && v.spoke, "and speaks, being well past the threshold in open hours");
  eq(h.notified.length, 1, "exactly once");
  eq(h.notified[0]?.key, PUBLIC_BOOKING_STOPPED_KEY, "on its own key");
  eq(
    h.resolved.length,
    0,
    "and clears NOTHING: a tick that is itself reporting the condition must never also announce " +
      "it is over",
  );
}

{
  const h = harness({ reading: { paused: true, sinceMs: NOW - 5 * MIN } });
  const v = await runBookingPauseCheck(h.deps);
  eq(v.status, "stopped", "under the threshold it still REPORTS the state it measured");
  assert(v.status === "stopped" && !v.spoke, "and says it did not speak, so an observed tick is never mistaken for a sent one");
  eq(h.notified.length, 0, "nothing is sent while the lever is plausibly in use");
  eq(
    h.resolved.length,
    0,
    "and nothing is cleared either: bookings are stopped, which is not a healthy reading whatever " +
      "the threshold says",
  );
}

// THE FAILURE PATH. A notify that throws must not take out the tick, and must never
// leave the check claiming it spoke.
{
  const h = harness({
    reading: { paused: true, sinceMs: NOW - 9 * 60 * MIN },
    notify: async () => {
      throw new Error("slack is down");
    },
  });
  const v = await runBookingPauseCheck(h.deps);
  eq(v.status, "stopped", "a Slack failure does not fail the tick, or it would take out the checks after it");
  eq(h.resolved.length, 0, "and still clears nothing");
}
{
  const h = harness({
    reading: { paused: false, sinceMs: null },
    resolve: async () => {
      throw new Error("alert_state is unreadable");
    },
  });
  const v = await runBookingPauseCheck(h.deps);
  eq(v.status, "running", "a resolve that throws does not fail the tick either");
  eq(h.notified.length, 0, "and pages about nothing");
}

// --- the copy a person actually reads ------------------------------------------
{
  const spoken = formatPublicBookingStoppedAlert(9 * 60 * MIN);
  const unstamped = formatPublicBookingStoppedAlert(null);
  const clear = formatPublicBookingRunningRecovery();

  for (const text of [spoken, unstamped, clear]) {
    assert(PLAIN.test(text), "the message is plain ASCII: no em dash, no en dash, no emoji");
    assert(
      !/undefined|NaN|\[object Object\]|null/.test(text),
      `nothing leaks a placeholder into the message: ${text}`,
    );
    assert(
      !text.startsWith("Slate"),
      "it does not open with the word Slate, which Slack already shows above every line of it",
    );
  }

  assert(/9 hours/.test(spoken), "it says how long booking has been stopped, which is the fact the reader has nowhere else");
  assert(
    /still meant to be|still meant/i.test(spoken),
    "and asks whether that is still intended, because somebody chose this and it is not a defect",
  );
  assert(
    /business hours|admin/i.test(spoken),
    "and names where to turn it back on, so the reader has an action rather than a fact (L111)",
  );
  assert(
    /volume/i.test(spoken),
    "and names the alarm that would otherwise report this as a drought, so the reader is not sent " +
      "after a funnel problem that does not exist",
  );
  // Asserted as the CLAIM the message makes rather than as a banned word (L347): the
  // sentence has to say somebody chose this, and the negative alone would pass on a
  // message that said nothing either way, and fail on one that says "rather than a
  // fault", which is the message doing exactly the right thing.
  assert(
    /on purpose|deliberate/i.test(spoken),
    "and states that somebody turned it off on purpose, so it is read as a deliberate state",
  );
  assert(
    !/\b(broken|error|went wrong|is failing)\b/i.test(spoken),
    "and accuses nothing of being broken, because nothing is",
  );

  assert(
    /how long/i.test(unstamped) || /when/i.test(unstamped),
    "the unstamped variant says the duration is unknown rather than inventing one",
  );
  assert(
    !/\d+ hours?|\d+ minutes?|\d+ days?/.test(unstamped),
    "and quotes no span at all, because none was measured (L11)",
  );
  assert(spoken !== unstamped, "the two are different sentences, so one never answers for the other");

  assert(
    /running again|taking bookings/i.test(clear),
    "the all clear answers the notice's own claim: bookings are being taken again",
  );
  assert(/No action is needed/.test(clear), "and closes the loop rather than leaving a reader wondering");
}

// --- the plumbing every alert key needs, or the suite fails ---------------------
{
  const entry = ALERT_CATALOG.find((e) => e.key === PUBLIC_BOOKING_STOPPED_KEY);
  assert(entry !== undefined, `${PUBLIC_BOOKING_STOPPED_KEY} is in the alert catalog`);
  eq(
    entry?.kind,
    "condition",
    "classified a CONDITION: it is true until a person turns booking back on, and the reader of " +
      "the notice needs to be told when that happened",
  );
  assert(
    alertFamily(PUBLIC_BOOKING_STOPPED_KEY) !== null,
    "and it belongs to a runbook family, so a reader at 7am has a procedure",
  );
  assert(
    ALERT_KEYS.includes(PUBLIC_BOOKING_STOPPED_KEY as (typeof ALERT_KEYS)[number]),
    "and its cooldown is tunable from the settings screen like every other key",
  );
  assert(
    ALERT_FIELDS.some((f) => f.key === PUBLIC_BOOKING_STOPPED_KEY),
    "and it has a field there, or it would be a cooldown nobody can reach",
  );
  const cooldown = (MONITOR_DEFAULTS.cooldownMs as Record<string, number>)[PUBLIC_BOOKING_STOPPED_KEY];
  assert(typeof cooldown === "number", "and a coded default cooldown");
  assert(
    cooldown >= 60 * MIN,
    "which repeats no more than hourly: it is a question about a deliberate state, not a page",
  );
}

finish();
