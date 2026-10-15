/**
 * One texting line per lead (#3718), for the Call me now confirmation's Text us.
 *
 * Pennie's automations service hands out a different line on every ask (measured
 * 2026-10-15: six asks for one lead, six lines), so Slate remembers the line it gave a
 * lead and offers it again. Dan's rule (2026-10-14): "if the same lead asks 10 times,
 * we give them the same answer unless that phone line doesn't exist for some reason".
 * Whether it still exists is Sendblue's to say (`sendblue-line-state.ts`), and only
 * its DEAD answer replaces a line; an unknown keeps it.
 *
 * Two presses can run at once, so the store owns the race rather than the order of
 * the calls here: `claim` saves a line only where the lead has none and returns what
 * is saved, and `swap` replaces a line only while it is still the one being replaced
 * and returns what is saved. Whoever loses is shown the winner's line.
 *
 * Any failure on the way is NO line, reported, never an unsaved line: a line the lead
 * is shown but Slate did not keep can differ on the next press, which is the fault this
 * module exists to remove. The whole lookup runs under the confirmation's one deadline.
 *
 * Pure apart from its injected collaborators, so `scripts/test-lead-texting-line.ts`
 * drives every path without a database, Sendblue or the service (L524).
 */
import { readWithinDeadline, realTimer, type ScheduleTimer } from "../read-within-deadline.ts";
import type { LineState } from "./sendblue-line-state.ts";
import { TEXTING_LINE_DEADLINE_MS } from "./texting-line.ts";

export interface TextingLineStore {
  /** The lead's saved line, or null when there is none. Throws when unreadable. */
  read(key: string): Promise<string | null>;
  /** Saves `line` only where the lead has none; returns the line now saved. */
  claim(key: string, line: string): Promise<string>;
  /** Replaces `from` with `to` only while `from` is still saved; returns the line now saved. */
  swap(key: string, from: string, to: string): Promise<string>;
}

export interface LeadTextingLineDeps {
  store: TextingLineStore;
  lineState: (line: string) => Promise<LineState>;
  /** A fresh line from the automations service, or null when it gave none. */
  fetchLine: () => Promise<string | null>;
  onUnread: (err: unknown) => void;
  timer?: ScheduleTimer;
}

/**
 * The key a lead's line is saved under: the first 15 characters of its Salesforce id,
 * which a 15 and an 18 character id for the same lead share (the last three are only a
 * case checksum).
 */
export const leadTextingKey = (leadId: string): string => leadId.slice(0, 15);

export async function textingLineForLead(leadId: string, deps: LeadTextingLineDeps): Promise<string | null> {
  const key = leadTextingKey(leadId);
  return readWithinDeadline(
    async () => {
      const saved = await deps.store.read(key);
      if (saved !== null && (await deps.lineState(saved)) !== "dead") return saved;
      const fresh = await deps.fetchLine();
      if (fresh === null) return null;
      return saved === null ? deps.store.claim(key, fresh) : deps.store.swap(key, saved, fresh);
    },
    TEXTING_LINE_DEADLINE_MS,
    deps.onUnread,
    deps.timer ?? realTimer,
  );
}
