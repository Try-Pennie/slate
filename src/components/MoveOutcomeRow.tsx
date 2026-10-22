import type { BulkReassignActionableItem } from "@/lib/booking/bulk-reassign";
import { MOVED_ITEM_STATUSES, SKIPPED_ITEM_STATUSES } from "@/lib/booking/bulk-reassign";
import { formatSlotTime } from "@/lib/booking/slot-label";
import ViewerTime from "@/components/ViewerTime";

/**
 * One booking the move did not simply place, in either list (#2122).
 *
 * ONE row component for both, because they are the same row: a name, a time and
 * the reason, differing only in whether anybody has to do anything. Two copies
 * would drift, and the half that drifts first is the reason line, which is the
 * only part carrying what actually happened.
 *
 * Its own file since #3595, because a second surface draws the same row: the
 * standing list of calls the last move could not place, at the top of the agent
 * page. That list spans days, so it passes `dated`, and the time is then the staff
 * surface's one booking time format, the date and the time in the viewer's zone,
 * labelled (`ViewerTime`, #1916). The move's own progress view keeps the bare time
 * its design settled on.
 *
 * The control appears only where there IS one. A skip means the booking was gone,
 * cancelled or completed, so there is nothing to place: offering "Place by hand"
 * on it would be a control that cannot do what it says.
 */
export function MoveOutcomeRow({ item, dated = false }: { item: BulkReassignActionableItem; dated?: boolean }) {
  // Asked of the SAME list the engine classifies by, never of a string compared
  // here. Two definitions of "is this a skip" on either side of a boundary are
  // never compared and can drift indefinitely while each reads as correct (L263),
  // and the drift here would put a Place by hand link on a booking that no longer
  // exists.
  const canPlace = !SKIPPED_ITEM_STATUSES.includes(item.status);
  // #3615: a call the sweep MOVED is not placed by hand; its control is the move back, which
  // lives on the booking. Asked of the engine's own list, like the skip above.
  const wasMoved = MOVED_ITEM_STATUSES.includes(item.status);
  // A moved call an admin already moved back says so, and offers nothing: a second move back
  // would only be refused on the booking page.
  const movedBack = wasMoved && Boolean(item.revertedAt);
  // #3615: a moved call that can no longer go back (cancelled, started, moved again, its advisor
  // left) offers the booking rather than an action the rules no longer permit (L1007).
  const cannotGoBack = wasMoved && !movedBack && item.canMoveBack === false;
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="min-w-0">
        <span className="block truncate text-fg">
          {item.attendeeName ?? "Booking"}
          {item.startsAt ? (
            dated ? (
              <>
                {" · "}
                <ViewerTime iso={item.startsAt} />
              </>
            ) : (
              ` · ${formatSlotTime(item.startsAt)}`
            )
          ) : (
            ""
          )}
        </span>
        {movedBack ? (
          <span className="block truncate text-xs text-fg-muted">Moved back to the original advisor</span>
        ) : cannotGoBack ? (
          <span className="block truncate text-xs text-fg-muted">Can no longer be moved back</span>
        ) : (
          item.detail && <span className="block truncate text-xs text-fg-muted">{item.detail}</span>
        )}
      </span>
      {canPlace && !movedBack && (
        <a
          href={`/admin/bookings/${item.bookingId}`}
          className="shrink-0 text-pennie-blue underline dark:text-pennie-sky"
        >
          {cannotGoBack ? "Open booking" : wasMoved ? "Move back" : "Place by hand"}
        </a>
      )}
    </li>
  );
}
