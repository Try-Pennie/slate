// #913: classifying a failed Google calendar probe as a definitive "gone"
// (account removed from the Workspace, delegation revoked, not found) vs a
// "transient" failure worth a retry (5xx, rate limit, network/timeout with no
// status). Pure so the node runner can import it directly.
// Run: node --experimental-strip-types scripts/test-google-reachability.ts
import {
  classifyGoogleStatus,
  reachabilityFromError,
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

// reachabilityFromError maps a caught probe error to gone/transient.
eq(reachabilityFromError(new GoogleHttpError("forbidden", 403)), "gone", "GoogleHttpError 403 = gone");
eq(reachabilityFromError(new GoogleHttpError("not found", 404)), "gone", "GoogleHttpError 404 = gone");
eq(reachabilityFromError(new GoogleHttpError("server error", 503)), "transient", "GoogleHttpError 503 = transient");
eq(reachabilityFromError(new Error("network down")), "transient", "plain Error (network) = transient");

finish();
