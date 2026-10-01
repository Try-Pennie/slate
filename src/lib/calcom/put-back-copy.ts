import { MAX_RETRIES_PER_TICK } from "@/lib/monitor/override-sweep-limits";

/**
 * The words putting cal.com back says, before the press and after (#2890), and
 * the redirect fragment that carries the counts between the two.
 *
 * Its own module, importing nothing server side, because the confirmation is
 * rendered by a "use client" component: the loaders beside the counts
 * (`src/lib/calcom/put-back.ts`) read Supabase, log, and import the override
 * sweep, none of which belongs in the client bundle (L730).
 * `scripts/test-calcom-put-back.ts` pins the import list.
 */

/** What putting cal.com back has to bring into line, each half null when unreadable. */
export interface PutBackCounts {
  /** Approved time off made while retired, to be copied into cal.com. */
  copy: number | null;
  /** Blocks for time off cancelled or changed while retired, to be taken out. */
  remove: number | null;
}

function requests(n: number): string {
  return n === 1 ? "1 approved time off request" : `${n} approved time off requests`;
}

function blocks(n: number): string {
  return n === 1 ? "1 block" : `${n} blocks`;
}

/** How the sweep paces the work, said once so the sentences cannot disagree. */
const PACE = `the check that runs every 5 minutes does this ${MAX_RETRIES_PER_TICK} at a time`;

/**
 * The two halves in words, or null when there is nothing to say about either. An
 * unreadable half says so; it is never folded into the other or into a zero.
 */
function halves(c: PutBackCounts, tense: "will" | "waiting"): string[] {
  const out: string[] = [];
  if (c.copy === null) out.push("how much time off approved while it was retired is to be copied into it could not be counted");
  else if (c.copy > 0) {
    out.push(
      tense === "will"
        ? `${requests(c.copy)} made while it was retired ${c.copy === 1 ? "is" : "are"} copied into it`
        : `${requests(c.copy)} made while it was retired ${c.copy === 1 ? "is" : "are"} waiting to be copied into it`,
    );
  }
  if (c.remove === null) out.push("how many blocks for time off cancelled or changed while it was retired are to be taken out could not be counted");
  else if (c.remove > 0) {
    out.push(
      tense === "will"
        ? `${blocks(c.remove)} for time off cancelled or changed while it was retired ${c.remove === 1 ? "is" : "are"} taken out of it`
        : `${blocks(c.remove)} for time off cancelled or changed while it was retired ${c.remove === 1 ? "is" : "are"} waiting to be taken out of it`,
    );
  }
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describe(c: PutBackCounts, tense: "will" | "waiting"): string {
  const parts = halves(c, tense);
  if (parts.length === 0) {
    return "Nothing changed in time off while it was retired needs copying into cal.com or taking out of it.";
  }
  const anyWork = (c.copy ?? 0) > 0 || (c.remove ?? 0) > 0;
  const unknown = c.copy === null || c.remove === null;
  const pace = anyWork || unknown ? ` ${capitalise(PACE)}.` : "";
  return `${capitalise(parts.join(", and "))}.${pace}`;
}

/** The sentence on the put back confirmation, before the press. */
export function putBackConfirmSentence(c: PutBackCounts): string {
  return describe(c, "will");
}

/** The value a put back redirect carries for a count that could not be read. */
export const PUT_BACK_UNKNOWN = "unknown";

/** The query fragment the put back redirect appends after `savedQuery`. */
export function putBackQuery(c: PutBackCounts): string {
  const v = (n: number | null) => (n === null ? PUT_BACK_UNKNOWN : String(n));
  return `&copy=${v(c.copy)}&remove=${v(c.remove)}`;
}

/** A redirect value back into a count: a number, unknown (null), or absent. */
function parseCount(raw: string | undefined | null): number | null | undefined {
  if (raw === PUT_BACK_UNKNOWN) return null;
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * The saved notice after putting cal.com back, built from the counts the redirect
 * carried. A value that is not a count (an old or hand edited link) claims nothing
 * about that half rather than a guessed number.
 */
export function putBackSavedSentence(copyRaw: string | undefined | null, removeRaw: string | undefined | null): string {
  const base = "Saved: cal.com is back. Its lanes run again from their next scheduled check.";
  const copy = parseCount(copyRaw);
  const remove = parseCount(removeRaw);
  if (copy === undefined || remove === undefined) return base;
  return `${base} ${describe({ copy, remove }, "waiting")}`;
}
