/**
 * The pages a signed-in person has of their OWN, as opposed to the console,
 * which is about other people.
 *
 * There are two, and they were one page until 2026-09-08. The single page
 * carried the hours that decide when somebody can be booked AND the time off
 * they are asking for, which are different questions asked at different moments:
 * hours are set once when you join and edited when your life changes, time off
 * is asked for the week before a holiday. Stacking them made the page long
 * enough that the working hours card sat below a form most visits did not need.
 *
 * Kept in one list, and read by the header rather than written out there, so a
 * tab and its page cannot drift apart (L41). `scripts/test-me-nav.ts` resolves
 * every href to a real page file, because a nav entry is read by everyone
 * afterwards as proof its destination exists (L619).
 *
 * Deliberately NOT gated by anything. AGENT_SCHEDULING_LIVE hid an agent's own
 * hours from them while the tool was unfinished; the tool is finished, and a
 * person's own hours are not a console surface.
 */
export type MeTab = {
  href: string;
  label: string;
};

export const ME_TABS: readonly MeTab[] = [
  // First, because /me lands here: the hours are what decide whether an agent
  // gets calls at all, so they are in front of them on every visit.
  //
  // #2107: it has its own address, in the same shape as every other page in the
  // product, and /me redirects to it. Everything that sends somebody to their own
  // availability reads this href rather than writing an address out, so the tab
  // and the page cannot drift (L41).
  { href: "/me/my-availability", label: "My Availability" },
  // "My Requests" named the mechanism and not the subject, so it said nothing
  // about what was being requested. The manager-side twin is "Team Time Off".
  { href: "/me/time-off", label: "My Time Off" },
] as const;
