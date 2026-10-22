/**
 * Every sentence the reroute panel shows, and the manager's bucket choice (#3250,
 * phase 4 of #3244). Settled in design rounds with Dan on 2026-10-04; the design is
 * `docs/design/reroute-panel.html` and the numbered requirements are on #3250.
 *
 * The component holds no wording of its own (the booker's copy rule), so a sentence
 * changes in one place and `scripts/test-reroute-panel-copy.ts` reads every state.
 * The tier drop leads the result (R8, R9), an admin reads bucket codes and a manager
 * pool names (R7, R15), and nothing explains the interface (L604).
 */
import { poolLabelForCode } from "../availability/pool-label.ts";
import { bucketSpecForXbc } from "../xbc.ts";
import type { RerouteOutcome, RerouteProposal } from "./reroute.ts";
import type { CurrentAgentUnavailable } from "./orchestration.ts";

/** The three backend choices a manager picks from, in their on screen order (R5). */
export const MANAGER_BACKENDS = [
  { key: "beyond", label: "Beyond" },
  { key: "achieve", label: "Achieve" },
  { key: "either", label: "Either" },
] as const;
export type ManagerBackend = (typeof MANAGER_BACKENDS)[number]["key"];

/** The debt levels, by their first code digit (R5). */
export const MANAGER_DEBT_LEVELS = [
  { digit: "1", label: "Low" },
  { digit: "2", label: "Medium" },
  { digit: "3", label: "High" },
  { digit: "4", label: "Very High" },
  { digit: "5", label: "Ultra High" },
] as const;
export type ManagerDebtDigit = (typeof MANAGER_DEBT_LEVELS)[number]["digit"];

/**
 * The code a manager's choice stands for (R6): only the debt level and backend
 * change, and the booking keeps its own legal digit. Either keeps the booking's
 * backend digit when it is None or Both (which route to the same pool) and
 * otherwise stores Both. A current code that is no XBC keeps nothing of it.
 */
export function composeManagerCode(currentCode: string | null, debt: ManagerDebtDigit, backend: ManagerBackend): string {
  const current = currentCode && bucketSpecForXbc(currentCode) ? currentCode : null;
  const legal = current ? current[2] : "0";
  const backendDigit =
    backend === "beyond" ? "2" : backend === "achieve" ? "3" : current && (current[1] === "0" || current[1] === "1") ? current[1] : "1";
  return `${debt}${backendDigit}${legal}`;
}

/** Where the manager's controls start: the booking's own code, read back. */
export function managerChoiceFromCode(code: string | null): { debt: ManagerDebtDigit; backend: ManagerBackend } {
  if (!code || !bucketSpecForXbc(code)) return { debt: "1", backend: "either" };
  const backend: ManagerBackend = code[1] === "2" ? "beyond" : code[1] === "3" ? "achieve" : "either";
  return { debt: code[0] as ManagerDebtDigit, backend };
}

/** A bucket as the viewer reads buckets elsewhere (R7): the code, or the pool name. */
export function bucketWords(code: string, showCodes: boolean): string {
  return showCodes ? code : (poolLabelForCode(code) ?? code);
}

const TIER_COUNT = ["", "One", "Two", "Three", "Four", "Five"];

/** "One tier down", "Two tiers down". */
export function tiersDownPhrase(rungs: number): string {
  const n = TIER_COUNT[rungs] ?? String(rungs);
  return `${n} tier${rungs === 1 ? "" : "s"} down`;
}

/** "Held for 4:32" (R14), from the seconds the server said were left. */
export function heldFor(seconds: number): string {
  // An unreadable count reads as none left, the side that sends the admin to search
  // again rather than confirm a hold that may be gone (L50).
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `Held for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The request failed on the network: no answer came back at all. */
export const REROUTE_UNREACHABLE = "Slate could not reach the server. Please try again.";

/**
 * The panel stopped waiting before an answer came (#3307). That says nothing about
 * the server, which can still finish: Find an advisor once answered 200 after 24
 * seconds, having held somebody, while this panel said the server was unreachable.
 * So it claims only that no answer came in time (L11), and sends the reader to
 * reload, which restores a hold that was placed or shows a move that landed,
 * rather than to press again.
 */
export const REROUTE_TIMED_OUT =
  "Slate did not answer in time, so this may still be finishing. Reload the page to see whether it went through.";

/** Slate answered with a refusal that carried no message of its own (L11). */
export function rerouteFailed(status: number): string {
  return `Slate could not finish that (error ${status}). Please try again.`;
}

export interface RerouteCopy {
  heading: string;
  body: string;
  /** Whether the result carries a hold countdown. */
  held: boolean;
  /** Whether it offers the optional note. */
  note: boolean;
  /** The primary button's label, or null for none. */
  primary: string | null;
  /** Whether it offers Cancel. */
  cancel: boolean;
  /**
   * The label of the button that opens the booking's own Reassign picker, or null
   * for none (#4043). Only a nobody result offers it: nobody is free on any tier, so
   * naming an advisor, over their cap if need be, is the one way forward.
   */
  reassign: string | null;
}

/**
 * How many DEBT tiers below the bucket asked for `code` sits, from the two codes'
 * first digits, or 0 when either is no XBC. Not the ladder position the search
 * records: a Beyond or Achieve code widens sideways in its own tier first (522,
 * then 532, then the pool 512), and calling that "one tier down" would be false.
 */
function tiersBelow(requestedCode: string, code: string): number {
  if (!bucketSpecForXbc(requestedCode) || !bucketSpecForXbc(code)) return 0;
  return Math.max(0, Number(requestedCode[0]) - Number(code[0]));
}

function heading(requestedCode: string, bucketCode: string, showCodes: boolean): string {
  const where = bucketWords(bucketCode, showCodes);
  const tiers = tiersBelow(requestedCode, bucketCode);
  return tiers > 0 ? `${tiersDownPhrase(tiers)}, in ${where}` : `In ${where}`;
}

/** Why the current advisor cannot take the call, as the result says it (#3487). */
const UNAVAILABLE_WORDS: Record<CurrentAgentUnavailable, string> = {
  time_off: "is on time off for this call",
  not_free: "is not free for this call",
  no_schedule: "has no schedule in Slate",
};

/** The button a nobody result offers: the booking's own Reassign (#3487, #4043). */
const REASSIGN_LABEL = "Reassign to another advisor";

/** What a search found (R8 to R11). */
export function proposalCopy(p: RerouteProposal, showCodes: boolean): RerouteCopy {
  if (p.kind === "none") {
    // #3487: the current advisor was there but cannot take the call, so the result
    // says why. Never that they stay. #4043: the way forward is the Reassign button
    // under it, so no sentence also says to reassign (L605).
    const where = bucketWords(p.requested.code, showCodes);
    return {
      heading: "Nobody is free",
      body: p.current
        ? `${p.current.advisor.name} ${UNAVAILABLE_WORDS[p.current.reason]}, and nobody else in ${where} or any tier below is free. Nothing has changed.`
        : `Nobody in ${where} or any tier below is free at this time. Nothing has changed.`,
      held: false,
      note: false,
      primary: null,
      cancel: false,
      reassign: REASSIGN_LABEL,
    };
  }
  const requested = bucketWords(p.requested.code, showCodes);
  if (p.kind === "move") {
    return {
      heading: heading(p.requested.code, p.bucket.code, showCodes),
      body: p.bucket.code !== p.requested.code ? `${p.advisor.name} is free. Nobody in ${requested} is.` : `${p.advisor.name} is free.`,
      held: true,
      note: true,
      primary: `Move to ${p.advisor.name}`,
      cancel: true,
      reassign: null,
    };
  }
  const corrected = `Change the ${showCodes ? "bucket" : "pool"} to ${bucketWords(p.bucket.code, showCodes)}`;
  if (p.lastResort) {
    return {
      heading: `${p.advisor.name} stays`,
      body: `Nobody else in ${requested} or any tier below is free. The ${showCodes ? "bucket" : "pool"} changes to ${requested} and the advisor does not.`,
      held: false,
      note: true,
      primary: corrected,
      cancel: true,
      reassign: null,
    };
  }
  return {
    heading: heading(p.requested.code, p.bucket.code, showCodes),
    body:
      p.bucket.code !== p.requested.code
        ? `${p.advisor.name} can keep this call. Nobody in ${requested} is free.`
        : `${p.advisor.name} can keep this call.`,
    held: false,
    note: true,
    primary: corrected,
    cancel: true,
    reassign: null,
  };
}

/**
 * What a confirm did (R12, R13), and the line a finished move or keep leaves on the
 * page (L608). `heldAdvisor` names who was held, for the hold that ran out.
 */
export function outcomeCopy(o: RerouteOutcome, showCodes: boolean, heldAdvisor: string | null): RerouteCopy {
  const quiet = { held: false, note: false, primary: null, cancel: false, reassign: null };
  if (o.kind === "expired") {
    return {
      heading: "The hold ran out",
      body: `${heldAdvisor ?? "The advisor"} may have been booked since. Nothing has changed.`,
      held: false,
      note: false,
      primary: "Find an advisor",
      cancel: true,
      reassign: null,
    };
  }
  if (o.kind === "taken") {
    const next = proposalCopy(o.proposal, showCodes);
    return { ...next, body: `${o.previous.name} was booked a moment ago, so Slate searched again. ${next.body}` };
  }
  if (o.kind === "moved") {
    const where = `${o.advisor.name}, in ${bucketWords(o.bucket.code, showCodes)}`;
    // #3307: a repeated confirm whose first one landed moved nothing itself, and the
    // reader pressed again because they believed the first failed (L12).
    if (o.already) {
      return { heading: "Already moved", body: `Moved to ${where}, by an earlier confirm. Nothing changed this time.`, ...quiet };
    }
    return { heading: "Moved", body: `Moved to ${where}.`, ...quiet };
  }
  return {
    heading: "Corrected",
    body: `The ${showCodes ? "bucket" : "pool"} is now ${bucketWords(o.bucket.code, showCodes)}.`,
    ...quiet,
  };
}
