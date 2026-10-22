import type { BulkReassignActionableItem } from "@/lib/booking/bulk-reassign";
import {
  coverageCouldNotPlaceHeading,
  coverageStrandedMovesLead,
  coverageStrandedUnreadableNotice,
} from "@/lib/booking/coverage-panel-copy";
import { MoveOutcomeRow } from "@/components/MoveOutcomeRow";
import ViewerTime from "@/components/ViewerTime";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { cardCls } from "@/components/ui/styles";

/** What the agent page read (#3595): the calls, or that it could not tell. */
export type StrandedCallsState =
  | { kind: "unreadable" }
  | {
      kind: "read";
      calls: BulkReassignActionableItem[];
      /** When each move that left one of them was started, newest first. */
      moves: string[];
    };

/**
 * The calls the last coverage sweep could not place that are still with this
 * agent (#3595), at the top of the agent page, under the agent's own card.
 *
 * WHERE: Dan's design round, 2026-10-21, chose the top of the page over a card above
 * the closed section and over the Move panel itself. That panel lives in a section
 * closed on every visit, which by design hides no signal, and calls nobody owns are
 * the most urgent thing on this page.
 *
 * NO CARD WHEN NOTHING WAITS. The issue asked for a line saying nothing is waiting,
 * but at the top of the page that is a permanent card above everything else on every
 * healthy visit, and the top is for trouble. The healthy agent's page reads as it did
 * before this existed. A failed read is NOT that: it says the list could not be
 * checked (L10), because an empty list is what the healthy day shows.
 *
 * The rows are the move's own rows (`MoveOutcomeRow`), dated, since a standing list
 * spans days. The line beside the heading says which move left them, so a reader can
 * tell this week's trouble from a week old sweep.
 */
export function StrandedCallsCard({ state, agentName }: { state: StrandedCallsState; agentName: string }) {
  if (state.kind === "unreadable") {
    return <UnreadableNotice>{coverageStrandedUnreadableNotice(agentName)}</UnreadableNotice>;
  }
  if (state.calls.length === 0) return null;
  const latest = state.moves[0];
  return (
    <section className={cardCls} aria-labelledby="stranded-calls-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p id="stranded-calls-heading" className="pn-eyebrow text-fg-muted">
          {coverageCouldNotPlaceHeading(state.calls.length)}
        </p>
        {latest && (
          <p className="text-xs text-fg-muted">
            {coverageStrandedMovesLead(state.moves.length)} <ViewerTime iso={latest} />
          </p>
        )}
      </div>
      <ul className="mt-2 divide-y divide-border">
        {state.calls.map((it) => (
          <MoveOutcomeRow key={it.bookingId} item={it} dated />
        ))}
      </ul>
    </section>
  );
}
