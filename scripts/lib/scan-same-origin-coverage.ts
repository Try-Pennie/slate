/**
 * Which API routes must carry the same-origin refusal, and which of them do not
 * (#1046).
 *
 * The subject list is DERIVED from the routes themselves rather than written down,
 * because a hand list checks only what somebody remembered to add to it, and the
 * route that gets forgotten is exactly the one the guard exists to catch (L96).
 *
 * A route is a subject when BOTH are true of its file:
 *
 *   * it exports a mutating method (POST / PUT / PATCH / DELETE), and
 *   * it authenticates with the SESSION, i.e. it reaches one of the cookie-backed
 *     role guards.
 *
 * A key-authed route (a Bearer secret, a per-booking token in the URL) is not a
 * subject: CSRF needs a credential the browser attaches on its own, and neither of
 * those is ambient. A read-only route is not a subject either: a cross-site GET can
 * be sent but its response cannot be read.
 */

export interface RouteSource {
  /** Repo-relative path, used in the failure message. */
  path: string;
  text: string;
}

export interface UnguardedRoute {
  path: string;
  /** The mutating methods the file exports, so the message names what is exposed. */
  methods: string[];
  /** The session guard that made it a subject. */
  guard: string;
}

export const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** The cookie-backed guards. A route reaching any of these authenticates with the
 *  session, which is the credential a browser attaches by itself. */
export const SESSION_GUARDS = [
  "requireBookingActor",
  "requireManager",
  "requireAdmin",
  "requireSuperAdmin",
  "currentUser",
  "realCurrentUser",
] as const;

/** The call every subject must make. */
export const REFUSAL_HELPER = "crossOriginRefusal";

/** The mutating methods a route file exports. */
export function mutatingMethods(text: string): string[] {
  return MUTATING_METHODS.filter((m) =>
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(text),
  );
}

/** The first session guard a route file reaches, or null when it uses none. */
export function sessionGuard(text: string): string | null {
  return SESSION_GUARDS.find((g) => new RegExp(`\\b${g}\\b`).test(text)) ?? null;
}

/** Every route that must carry the refusal, whether or not it does. */
export function subjectRoutes(files: RouteSource[]): { path: string; methods: string[]; guard: string }[] {
  const subjects: { path: string; methods: string[]; guard: string }[] = [];
  for (const f of files) {
    const methods = mutatingMethods(f.text);
    if (methods.length === 0) continue;
    const guard = sessionGuard(f.text);
    if (!guard) continue;
    subjects.push({ path: f.path, methods, guard });
  }
  return subjects;
}

/** The subjects that do NOT call the refusal helper. Empty means the rule holds. */
export function scanSameOriginCoverage(files: RouteSource[]): UnguardedRoute[] {
  return subjectRoutes(files).filter((s) => {
    const text = files.find((f) => f.path === s.path)!.text;
    return !new RegExp(`\\b${REFUSAL_HELPER}\\b`).test(text);
  });
}
