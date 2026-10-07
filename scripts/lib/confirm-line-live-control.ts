// The decision logic behind `pnpm verify:confirm-line` (#3340), apart from the live IO so
// every ending it can reach is driven offline by scripts/test-confirm-line-live-control.ts.
//
// The command asks the deployed endpoint to run the probe (`src/lib/monitor/confirm-line-probe.ts`)
// and judges what comes back. Only five passed checks pass. A reply missing a check is
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
  nothingHeld: "nothing left held",
  directory: "the pool grouping directory stores, keeps the newest, and holds a live grouping",
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
  // #3460: a directory that serves nothing splits a crowd on sibling codes by code again,
  // which is lost capacity on the line rather than a line that misbehaves, so it ranks
  // below every line fault and above a slot merely left held.
  "directory-unreachable",
  "not-stored",
  "older-won",
  "no-grouping",
  "grouping-unusable",
  "held",
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
      "The pool grouping directory did not answer the confirm path's own transport, so a server holding no grouping of its own keys its confirm line by code, and a crowd for one slot on sibling codes elects a leader per code again.",
  },
  "not-stored": {
    exit: CONFIRM_LINE_EXIT.directoryNotStored,
    says: "The pool grouping directory did not keep a fresh grouping it was handed, so whatever the recompute lane publishes never reaches a cold server.",
  },
  "older-won": {
    exit: CONFIRM_LINE_EXIT.directoryOlderWon,
    says: "The pool grouping directory let an older grouping replace a newer one, so a slow publisher can hand cold servers a grouping an admin has since edited.",
  },
  "no-grouping": {
    exit: CONFIRM_LINE_EXIT.groupingAbsent,
    says: "The live pool grouping directory holds no grouping, so the recompute lane has not published one since the object started. Search the logs for tag=pool-grouping to see why.",
  },
  "grouping-unusable": {
    exit: CONFIRM_LINE_EXIT.groupingUnusable,
    says: "The live pool grouping is one every cold server refuses (another format, malformed, or stale), so the snapshot reaches nobody and cold servers key their confirm line by code.",
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
