/**
 * Whether this version's scheduled() handler stands down (#3095).
 *
 * The gradual deploy sends 10% of traffic to a new version while it is probed, so two
 * versions serve at once, and Cloudflare does not document which of them a cron tick is
 * handed to while they do. Rather than rest on that, the canary is uploaded with
 * `SLATE_CRON_STANDBY=1` and runs no lane at all: whichever version Cloudflare picks,
 * only the version that was already serving ever runs a cron lane, nothing runs twice,
 * and code that has not passed its probe never touches the lanes. The version that is
 * then promoted is the same build uploaded WITHOUT the variable
 * (scripts/lib/gradual-deploy.ts), so standby never reaches 100%.
 *
 * A tick handed to the canary is dropped, not run. The deploy only opens the split when
 * no hourly or daily instant falls inside it, so the only ticks that can be dropped
 * belong to lanes that run again within fifteen minutes.
 */
export type CronStandby = { standby: false } | { standby: true; why: "set" | "unreadable" };

export function cronStandby(value: unknown): CronStandby {
  if (value === undefined || value === null || value === "" || value === "0") return { standby: false };
  if (value === "1") return { standby: true, why: "set" };
  // Only the canary upload ever sets this, so a value nobody can read most likely came
  // from one, and the safe side for a canary is to run nothing.
  return { standby: true, why: "unreadable" };
}
