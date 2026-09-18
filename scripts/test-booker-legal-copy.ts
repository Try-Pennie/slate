/**
 * #1041: the standalone booker collects a name, an email and a phone number for a
 * debt consultation call, and said nothing about privacy, terms, or what giving
 * us the number leads to.
 *
 * From the 2026-07-23 production readiness audit. The EMBEDDED funnel inherits
 * Pennie's own policies from the trypennie.com page around it; the standalone
 * page at slate.trypennie.app/book has no page around it, so it inherits nothing.
 *
 * This pins the parts that are not a matter of taste: that the links point at
 * pages that really exist, and that all of it obeys the copy rules the rest of
 * the booker is held to.
 *
 * #2204 deleted the third thing it used to pin, the contact disclosure above the
 * confirm button, along with the sentence itself.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-booker-legal-copy.ts
 */
import { LEGAL_COPY, legalLinks } from "../src/lib/booking/booker-copy.ts";
import { bookerCopyScreens } from "../src/lib/booking/copy-preview.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Written as escapes so the file holds no literal dash for the style hook to
// catch (the repo convention).
const DASHES = /[—–]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// ---------------------------------------------------- the links

// These are real routes on trypennie.com, taken from that site's own sitemap
// route file rather than guessed. A legal link that 404s is worse than no link:
// it says a policy exists and then fails to produce it.
{
  const links = legalLinks();
  assert(links.length >= 2, "the booker offers at least a privacy policy and terms");

  for (const link of links) {
    assert(
      link.href.startsWith("https://trypennie.com/"),
      `${link.label} points at Pennie's own site, absolutely, since the booker can be embedded elsewhere`,
    );
    assert(link.label.trim().length > 0, "every link has a label a person can read");
    assert(!DASHES.test(link.label), `${link.label} carries no dash`);
    // #2204 took the disclosure and its emoji check with it. The rule is about
    // lead-facing copy rather than about that one sentence, so it moves onto what
    // this file still checks rather than leaving with the thing it was written
    // beside (L362).
    assert(!EMOJI.test(link.label), `${link.label} carries no emoji`);
  }

  const hrefs = links.map((l) => l.href);
  assert(
    hrefs.includes("https://trypennie.com/privacy-policy"),
    "the privacy policy is linked",
  );
  assert(
    hrefs.includes("https://trypennie.com/terms-of-service"),
    "the terms of service are linked",
  );
  eq(new Set(hrefs).size, hrefs.length, "no link is offered twice");
}

// ---------------------------------------------------- the disclosure, deleted
//
// #2204 removed the sentence that used to sit above the confirm button, and its
// assertions went with it rather than being left pointed at a builder nobody
// calls (L252, L430). The dash and emoji rules it carried moved onto the links
// and the heading above, and every remaining line the booker can show is held to
// the same two by `scripts/test-booker-preview-coverage.ts`.

// ---------------------------------------------------- reachable in the preview

// `pnpm preview:booker` is the required cold read before this copy ships, and
// copy the preview cannot see is copy nobody reads before a customer does. This
// is the same completeness rule the rest of the file lives under.
{
  const screens = bookerCopyScreens();
  const all = screens.flatMap((s) => s.lines.map((l) => l.text));

  for (const link of legalLinks()) {
    assert(
      all.includes(link.label),
      `the "${link.label}" link's label appears in the preview`,
    );
  }
}

// ---------------------------------------------------- the heading

{
  assert(!DASHES.test(LEGAL_COPY.heading), "the footer heading carries no dash");
  assert(!EMOJI.test(LEGAL_COPY.heading), "the footer heading carries no emoji");
  assert(LEGAL_COPY.heading.trim().length > 0, "and is not blank");
}

finish();
