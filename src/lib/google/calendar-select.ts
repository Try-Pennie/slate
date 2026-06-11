import type { CalendarListEntry } from "./calendar.ts";

/**
 * Pure: which of an agent's calendars should count toward their busy time.
 *
 * Primary calendar ONLY. The earlier owner/writer rule counted shared team
 * calendars agents can edit (e.g. team OOO calendars), so one teammate's OOO
 * blocked every subscriber's availability (#42). At Pennie all real
 * commitments land on the agent's primary calendar (invites, their own OOO),
 * so that is the busy source of truth.
 */
export function selectableCalendarIds(entries: CalendarListEntry[]): string[] {
  return entries
    .filter((e): e is CalendarListEntry & { id: string } => !!e.id)
    .filter((e) => !e.deleted)
    .filter((e) => e.primary === true)
    .map((e) => e.id);
}
