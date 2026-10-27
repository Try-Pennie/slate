/**
 * The Coordinator booking page's list of scheduling coordinators (#4264, D10).
 *
 * Pure: the rows and their sign in times in, the rows the table draws out. The reads
 * live in `coordinators-load.ts`; this is the part a test can judge without a database.
 *
 * Sorted by the name shown, because a super admin comes here looking for one person
 * (D10). A coordinator granted on Team access who has never signed in has no name yet,
 * so their address stands in for it, in the sort and in the cell.
 */
import { DateTime } from "luxon";
import { NEVER_SIGNED_IN, SIGN_IN_UNREADABLE } from "./coordinator-booking-copy.ts";

export interface CoordinatorUser {
  id: string;
  name: string | null;
  email: string;
  /** The Supabase sign in behind the row; null for somebody who has never signed in. */
  auth_user_id: string | null;
}

/** What Supabase answered about one sign in account. */
export type SignIn = { kind: "never" } | { kind: "at"; iso: string } | { kind: "unreadable" };

export interface CoordinatorRow {
  id: string;
  name: string;
  email: string;
  lastSignedIn: string;
}

/** The list as the page draws it: the rows, or a read that failed, never an empty list in its place (D14). */
export type CoordinatorsRead = { ok: true; rows: CoordinatorRow[] } | { ok: false };

/** Under this long, a sign in is counted in minutes or hours rather than named as today. */
const HOURS_SHOWN = 3;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/**
 * When somebody last signed in, in words, judged in the business zone's calendar days.
 *
 * An unparseable stamp is unreadable rather than a time (L50): every comparison is false
 * for NaN, and the branch it would fall to is the most confident one.
 */
export function signedInWhen(signIn: SignIn, nowMs: number, zone: string): string {
  if (signIn.kind === "never") return NEVER_SIGNED_IN;
  if (signIn.kind === "unreadable") return SIGN_IN_UNREADABLE;
  const then = DateTime.fromISO(signIn.iso, { zone });
  if (!then.isValid) return SIGN_IN_UNREADABLE;
  const minutes = Math.floor((nowMs - then.toMillis()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < HOURS_SHOWN) return plural(hours, "hour");
  const today = DateTime.fromMillis(nowMs, { zone }).startOf("day");
  const days = Math.round(today.diff(then.startOf("day"), "days").days);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The table's rows, alphabetical by the name shown. A sign in account the lookup has no
 * answer for is unreadable, never "never signed in": the second is a claim about the
 * person, the first only about the read.
 */
export function coordinatorRows(
  users: readonly CoordinatorUser[],
  signIns: ReadonlyMap<string, SignIn>,
  nowMs: number,
  zone: string,
): CoordinatorRow[] {
  return users
    .map((u) => {
      const signIn: SignIn = u.auth_user_id ? (signIns.get(u.auth_user_id) ?? { kind: "unreadable" }) : { kind: "never" };
      const name = u.name?.trim() || u.email;
      return { id: u.id, name, email: u.email, lastSignedIn: signedInWhen(signIn, nowMs, zone) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
