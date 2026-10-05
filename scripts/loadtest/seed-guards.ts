/**
 * The refusals the load test seed makes before it writes anything (#2243). Pure,
 * so `scripts/test-loadtest-seed-guards.ts` drives every one of them with no
 * database.
 */

/**
 * Why a branch's schema is not the one this checkout ships, or null when it is.
 *
 * BOTH the count and the highest version, and the count is the half that matters.
 * The migration directory has never been replayed from empty (L570), so a branch
 * can carry the newest file and be missing one in the middle, and every finding of
 * a ten minute run would then be about the schema rather than about the booking
 * path. Comparing only the highest is the check that looks right and passes on the
 * broken case.
 *
 * An EMPTY applied list is its own message rather than an off-by-N: a branch that
 * reports no migrations at all is one whose migration table could not be read, or
 * one that was never migrated, and neither is a count somebody should reason about.
 */
export function migrationMismatch(
  applied: readonly string[],
  shipped: readonly string[],
  shippedVersion: string,
): string | null {
  if (shipped.length === 0) {
    return "this checkout ships no migrations at all, so there is nothing to compare a branch against";
  }
  if (applied.length === 0) {
    return (
      "the branch reports no applied migrations at all, so it was either never migrated or its " +
      "migration table could not be read. The seed refuses either way."
    );
  }
  const highest = [...applied].sort()[applied.length - 1]!;
  if (applied.length !== shipped.length || highest !== shippedVersion) {
    return (
      `the branch has ${applied.length} migrations (highest ${highest}) and this checkout ships ` +
      `${shipped.length} (highest ${shippedVersion}). A run seeded against a different schema ` +
      `measures the schema. Rebase or recreate the branch.`
    );
  }
  return null;
}

/**
 * An agent count that can actually be seeded, or null.
 *
 * `Number(process.env.AGENTS)` is NaN for anything unreadable, and NaN compares
 * false against every threshold, so a guard written as `n <= 0` waves it through
 * and the arithmetic downstream produces a roster of NaN agents with every count
 * reading as a number (L50). Refused by name instead.
 */
export function readAgentCount(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  // Matched as DIGITS rather than parsed, for the same reason `readEventTypeId`
  // is: `Number` accepts "1e3", "0x10" and " 12 " and quietly yields 1000, 16 and
  // 12, and no seed command is ever written in any of those. A roster silently
  // sixteen agents deep is worse than a refusal somebody can read.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** What the seed will build, or why it will not. */
export interface AgentCountDecision {
  /** The roster size to seed, or null when this refuses. */
  count: number | null;
  /**
   * What a reader needs told: why it refused, or that a deliberate mismatch is
   * being honoured. Null when there is nothing to explain.
   */
  why: string | null;
}

/**
 * How many agents to seed: the SHAPE decides, not a coded default (#2320).
 *
 * `AGENTS` defaulted to 200 while the shape the seed reproduces carries the
 * measured count (90 baked in, 94 on the 2026-09-14 export). The seed printed the
 * shape's count in its own log line and then ignored it, so on 2026-09-14 the first
 * branch for the #2284 re-run came up with 200 bookable agents against
 * production's 94, pool depths roughly double the real ones, and had to be thrown
 * away and re-created.
 *
 * It fails GREEN, which is why it is a refusal rather than a matter of care: a
 * roster of the wrong size seeds perfectly, every count reads as a number, and the
 * run measures a shape nobody chose (L354). The shape's pool depths are also what
 * the seeded output is CHECKED against, so a different total makes that check
 * meaningless, which is why an explicit count that DISAGREES is refused rather
 * than quietly winning.
 *
 * A deliberate experiment says so with `ALLOW_AGENT_COUNT_MISMATCH`, and the run
 * still SAYS the roster is not the one the shape describes: a silent override is
 * the same defect wearing a flag.
 */
export function resolveAgentCount(input: {
  /** The raw `AGENTS` value, or undefined when none was given. */
  rawAgents: string | undefined;
  /** The agent count the shape being reproduced carries. */
  shapeAgents: number;
  /** `ALLOW_AGENT_COUNT_MISMATCH`, for a deliberate experiment. */
  allowMismatch?: boolean;
}): AgentCountDecision {
  const fromShape =
    Number.isSafeInteger(input.shapeAgents) && input.shapeAgents > 0 ? input.shapeAgents : null;
  const raw = (input.rawAgents ?? "").trim();

  if (raw === "") {
    // No count given, so the shape is the only answer. A shape with no usable count
    // is its own refusal rather than a reason to fall back to a coded default: that
    // substitution is the whole defect.
    if (fromShape === null) {
      return {
        count: null,
        why:
          `the roster shape claims ${JSON.stringify(input.shapeAgents)} agents, which is not a ` +
          "roster this can seed, and no AGENTS was given to use instead",
      };
    }
    return { count: fromShape, why: null };
  }

  // Unreadable is refused on its own wording, never folded into the mismatch
  // message: they send a reader to two different things (L11).
  const asked = readAgentCount(raw, 0);
  if (asked === null || asked === 0) {
    return {
      count: null,
      why:
        `AGENTS is not a positive whole number: ${JSON.stringify(input.rawAgents)}. Refused by ` +
        "name rather than left to become a roster of NaN agents",
    };
  }
  if (fromShape === null || asked === fromShape) return { count: asked, why: null };
  if (input.allowMismatch) {
    return {
      count: asked,
      why:
        `seeding ${asked} agents against a shape measured at ${fromShape}, because ` +
        "ALLOW_AGENT_COUNT_MISMATCH is set. The shape's pool depths describe a different roster, " +
        "so the seed's own depth check is about a roster this run is not building",
    };
  }
  return {
    count: null,
    why:
      `AGENTS is ${asked} and the roster shape was measured at ${fromShape} agents, which does ` +
      "not match. The shape's pool depths are what the seeded output is checked against, so a " +
      "different total makes that check meaningless. Drop AGENTS to seed the shape, or set " +
      "ALLOW_AGENT_COUNT_MISMATCH=1 if the difference is the experiment",
  };
}

/**
 * Why the branch's applied migrations could not be read, or null (#2261).
 *
 * The read goes through the `applied_migration_versions()` RPC, never the table.
 * PostgREST exposes the `public` schema ONLY, so
 * `supabase_migrations.schema_migrations` is unreachable over the API and answers
 * 406 on every project; migration 0072 records that and ships the function for
 * exactly this. The seed shipped reading the table and died on its own check
 * before writing a row, which looks identical to the bad schema the check exists
 * to catch.
 *
 * Each status gets its own sentence, because they send different people to
 * different places (L11): a 404 is a branch missing migration 0072, a 401 or 403
 * is a key that may not call a function granted to the secret key client alone,
 * and anything else is the read itself.
 */
export function migrationReadRefusal(status: number, bodyText: string): string | null {
  if (status === 200) return null;
  const tail = bodyText.trim() === "" ? "" : ` ${bodyText.slice(0, 200)}`;
  if (status === 404) {
    return (
      `applied_migration_versions() answered 404${tail}. Migration 0072 is not applied to this ` +
      `branch, so its schema cannot be checked and the seed refuses.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `applied_migration_versions() answered ${status}${tail}. Execute on it is granted to the ` +
      `secret key server client only, so this key may not call it.`
    );
  }
  if (status === 406) {
    return (
      `applied_migration_versions() answered 406${tail}. A 406 is what reading ` +
      `supabase_migrations directly gives, so something is calling the table rather than the RPC.`
    );
  }
  return (
    `could not read the branch's applied migrations (${status}${tail}). The seed refuses to run ` +
    `against a schema it cannot check.`
  );
}

/**
 * The applied versions out of the RPC's answer, or a refusal.
 *
 * An answer that is not an array is NOT an empty branch. Reading it as one would
 * hand `migrationMismatch` a count of zero, which it reports as "never migrated or
 * the migration table could not be read": a true sentence about the wrong thing,
 * pointing at the branch when the fault is the function.
 */
export function appliedVersionsFrom(body: unknown): { versions: string[] } | { why: string } {
  if (!Array.isArray(body)) {
    return {
      why:
        "applied_migration_versions() did not return an array, so the branch's schema could not " +
        "be checked. Migration 0072 may be unapplied, or something other than the RPC answered.",
    };
  }
  return { versions: body.map((v) => String(v)) };
}

/**
 * Why a script must not write to this Supabase address, or null when it may
 * (#3258). Shared by the seed and the between arms reset, so the two can never
 * disagree about what production is (L41). The production ref is passed in rather
 * than imported, which keeps this file free of imports.
 *
 * An empty address refuses rather than passing: whether it is production cannot
 * be established. `force` is the seed's own FORCE=1 escape hatch; the reset always
 * passes false.
 */
export function productionRefusal(
  url: string,
  productionRef: string,
  opts: { force: boolean; action: string },
): string | null {
  if (url.trim() === "") return `No SUPABASE_URL is set, so whether this would ${opts.action} production cannot be established.`;
  if (url.includes(productionRef) && !opts.force) {
    return `Refusing to ${opts.action} the production project (${productionRef}). Point SUPABASE_URL at a branch.`;
  }
  return null;
}

/**
 * The seed's own marker (#3258): what `seed.ts` writes that no real project holds.
 * The between arms reset deletes only where it finds these, so they live here, beside
 * the guard both scripts share, rather than as literals in each (L41).
 */
export const SEED_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SEED_ORG_NAME = "Loadtest Org";
/** Every seeded agent's address is `loadtest-agent-<n>@` this domain, which is not routable. */
export const SEED_AGENT_EMAIL_DOMAIN = "loadtest.local";

/**
 * The settings row the seed writes (#3325): the shared confirm line ON.
 *
 * The run exists to prove the shared confirm line before production uses it, so the
 * branch's stored switch must be on, or every confirm would wait in its own server's
 * line and the burst would measure the line the run is meant to replace. A fresh branch
 * holds no settings row at all (migration 0086 seeds none), and every other column has a
 * default, so this one row is the whole write. The preflight refuses a branch where the
 * switch is not on (`sharedLineSwitchVerdict` in `preflight-checks.ts`), and its test
 * drives that verdict with THIS constant, so the two cannot disagree about what on looks
 * like.
 */
export const SEED_BOOKING_SETTINGS = { id: 1, shared_confirm_line: true } as const;
