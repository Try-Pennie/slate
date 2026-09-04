import { cardCls } from "@/components/ui/styles";

/**
 * What the content column shows while a console page is being fetched (#1848).
 *
 * WHY IT EXISTS AT ALL. Every page under /admin is `force-dynamic`, and there
 * was no loading boundary anywhere in the tree, which had two consequences. The
 * router could not commit a navigation until the whole server render finished,
 * so a click left the OLD page on screen under a spinner for the entire wait;
 * and a prefetch of a dynamic route fills only up to the nearest boundary, so
 * with none, every sidebar link prefetched on hover, returned in about 100ms
 * with nothing useful, and the click still paid full price. Measured in
 * production: the cheap ~100ms requests in the tail are those wasted prefetches.
 *
 * With a boundary the click lands immediately. The header and the sidebar stay
 * exactly where they are, because they belong to the layout and the layout is
 * not re-rendered, and only this column is replaced.
 *
 * IT IS A SKELETON, NOT A SPINNER, and not an empty fragment. An empty boundary
 * commits the navigation to a blank column, which is worse than the spinner it
 * replaces: a blank screen reads as "there is nothing here" rather than as "this
 * is coming" (L10). The shapes match the page header card and the first content
 * card every console page draws, so the real content lands where the skeleton
 * was rather than jumping.
 *
 * IT SAYS NOTHING TO A SCREEN READER, deliberately. `LinkPending` (#1792)
 * already carries exactly one `role="status"` for the wait, on the link that was
 * clicked, which is the one that can say WHICH page is coming. A second live
 * region here would announce the same wait twice, and
 * scripts/test-admin-loading-skeleton.ts holds that to one.
 */
export default function AdminLoading() {
  return (
    <div aria-hidden="true" className="space-y-8">
      {/* The page header card. */}
      <section className={cardCls}>
        <div className="pn-skeleton h-7 w-64 rounded-sm" />
        <div className="pn-skeleton mt-3 h-4 w-full max-w-[52ch] rounded-sm" />
        <div className="pn-skeleton mt-2 h-4 w-full max-w-[38ch] rounded-sm" />
      </section>

      {/* The first content card, in the shape most console pages use: a short
          heading, then rows. */}
      <section className={cardCls}>
        <div className="pn-skeleton h-4 w-32 rounded-sm" />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="pn-skeleton h-9 w-9 shrink-0 rounded-full" />
              <div className="pn-skeleton h-4 flex-1 rounded-sm" />
              <div className="pn-skeleton h-4 w-24 shrink-0 rounded-sm" />
              <div className="pn-skeleton h-4 w-16 shrink-0 rounded-sm" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
