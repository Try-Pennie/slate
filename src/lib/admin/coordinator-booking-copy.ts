/**
 * Every sentence the Coordinator booking admin page says (#4264), in one place.
 *
 * The settled design (docs/design/coordinator-admin.html) draws its frames from
 * docs/design/fixtures/coordinator-admin.json, and
 * scripts/test-coordinator-admin-design-fixture.ts holds that file's copy to this one,
 * word for word, so the page and the design cannot drift into saying two things.
 *
 * Pure and import free, so the node suites load it.
 */

export const COORDINATOR_BOOKING_HREF = "/admin/coordinator-booking";

export const COORDINATOR_BOOKING_COPY = {
  page: {
    title: "Coordinator booking",
    // D5: who these people are, explained once, under the title (L604).
    intro:
      "The offshore team who book and move customers' calls by phone. Slate opens no other page to them.",
  },
  section: { heading: "Scheduling coordinators" },
  switch: {
    heading: "Coordinator calls nobody is free for",
    // D6: true in both states, so it stays whichever way the switch is set.
    rule:
      "Only scheduling coordinators, booking on their own page, can ever put a call on Marcia, Pennie's AI agent. Leads booking on the website never can.",
    off: "Off. A coordinator who tries to book one is refused.",
    on: "On. A coordinator can book one on Marcia, and Regal rings it to whichever advisor is free.",
    turnOn: "Let coordinators book on Marcia",
    turnOff: "Stop booking them on Marcia",
    confirmOn:
      "From the next booking, a coordinator can book a time no advisor is free for. The call goes on Marcia, and Regal rings it to whichever advisor is free when it comes up. You can turn this off again here.",
  },
  list: {
    person: "Coordinator",
    lastSignedIn: "Last signed in",
    empty: "Nobody has coordinator access yet. You give it on Team access.",
    failed: "Could not read who has coordinator access.",
    failedMeanwhile: "Nobody's access has changed. Reload the page to try again.",
    removeAsk:
      "{name} will no longer be able to sign in to Slate or book calls. The calls {first} has already booked stay as they are.",
  },
} as const;

/**
 * The switch's third state, which the design does not draw: the setting could not be
 * read. It says what coordinators meet meanwhile rather than claiming either answer
 * (L530), and offers no control, since a press would be a guess at which way it goes.
 * The booking path refuses an unreadable switch by name (`switch-unreadable`).
 */
export const PLACEHOLDER_SWITCH_UNREADABLE = {
  title: "Could not read whether coordinators can book a call nobody is free for.",
  meanwhile:
    "Until it can be read, a coordinator who tries to book one is refused, as if it were off. A time an advisor is free for still books as usual, and this clears itself once the setting can be read again.",
} as const;

/** A coordinator who has never signed in, in the Last signed in column. */
export const NEVER_SIGNED_IN = "Never signed in";

/** A sign in time Supabase could not give us for one person: said, never guessed. */
export const SIGN_IN_UNREADABLE = "Could not read";

/** The question Remove asks, for one person. `first` is the name's first word. */
export function removeQuestion(name: string): string {
  const first = name.split(" ")[0] || name;
  return COORDINATOR_BOOKING_COPY.list.removeAsk.replace("{name}", name).replace("{first}", first);
}

/** The Remove control's name for a screen reader, and its confirm's label (D11, D12). */
export const removeLabel = (name: string): string => `Remove ${name}`;
