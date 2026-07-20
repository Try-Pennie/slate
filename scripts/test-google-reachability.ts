// #913: classifying a failed Google calendar probe as a definitive "gone"
// (account removed from the Workspace, delegation revoked, not found) vs a
// "transient" failure worth a retry (5xx, rate limit, network/timeout with no
// status). Pure so the node runner can import it directly.
// Run: node --experimental-strip-types scripts/test-google-reachability.ts
import {
  classifyGoogleStatus,
  reachabilityFromError,
  parseGoogleErrorReason,
} from "../src/lib/google/reachability-classify.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { eq, finish } from "./lib/harness.ts";

// Definitive account/permission failures => gone.
eq(classifyGoogleStatus(400), "gone", "400 (token invalid_grant) = gone");
eq(classifyGoogleStatus(401), "gone", "401 unauthorized = gone");
eq(classifyGoogleStatus(403), "gone", "403 forbidden (delegation revoked) = gone");
eq(classifyGoogleStatus(404), "gone", "404 not found = gone");

// Everything else => transient (retry-worthy).
eq(classifyGoogleStatus(500), "transient", "500 = transient");
eq(classifyGoogleStatus(503), "transient", "503 = transient");
eq(classifyGoogleStatus(429), "transient", "429 rate limit = transient");
eq(classifyGoogleStatus(undefined), "transient", "no status (network/abort) = transient");

// #917: a 403 caused by a rate limit is transient, not "gone". The reason
// disambiguates the same 403 status.
eq(classifyGoogleStatus(403, "rateLimitExceeded"), "transient", "403 rateLimitExceeded = transient");
eq(classifyGoogleStatus(403, "userRateLimitExceeded"), "transient", "403 userRateLimitExceeded = transient");
eq(classifyGoogleStatus(403, "quotaExceeded"), "transient", "403 quotaExceeded = transient");
eq(classifyGoogleStatus(403, "forbidden"), "gone", "403 with a non-rate-limit reason = gone");
eq(classifyGoogleStatus(403, undefined), "gone", "403 with no reason = gone (default)");

// parseGoogleErrorReason pulls the reason out of a Google error body.
eq(
  parseGoogleErrorReason('{"error":{"errors":[{"reason":"rateLimitExceeded"}],"code":403}}'),
  "rateLimitExceeded",
  "parses calendar error body reason",
);
eq(parseGoogleErrorReason('{"error":"invalid_grant"}'), "invalid_grant", "parses token error string");
eq(parseGoogleErrorReason("not json"), undefined, "non-JSON body = no reason");
eq(parseGoogleErrorReason("{}"), undefined, "no error field = no reason");

// reachabilityFromError maps a caught probe error to gone/transient.
eq(reachabilityFromError(new GoogleHttpError("forbidden", 403)), "gone", "GoogleHttpError 403 = gone");
eq(reachabilityFromError(new GoogleHttpError("not found", 404)), "gone", "GoogleHttpError 404 = gone");
eq(reachabilityFromError(new GoogleHttpError("server error", 503)), "transient", "GoogleHttpError 503 = transient");
eq(
  reachabilityFromError(new GoogleHttpError("rate limited", 403, "rateLimitExceeded")),
  "transient",
  "GoogleHttpError 403 rate-limit = transient",
);
eq(reachabilityFromError(new Error("network down")), "transient", "plain Error (network) = transient");

finish();
