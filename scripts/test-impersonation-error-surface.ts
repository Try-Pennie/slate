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
// 2. THE STANDING WARNING IS GONE, AND THE BANNER CARRIES IT (#1836). Point 2
//    used to say the opposite: that a shared IMPERSONATION_WARNING constant had
//    to outlive the deleted panel because the explanation lived nowhere else.
//    That premise was wrong. It was reached by grepping for the SENTENCE and
//    finding it nowhere, which is a different claim from the FACT living nowhere
//    (L58 in spirit, and L103: a guard that pins a value rather than the rule can
//    be satisfied by a comment about the thing). AppHeader's active banner
//    already said both halves and named the person, on every page, for the whole
//    session. So the constant, its module and the prose above the roster are all
//    removed, and this section now asserts their absence. The preservation half
//    lives in src/components/AppHeader.test.tsx, which mounts the header and
//    requires the banner to name the target, explain that actions happen as them,
//    and offer the way back.
//
// 3. THE FREE TEXT FIELD IS GONE. Its only unique reach was people the roster
//    deliberately excludes, which is offboarded employees.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-impersonation-error-surface.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { impersonationErrorUrl } from "../src/lib/admin/imp-error-url.ts";

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

// --- 2. the standing warning and its module are gone (#1836) ---------------
{
  assert(
    !existsSync("src/lib/admin/impersonation-copy.ts"),
    "the impersonation-copy module is deleted, docstring and all",
  );
  // Not just the module: a surviving IMPORT would break the build, but a page
  // that re-inlined the sentence would not, and that is the regression this
  // guard exists for. So it asks the SOURCE TREE about the prose, not only about
  // the symbol (L63: assert the quantity, not a proxy for it). Offenders are
  // collected and named in one assertion rather than one per file, so the
  // failure reads as one thing.
  const srcFiles = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => `src/${f}`);
  assert(srcFiles.length > 100, `the sweep really walked src (${srcFiles.length} files)`);

  const PROSE = /A banner stays up the whole time/;
  const reaches: string[] = [];
  const inlines: string[] = [];
  for (const f of srcFiles) {
    const text = readFileSync(f, "utf8");
    if (/IMPERSONATION_WARNING|impersonation-copy/.test(text)) reaches.push(f);
    if (PROSE.test(text)) inlines.push(f);
  }
  eq(reaches.join(", "), "", "nothing in src reaches the removed warning module");
  eq(inlines.join(", "), "", "nothing in src re-inlined the standing warning prose");

  // A positive control on the prose sweep: the sentence it hunts for is a real
  // string this file itself holds, so a sweep that matched nothing because it
  // read the wrong tree cannot pass as a clean one (L98).
  assert(
    PROSE.test(readFileSync("scripts/test-impersonation-error-surface.ts", "utf8")),
    "the prose sweep can still match its own subject, so an empty sweep is not a pass",
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
