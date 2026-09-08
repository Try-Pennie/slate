import { cardCls } from "@/components/ui/styles";

/**
 * What a person's own pages show while one is being fetched (#2103).
 *
 * WHY IT EXISTS. The header's tabs stopped drawing a per-link spinner, because
 * the slot reserving that spinner's width was the widest thing between three
 * tabs and it was reserved whether or not anything was loading (Dan, 2026-09-08:
 * "get rid of the spinner, and do a skeleton loader on the page instead"). Both
 * pages here are `force-dynamic`, so there is a real beat before the new one
 * commits, and this is now the thing that fills it.
 *
 * It also earns the same two things the console's boundary did: the router can
 * commit the navigation immediately rather than holding the old page on screen
 * for the whole server render, and a prefetch of a dynamic route has somewhere
 * to fill up to.
 *
 * ONE SKELETON FOR BOTH PAGES, which is why the shapes are the ones they share:
 * the greeting card, then a card with a heading and a stack of rows. My
 * Availability puts a week of day rows there and My Time Off puts a form, and at
 * this fidelity those are the same picture. A skeleton that matched one exactly
 * would be wrong on the other, and the point is only that the content lands
 * roughly where the placeholder was rather than jumping.
 *
 * IT IS A SKELETON, NOT AN EMPTY BOUNDARY. An empty one still commits the
 * navigation instantly and commits it to a blank column, which reads as "there
 * is nothing here" rather than as "this is coming" (L10).
 *
 * IT SAYS NOTHING TO A SCREEN READER, deliberately, exactly as the console's
 * does. `LinkPending` still carries the load bar under `marker="bar"`, and that
 * bar holds the one `role="status"` for the wait. A second live region here
 * would announce the same wait twice, and
 * `scripts/test-admin-loading-skeleton.ts` holds both boundaries to zero.
 */
export default function MeLoading() {
  return (
    <div aria-hidden="true" className="space-y-8">
      {/* The greeting card: a name, two lines of copy, and the bookable pill. */}
      <section className={cardCls}>
        <div className="pn-skeleton h-7 w-40 rounded-sm" />
        <div className="pn-skeleton mt-3 h-4 w-full rounded-sm" />
        <div className="pn-skeleton mt-2 h-4 w-3/5 rounded-sm" />
        <div className="pn-skeleton mt-4 h-6 w-28 rounded-full" />
      </section>

      {/* The content card: a short heading, a line of description, then the
          rows. Seven, because that is a week, and the time off form is about the
          same height. */}
      <section className={cardCls}>
        <div className="pn-skeleton h-4 w-32 rounded-sm" />
        <div className="pn-skeleton mt-3 h-3 w-3/4 rounded-sm" />
        <div className="mt-6 space-y-2">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="pn-skeleton h-[68px] w-full rounded-[var(--radius-md)]" />
          ))}
        </div>
        <div className="pn-skeleton mt-5 h-11 w-24 rounded-[var(--radius-md)]" />
      </section>
    </div>
  );
}
