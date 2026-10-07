/**
 * Where a confirm's time went, from its own profile (#3511).
 *
 * The booking failure page used to reason only about the step that refused. On
 * 2026-10-07 16:55 ET the commit gate (#3338) declined to write a booking with 4
 * seconds left and the page said the time went "inside Slate", to look "rather
 * than Google Calendar API and Supabase health", while the request's own line read
 * `assign-and-verify:7555` with one Google call of 6.5 seconds. The profile knew;
 * the page did not ask it.
 */
import { requestObserver } from "@/lib/call-budget";
import type { ConfirmProfile, ConfirmRequestReading } from "./confirm-profile";

export interface TimeSpent {
  /** The dearest named stage. */
  stage: { name: string; ms: number } | null;
  /** The slowest single outside call made INSIDE that stage, by its full label. */
  call: { label: string; ms: number } | null;
}

export function whereTimeWent(r: ConfirmRequestReading): TimeSpent {
  const top = r.stages[0];
  return {
    stage: top ? { name: top.stage, ms: top.ms } : null,
    call: top ? (r.calls?.slowestByStage[top.stage] ?? null) : null,
  };
}

/**
 * The time spent so far by the confirm in force, read through the request's
 * observer, or null when there is none to read: outside any request, or in one
 * nothing profiles. Never throws, since it only feeds a page.
 */
export function timeSpentInThisRequest(now: () => number = () => Date.now()): TimeSpent | null {
  const observer = requestObserver() as Partial<ConfirmProfile> | undefined;
  if (!observer || typeof observer.read !== "function") return null;
  try {
    return whereTimeWent(observer.read(now()));
  } catch {
    return null;
  }
}
