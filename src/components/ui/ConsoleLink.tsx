"use client";

import { btnSecondaryCls } from "@/components/ui/styles";

/**
 * A control pointing at a console route, which is hidden from everyone below
 * super admin until agent scheduling goes live (#2119).
 *
 * THE DEFECT THIS EXISTS FOR. Team Time Off offered `View the coverage sweep` on
 * an approved request, pointing at `/admin/agents/{id}?job=...#coverage`. Every
 * console route calls `consoleHiddenFor` and redirects a manager to
 * `/admin/ooo`, which is the page they were already on. So for every manager,
 * which is everyone below super admin today, the button did not refuse and did
 * not explain: it appeared to do nothing, and pressing it again was the only
 * diagnosis available (L109, L148). Managers are the only people using Slate
 * before cutover and the OOO surfaces are the only place they work, so it read
 * as the product being broken rather than as a feature not being open yet.
 *
 * THE CLASS, NOT THE BUTTON. That link is the only one a manager can reach today
 * (`adminNavFor` returns an empty nav for them), but nothing stopped the next one
 * being added the same way, and the failure is silent by construction: the
 * redirect lands on a real page, so no error is raised anywhere.
 * `scripts/test-console-hidden-links.ts` derives the surfaces a manager can reach
 * and fails on a raw `<a>` or `<Link>` from one of them into a route
 * `consoleHiddenFor` redirects away from. This component is what such a call site
 * uses instead.
 *
 * WHY IT IS A BUTTON AND NOT A DISABLED LINK. Three things have to hold at once:
 *
 *  - Nothing may navigate, and the address must not survive in the markup. An
 *    `<a>` with a dead href is still reachable by a middle click, a right click
 *    and copy-link, so the href goes rather than being neutralised.
 *  - The reason has to be reachable FROM THE KEYBOARD. `disabled` removes a
 *    control from every tab order, so a keyboard user would meet the same silence
 *    the dead link gave them. `aria-disabled` announces it as unavailable while
 *    leaving it focusable, which is the whole point.
 *  - The reason is VISIBLE TEXT, not a `title`. That is #1477's rule, learned on
 *    this same page: detail in a title attribute names a problem and offers no way
 *    to read it on a phone, from a keyboard, or to a screen reader.
 *
 * WHY THE REASON IS NOT INSIDE THE CONTROL. It was, on the first build, and the
 * screenshot at the real count is what settled it: these controls appear once per
 * approved request with a sweep, so a sentence attached to the control became a
 * wall of the identical sentence down the page (L579). It is one fact and it
 * belongs once on the surface (L605), so `ConsoleComingSoonNote` renders it once
 * and every control points at it with `aria-describedby`. A sighted reader meets
 * it once; a screen reader hears it on each control, which is where it is needed.
 *
 * The shared id is a CONSTANT rather than a prop, so a call site cannot invent one
 * that points at nothing, and `scripts/test-console-hidden-links.ts` fails a file
 * that renders the control without the note, because a rule each call site has to
 * remember is a rule enforced by nothing (L621, L27).
 */
/**
 * The wording, once, for the whole class.
 *
 * It names its own antecedent ("Anything marked Coming soon") rather than saying
 * "these", because the note sits at the top of a section and is read BEFORE the
 * first control: a pronoun there points at nothing yet. That also lets one
 * sentence serve a page whose note sits above the controls and one whose sits
 * below, without either call site rewriting it (L41).
 */
export const CONSOLE_COMING_SOON_REASON =
  "Anything marked Coming soon opens when agent scheduling goes live. Until then it is not available to your account.";

/**
 * The id every `ConsoleLink` on a page describes itself with. One per page, which
 * is what makes it safe to hardcode: two notes on one screen would be the
 * duplication this exists to remove.
 */
export const CONSOLE_COMING_SOON_ID = "console-coming-soon-reason";

/**
 * The reason, once per surface. Rendered by any page that offers a `ConsoleLink`,
 * near the controls rather than at the top, so it is read with them.
 */
export function ConsoleComingSoonNote({
  reason = CONSOLE_COMING_SOON_REASON,
  className,
}: {
  reason?: string;
  className?: string;
}) {
  return (
    <p id={CONSOLE_COMING_SOON_ID} className={className ?? "text-xs text-fg-muted"}>
      {reason}
    </p>
  );
}

export function ConsoleLink({
  href,
  consoleHidden,
  className,
  children,
}: {
  /** Where it goes once the console is open. */
  href: string;
  /** `consoleHiddenFor(viewer.role)`, resolved by the page that knows the viewer. */
  consoleHidden: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (!consoleHidden) {
    return (
      <a className={className ?? btnSecondaryCls} href={href}>
        {children}
      </a>
    );
  }

  return (
    <button
      // Never `submit`: these sit among forms (the OOO retry form is a sibling),
      // and a control explaining why it cannot act must not post one.
      type="button"
      aria-disabled="true"
      aria-describedby={CONSOLE_COMING_SOON_ID}
      className={`${className ?? btnSecondaryCls} cursor-not-allowed opacity-60`}
    >
      {children}
      {/* Says it on its FACE, so the state is visible without focusing or
          hovering: a control that only explains itself on interaction is one
          somebody has to press to find out about, which is the thing this
          replaces. */}
      <span className="ml-2 text-xs text-fg-muted">Coming soon</span>
    </button>
  );
}
