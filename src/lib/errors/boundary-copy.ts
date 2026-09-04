/**
 * What a person reads when a page could not finish (#1970).
 *
 * Dan hit this twice, updating an agent's hours after leaving the page sitting
 * for twenty to thirty minutes. What he got was Next's own unstyled dark screen
 * saying "This page couldn't load": no Pennie type, no colours, no header, no
 * way back into the app, and nothing about whether the hours he had typed were
 * saved.
 *
 * The copy lives here rather than inline in the boundaries for the reason every
 * other copy module in this repo exists: three surfaces show it and they must
 * not drift, and `pnpm preview:booker` and `preview:alerts` set the precedent
 * that a string a person reads belongs in a module the component calls (L41).
 *
 * THE HARD PART IS WHAT IT MAY CLAIM. A boundary catches a failed render and a
 * failed save alike, and from inside it there is no way to tell them apart, nor
 * whether a save that failed got half way. So it may not say "nothing was
 * saved": that is a claim nothing here measured, and it is the one that would
 * send somebody away from a change that actually landed (L11). It says what is
 * true instead, which is that this screen cannot tell, and what to do about it,
 * which is to look before trying again.
 */

/** The heading, said as what happened rather than as an apology. */
export const BOUNDARY_TITLE = "This page did not finish loading";

/**
 * The body. Two sentences, and the second is the one that matters: it tells
 * somebody who was mid save what to actually do.
 */
export const BOUNDARY_BODY =
  "Something went wrong while the page was working. If you were saving a change, " +
  "reload and check whether it went through before trying again: this screen " +
  "cannot tell whether it did.";

/** Offered when the failure might be temporary, which is what `retry` is for. */
export const BOUNDARY_RETRY = "Try again";

/** Offered on the admin surface, where a dead end screen has somewhere to go. */
export const BOUNDARY_HOME = "Go to the admin overview";

/**
 * Where "back" goes, decided by where the person actually IS (#1970).
 *
 * The global backstop replaces the root layout, so it is the screen a LEAD sees
 * if the booker's own layout fails, and the first version of it offered them
 * "Go to the admin overview" unconditionally. A customer being sent to our admin
 * console is worse than offering nothing at all, and it is not a hypothetical:
 * `/book` and `/booking` are the public surfaces this boundary sits above.
 *
 * So a lead facing path gets NO link. There is nowhere useful to send them: a
 * booking link is per booking and this screen does not know which, and the front
 * page is not where they were going. Retrying is the only honest offer.
 */
export function boundaryWayBack(
  pathname: string,
): { href: string; label: string } | null {
  if (pathname.startsWith("/admin")) {
    return { href: "/admin", label: BOUNDARY_HOME };
  }
  if (pathname.startsWith("/me")) {
    return { href: "/me", label: "Go to your availability" };
  }
  return null;
}

/**
 * The reference to quote when asking for help.
 *
 * A digest is Next's own hash of the error and is the ONLY thing tying this
 * screen to a line in the Worker's logs, so it is shown rather than swallowed. A
 * server error's message is deliberately generic in production (Next replaces it
 * to avoid leaking detail), which is why the digest is surfaced and the message
 * is not.
 */
export function boundaryReference(digest: string | undefined): string | null {
  const d = (digest ?? "").trim();
  return d ? `Reference ${d}` : null;
}
