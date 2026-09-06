import { badgeCountCls, badgeCountInkCls } from "@/components/ui/styles";

/**
 * The count pill on a nav tab, and the sentence a screen reader gets for it.
 *
 * Lifted out of `HeaderNav` (#1847) so the nav no longer needs to know what a
 * badge looks like, and so the count can arrive LATER than the tab it sits on.
 * The tab now takes a node rather than a number, which is what lets the read
 * behind it sit under its own `Suspense` boundary.
 *
 * Zero renders nothing at all, not an empty pill: an approvals queue with
 * nothing in it is a tab with no badge, and a pill holding "0" reads as a thing
 * to go and look at.
 */
export function PendingBadge({ count }: { count: number }) {
  if (!count || count <= 0) return null;
  return (
    <>
      <span aria-hidden="true" className={badgeCountCls}>
        {/* #1921: the digits carry the optical nudge, not the pill, which would
            move the whole badge with it. */}
        <span className={badgeCountInkCls}>{count > 99 ? "99+" : count}</span>
      </span>
      <span className="sr-only">
        ({count} {count === 1 ? "request" : "requests"} pending)
      </span>
    </>
  );
}
