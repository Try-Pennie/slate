/**
 * Which SECURITY DEFINER functions can the web roles execute, in PRODUCTION? (#2447)
 *
 * A definer function runs as its owner, so a grant to `anon` or `authenticated` hands an
 * unauthenticated caller the owner's reach over PostgREST. Slate revokes those grants in
 * every migration that defines one, and `scripts/test-migration-grants.ts` (#2391) proves
 * it. That guard reads the REPOSITORY, which leaves it blind to exactly the two cases where
 * the database is the only witness: a grant made by hand against the live database, and a
 * definer function that appears in no migration at all. A check verifying another system's
 * work must not be built on the record our own code wrote (L58).
 *
 * Production holds one of the second kind. Measured 2026-09-16 and 2026-09-17: Supabase's
 * own `rls_auto_enable`, owner `postgres`, attached to the `ensure_rls` event trigger and in
 * no Slate migration, reads executable for both web roles. It is not a live hole, and the
 * reason it is not is the whole design of the exemption below.
 *
 * THE EXEMPTION IS THE INTERESTING PART. Excusing the platform by a blanket filter (an owner,
 * a name prefix, a schema) would excuse the next platform function too, including one that IS
 * reachable, and nothing would ever say so. So each exemption is named, carries a written
 * reason, and is matched on the FACT the reason rests on: `rls_auto_enable` is safe because it
 * returns `event_trigger`, which PostgREST cannot serialize and therefore cannot call. Match on
 * the name alone and a platform function that started returning jsonb would stay excused by a
 * word somebody typed in 2026 (L129, L233, L362: write the exemption as the REASON, never as
 * one named case).
 *
 * Three outcomes, never two, because "nothing is exposed" and "nothing was read" render
 * identically in silence (#1394, L98):
 *
 *   unmeasured - the read threw, or came back with no rows. Slate defines a dozen definer
 *                functions, so an empty answer is the shape of a broken read and never a
 *                healthy database. It pages nobody and, crucially, CLEARS nobody.
 *   healthy    - measured, and everything the web roles can execute is named and reasoned.
 *   exposed    - measured, and something else is. This pages.
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state key for the condition. */

export const DEFINER_GRANTS_KEY = "definer_grants_to_web_roles";

/** The two roles PostgREST serves a request as. Nothing else is a web role. */
export const WEB_ROLES = ["anon", "authenticated"] as const;
export type WebRole = (typeof WEB_ROLES)[number];

/** One `SECURITY DEFINER` function in `public`, as the database reports it. */
export interface DefinerFunctionRow {
  name: string;
  args: string;
  returns: string;
  anonExecute: boolean;
  authenticatedExecute: boolean;
}

/**
 * A function the web roles may execute, excused by name AND by the fact that makes it safe.
 *
 * `returns` is not documentation. It is the condition: a row whose return type differs is
 * not this function any more for the purpose of the excuse, and is reported.
 */
export interface PlatformExemption {
  name: string;
  returns: string;
  reason: string;
}

export const PLATFORM_DEFINER_EXEMPTIONS: readonly PlatformExemption[] = [
  {
    name: "rls_auto_enable",
    returns: "event_trigger",
    reason:
      "Supabase's own function behind the ensure_rls event trigger, owned by postgres and " +
      "defined in no Slate migration. It is unreachable over PostgREST because a function " +
      "returning event_trigger cannot be called through the API at all, which is the fact " +
      "this excuse rests on, so a version of it returning anything callable is reported.",
  },
];

/** One function the web roles can execute that nothing excuses. */
export interface ExposedDefinerFunction {
  name: string;
  args: string;
  returns: string;
  /** Which web roles hold EXECUTE, because a grant to anon is a different urgency to one to authenticated. */
  roles: WebRole[];
}

export type DefinerGrantsHealth =
  | { status: "unmeasured"; why: string }
  | {
      status: "healthy";
      scanned: number;
      /** The excused functions actually found, so an excuse is never silent. */
      exempted: string[];
      /**
       * Exemptions matching nothing this tick. Deliberately NOT a page: an excuse that
       * covers nothing suppresses nothing, so it is a tidy up rather than an incident. It
       * is reported here and in the log line so a suppression cannot sit unread forever
       * (L523), which is the whole complaint against a hand maintained list.
       */
      unusedExemptions: string[];
    }
  | {
      status: "exposed";
      scanned: number;
      exposed: ExposedDefinerFunction[];
      exempted: string[];
      unusedExemptions: string[];
    };

function rolesHolding(row: DefinerFunctionRow): WebRole[] {
  const held: WebRole[] = [];
  if (row.anonExecute) held.push("anon");
  if (row.authenticatedExecute) held.push("authenticated");
  return held;
}

/**
 * The verdict. Pure, so every branch including the two that must stay silent is driven
 * offline by `scripts/test-definer-grants.ts`.
 *
 * `rows: null` is a read that failed. `rows: []` is a read that returned nothing, which is
 * the same verdict for a different reason, and both are said separately so a reader is not
 * sent to look at the wrong thing (L11).
 */
export function definerGrantsHealth(input: {
  rows: DefinerFunctionRow[] | null;
  exemptions?: readonly PlatformExemption[];
}): DefinerGrantsHealth {
  const exemptions = input.exemptions ?? PLATFORM_DEFINER_EXEMPTIONS;

  if (input.rows === null) {
    return {
      status: "unmeasured",
      why: "the definer function grants could not be read from the database this tick",
    };
  }
  if (input.rows.length === 0) {
    return {
      status: "unmeasured",
      why:
        "the read returned no definer functions at all, and Slate defines several, so this " +
        "is a read that did not work rather than a database with nothing in it",
    };
  }

  const exempted: string[] = [];
  const exposed: ExposedDefinerFunction[] = [];

  for (const row of input.rows) {
    const roles = rolesHolding(row);
    if (roles.length === 0) continue;
    const excuse = exemptions.find((e) => e.name === row.name && e.returns === row.returns);
    if (excuse) {
      exempted.push(row.name);
      continue;
    }
    exposed.push({ name: row.name, args: row.args, returns: row.returns, roles });
  }

  const present = new Set(input.rows.map((r) => r.name));
  const unusedExemptions = exemptions.filter((e) => !present.has(e.name)).map((e) => e.name);

  if (exposed.length > 0) {
    return { status: "exposed", scanned: input.rows.length, exposed, exempted, unusedExemptions };
  }
  return { status: "healthy", scanned: input.rows.length, exempted, unusedExemptions };
}

function describe(f: ExposedDefinerFunction): string {
  return `${f.name}(${f.args}) returns ${f.returns}, executable by ${f.roles.join(" and ")}`;
}

/**
 * The page. It names every function and the role that holds it, because the remedy is a
 * REVOKE naming both, and it says where to look rather than pasting a catalogue dump.
 */
export function formatDefinerGrantsExposedAlert(
  health: Extract<DefinerGrantsHealth, { status: "exposed" }>,
): string {
  const one = health.exposed.length === 1;
  const lines = health.exposed.map((f) => `- ${describe(f)}`);
  return (
    `${health.exposed.length} privileged database ${one ? "function is" : "functions are"} ` +
    `open to the web in production, out of ${health.scanned} read. Each one runs with its ` +
    `owner's privileges and ignores row level security, and the roles below are what a ` +
    `caller gets with no Slate login.\n` +
    lines.join("\n") +
    `\nRevoke EXECUTE on it from the role named (these are SECURITY DEFINER functions in ` +
    `schema public), then re-run the check. A grant that is deliberate needs an exemption ` +
    `carrying the fact that makes it safe.`
  );
}

/** The all clear. It says how many it measured, so nobody reads it as a read that found nothing. */
export function formatDefinerGrantsClearedAlert(
  health: Extract<DefinerGrantsHealth, { status: "healthy" }>,
): string {
  const excused = health.exempted.length
    ? ` ${health.exempted.length} excused by name: ${health.exempted.join(", ")}.`
    : "";
  return (
    `No privileged database function is open to the web any more. ` +
    `${health.scanned} read in production.${excused}`
  );
}

/**
 * The lane's step. Mirrors `runEdgeLimiterCheck`: a throwing read is caught HERE so the
 * check still returns a typed verdict rather than the step boundary's fallback standing in
 * for one, and an unmeasured tick returns before it can notify or resolve anything.
 */
export async function runDefinerGrantsCheck(deps: {
  read: () => Promise<DefinerFunctionRow[] | null>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<DefinerGrantsHealth> {
  let rows: DefinerFunctionRow[] | null;
  try {
    rows = await deps.read();
  } catch {
    rows = null;
  }

  const health = definerGrantsHealth({ rows });

  if (health.status === "unmeasured") {
    deps.log?.(`monitor definer-grants: unmeasured, ${health.why}`);
    return health;
  }

  if (health.status === "exposed") {
    await deps
      .notify(DEFINER_GRANTS_KEY, deps.cooldownMs, formatDefinerGrantsExposedAlert(health))
      .catch(() => {});
    deps.log?.(
      `monitor definer-grants: EXPOSED scanned=${health.scanned} exposed=${health.exposed.length} ` +
        `names=${health.exposed.map((f) => f.name).join("|")} unused_exemptions=${health.unusedExemptions.length}`,
    );
    return health;
  }

  // The all clear hangs off this MEASURED healthy result, never off "we did not alert this
  // tick" (#1134, #1152): the unmeasured branch above returns before reaching it.
  await deps.resolve(DEFINER_GRANTS_KEY, formatDefinerGrantsClearedAlert(health)).catch(() => {});
  deps.log?.(
    `monitor definer-grants: healthy scanned=${health.scanned} exempted=${health.exempted.join("|") || "none"} ` +
      `unused_exemptions=${health.unusedExemptions.join("|") || "none"}`,
  );
  return health;
}
