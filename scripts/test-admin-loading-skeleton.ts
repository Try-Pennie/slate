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

// #2103: /me got a boundary too, and for a sharper reason than the console's.
// The header's tabs no longer draw a per-link spinner (`LinkPending marker="bar"`),
// so a skeleton is now the ONLY thing standing between the click and the page.
// Without it a click on My Availability or My Time Off would leave the previous
// page on screen with nothing at all saying a new one is coming.
//
// The shared properties are checked over BOTH, from one list, so a third boundary
// is covered by construction rather than by somebody remembering to copy this
// file (L41, L96).
const BOUNDARIES = [
  "src/app/admin/loading.tsx",
  "src/app/me/loading.tsx",
];

for (const file of BOUNDARIES) {
  assert(existsSync(file), `${file} exists, so its segment has a loading boundary`);
}

// --- the chrome survives the boundary ----------------------------------------
//
// The failure that makes a loading boundary WORSE than no boundary. Next swaps
// everything below the nearest layout, so a segment whose PAGES render their own
// header has that header replaced by the skeleton: click a tab and the header
// disappears and comes back, which is the "things you did not click moved" fault
// (#2045) at the largest possible scale.
//
// /me shipped exactly that shape, with `<AppHeader/>` inside each page and no
// layout at all, and it only became a problem the moment it got a boundary.
for (const file of BOUNDARIES) {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const layout = `${dir}/layout.tsx`;
  assert(existsSync(layout), `${dir} renders its chrome from a layout, not its pages`);
  assert(
    /<AppHeader/.test(readFileSync(layout, "utf8")),
    `${layout} is where the header is drawn, so the skeleton cannot replace it`,
  );
  const pages = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)page\.tsx$/.test(f))
    .map((f) => `${dir}/${f}`);
  assert(pages.length > 0, `the sweep found ${dir}'s pages (${pages.length})`);
  for (const page of pages) {
    assert(
      !/<AppHeader/.test(readFileSync(page, "utf8")),
      `${page} leaves the header to the layout`,
    );
  }
}

// --- it is a skeleton, not an empty boundary ---------------------------------
//
// The thing that would silently make this worse rather than better. An empty
// boundary still commits the navigation instantly, and commits it to a BLANK
// column, which reads as "there is nothing here" rather than as "this is coming"
// (L10). Asserted on what it draws, not on the file merely existing.
for (const file of BOUNDARIES) {
  const src = readFileSync(file, "utf8");
  const shapes = src.match(/pn-skeleton/g) ?? [];
  assert(shapes.length >= 4, `${file} draws real placeholder shapes (${shapes.length})`);
  assert(
    /export default function/.test(src),
    `${file} is a real component rather than a stub export`,
  );
  assert(
    !/return\s*(null|<>\s*<\/>|<\/>)/.test(src),
    `${file} never renders nothing, which would commit the navigation to a blank column`,
  );
}

// --- the wait is announced ONCE ----------------------------------------------
//
// `LinkPending` already carries exactly one `role="status"` for a pending
// navigation, on the link that was clicked, which is the only thing that can say
// WHICH page is coming. A second live region here would announce the same wait
// twice, so the skeleton is hidden from assistive tech entirely.
{
  for (const file of BOUNDARIES) {
    const src = code(readFileSync(file, "utf8"));
    assert(/aria-hidden/.test(src), `${file} is hidden from assistive tech`);
    eq((src.match(/role="status"/g) ?? []).length, 0, `${file} carries no live region of its own`);
    // A positive control on `code`: it must not simply be emptying the file, or
    // every count above is trivially zero (L98).
    assert(src.includes("pn-skeleton"), `stripping comments leaves ${file}'s real markup`);
  }
  const linkPending = readFileSync("src/components/ui/LinkPending.tsx", "utf8");
  eq(
    (code(linkPending).match(/role="status"/g) ?? []).length,
    1,
    "because the one that speaks lives on the link, and there is still exactly one",
  );
  // #2103: and it survives BOTH markers. The header keeps the load bar precisely
  // so that dropping its spinner does not take the announcement with it, and a
  // marker that rendered nothing at all would pass every check above while
  // leaving a screen reader silent through the whole fetch.
  assert(
    /marker === "spinner"/.test(code(linkPending)),
    "the spinner is what the marker withholds",
  );
  const barBranchDropsTheBar = /marker === "bar"[\s\S]{0,200}pn-loadbar/.test(code(linkPending));
  assert(
    !barBranchDropsTheBar,
    "and the load bar is outside the marker branch, so both navs announce",
  );
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
