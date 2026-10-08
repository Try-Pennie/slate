/**
 * Compile-time guard (#3489): the person lookup's typed arguments say what the
 * database accepts. `find_active_bookings_for_person` refuses the `bucket` world
 * without a bucket code (22023), and a named world carries none, so the types refuse
 * both shapes too: a world and the code it needs are one value, never two fields that
 * can disagree (L544). If the Args type were loosened back to a flat record, the
 * assignments below would compile, an `@ts-expect-error` would become unused, and
 * `tsc --noEmit` (CI and the pre-push gate) fails on that instead.
 *
 * Never imported at runtime; it exists only to be type-checked.
 */
import type { Database } from "@/lib/db/schema";

type Args = Database["public"]["Functions"]["find_active_bookings_for_person"]["Args"];
const signals = { p_ids: [] as string[], p_email_like: null, p_phone: null };

// @ts-expect-error the bucket world names the bucket whose world it is
export const _bucketWithoutCode: Args = { ...signals, p_world: "bucket" };

// @ts-expect-error a named world carries no bucket code
export const _namedWorldWithCode: Args = { ...signals, p_world: "real", p_bucket_code: "100" };

// And the shapes the database accepts still compile.
export const _bucketWorld: Args = { ...signals, p_world: "bucket", p_bucket_code: "100" };
export const _namedWorld: Args = { ...signals, p_world: "test" };
export const _bothWorlds: Args = { ...signals, p_world: "both" };
