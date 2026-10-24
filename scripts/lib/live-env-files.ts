/**
 * Which files in a checkout hold live settings that a local run would pick up by
 * itself, and the refusals built on that one rule (#3079, #3694).
 *
 * Next reads every `.env*` file in the project on its own, the Cloudflare adapter
 * bakes their values into the Worker bundle, and wrangler loads `.dev.vars*` into a
 * local Workers session. In the main checkout `.env.local` and `.dev.vars` hold
 * production's keys, so a local run that can see them can reach real systems.
 * `.env.example` is the committed template and nothing reads it.
 *
 * Two runs refuse such a checkout, and both read `liveEnvFiles` so they cannot
 * drift apart: the browser checks (`e2e/env.ts`, `envFileRefusal`) and the local
 * Workers preview (`scripts/cf-preview-guard.ts`, run first by `pnpm cf:preview`).
 * A git worktree holds none of these files, which is why both say to use one.
 *
 * Pure. Tests: `scripts/test-cf-preview-guard.ts`, `scripts/test-e2e-isolation.ts`.
 */

const LIVE_ENV_FILE = /^(\.env(\..+)?|\.dev\.vars(\..+)?)$/;
const COMMITTED_TEMPLATE = ".env.example";

/** The names, from one directory listing, of files a local run would load live settings from. */
export function liveEnvFiles(fileNames: readonly string[]): string[] {
  return fileNames.filter((f) => LIVE_ENV_FILE.test(f) && f !== COMMITTED_TEMPLATE);
}

/**
 * Why `pnpm cf:preview` must not start in this checkout, or null when it may.
 *
 * The preview runs on the Workers runtime, which `mayWriteAlerts`
 * (`src/lib/notify/dispatch.ts`) treats as production, so the files' values would
 * make every alert it raised a real one.
 */
export function cfPreviewRefusal(fileNames: readonly string[]): string | null {
  const found = liveEnvFiles(fileNames);
  if (found.length === 0) return null;
  return (
    `Refusing to start the local Workers preview: this checkout holds ${found.join(", ")}. ` +
    `The preview would build those settings in, and it runs the way production does, so any ` +
    `alert it raised would post to the real Slack channel and change production's alert state. ` +
    `Run it from a git worktree, which holds none of these files.`
  );
}
