import { createHash } from "node:crypto";

/**
 * The build identity Next stamps into every page and every server action (#1994).
 *
 * ## What it is for
 *
 * A browser submitting a server action names it by an id minted at BUILD time.
 * When a deploy lands under a page somebody already has open, that name no
 * longer exists, Next replies 404 with `x-nextjs-action-not-found`, and the save
 * dies in the error boundary. Nothing was set here at all, so Next could not
 * tell a stale page from a current one and had no way to say so.
 *
 * ## Why it is a HASH of the commit and not the commit
 *
 * `deploymentId` is sent to the BROWSER: it rides on every RSC request. The
 * commit is deliberately not public (see `src/lib/build-info.ts`, which records
 * that a `NEXT_PUBLIC_` var was rejected for exactly this reason, and
 * `/api/smoke/version` sits behind the booking key). A digest changes on every
 * deploy, which is the only property Next needs, and reveals nothing.
 *
 * Truncated to 16 hex characters because the value travels on every request and
 * only has to differ between consecutive deploys, not resist collision by an
 * adversary who would gain nothing from one.
 */
export function deploymentIdFor(commit: string): string {
  return createHash("sha256").update(`slate:${commit}`).digest("hex").slice(0, 16);
}

/** The placeholder `src/lib/build-info.ts` carries until the deploy job stamps it. */
export const UNSTAMPED_COMMIT = "dev";

/** Read the stamped commit out of `build-info.ts` without importing it, so the
 *  build config does not depend on module resolution into `src/`. */
export function buildCommitFrom(source: string): string {
  const m = source.match(/export const BUILD_COMMIT = "([^"]*)";/);
  if (!m) {
    throw new Error(
      "src/lib/build-info.ts no longer declares BUILD_COMMIT, so the deployment id cannot be derived",
    );
  }
  return m[1];
}
