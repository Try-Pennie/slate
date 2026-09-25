import { embedTestPassSecret } from "@/lib/env";
import { log } from "@/lib/log";
import { TEST_PASS_HEADER } from "./test-pass-header";
import { testPassForBucket, testPassRefusal, verifyTestPass } from "./test-pass";

/**
 * A pass for `code` minted now with the deployment's secret, or null when the code
 * is not the public test bucket or there is no secret. The one place a page reads
 * the secret and the clock to make one: `/book` (after its origin gate allows),
 * and the manage page and admin panel for a test booking.
 */
export function currentTestPassFor(code: string): string | null {
  return testPassForBucket({ code, secret: embedTestPassSecret(), nowMs: Date.now() });
}

/**
 * The one check every public route runs before serving the public test bucket
 * (#2666): `/api/availability`, `/api/availability/next` and the Booker's confirm.
 * One function rather than three copies of the same four lines, so the header
 * name, the secret, the clock and the log line cannot drift between them (L41).
 *
 * Null when the pass is good. Otherwise the 403 to answer with, already logged
 * under `embed-test` with the reason CLASS and the route. The pass itself is never
 * logged: it is a credential for as long as it lives.
 */
export function refuseUnlessTestPass(
  headers: Headers,
  code: string,
  route: string,
): ReturnType<typeof testPassRefusal> | null {
  const verdict = verifyTestPass({
    pass: headers.get(TEST_PASS_HEADER),
    code,
    secret: embedTestPassSecret(),
    nowMs: Date.now(),
  });
  if (verdict.ok) return null;
  log.warn("embed-test", { msg: "refused a test pass", reason: verdict.reason, route });
  return testPassRefusal(verdict.reason);
}
