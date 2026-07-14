import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";

export const dynamic = "force-dynamic";

/** Every console method the server code could plausibly use. */
export const CANARY_LEVELS = ["debug", "log", "info", "warn", "error"] as const;

const MAX_SAMPLES = 50;
const DEFAULT_SAMPLES = 10;

/** A needle, not a secret: it is echoed into the log line we then search for. */
const TOKEN_RE = /^[a-z0-9-]{6,40}$/i;

/**
 * TEMPORARY (#801). Multi-sample logging canary: emits N lines per console
 * level, each tagged with a caller-supplied token, so the token can be counted
 * back out of Cloudflare observability per level. Answers "which console
 * methods actually survive to the logs, and what `level` do they carry" with a
 * real sample count instead of a single observation.
 *
 * It has to live in the deployed Worker because a preview version emits no
 * observability events at all. DELETE once the matrix in
 * docs/cloudflare-platform-notes.md is recorded.
 *
 *   GET (Bearer CRON_SECRET) ?token=<needle>&samples=<1-50> -> 200 | 400 | 401
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json(
      { error: "token must be 6-40 chars of [a-z0-9-]", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const requested = Number(req.nextUrl.searchParams.get("samples") ?? DEFAULT_SAMPLES);
  const samples = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SAMPLES)
    : DEFAULT_SAMPLES;

  for (const level of CANARY_LEVELS) {
    for (let i = 1; i <= samples; i++) {
      console[level](`logcanary ${token} level=${level} i=${i}`);
    }
  }

  return NextResponse.json({
    token,
    samples,
    levels: [...CANARY_LEVELS],
    emitted: samples * CANARY_LEVELS.length,
  });
}
