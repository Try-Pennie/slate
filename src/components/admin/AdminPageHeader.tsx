import { cardCls, proseCls } from "@/components/ui/styles";

/**
 * The title block at the top of a console page (#1748).
 *
 * IT IS A CARD, NOT A NAVY BAND (#1838). Dan, 2026-09-03: "I feel like the dark
 * banner doesn't really fit in light mode? Maybe we should change it?" Chosen
 * from five rendered treatments: it matches the blocks below it, and the
 * always-on "Admin" eyebrow is gone, since every page under /admin is already
 * under a sidebar that says so.
 *
 * This REMOVED a special case rather than adding one. The old class list ended
 * in `dark:bg-surface`, so dark mode had been drawing an ordinary card since the
 * day it shipped; light mode now does what dark mode already did, and the theme
 * divergence is gone rather than inverted.
 *
 * THE COLOURS MOVED WITH THE BACKGROUND, and that is the whole risk in this
 * change. The title, description and eyebrow were `text-pennie-beige`,
 * `text-pennie-beige/75` and `text-pennie-sky`, all chosen for a dark ground.
 * Changing only the fill leaves beige on white, which is invisible rather than
 * merely low contrast, and nothing reports it because both halves are
 * individually valid tokens (L213). AdminPageHeader.test.tsx asserts the
 * foreground as hard as it asserts the fill.
 *
 * IT REUSES `cardCls` rather than restating its values, so the header cannot
 * drift from the cards it exists to match (L41). Ten pages hand wrote the old
 * band instead of calling this component, which is why
 * `scripts/test-no-handrolled-page-band.ts` now exists: the docstring saying
 * "thirteen copies is how the widths in #1745 ended up disagreeing" was a rule
 * living only in a comment, and a rule that lives only in a comment is a hope
 * (L27).
 */
export function AdminPageHeader({
  title,
  children,
  /**
   * Optional STATUS block placed just after the title in the header row (a set
   * of pills). Setting it lays the header out as a row rather than a stack; the
   * agent detail page is what needs it, and it is here rather than as a second
   * component so the two cannot drift apart the way the ten copies did.
   *
   * It is deliberately NOT pinned to the right edge (#1878). `action` sits to
   * its right and renders conditionally, and a group carrying `ml-auto` would
   * slide across the header as soon as the control beside it disappeared, so the
   * same page would lay out differently depending on who was looking at it.
   */
  aside,
  /**
   * Optional CONTROL pinned to the right of the header row (#1878). Separate
   * from `aside` because these are different things: a pill is a label and this
   * does something, and one group holding both makes an action read as a third
   * status. Renders nothing when absent, and its absence moves nothing.
   */
  action,
  /** Optional block placed BEFORE the title in the row, e.g. an avatar. */
  leading,
}: {
  title: string;
  children?: React.ReactNode;
  aside?: React.ReactNode;
  action?: React.ReactNode;
  leading?: React.ReactNode;
}) {
  const asRow = aside !== undefined || action !== undefined || leading !== undefined;
  const text = (
    <>
      <h1 className={asRow ? "pn-h4 truncate text-fg" : "pn-h3 text-fg"}>{title}</h1>
      {children && (
        <div className={`${asRow ? "mt-0.5" : "mt-2"} text-fg-muted ${proseCls}`}>{children}</div>
      )}
    </>
  );

  if (!asRow) return <section className={cardCls}>{text}</section>;

  return (
    <section className={`flex flex-wrap items-center gap-4 ${cardCls}`}>
      {leading}
      <div className="min-w-0">{text}</div>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
    </section>
  );
}

/**
 * What a person sees on a console route their role cannot open.
 *
 * The sidebar does not list an entry someone cannot use, so reaching one of these
 * means a typed address or an old link rather than a control that misled them.
 * It still says which level is needed, because "no" with no reason is a dead end.
 */
export function AdminDenied({ need }: { need: string }) {
  return (
    <p className="text-sm text-fg-muted">
      You need {need} account to open this page.
    </p>
  );
}
