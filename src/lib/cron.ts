import { type NextRequest } from "next/server";
import { cronSecret } from "@/lib/env";

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; also allow ?secret=. */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = cronSecret();
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}
