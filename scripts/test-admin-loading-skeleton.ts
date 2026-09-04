// The console has a loading boundary, and it announces the wait exactly once (#1848).
//
// Every page under /admin is `force-dynamic` and there was no loading boundary
// anywhere in the tree, which cost two things. The router could not commit a
// navigation until the whole server render finished, so a click left the OLD page
// on screen under a spinner for the entire wait. And a prefetch of a dynamic route
// fills only up to the nearest boundary, so with none, every sidebar link
// prefetched on hover, came back in about 100ms carrying nothing, and the click
// still paid full price. Both were measured in production.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-admin-loading-skeleton.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * Source with its comments removed.
 *
 * Both counts below are of a thing these files also NAME in prose while
 * explaining themselves, so counting the raw text finds the explanation as well
 * as the code and reports a live region that is not there. Strip the comments
 * from INSIDE the file rather than skipping a file whose first line is a comment,
 * which is the shape that fails in both directions (L361).
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILE = "src/app/admin/loading.tsx";
assert(existsSync(FILE), "the console segment has a loading boundary");
const loading = readFileSync(FILE, "utf8");

// --- it is a skeleton, not an empty boundary ---------------------------------
//
// The thing that would silently make this worse rather than better. An empty
// boundary still commits the navigation instantly, and commits it to a BLANK
// column, which reads as "there is nothing here" rather than as "this is coming"
// (L10). Asserted on what it draws, not on the file merely existing.
{
  const shapes = loading.match(/pn-skeleton/g) ?? [];
  assert(shapes.length >= 4, `it draws real placeholder shapes (${shapes.length})`);
  assert(
    /export default function/.test(loading),
    "and it is a real component rather than a stub export",
  );
  assert(
    !/return\s*(null|<>\s*<\/>|<\/>)/.test(loading),
    "it never renders nothing, which would commit the navigation to a blank column",
  );
}

// --- the wait is announced ONCE ----------------------------------------------
//
// `LinkPending` already carries exactly one `role="status"` for a pending
// navigation, on the link that was clicked, which is the only thing that can say
// WHICH page is coming. A second live region here would announce the same wait
// twice, so the skeleton is hidden from assistive tech entirely.
{
  assert(/aria-hidden/.test(code(loading)), "the skeleton is hidden from assistive tech");
  eq(
    (code(loading).match(/role="status"/g) ?? []).length,
    0,
    "and carries no live region of its own",
  );
  const linkPending = readFileSync("src/components/ui/LinkPending.tsx", "utf8");
  eq(
    (code(linkPending).match(/role="status"/g) ?? []).length,
    1,
    "because the one that speaks lives on the link, and there is still exactly one",
  );
  // A positive control on `code`: it must not simply be emptying the file, or
  // every count above is trivially zero (L98).
  assert(code(loading).includes("pn-skeleton"), "stripping comments leaves the real markup");
}

// --- the skeleton's tone is a real one ---------------------------------------
//
// It is drawn in the hover and zebra tint, which #1851 made visible. At the value
// before that (1.009:1 against the page) this would have been a skeleton nobody
// could see, which is the empty-column failure wearing a different hat.
{
  const css = readFileSync("src/app/globals.css", "utf8");
  assert(/\.pn-skeleton\s*\{/.test(css), "the skeleton class is defined");
  const block = css.slice(css.indexOf(".pn-skeleton {"));
  assert(
    /background-color:\s*var\(--bg-alt\)/.test(block.slice(0, 400)),
    "and paints in a token rather than a raw colour",
  );
  // Motion is a background sweep, never transform or opacity: those move the
  // element, and the embed's ResizeObserver reports scrollHeight.
  const keyframes = css.slice(css.indexOf("@keyframes pn-skeleton-sweep"));
  const body = keyframes.slice(0, keyframes.indexOf("}\n}") + 3);
  assert(/background-position/.test(body), "the shimmer moves a background position");
  assert(!/transform|opacity/.test(body), "and never a transform or an opacity");
}

// --- every console page it covers really is dynamic ---------------------------
//
// The boundary only earns its keep over routes that actually take time to render.
// If the console ever went static, this would be a skeleton flashing in front of
// an instant page, which is worse than no boundary at all.
{
  const pages = readdirSync("src/app/admin", { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)page\.tsx$/.test(f))
    .map((f) => `src/app/admin/${f}`);
  assert(pages.length > 10, `the sweep really found the console pages (${pages.length})`);
  // A page that only REDIRECTS has no UI for a skeleton to stand in front of, and
  // does not need to declare itself dynamic. /admin/settings is one: #1748 broke
  // that hub into sections and it survives purely so an old bookmark lands
  // somewhere real. Exempted by what it IS rather than by name, so a second one
  // added later is exempt for the same stated reason rather than by being
  // forgotten.
  const isRedirectOnly = (src: string) =>
    /\bredirect\(/.test(code(src)) && !/return\s*\(/.test(code(src));
  const notDynamic = pages.filter((f) => {
    const src = readFileSync(f, "utf8");
    return !/dynamic\s*=\s*"force-dynamic"/.test(src) && !isRedirectOnly(src);
  });
  eq(
    notDynamic.join(", "),
    "",
    "every console page that RENDERS is force-dynamic, so the boundary is never in front of an instant page",
  );
  // The exemption is load bearing and narrow: it really is excusing something,
  // and it does not excuse a page that draws a screen.
  const exempted = pages.filter((f) => isRedirectOnly(readFileSync(f, "utf8")));
  assert(exempted.length > 0, `the redirect exemption matches something (${exempted.join(", ")})`);
  assert(
    !isRedirectOnly(readFileSync("src/app/admin/agents/page.tsx", "utf8")),
    "and does not excuse a page that renders, which also calls redirect on its gate",
  );
}

finish();
