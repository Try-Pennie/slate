// What a change has to touch for the booking path load run to be due again (#3103).
//
// The run measures the confirm path (the booking API, verify-on-book, the slot
// refresh after a confirm) and the cron lanes that share one invocation's CPU
// (`limits.cpu_ms`). A change to either moves a number the last run recorded, so
// `.github/workflows/loadtest-due.yml` opens one "load run due" issue, or records the
// push on the one already open, when a push to main touches any of these. The
// workflow's `paths:` block must be EXACTLY this list, which
// scripts/test-loadtest-due-paths.ts holds, along with every cron route and the confirm
// route sitting under one of them. The nag lists the pushes on the issue by this same
// list (`gitPathspecs` in scripts/lib/loadtest-due-nag.ts).
//
// Each entry is a directory prefix (`dir/**`) or one exact file, nothing else.
export const LOADTEST_DUE_PATHS = [
  // The booking API: the confirm route the drivers call.
  "src/app/api/bookings/**",
  // The confirm service, verify-on-book, the reservation and the outbox.
  "src/lib/booking/**",
  // Slot computation and the slot cache the drivers read and the confirm refreshes.
  "src/lib/availability/**",
  // The calendar reads verify-on-book and the sync lane make.
  "src/lib/google/**",
  // The per caller ceilings every booking request passes.
  "src/lib/rate-limit.ts",
  "src/lib/rate-limit-core.ts",
  "src/lib/rate-limit-burst.ts",
  // Every cron lane's route.
  "src/app/api/cron/**",
  // The Worker entry that dispatches crons and the shared lane plumbing.
  "worker/**",
  // Cron triggers, `limits.cpu_ms` and the bindings.
  "wrangler.jsonc",
] as const;

/** True when a repo relative path falls under one of `LOADTEST_DUE_PATHS`. */
export function isLoadtestDuePath(path: string): boolean {
  return LOADTEST_DUE_PATHS.some((p) =>
    p.endsWith("/**") ? path.startsWith(p.slice(0, -2)) : path === p,
  );
}
