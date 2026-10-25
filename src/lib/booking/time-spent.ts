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
import { stalledTogether, type StalledTogether } from "@/lib/dependency-stall";
import type { ConfirmProfile, ConfirmRequestReading } from "./confirm-profile";

export interface TimeSpent {
  /** The dearest named stage. */
  stage: { name: string; ms: number } | null;
  /** The slowest single outside call made INSIDE that stage, by its full label. */
  call: { label: string; ms: number } | null;
  /**
   * #3784: Google and Supabase BOTH stalled in this confirm (`dependency-stall.ts`),
   * with each one's slowest call; null or absent when they did not. The page then
   * suspects the Cloudflare location before either service.
   */
  stalled?: StalledTogether | null;
  /**
   * #3784: where the confirm ran, the colos Supabase's edge answered it from (the
   * line's `supabase_edge_colo`); null or absent when no answer named one.
   */
  ranAt?: string | null;
}

export function whereTimeWent(r: ConfirmRequestReading): TimeSpent {
  const top = r.stages[0];
  const slowest = (dependency: string) => r.calls?.byDependency.find((d) => d.dependency === dependency)?.maxMs ?? null;
  return {
    stage: top ? { name: top.stage, ms: top.ms } : null,
    call: top ? (r.calls?.slowestByStage[top.stage] ?? null) : null,
    stalled: stalledTogether({ google: slowest("google"), supabase: slowest("supabase") }),
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
    const ranAt = typeof observer.answeredFrom === "function" ? observer.answeredFrom("supabase") : [];
    return { ...whereTimeWent(observer.read(now())), ranAt: ranAt.length > 0 ? ranAt.join(",") : null };
  } catch {
    return null;
  }
}
