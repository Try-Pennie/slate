/**
 * Where every Durable Object Slate creates is placed (#3752).
 *
 * The Worker runs beside Supabase in Oregon (the `aws:us-west-2` placement hint, #3693),
 * and an object is created where its FIRST request comes from, then stays there for
 * life. A hint applies only at creation, so an object already created elsewhere keeps
 * its place. One constant, so a new object cannot be created somewhere else by omission;
 * `scripts/test-object-location-hint.ts` fails any lookup in `src/` or `worker/` that
 * does not pass it.
 */
export const OBJECT_LOCATION_HINT = "wnam";

/** The Durable Object namespace shape the counters use, named here because
 *  `@cloudflare/workers-types` is not a dependency of the app's program. */
export interface DurableObjectishNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, opts?: { locationHint?: string }): { fetch(url: string, init?: RequestInit): Promise<Response> };
}
