// Tests for the impersonation error redirect target.
//
// #141 built this to echo the typed email back so the free text field would not
// wipe it. #1795 deleted that field, so there is nothing to repopulate and the
// echo is gone with it; the assertions that defended it are deleted rather than
// adjusted, because their whole content was the behaviour being removed (L252).
//
// What matters now is the PATH: the message has to land on a page that renders it,
// and for a while it did not. The end to end version of that (deriving the page
// file from this URL and reading it) lives in
// scripts/test-impersonation-error-surface.ts; this file pins the builder itself.
//
// Run: node --experimental-strip-types scripts/test-imp-error-url.ts
import { impersonationErrorUrl } from "../src/lib/admin/imp-error-url.ts";
import { assert, eq, finish } from "./lib/harness.ts";

{
  const url = impersonationErrorUrl("No user with email a@b.com.");
  assert(url.includes("imp_error="), "carries the error message");
  eq(
    new URL(url, "https://x.local").pathname,
    "/admin/agents",
    "lands on the roster, which is the page that renders the message",
  );
}
{
  // The message survives the round trip intact, punctuation and all: it is read
  // by a person, and an email address in it is the useful half.
  const msg = "No user with email a+x@b.com.";
  const url = impersonationErrorUrl(msg);
  eq(
    new URL(url, "https://x.local").searchParams.get("imp_error"),
    msg,
    "encodes and decodes the message without mangling a + in an address",
  );
}
{
  // Nothing echoes the email any more, on any message.
  const url = impersonationErrorUrl("a@b.com has been offboarded.");
  assert(!url.includes("imp_email"), "no echoed email parameter is produced");
}

finish();
