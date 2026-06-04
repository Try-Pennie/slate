import type { CalendarListEntry } from "./calendar.ts";

/**
 * Pure: which of an agent's calendars should count toward their busy time.
 *
 * Keep only calendars the agent actually owns or writes to (their real
 * commitments) and drop the noise that would create phantom busy: deleted
 * calendars, Google holiday and birthday/contacts calendars, and read-only
 * subscriptions (e.g. a shared team calendar the agent merely follows). The
 * primary calendar is an owner calendar, so it's always included.
 */
export function selectableCalendarIds(entries: CalendarListEntry[]): string[] {
  return entries
    .filter((e): e is CalendarListEntry & { id: string } => !!e.id)
    .filter((e) => !e.deleted)
    .filter((e) => e.accessRole === "owner" || e.accessRole === "writer")
    .filter((e) => !e.id.endsWith("#holiday@group.v.calendar.google.com"))
    .filter((e) => !e.id.endsWith("#contacts@group.v.calendar.google.com"))
    .map((e) => e.id);
}
