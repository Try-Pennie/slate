import { bookingDetailHref } from "@/lib/booking/detail";

/**
 * The "Open" link from a staff table row to one booking, in a new tab (#1914).
 *
 * A new tab because these are scan and dig surfaces, and losing your place in a
 * list to look at one booking is the complaint. The sr-only half is not optional:
 * a link that opens a new window without saying so is a surprise to a screen
 * reader user, who has no visual cue that anything moved.
 */
export function OpenBookingLink({ bookingId }: { bookingId: string }) {
  return (
    <a
      href={bookingDetailHref(bookingId)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-2 py-1 text-fg hover:border-fg/45"
    >
      Open
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
