/**
 * Which commit this build came from (#1037).
 *
 * OVERWRITTEN AT DEPLOY TIME by `scripts/stamp-build-info.ts`, which the CI deploy
 * job runs immediately before `pnpm cf:deploy`. The committed value is the
 * local-development placeholder and is expected to be stale in git; do not "fix"
 * it by hand.
 *
 * Why a generated module rather than an environment variable: the value has to be
 * compiled INTO the Worker bundle. A server-side env var would have to reach the
 * Worker through `wrangler.jsonc` vars (committed, so it cannot hold a per-commit
 * value) or a deploy-time flag (which risks disturbing the vars block that
 * deliberately pins security-relevant settings, see the comment in wrangler.jsonc).
 * A `NEXT_PUBLIC_` var would be inlined correctly but also ships to the browser,
 * which would publish the running commit to anyone: the version is deliberately
 * readable only behind the booking key (`/api/smoke/version`).
 */
export const BUILD_COMMIT = "dev";
