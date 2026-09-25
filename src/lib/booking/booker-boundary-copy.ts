/**
 * What the booker's own error boundary says to a lead (#2754).
 *
 * `booker-copy.ts` re-exports this, so the preview and the parity test read it
 * where they read every other booker sentence. It lives in its own file, with no
 * imports, for one reason: the boundary is a client component on the booker's
 * routes, and importing the whole booker copy module into it added about 10 KB
 * gzipped to the client bundle (measured 2026-09-25, 448,323 to 458,116) for one
 * heading, one sentence and a button label. An error screen should carry as
 * little as possible, since it is what draws when something else has already
 * gone wrong.
 *
 * The boundary used the staff sentence, which tells an admin mid edit to check
 * whether their change went through, and read oddly to a lead mid booking.
 *
 * What it may CLAIM is the hard part the staff copy names too: a boundary cannot
 * tell a failed page load from a crash on the confirmation screen, which renders
 * AFTER the booking committed. So it may not say "nothing was booked". It says
 * what is true: trying again brings the times back, and somebody who had just
 * booked has an invite to look for before booking a second call.
 */
export const BOOKER_BOUNDARY_COPY = {
  heading: "This page did not finish loading",
  body:
    "Something went wrong on our side. Try again to pick a time. If you had just " +
    "booked a call, check your email for the invite before booking again.",
  retry: "Try again",
} as const;
