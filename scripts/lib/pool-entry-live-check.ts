// Decision logic for `pnpm verify:pool-entry` (#2316), pure so it is pinned
// offline by scripts/test-pool-entry-live-control.ts while the live half talks to
// Google.
//
// The command runs the activation gate's two READS against real accounts: the
// reachability probe (`checkActivationGate`) and the pool entry calendar read
// (`onboardIntoPool`). It needs BOTH directions (L1): a readable agent must come
// back with every calendar hydrated, and an account with no Calendar licence must
// come back refused as not provisioned. A gate hard wired to either answer
// satisfies one direction alone.
//
// Every way of learning nothing has its OWN exit code and its own sentence (L11,
// L98): "could not check" must never read as "checked, all fine".
import { poolEntryRefusal } from "@/lib/bookable/pool-entry-verdict";
import type { BlockedReason } from "@/lib/bookable/service";
import type { PoolEntryResult } from "@/lib/google/pool-entry";

/**
 * Every outcome, its exit code, and what it means. Order is the order they are
 * met: inputs, then the Slate rows, then the readable direction, then the
 * unprovisioned one. The AGENTS.md table is written from this.
 */
export const OUTCOMES = {
  passed: {
    exit: 0,
    meaning: "both directions proved: the readable agent hydrated every calendar and the unlicensed account was refused as not provisioned",
  },
  "inputs-missing": {
    exit: 1,
    meaning: "POOL_ENTRY_READABLE_EMAIL and POOL_ENTRY_UNPROVISIONED_EMAIL must both be set; nothing was attempted",
  },
  "inputs-same-account": {
    exit: 2,
    meaning: "both emails name the same account, and one account cannot prove both directions",
  },
  "users-unreadable": {
    exit: 3,
    meaning: "the Slate users table could not be read, so neither subject could be looked up",
  },
  "readable-not-found": {
    exit: 4,
    meaning: "no Slate user has the readable email",
  },
  "readable-not-bookable": {
    exit: 5,
    meaning: "the readable agent is not bookable; onboarding is only run on somebody already in the pool, where every write it makes is a refresh the lanes make anyway",
  },
  "readable-deactivated": {
    exit: 6,
    meaning: "the readable agent has been deactivated; name a current agent",
  },
  "unprovisioned-not-found": {
    exit: 7,
    meaning: "no Slate user has the unprovisioned email",
  },
  "readable-not-provisioned": {
    exit: 10,
    meaning: "the readable agent's account has no Calendar licence, so it cannot prove the success direction",
  },
  "readable-refused": {
    exit: 11,
    meaning: "Google refused the readable agent's account outright (removed, or delegation revoked)",
  },
  "readable-unverified": {
    exit: 12,
    meaning: "the probe could not reach the readable agent's calendar twice running; usually a Google blip, run it again",
  },
  "readable-threw": {
    exit: 13,
    meaning: "the pool entry read threw for the readable agent, so nothing it did is known",
  },
  "readable-no-calendars": {
    exit: 14,
    meaning: "the pool entry read found no calendars at all for the readable agent",
  },
  "readable-not-hydrated": {
    exit: 15,
    meaning: "at least one of the readable agent's calendars failed to hydrate, so the gate would refuse them",
  },
  "readable-out-of-budget": {
    exit: 16,
    meaning: "the activation budget ran out before every calendar was attempted",
  },
  "readable-contended": {
    exit: 18,
    meaning: "another job was refreshing one of the readable agent's calendars at the same moment, so the read stood down; run it again",
  },
  "gate-admitted-unhydrated": {
    exit: 17,
    meaning: "the shipped gate predicate admits a result in which a calendar was neither hydrated nor failed",
  },
  "unprovisioned-admitted": {
    exit: 20,
    meaning: "the probe REACHED the account named as unlicensed, so the gate would let it through its first half",
  },
  "unprovisioned-refused-as-gone": {
    exit: 21,
    meaning: "the unlicensed account was refused as gone rather than as not provisioned, so the not provisioned arm was not exercised",
  },
  "unprovisioned-unverified": {
    exit: 22,
    meaning: "the probe could not reach the unlicensed account twice running, which proves nothing either way; run it again",
  },
} as const;

export type OutcomeCode = keyof typeof OUTCOMES;

export interface SubjectRow {
  id: string;
  email: string;
  bookable: boolean;
  deactivatedAt: string | null;
}

export interface Refusal {
  ok: false;
  code: OutcomeCode;
  why: string;
}

function refuse(code: OutcomeCode, why?: string): Refusal {
  return { ok: false, code, why: why ?? OUTCOMES[code].meaning };
}

/** Reads the two emails. A blank value is missing, never a subject (L138). */
export function readInputs(
  env: Record<string, string | undefined>,
): { ok: true; readableEmail: string; unprovisionedEmail: string } | Refusal {
  const readableEmail = env.POOL_ENTRY_READABLE_EMAIL?.trim() ?? "";
  const unprovisionedEmail = env.POOL_ENTRY_UNPROVISIONED_EMAIL?.trim() ?? "";
  if (!readableEmail || !unprovisionedEmail) return refuse("inputs-missing");
  if (readableEmail.toLowerCase() === unprovisionedEmail.toLowerCase()) {
    return refuse("inputs-same-account");
  }
  return { ok: true, readableEmail, unprovisionedEmail };
}

/**
 * Whether the two Slate rows are subjects this command may use. The readable one
 * must be ALREADY bookable and active, because onboarding writes (a watch renewal
 * if one is due, a re-bootstrap of the busy window, `last_synced_at`), and on an
 * agent already in the pool every one of those is a refresh the watch, hydration
 * and sync lanes make anyway. On anybody else it would be building a pool entry
 * nobody asked for. Deactivated is named over not bookable, since it is the cause.
 */
export function checkSubjects(readable: SubjectRow | null, unprovisioned: SubjectRow | null): Refusal | null {
  if (readable === null) return refuse("readable-not-found");
  if (readable.deactivatedAt) return refuse("readable-deactivated");
  if (!readable.bookable) return refuse("readable-not-bookable");
  if (unprovisioned === null) return refuse("unprovisioned-not-found");
  return null;
}

/** The probe half's answer: null admits, otherwise the gate's own reason. */
export type ProbeAnswer = BlockedReason | null;

export type EntryReading =
  | { kind: "not-run" }
  | { kind: "threw"; detail: string }
  | { kind: "result"; result: PoolEntryResult };

export interface DirectionVerdict {
  ok: boolean;
  /** null when this direction proved what it had to. */
  code: OutcomeCode | null;
  detail: string;
}

function failed(code: OutcomeCode, detail?: string): DirectionVerdict {
  return { ok: false, code, detail: detail ?? OUTCOMES[code].meaning };
}

function counts(r: PoolEntryResult): string {
  return `${r.hydrated} of ${r.calendars} calendar(s) hydrated, ${r.failed} failed, watch ${r.watch}` +
    (r.contended > 0 ? `, ${r.contended} held by another job` : "") +
    (r.outOfBudget ? ", out of budget" : "");
}

/**
 * The readable direction. Passes only when the probe admitted AND every calendar
 * found was hydrated. The shipped predicate is consulted too: if it admits a
 * result this calls incomplete, that is its own finding, since it means the gate
 * lets somebody in with a calendar nobody read.
 */
export function judgeReadable(probe: ProbeAnswer, entry: EntryReading): DirectionVerdict {
  if (probe === "google_not_provisioned") return failed("readable-not-provisioned");
  if (probe === "google_unreachable") return failed("readable-refused");
  if (probe !== null) return failed("readable-unverified");
  if (entry.kind === "not-run") return failed("readable-threw", "the probe admitted and the pool entry read never ran");
  if (entry.kind === "threw") return failed("readable-threw", `${OUTCOMES["readable-threw"].meaning}: ${entry.detail}`);

  const r = entry.result;
  const detail = counts(r);
  if (r.calendars === 0) return failed("readable-no-calendars", `${OUTCOMES["readable-no-calendars"].meaning} (${detail})`);
  // A measured failure outranks the budget, as the gate ranks them (#2317).
  if (r.failed > 0) return failed("readable-not-hydrated", `${OUTCOMES["readable-not-hydrated"].meaning} (${detail})`);
  if (r.outOfBudget) return failed("readable-out-of-budget", `${OUTCOMES["readable-out-of-budget"].meaning} (${detail})`);
  // #2705: ranked as the gate ranks it, below the budget and any measured failure.
  if (r.contended > 0) return failed("readable-contended", `${OUTCOMES["readable-contended"].meaning} (${detail})`);
  const everyCalendar = r.hydrated === r.calendars;
  const shippedAdmits = poolEntryRefusal(r) === null;
  if (!everyCalendar && shippedAdmits) {
    return failed("gate-admitted-unhydrated", `${OUTCOMES["gate-admitted-unhydrated"].meaning} (${detail})`);
  }
  if (!everyCalendar || !shippedAdmits) {
    // Unreachable with the shipped predicate as written: every incomplete result
    // above is caught by a named branch. Refused rather than passed if it changes.
    return failed("readable-not-hydrated", `${OUTCOMES["readable-not-hydrated"].meaning} (${detail})`);
  }
  return { ok: true, code: null, detail: `admitted: ${detail}` };
}

/**
 * The unprovisioned direction. The gate's probe must refuse the account AS not
 * provisioned. The pool entry read is never run for it, exactly as the real gate
 * never runs it once the probe refuses, which is also what keeps this direction
 * free of writes.
 */
export function judgeUnprovisioned(probe: ProbeAnswer): DirectionVerdict {
  if (probe === "google_not_provisioned") {
    return { ok: true, code: null, detail: "refused as google_not_provisioned before any calendar was read" };
  }
  if (probe === null) return failed("unprovisioned-admitted");
  if (probe === "google_unreachable") return failed("unprovisioned-refused-as-gone");
  return failed("unprovisioned-unverified");
}

/** One code for the run. The readable direction names it when both fail: it is
 *  the one whose breakage stops every activation. Both lines are printed anyway. */
export function settle(
  readable: DirectionVerdict,
  unprovisioned: DirectionVerdict,
): { code: OutcomeCode; exit: number } {
  const code: OutcomeCode = readable.code ?? unprovisioned.code ?? "passed";
  return { code, exit: OUTCOMES[code].exit };
}
