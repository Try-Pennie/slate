// Shared plumbing for the hand-run production smoke scripts (scripts/smoke-*.ts),
// extracted so the request helpers and the pass/fail checker have ONE definition
// instead of being copy-pasted (and drifting) across each script (#530).
//
// Env is read lazily, at call time, NOT at import: several smoke scripts call
// loadEnvFiles(".env.local", ...) in their own top-level code, which runs AFTER
// this module's imports are evaluated. Reading process.env inside each function
// keeps those scripts working regardless of import order.

export type Json = Record<string, unknown>;

/** Base URL of the target deployment (SLATE_BASE_URL, default prod), no trailing slash. */
export function smokeBase(): string {
  return (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
}

/** The booking API key (BOOKING_API_KEY); empty string if unset. */
export function smokeKey(): string {
  return process.env.BOOKING_API_KEY ?? "";
}

/** Last path segment of a manage URL (the manage token); safe on null/undefined. */
export function tokenFrom(manageUrl: unknown): string {
  return String(manageUrl ?? "").split("/").pop() ?? "";
}

/** POST JSON to `path`, optionally bearer-authed. Never throws on a non-JSON body. */
export async function jpost(
  path: string,
  body: Json,
  auth = false,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${smokeKey()}`;
  const res = await fetch(`${smokeBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

/** Open availability slots for a bucket. Returns [] on any non-200 or missing field. */
export async function slots(bucket: string): Promise<string[]> {
  const res = await fetch(`${smokeBase()}/api/availability?bucket=${encodeURIComponent(bucket)}`, {
    headers: { authorization: `Bearer ${smokeKey()}` },
  });
  const body = (await res.json().catch(() => ({}))) as { slots?: string[] };
  return res.status === 200 ? body.slots ?? [] : [];
}

/**
 * A pass/fail checker with isolated counting. Each smoke script does:
 *   const { check, failed } = createChecker();
 *   ...
 *   process.exit(failed() ? 1 : 0);
 */
export function createChecker(): {
  check: (cond: boolean, msg: string) => void;
  failed: () => number;
} {
  let failures = 0;
  return {
    check(cond: boolean, msg: string): void {
      if (cond) console.log("ok:", msg);
      else {
        console.error("FAIL:", msg);
        failures += 1;
      }
    },
    failed: () => failures,
  };
}
