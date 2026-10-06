/**
 * Whether a pull request changes a Durable Object class without planning its hand deploy
 * (#3352). Pure and dependency free, so the bare node check
 * (`scripts/check-do-migration-planned.ts`) and `scripts/test-do-migration-plan.ts` share
 * one decision.
 *
 * A release with a new top level `migrations` entry in wrangler.jsonc cannot ship
 * gradually: Cloudflare refuses to upload it as a version (`EXIT.classChange` in
 * gradual-deploy.ts), and until somebody ships it by hand every later merge's deploy stops
 * the same way. Dan, 2026-10-06: plan these at PR time. So a pull request adding one is
 * refused unless it carries `HAND_DEPLOY_LABEL`, which says the merge is planned together
 * with `pnpm cf:deploy:verified`. Only the TOP LEVEL list counts: the load test Worker
 * deploys whole with `wrangler deploy`, which applies a migration itself.
 */
import { stripJsonComments } from "./gradual-deploy.ts";

/** The label that says a class change's merge is planned with its hand deploy. */
export const HAND_DEPLOY_LABEL = "deploy/hand";

/** A value as JSON with its object keys sorted, so two equal entries compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The top level migration entries, in order, each with its tag and its whole content. */
export function migrationEntriesOf(jsonc: string): { tag: string; content: string }[] | null {
  let json: { migrations?: unknown };
  try {
    // Trailing commas are legal JSONC and not JSON.
    json = JSON.parse(stripJsonComments(jsonc).replace(/,(\s*[}\]])/g, "$1")) as { migrations?: unknown };
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  if (json.migrations === undefined) return [];
  if (!Array.isArray(json.migrations)) return null;
  const entries: { tag: string; content: string }[] = [];
  for (const m of json.migrations) {
    const tag = (m as { tag?: unknown } | null)?.tag;
    if (typeof tag !== "string" || tag === "") return null;
    entries.push({ tag, content: canonical(m) });
  }
  return entries;
}

/** The top level migration tags, in order, or null when the file cannot be read as one. */
export function migrationTagsOf(jsonc: string): string[] | null {
  return migrationEntriesOf(jsonc)?.map((e) => e.tag) ?? null;
}

/**
 * The check's verdict and its one line. Fails closed: a wrangler.jsonc that cannot be read
 * on either side cannot rule a class change out, so it is refused by name (L42).
 */
export function doMigrationVerdict(input: { base: string | null; head: string; labels: readonly string[] }): { ok: boolean; message: string } {
  if (input.base === null) {
    return { ok: false, message: "the base commit's wrangler.jsonc could not be read, so a Durable Object class change cannot be ruled out" };
  }
  const beforeEntries = migrationEntriesOf(input.base);
  const afterEntries = migrationEntriesOf(input.head);
  if (beforeEntries === null) return { ok: false, message: "the base commit's wrangler.jsonc could not be read as a migrations list, so a Durable Object class change cannot be ruled out" };
  if (afterEntries === null) return { ok: false, message: "this pull request's wrangler.jsonc could not be read as a migrations list, so a Durable Object class change cannot be ruled out" };
  // A tag Cloudflare has applied is never applied again, so an edit to its entry never
  // takes effect, and removing one rewrites a history the platform keeps. Neither can be
  // planned around with a label: the change belongs in a new tag.
  const afterByTag = new Map(afterEntries.map((e) => [e.tag, e.content]));
  const removed = beforeEntries.filter((e) => !afterByTag.has(e.tag)).map((e) => e.tag);
  const edited = beforeEntries.filter((e) => afterByTag.has(e.tag) && afterByTag.get(e.tag) !== e.content).map((e) => e.tag);
  if (removed.length > 0 || edited.length > 0) {
    const what = [
      edited.length > 0 ? `edits Durable Object migration ${edited.join(", ")}, which Cloudflare has already applied and will not apply again` : null,
      removed.length > 0 ? `removes Durable Object migration ${removed.join(", ")} from the history Cloudflare keeps` : null,
    ].filter((w): w is string => w !== null);
    return { ok: false, message: `this pull request ${what.join(" and ")}. Put the change in a new tag instead` };
  }
  const before = beforeEntries.map((e) => e.tag);
  const added = afterEntries.map((e) => e.tag).filter((t) => !before.includes(t));
  if (added.length === 0) return { ok: true, message: "no Durable Object class change: the gradual deploy can ship this" };
  const which = `Durable Object migration ${added.join(", ")}`;
  const ship = "ship it by hand with `pnpm cf:deploy:verified` (DEPLOY.md, Deploying by hand, verified) as soon as it merges, since every deploy after it stops until it ships";
  if (input.labels.includes(HAND_DEPLOY_LABEL)) {
    return { ok: true, message: `this pull request adds ${which} and is labelled ${HAND_DEPLOY_LABEL}: the gradual deploy will refuse it, so ${ship}` };
  }
  return {
    ok: false,
    message:
      `this pull request adds ${which}, which Cloudflare refuses to deploy gradually. Plan the merge with its hand deploy and add the ` +
      `${HAND_DEPLOY_LABEL} label to say so; then ${ship}`,
  };
}
