// The one judge of Slate's `placement` block (#3693), driven by
// scripts/test-worker-placement.ts against wrangler's resolved config.

/**
 * The cloud region Slate's Worker is pinned beside: the Supabase project's region.
 *
 * Supabase reports the project (`drukfvgaynzrralbzkzj`) as `us-west-2` (West US,
 * Oregon), read from the Management API on 2026-10-14, and Cloudflare's Placement
 * Hints take an AWS region as `aws:{region}`. If the database ever moves, this and
 * the `placement` blocks in wrangler.jsonc move together, in one change.
 */
export const DATABASE_PLACEMENT_REGION = "aws:us-west-2";

/**
 * What is wrong with one resolved `placement` value, empty when it is the hint.
 *
 * Accepts exactly `{ region: DATABASE_PLACEMENT_REGION }`, optionally with
 * `mode: "targeted"`, which wrangler's schema allows as the same hint spelled out.
 * Refuses Smart Placement by name, because that is the edit most likely to come
 * back, and it is the one #3720 measured not moving the cron lanes.
 */
export function placementFaults(label: string, placement: unknown): string[] {
  if (placement === undefined || placement === null) {
    return [`${label} has no placement, so every request runs by whoever sent it, far from the database`];
  }
  if (typeof placement !== "object" || Array.isArray(placement)) {
    return [`${label} has a placement wrangler should never resolve: ${JSON.stringify(placement)}`];
  }
  const p = placement as Record<string, unknown>;
  const faults: string[] = [];
  if (p.mode === "smart") {
    faults.push(
      `${label} uses Smart Placement, which #3720 measured never moving the cron lanes near the database; ` +
        `pin "region": "${DATABASE_PLACEMENT_REGION}" instead (#3693)`,
    );
  } else if (p.mode !== undefined && p.mode !== "targeted") {
    faults.push(`${label} sets placement mode ${JSON.stringify(p.mode)}, not the region hint`);
  }
  if (p.region === undefined) {
    if (p.mode !== "smart") faults.push(`${label} names no placement region; it should be ${DATABASE_PLACEMENT_REGION}`);
  } else if (p.region !== DATABASE_PLACEMENT_REGION) {
    faults.push(
      `${label} is hinted to ${JSON.stringify(p.region)}, but the database is in ${DATABASE_PLACEMENT_REGION}`,
    );
  }
  const extra = Object.keys(p).filter((k) => k !== "mode" && k !== "region");
  if (extra.length > 0) faults.push(`${label} sets ${extra.join(", ")} beside the region hint`);
  return faults;
}
