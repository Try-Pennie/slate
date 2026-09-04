/**
 * What a NEW event type gets when a field is left blank, and what each field
 * does (#1950).
 *
 * The add form used to carry these numbers as literal `defaultValue`s in its
 * JSX, and the database carries its own DDL defaults, and the create action
 * carried a third set as `num(form, ..., fallback)` arguments. Three copies of
 * one fact, and they had already drifted: the form offered a 30 minute call on
 * a 15 minute grid while the record listed directly above it read 20 minutes on
 * a 10 minute grid. Dan read the two numbers off one screen ("it's say 10m grid
 * in the top but the box says 15m").
 *
 * So this is the ONE copy. The form quotes it in its placeholders, the action
 * applies it to a blank field, and `scripts/test-event-type-defaults.ts` parses
 * the `create table event_types` block out of the migration and fails if the
 * database disagrees with any value here. Updating a default is one edit plus a
 * migration, and the guard names the mismatch if only one of the two is done.
 *
 * The numbers are deliberately NOT read from the existing record. A default
 * derived from whatever happens to be configured is how the drift above reads
 * as a suggestion, and it makes the commonest mistake (pressing Add without
 * editing anything) create a near copy of a record that already exists.
 */
export const EVENT_TYPE_DEFAULTS = {
  regal_type: "call",
  duration_min: 30,
  buffer_before_min: 0,
  buffer_after_min: 0,
  min_notice_min: 120,
  slot_interval_min: 15,
} as const;

/**
 * What the non obvious fields DO, as opposed to what unit they are in.
 *
 * The labels are bracketed with their unit (`Grid (m)`), which #1901's guard
 * correctly treats as a unit rather than a gloss. Both are true and Dan wanted
 * the other half: "I also don't know exactly what each box does". `Grid (m)`
 * says the value is minutes and never says it is the spacing between the start
 * times a lead is offered.
 *
 * These render as VISIBLE hint lines under each field, not as a `title`
 * tooltip. The tooltip half of the pattern in `RosterTable` is right for a
 * legend on a table header, where the letters are a shorthand and the hover is
 * an extra; it is the wrong half here, because a hint that only appears on
 * hover is not there for a touch screen or for somebody tabbing through the
 * form, which is exactly who is filling one in.
 *
 * Keyed by the form field name, so a field and its explanation cannot drift
 * apart, and the guard requires every key here to be a real field on the form.
 */
export const EVENT_TYPE_FIELD_NOTES: Record<string, string> = {
  slot_interval_min: "How far apart the offered start times sit.",
  min_notice_min: "How far ahead of now the earliest offered time can be.",
  buffer_after_min: "Kept free after the call, so the next cannot start on top of it.",
  daily_cap: "Most calls one agent takes in a day. Blank means no cap.",
};
