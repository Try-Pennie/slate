// Tests for the impersonation error redirect target (#141): a failed "view as"
// must echo the typed email back so the form doesn't wipe it.
// Run: node --experimental-strip-types scripts/test-imp-error-url.ts
import { impersonationErrorUrl } from "../src/lib/admin/imp-error-url.ts";
import { assert, finish } from "./lib/harness.ts";

{
  const url = impersonationErrorUrl("No user with email a@b.com.", "a@b.com");
  assert(url.includes("imp_error="), "carries the error message");
  assert(
    url.includes("imp_email=a%40b.com"),
    "echoes the typed email (url-encoded) so the form can repopulate it",
  );
}
{
  // The empty-email case: nothing to echo, so no imp_email param.
  const url = impersonationErrorUrl("Enter an email.");
  assert(url.includes("imp_error="), "carries the error message");
  assert(!url.includes("imp_email"), "omits imp_email when there is no email to echo");
}
{
  // A '+' in an email must survive as %2B, not decode to a space on the way back.
  const url = impersonationErrorUrl("No user with email a+x@b.com.", "a+x@b.com");
  assert(url.includes("imp_email=a%2Bx%40b.com"), "encodes + in the echoed email");
}

finish();
