/**
 * Every sentence the coordinator booking page draws (#4205), as settled with Dan over ten
 * design rounds (docs/design/coordinator-booking.html). The design's own fixture carries
 * the same words, and `scripts/test-coordinator-booking-design-fixture.ts` holds the two
 * together, so a word changed here without a design round fails a test.
 *
 * Written for a reader whose first language may not be English (D20): short sentences,
 * common words, no idioms, and "Check", never "Tick". No script for the coordinator to
 * read aloud (D35): the page states the facts and they say them in their own words.
 *
 * Templates carry `{name}` holes, filled by `fillCopy`. The few sentences beyond the
 * design are for states its frames do not draw (a lookup or booking that never answered,
 * a call check that could not be read), in the same voice. Pure, no imports.
 */
export const COORDINATOR_PAGE_COPY = {
  page: { title: "Book a call" },
  lead: {
    label: "Salesforce Lead",
    find: "Find customer",
    pending: "Looking up the customer",
    notALeadId:
      "This is not a Salesforce Lead link or ID. Paste the link to the customer's Lead. You can also paste the ID at the end of the link. It starts with 00Q.",
    noSuchLead: "Salesforce has no Lead with this ID. Make sure you copied all of it.",
  },
  customer: {
    heading: "Customer",
    phone: "Phone",
    zone: "Time zone",
    clock: "It's {time} for {first} right now.",
  },
  newTime: {
    dayLabel: "Day",
    timeLabel: "Time",
    hours: "On {day}, calls can start from {from} to {to}.",
    reasonLabel: "Why the call is moving",
    reasonPlaceholder: "Choose a reason",
    reasonNeeded: "Choose why the call is moving.",
    book: "Book {day} at {time}",
    bookIdle: "Book the call",
    move: "Move the call to {day} at {time}",
    moveIdle: "Move the call",
    pickDay: "Choose a day to see when calls can start.",
    morning: "Morning",
    afternoon: "Afternoon",
    detailCode: "other",
    detailLabel: "What happened",
    detailMax: 500,
    detailNeeded: "Write what happened.",
  },
  outcome: {
    booking: "Booking the call",
    moving: "Moving the call",
    booked: "Booked",
    moved: "Moved",
    withAdvisor: "With {advisor}.",
    withMarcia: "With Marcia, Pennie's AI agent. No advisor was free at this time, so Marcia will text {first}.",
    marciaName: "Marcia, Pennie's AI agent",
    linkWorks: "{first}'s booking link still works.",
    bookedByYou: "Booked by you",
    movedByYou: "Moved by you",
    again: "Book another call",
  },
  warning: {
    heading: "{first} already has a call",
    details: "It is on {when} with {advisor}.",
    consequence: "If you book a new time, this call moves to the new time.",
    told: "I told {first} their {dayName} call will move",
    unlock: "Check the box above after you tell {first}.",
    lockedSay: "You cannot book yet. First check the box that says you told {first} their {dayName} call will move.",
    overlay: "Check the box above first",
  },
  day: { today: "Today", tomorrow: "Tomorrow", closed: "Closed" },
  dialog: {
    titleBook: "Book this call for {name}?",
    titleMove: "Move {name}'s call?",
    when: "{day} at {time}, {zone}",
    moves: "Moves {first}'s {old} call",
    back: "Go back",
    book: "Book the call",
    move: "Move the call",
  },
  /** States the design's frames do not draw, in the same voice. */
  more: {
    /** Said for the customer when the Lead carries no first name. */
    theCustomer: "the customer",
    noPhone: "No phone on the Lead",
    anAdvisor: "an advisor",
    lookupNoAnswer: "Salesforce did not answer. Press Find customer to try again.",
    daysUnreadable: "We could not load the times calls can start. Press Find customer to try again.",
    noDays: "No calls can be booked in the next few days.",
    callUnreadableHeading: "We could not check if {first} already has a call",
    callUnreadableDetails: "Slate checks again when you book, so a call is never booked twice.",
    looseHeading: "{first} may already have a call",
    looseDetails: "A call on {when} has the same {matched} but a different Salesforce Lead.",
    looseConsequence: "Nothing can be booked here until you check with {first} which Lead is theirs.",
    looseLine: "Check which Lead is theirs, then find the customer again.",
    matchedBoth: "email and phone",
    matchedOne: "email or phone",
    needsConfirm: "{first} already has a call, so nothing was booked. Check the box above after you tell {first}, then try again.",
    placeNoAnswer: "We did not hear back, so we do not know if the call was booked. Press the button again. The call will not be booked twice.",
    slow: "Still working",
  },
} as const;

/** Fills `{name}` holes; a hole with no value is left visible rather than silently dropped. */
export function fillCopy(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (hole, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : hole));
}
