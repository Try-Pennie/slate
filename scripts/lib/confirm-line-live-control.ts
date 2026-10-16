// The decision logic behind `pnpm verify:confirm-line` (#3340), apart from the live IO so
// every ending it can reach is driven offline by scripts/test-confirm-line-live-control.ts.
//
// The command asks the deployed endpoint to run the probe (`src/lib/monitor/confirm-line-probe.ts`)
// and judges what comes back. Only every check passing passes. A reply missing a check is
// never a pass on the ones it carried (L98), and every other ending exits on its own code
// with its own opening sentence (L11).
import {
  CONFIRM_LINE_PROBE_REASON,
  CONFIRM_LINE_CHECKS,
  CHECK_CAN_END_ON,
  type ConfirmLineCheck,
  type CheckOutcome,
  type CheckResult,
} from "@/lib/monitor/confirm-line-probe";
import { CONFIRM_LINE_EXIT } from "./confirm-line-run-outcome.ts";

// The table LIVES in the bare node module, re-exported so there is one of it (L41).
export { CONFIRM_LINE_EXIT };

/**
 * The longest the command waits for the probe's answer. A healthy probe takes the line
 * checks' few seconds plus one idle spell of the directory's wake check (#3481), about
 * 30 seconds. The slowest honest one, every follower waiting out its whole wait and the
 * directory never answering from storage, is a little over two minutes since #3823 added
 * three ladder checks (measured 124s, a report that never reaches the object):
 * `scripts/test-confirm-line-live-control.ts` measures every planted run on its virtual
 * clock and holds the slowest well inside this. Past it the reply is not coming, and
 * waiting on it would only hold the job until its own timeout (L110), which is 20 minutes.
 */
export const REPLY_DEADLINE_MS = 180_000;

/** What one call to the endpoint produced. */
export type ProbeOutcome =
  | { kind: "checked"; checks: Record<ConfirmLineCheck, CheckResult> }
  | { kind: "incomplete"; detail: string }
  | { kind: "no-answer"; detail: string }
  | { kind: "unreadable-reply"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "not-configured" }
  | { kind: "endpoint-missing" }
  | { kind: "context-unreadable" }
  | { kind: "binding-missing" };

export type Verdict = { ok: true; message: string } | { ok: false; exitCode: number; message: string };

/** Each check by what it asks, for the roll call every message ends with. */
const ASKS: Record<ConfirmLineCheck, string> = {
  full: "refused after a full verdict",
  notFull: "handed the lead after a not full verdict",
  abandoned: "freed behind an unacknowledged lead",
  handedStart: "released holding the advisor nobody had claimed",
  heldVerdict: "a full verdict held while a claim is in flight, then applied",
  claimOutcome: "an advisor found busy kept out and an untried one handed back",
  nothingHeld: "nothing left held",
  directory: "the pool grouping directory stores, keeps the newest, and holds a live grouping",
  directoryWake: "the pool grouping directory hands its grouping back from storage after an idle sleep",
};

/**
 * One check's result as the endpoint sent it, or why it cannot be believed: an outcome
 * that check can never end on is a reply from some other version of the probe, and is
 * refused rather than mapped onto a guess.
 */
function readCheck(check: ConfirmLineCheck, raw: unknown): CheckResult | string {
  if (typeof raw !== "object" || raw === null) return `the reply carried no ${check} check`;
  const { outcome, detail } = raw as { outcome?: unknown; detail?: unknown };
  if (typeof outcome !== "string" || !(CHECK_CAN_END_ON[check] as readonly string[]).includes(outcome)) {
    return `the ${check} check ended on ${JSON.stringify(outcome ?? null)}, which that check cannot end on`;
  }
  if (typeof detail !== "string" || !detail.trim()) return `the ${check} check said nothing about what it saw`;
  return { outcome: outcome as CheckOutcome, detail: detail.trim() };
}

/**
 * Turn one HTTP reply into an outcome, by the reason field and the status, never by
 * looking for words in the text (L156): every failure below names the binding the
 * success case names too.
 */
export function readConfirmLineOutcome(status: number, bodyText: string): ProbeOutcome {
  let parsed: unknown = null;
  let json = true;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    // An HTML 404 still says something through its status, so it gets its turn below.
    json = false;
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { reason?: unknown; checks?: unknown };
  if (body.reason === CONFIRM_LINE_PROBE_REASON.contextUnreadable) return { kind: "context-unreadable" };
  if (body.reason === CONFIRM_LINE_PROBE_REASON.bindingMissing) return { kind: "binding-missing" };
  if (body.reason === CONFIRM_LINE_PROBE_REASON.checked) {
    const raw = (typeof body.checks === "object" && body.checks !== null ? body.checks : {}) as Record<string, unknown>;
    const checks = {} as Record<ConfirmLineCheck, CheckResult>;
    for (const check of CONFIRM_LINE_CHECKS) {
      const read = readCheck(check, raw[check]);
      if (typeof read === "string") return { kind: "incomplete", detail: read };
      checks[check] = read;
    }
    return { kind: "checked", checks };
  }
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  // The shared auth refusal for an endpoint with no key configured: told apart from a
  // missing binding by the reason field above, since the two share this status.
  if (status === 503) return { kind: "not-configured" };
  if (status === 404) return { kind: "endpoint-missing" };
  return { kind: "unreadable-reply", detail: `HTTP ${status} ${json ? "with no reason this command recognises" : "with a body that is not JSON"}` };
}

type Failed = Exclude<CheckOutcome, "passed">;

/** Worst first: the outcome that names a run when several checks fail. */
export const OUTCOME_ORDER: readonly Failed[] = [
  // An object nothing can use makes every other reading a consequence of that.
  "unreachable",
  "errored",
  "idle-not-led",
  // A line that excludes nobody is the 2026-10-05 stampede, whatever else is true.
  "led-beside",
  "not-settled",
  "not-handed-on",
  "not-freed",
  "freed-late",
  // #3823: the ladder line's own behaviour. Two confirms on one advisor is the worst of
  // them, then a line answering the old way, then each rule a crowd leans on for speed.
  "start-wrong",
  "start-not-handed",
  "busy-handed-again",
  "verdict-not-held",
  "held-not-applied",
  "untried-not-returned",
  // #3460: a directory that serves nothing costs the line capacity rather than being a
  // line that misbehaves, so it ranks below every line fault and above a slot merely
  // left held.
  "directory-unreachable",
  "not-stored",
  // #3481: a directory that loses its grouping on every sleep is empty for most of each
  // minute, so nearly every confirm keys by code: worse than an older grouping winning now
  // and then.
  "lost-after-idle",
  "older-won",
  "no-grouping",
  "grouping-unusable",
  "held",
  // Last: nothing was found wrong, one half went unmeasured, and any real finding beside
  // it is the more useful thing to name the run by.
  "wake-unobserved",
];

/** Each failed outcome's exit code and its opening sentence, which no other ending shares. */
export const FAILED_CHECK: Record<Failed, { exit: number; says: string }> = {
  unreachable: {
    exit: CONFIRM_LINE_EXIT.objectUnreachable,
    says:
      "The CONFIRM_LINE object is bound and the confirm path's own client could not use it, so every confirm is on its isolate's own line. " +
      "This is exactly what the per isolate fallback hides: nothing else would say so until a crowd stampeded the database again.",
  },
  errored: {
    exit: CONFIRM_LINE_EXIT.checkErrored,
    says: "The probe failed in its own code before a check could answer, so the line was not judged. Read the check's own detail: this is a fault in the probe, not a reading of the object.",
  },
  "idle-not-led": {
    exit: CONFIRM_LINE_EXIT.idleNotLed,
    says: "The first confirm on a slot nobody had used was not given the lead, so the object holds a line it should not, or answers the protocol wrongly.",
  },
  "led-beside": {
    exit: CONFIRM_LINE_EXIT.ledBeside,
    says: "A second confirm was given the lead while the first still held the line, so the shared line excludes nobody and a crowd would run the whole confirm path together.",
  },
  "not-settled": {
    exit: CONFIRM_LINE_EXIT.fullNotSettled,
    says: "After a leader reported the slot full, the confirm waiting behind it was not refused as taken with the settlement intact, so a crowd for a taken slot would each do the whole confirm.",
  },
  "not-handed-on": {
    exit: CONFIRM_LINE_EXIT.notFullNotHandedOn,
    says: "After a leader reported the slot NOT full, the confirm waiting behind it was not handed the lead within the report's own two calls, so confirms for a slot with room are held up or turned away.",
  },
  "freed-late": {
    exit: CONFIRM_LINE_EXIT.abandonedFreedLate,
    says: "A lead nobody acknowledged was freed only when its lease ran out, not by the acknowledgement window, so a lost answer holds the line far longer than it should.",
  },
  "not-freed": {
    exit: CONFIRM_LINE_EXIT.abandonedNotFreed,
    says: "A lead nobody acknowledged was never freed inside the follower's whole wait, so one lost answer can hold every confirm behind it until they give up.",
  },
  held: {
    exit: CONFIRM_LINE_EXIT.leftHeld,
    says: "Something this proof used was still held on the object after it finished, so a newcomer on that slot could not lead at once and the next run could trip over it.",
  },
  "directory-unreachable": {
    exit: CONFIRM_LINE_EXIT.directoryUnreachable,
    says:
      "The pool grouping directory did not answer the confirm path's own transport, so the grouping the recompute lane publishes cannot reach any server.",
  },
  "not-stored": {
    exit: CONFIRM_LINE_EXIT.directoryNotStored,
    says: "The pool grouping directory did not keep a fresh grouping it was handed, so whatever the recompute lane publishes never reaches any server.",
  },
  "older-won": {
    exit: CONFIRM_LINE_EXIT.directoryOlderWon,
    says: "The pool grouping directory let an older grouping replace a newer one, so a slow publisher could hand servers a grouping an admin has since edited.",
  },
  "no-grouping": {
    exit: CONFIRM_LINE_EXIT.groupingAbsent,
    says: "The live pool grouping directory holds no grouping, so the recompute lane has not published one since the object started. Search the logs for tag=pool-grouping to see why.",
  },
  "grouping-unusable": {
    exit: CONFIRM_LINE_EXIT.groupingUnusable,
    says: "The live pool grouping is one a server reading it would refuse (another format, malformed, or stale), so the snapshot reaches nobody.",
  },
  "lost-after-idle": {
    exit: CONFIRM_LINE_EXIT.directoryLostAfterIdle,
    says:
      "The pool grouping directory did not hand back the grouping it stored once it was left idle past the platform's hibernation window, so between the recompute lane's publishes every server reads nothing and confirms key by code again.",
  },
  "start-not-handed": {
    exit: CONFIRM_LINE_EXIT.startNotHanded,
    says:
      "A confirm the line should have released holding the advisor nobody had claimed got no lead, or a lead holding nothing, so the line Worker is answering as it did before the ladder line (#3489) and a crowd reads every rung again confirm by confirm.",
  },
  "start-wrong": {
    exit: CONFIRM_LINE_EXIT.startWrong,
    says: "A confirm the line released was handed something other than the advisor nobody had claimed, so a crowd can put two confirms on one advisor while somebody free goes unasked.",
  },
  "verdict-not-held": {
    exit: CONFIRM_LINE_EXIT.verdictNotHeld,
    says: "With another confirm's claim still in flight, a full verdict answered the confirm waiting behind it at once instead of being held until that claim ended, so a crowd is refused or re-read on a verdict the claim could still overturn.",
  },
  "held-not-applied": {
    exit: CONFIRM_LINE_EXIT.heldNotApplied,
    says: "A full verdict the line held was not applied, with the settlement the last booking read, when the last claim in flight ended booked, so a crowd behind a spent ladder reads it again for itself or is told who sat there before that booking.",
  },
  "busy-handed-again": {
    exit: CONFIRM_LINE_EXIT.busyHandedAgain,
    says: "An advisor whose claim was reported found busy was handed to the next confirm, so the line ignores how a claim ended and sends leads to somebody already known to be unable to take the time.",
  },
  "untried-not-returned": {
    exit: CONFIRM_LINE_EXIT.untriedNotReturned,
    says: "An advisor whose claim was reported untried was not handed to the next confirm, so somebody nobody asked about is lost to the line and a crowd can be turned away with an advisor free.",
  },
  "wake-unobserved": {
    exit: CONFIRM_LINE_EXIT.directoryWakeUnobserved,
    says:
      "The pool grouping directory answered every read after its idle wait from memory, so the proof never saw it wake and did not measure whether a woken directory reads its grouping back. That is not a pass: the detail says whether it stayed awake or answered without saying where from.",
  },
};

/** The ending for anything other than a checked reply. Each its own code and its own words. */
function refuse(outcome: Exclude<ProbeOutcome, { kind: "checked" }>): { exitCode: number; message: string } {
  switch (outcome.kind) {
    case "no-answer":
      return { exitCode: CONFIRM_LINE_EXIT.noAnswer, message: `The endpoint never replied, so nothing about the line was learned: ${outcome.detail}. Check the base URL and that the deployment is serving.` };
    case "unreadable-reply":
      return { exitCode: CONFIRM_LINE_EXIT.unreadableReply, message: `The reply was not one this endpoint produces (${outcome.detail}), so it came from something in front of the Worker: a platform error page or a proxy.` };
    case "unauthorized":
      return { exitCode: CONFIRM_LINE_EXIT.unauthorized, message: "The deployment refused this key. Set BOOKING_API_KEY_CANARY to the canary key the running deployment holds, and check it was not rotated." };
    case "not-configured":
      return { exitCode: CONFIRM_LINE_EXIT.notConfigured, message: "The endpoint is disabled: the running deployment has no booking API key configured, so it refuses every caller and never reached the object." };
    case "endpoint-missing":
      return { exitCode: CONFIRM_LINE_EXIT.endpointMissing, message: "The running deployment has no /api/smoke/confirm-line, so it is older than the change that added it. Deploy the current build and run this again." };
    case "context-unreadable":
      return { exitCode: CONFIRM_LINE_EXIT.contextUnreadable, message: "The Worker could not read its own request context, so it never looked for the object. Not a missing binding: a local dev server reads exactly like this." };
    case "binding-missing":
      return { exitCode: CONFIRM_LINE_EXIT.bindingMissing, message: "The running deployment has no CONFIRM_LINE binding, so every confirm uses its isolate's own line. It is declared in the durable_objects block of wrangler.jsonc: compare that with the deployed version." };
    case "incomplete":
      return { exitCode: CONFIRM_LINE_EXIT.incompleteReply, message: `The endpoint said it checked the line, and ${outcome.detail}, so the run cannot be judged. The deployed probe and this command disagree: deploy the current build.` };
  }
}

/** One line naming every check's outcome, so a lesser finding is never lost behind the worst. */
function rollCall(checks: Record<ConfirmLineCheck, CheckResult>): string {
  return CONFIRM_LINE_CHECKS.map((c) => `${ASKS[c]}: ${checks[c].outcome}${checks[c].outcome === "passed" ? "" : ` (${checks[c].detail})`}`).join("; ");
}

/** The verdict over one run. */
export function judgeConfirmLineProbe(outcome: ProbeOutcome): Verdict {
  if (outcome.kind !== "checked") return { ok: false, ...refuse(outcome) };
  const failing = CONFIRM_LINE_CHECKS.filter((c) => outcome.checks[c].outcome !== "passed");
  if (failing.length === 0) {
    return { ok: true, message: `The shared confirm line answered the confirm path's own client as its rules say. ${rollCall(outcome.checks)}.` };
  }
  const worst = OUTCOME_ORDER.find((o) => failing.some((c) => outcome.checks[c].outcome === o)) as Failed;
  const named = failing.find((c) => outcome.checks[c].outcome === worst) as ConfirmLineCheck;
  return {
    ok: false,
    exitCode: FAILED_CHECK[worst].exit,
    message: `${FAILED_CHECK[worst].says}\n${outcome.checks[named].detail}.\nEvery check: ${rollCall(outcome.checks)}.`,
  };
}
