// A "view as" failure has to reach a screen that shows it (#1795).
//
// Three things this pins, each of which was wrong or about to be.
//
// 1. THE REDIRECT AND THE RENDERER HAVE TO BE THE SAME PAGE. They were not.
//    `impersonationErrorUrl` sent the admin to `/admin`, and the only place
//    rendering `imp_error` was `/admin/agents`, which the roster moved to when
//    the admin area was split into sections (#1748). So every impersonation
//    failure was silent: the admin landed on the health dashboard with an
//    invisible query parameter and no idea why nothing had happened. Asserted by
//    DERIVING the page file from the URL the builder actually produces, so the
//    two cannot drift apart again by editing one of them (L70).
//
// 2. THE WARNING HAS TO OUTLIVE THE PANEL. The only explanation in the whole app
//    of what impersonation does lived inside the free text panel this issue
//    deletes. It is a shared constant now, so removing it breaks a build rather
//    than quietly leaving the most consequential action in the admin area
//    unexplained.
//
// 3. THE FREE TEXT FIELD IS GONE. Its only unique reach was people the roster
//    deliberately excludes, which is offboarded employees.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-impersonation-error-surface.ts
import { readFileSync, existsSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { impersonationErrorUrl } from "../src/lib/admin/imp-error-url.ts";
import { IMPERSONATION_WARNING } from "../src/lib/admin/impersonation-copy.ts";

// --- 1. the failure lands somewhere that renders it ------------------------
const url = impersonationErrorUrl("No user with email a@b.com.");
const { pathname, searchParams } = new URL(url, "https://slate.local");

eq(searchParams.get("imp_error"), "No user with email a@b.com.", "the message rides the URL");
assert(
  !searchParams.has("imp_email"),
  "the echoed email is gone with the field it repopulated; nothing reads it now",
);

const pageFile = `src/app${pathname === "/" ? "" : pathname}/page.tsx`;
assert(existsSync(pageFile), `the redirect target ${pathname} is a real page (${pageFile})`);
const page = readFileSync(pageFile, "utf8");
assert(
  /imp_error/.test(page),
  `${pageFile} renders imp_error, so the failure is visible where it lands`,
);
// A positive control on the check above: /admin is where this used to point and
// is exactly the page that does NOT render it, so if the derivation ever silently
// resolved to the wrong file this assertion is what notices.
assert(
  !/imp_error/.test(readFileSync("src/app/admin/page.tsx", "utf8")),
  "the health page still does not render it, which is why pointing there was the bug",
);

// --- 2. the warning survives, and says the three things that matter --------
{
  assert(IMPERSONATION_WARNING.length > 40, "the warning is a real sentence, not a stub");
  for (const [what, re] of [
    ["that actions happen as them", /happens as them|as them/i],
    ["that a banner stays up", /banner/i],
    ["that there is a way back", /back to yourself|way back/i],
  ] as [string, RegExp][]) {
    assert(re.test(IMPERSONATION_WARNING), `the warning still says ${what}`);
  }
  assert(
    readFileSync("src/app/admin/agents/page.tsx", "utf8").includes("IMPERSONATION_WARNING"),
    "the roster page renders the shared warning rather than its own copy of it",
  );
}

// --- 3. the free text panel is gone ---------------------------------------
{
  const roster = readFileSync("src/app/admin/agents/page.tsx", "utf8");
  assert(
    !/name="email"/.test(roster),
    "no free text email field remains on the roster page",
  );
  assert(
    !/imp_email/.test(roster),
    "and nothing is left reading the echoed email",
  );
  // The per row control is still there, or this "removal" removed the feature.
  assert(/ViewAsButton|RosterTable/.test(roster), "the per row control is still reachable");
}

finish();
