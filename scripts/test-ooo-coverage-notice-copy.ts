// What the manager's time off notice SAYS about the appointments a coverage
// sweep will move, and about the ones it moved (#1239).
//
// Every state is asserted here because none of them is reachable from a preview
// tool: `pnpm preview:alerts` renders the alert catalog and these are Slack
// notifications to one manager, not alerts. The builders are pure and hold every
// sentence, so this file is the place the wording can be read before it ships.
// Run: node --experimental-strip-types scripts/test-ooo-coverage-notice-copy.ts
import {
  COVERAGE_SHORT_NOTICE_MS,
  approvedCoverageLine,
  cancelledCoverageLine,
  pendingCoverageLine,
  type CoverageMove,
} from "../src/lib/ooo/coverage-notice-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const TZ = { tzId: "America/New_York", tzLabel: "ET" };
const NOW = "2026-06-12T12:00:00Z";

/** A move starting `minutes` from NOW, as the snapshot records it. */
function move(minutes: number, attendeeName: string | null): CoverageMove {
  const start = new Date(Date.parse(NOW) + minutes * 60_000);
  return {
    startsAtIso: start.toISOString(),
    endsAtIso: new Date(start.getTime() + 30 * 60_000).toISOString(),
    attendeeName,
  };
}

// --- the pending notice: a count as of submit time -------------------------

assert(
  pendingCoverageLine(0) === null,
  "nothing to move says nothing: the line only appears above zero",
);

const one = pendingCoverageLine(1) ?? "";
assert(/\b1 upcoming appointment\b/.test(one), "one appointment is singular");
assert(!/appointments/.test(one), "one appointment does not say appointments");
assert(/approve/.test(one), "the line says the move happens on approval");
assert(
  /right now|can grow/.test(one),
  "the line says the count is as of now, because it drifts upward while the request waits",
);

const many = pendingCoverageLine(12) ?? "";
assert(/\b12 upcoming appointments\b/.test(many), "many appointments are plural");

// The failure path. An unreadable count must NEVER render as the zero state,
// because "no line" is how a manager reads "nothing will move" (L11, and the
// AGENTS.md rule about what an empty result means downstream).
const unreadable = pendingCoverageLine(null);
assert(unreadable !== null, "an unreadable count still says something");
assert(
  !/^0 |no upcoming/i.test(unreadable ?? ""),
  "an unreadable count never claims zero",
);
assert(
  /could not read/.test(unreadable ?? "") && /check/.test(unreadable ?? ""),
  "an unreadable count says it could not be read and what to do",
);
assert(
  unreadable !== pendingCoverageLine(0) && unreadable !== one,
  "the unreadable state reads differently from both zero and a real count",
);

// --- the approved edit: what was actually queued ----------------------------

const none = approvedCoverageLine({ kind: "queued", queued: 0, moves: [] }, { nowIso: NOW, ...TZ });
assert(
  none !== null && /nothing/i.test(none),
  "a sweep with nothing in the window says so rather than staying silent",
);

const queued = approvedCoverageLine(
  { kind: "queued", queued: 3, moves: [move(600, "Jane Smith"), move(700, null), move(800, "Ed")] },
  { nowIso: NOW, ...TZ },
);
assert(/\b3 upcoming appointments\b/.test(queued ?? ""), "the edit reports what was queued");
assert(
  !/within the next/.test(queued ?? ""),
  "nothing inside the short notice window means no short notice sentence",
);

const shortNoticeMinutes = COVERAGE_SHORT_NOTICE_MS / 60_000;
const soon = approvedCoverageLine(
  {
    kind: "queued",
    queued: 2,
    moves: [move(shortNoticeMinutes - 30, "Jane Smith"), move(600, "Later Larry")],
  },
  { nowIso: NOW, ...TZ },
);
assert(/\b2 upcoming appointments\b/.test(soon ?? ""), "the count still leads the edit");
assert(/Jane Smith/.test(soon ?? ""), "an appointment starting soon is named");
assert(
  !/Later Larry/.test(soon ?? ""),
  "an appointment outside the short notice window is not named",
);
assert(/call/i.test(soon ?? ""), "the short notice sentence says to call the customer");

// An appointment exactly ON the threshold is not short notice: the boundary is
// stated rather than left to whichever comparison somebody typed.
const onBoundary = approvedCoverageLine(
  { kind: "queued", queued: 1, moves: [move(shortNoticeMinutes, "Boundary Bob")] },
  { nowIso: NOW, ...TZ },
);
assert(
  !/Boundary Bob/.test(onBoundary ?? ""),
  "an appointment exactly at the threshold is outside the short notice window",
);

// A customer whose name we do not hold still gets named as an appointment,
// because the time is what the person needs in order to make the call.
const nameless = approvedCoverageLine(
  { kind: "queued", queued: 1, moves: [move(30, null)] },
  { nowIso: NOW, ...TZ },
);
assert(/a customer/.test(nameless ?? ""), "a nameless attendee still appears as an appointment");

// An unreadable start time is NAMED rather than dropped. Dropping it would hide
// exactly the appointment nobody can classify, and the harm of a missed call is
// worse than the harm of one extra line.
const badStamp = approvedCoverageLine(
  {
    kind: "queued",
    queued: 1,
    moves: [{ startsAtIso: "not-a-date", endsAtIso: "not-a-date", attendeeName: "Unknown Ursula" }],
  },
  { nowIso: NOW, ...TZ },
);
assert(
  /Unknown Ursula/.test(badStamp ?? ""),
  "an appointment whose start cannot be read is named rather than silently dropped",
);

// A long list is trimmed, and says how many it trimmed.
const lots = approvedCoverageLine(
  {
    kind: "queued",
    queued: 5,
    moves: [1, 2, 3, 4, 5].map((i) => move(i * 10, `Customer ${i}`)),
  },
  { nowIso: NOW, ...TZ },
);
assert(/Customer 1/.test(lots ?? ""), "the soonest named appointment is first");
assert(/2 more/.test(lots ?? ""), "a trimmed list says how many were left out");

const failed = approvedCoverageLine(
  { kind: "failed", reason: "sweep store unreachable" },
  { nowIso: NOW, ...TZ },
);
assert(
  /could not/.test(failed ?? "") && /sweep store unreachable/.test(failed ?? ""),
  "a failed sweep says so and carries the short reason",
);
assert(
  /[Rr]etry/.test(failed ?? ""),
  "a failed sweep names the action that fixes it",
);
assert(
  !/(was|were) queued to move/.test(failed ?? ""),
  "a failed sweep never claims a number of appointments was queued",
);

const already = approvedCoverageLine({ kind: "already" }, { nowIso: NOW, ...TZ });
assert(
  already !== null && /already/.test(already),
  "a sweep that had already been started says that rather than a number it does not hold",
);

// --- cancelling: the appointments that already moved stay moved -------------

const cancelledApproved = cancelledCoverageLine(true) ?? "";
assert(
  /stay/.test(cancelledApproved) && /not move them back/i.test(cancelledApproved),
  "cancelling approved time off states that moved appointments stay with the new advisor",
);
assert(
  cancelledCoverageLine(false) === null,
  "a request that was never approved moved nothing, so it says nothing",
);

// --- the copy rules, over every state --------------------------------------

const everyLine = [
  one,
  many,
  unreadable,
  none,
  queued,
  soon,
  nameless,
  badStamp,
  lots,
  failed,
  already,
  cancelledApproved,
].filter((s): s is string => typeof s === "string");
assert(everyLine.length >= 12, "every state produced a line to check");
for (const line of everyLine) {
  // Written as escapes so this file holds no literal dash for the style guard to
  // catch: it cannot tell the line banning the character from a line using it.
  assert(!/[\u2014\u2013]/.test(line), `no em or en dash in: ${line.slice(0, 60)}`);
  assert(!/undefined|NaN|\[object Object\]|null/.test(line), `no leaked value in: ${line.slice(0, 60)}`);
  assert(line.trim().length > 0, "no empty line");
}

finish();
