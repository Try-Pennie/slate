// Every unhandled error lands on a Pennie screen, and that screen claims only
// what it measured (#1970).
//
// There was no boundary anywhere in this product, so every unhandled error fell
// through to the framework's own unstyled dark screen. Dan met it twice while
// saving an agent's hours, after leaving the page sitting long enough for a
// deploy to land underneath it.
//
// Run: node --experimental-strip-types scripts/test-error-boundary.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import { ME_TABS } from "@/lib/me/nav";
import {
  BOUNDARY_TITLE,
  BOUNDARY_BODY,
  boundaryReference,
  boundaryWayBack,
} from "@/lib/errors/boundary-copy";

// --- the boundaries exist ----------------------------------------------------
const ADMIN = join("src", "app", "admin", "error.tsx");
const GLOBAL = join("src", "app", "global-error.tsx");
assert(existsSync(ADMIN), "the admin surface has an error boundary");
assert(existsSync(GLOBAL), "the root layout has a backstop");

const admin = readFileSync(ADMIN, "utf8");
const global = readFileSync(GLOBAL, "utf8");

// A boundary must be a client component or it is not a boundary at all.
for (const [name, src] of [["admin", admin], ["global", global]] as const) {
  assert(/^"use client";/m.test(src), `the ${name} boundary is a client component`);
}

// Next 16 hands a boundary BOTH `retry` and `reset`. `reset` only clears the
// boundary and redraws from the payload the browser already holds, so a failed
// server read throws again and the button looks dead; `retry` asks the server
// first. This scan is the cheap half and cannot see `onClick={reset}`; the proof is
// `src/app/error-boundaries-retry.test.tsx`, which mounts every boundary inside
// Next's own ErrorBoundary and presses Try again (#3425).
for (const [name, src] of [["admin", admin], ["global", global]] as const) {
  assert(/\bretry\b/.test(src), `the ${name} boundary takes Next 16's retry prop`);
  assert(!/\breset\(\)/.test(src), `the ${name} boundary does not call the old reset name`);
}

// --- the copy is shared, not written twice -----------------------------------
for (const [name, src] of [["admin", admin], ["global", global]] as const) {
  assert(
    /BOUNDARY_TITLE/.test(src) && /BOUNDARY_BODY/.test(src),
    `the ${name} boundary calls the shared copy rather than holding its own`,
  );
}
assert(
  !admin.includes(BOUNDARY_TITLE) && !global.includes(BOUNDARY_TITLE),
  "neither boundary repeats the wording as a literal, which is how two screens drift",
);

// --- and it claims only what it can know -------------------------------------
//
// A boundary catches a failed render and a failed save alike, and cannot tell
// them apart or know whether a save got half way. So the one thing it may not
// say is that nothing was saved: that would send somebody away from a change
// that actually landed (L11).
const claims = [
  "nothing was saved",
  "your changes were not saved",
  "no changes were made",
  "nothing has changed",
];
const claimed = claims.filter((c) => BOUNDARY_BODY.toLowerCase().includes(c));
assert(
  claimed.length === 0,
  `the body does not claim a save outcome it cannot measure: ${claimed.join(", ")}`,
);
// It has to tell somebody mid save what to DO, or it is only an apology.
assert(
  /check whether it went through/i.test(BOUNDARY_BODY),
  "the body tells somebody who was saving to look before trying again",
);
assert(BOUNDARY_TITLE.length > 0 && BOUNDARY_BODY.length > 60, "the copy says something");

// --- the reference is shown when there is one, and not faked when there is not
assert(boundaryReference("abc123") === "Reference abc123", "a digest is quoted for the logs");
assert(boundaryReference(undefined) === null, "no digest shows no reference rather than an empty one");
assert(boundaryReference("   ") === null, "a blank digest is no reference");

// --- A LEAD IS NEVER SENT TO THE ADMIN CONSOLE -------------------------------
//
// The backstop replaces the root layout, so it is the screen a lead sees if the
// booker's layout fails. The first version offered them "Go to the admin
// overview" unconditionally, which is worse than offering nothing.
for (const leadPath of ["/book/411", "/booking/manage/tok", "/", "/login"]) {
  assert(
    boundaryWayBack(leadPath) === null,
    `a lead facing path offers no way into the console (${leadPath})`,
  );
}
// And the staff paths DO get one, or the check above is satisfied by a function
// that always returns null (L159).
assert(
  boundaryWayBack("/admin/agents/abc")?.href === "/admin",
  "an admin path offers the overview",
);
assert(
  boundaryWayBack("/me")?.href === ME_TABS[0].href,
  "an agent's own page offers their availability, by the address the tab uses (#2107)",
);
assert(
  (boundaryWayBack("/admin")?.label ?? "").length > 0,
  "the way back is labelled, not a bare URL",
);

// --- the backstop can stand alone --------------------------------------------
//
// `global-error` replaces the root layout and renders its own document, so
// globals.css never loads: no tokens, no Tailwind, no PP Mori, and no
// `data-theme`, because the layout that sets it is what failed. A version
// carrying Tailwind classes would look correct in review and render unstyled.
assert(/<html/.test(global) && /<body/.test(global), "the backstop renders its own document");
assert(
  !/className="[^"]*\b(?:text-fg|bg-surface|rounded-|px-\d|mt-\d)/.test(global),
  "the backstop uses no Tailwind class, since no stylesheet reaches it",
);
assert(
  /prefers-color-scheme/.test(global),
  "the backstop follows the operating system, the app's theme attribute being gone with the layout",
);
// The admin boundary is INSIDE the layout, so it must use the tokens rather than
// inlining a second palette.
assert(
  /cardCls|text-fg/.test(admin),
  "the admin boundary uses the design system, which does reach it",
);
assert(
  !/rgb\(\d/.test(admin),
  "and holds no raw colour of its own",
);

// --- the digest reaches the logs ---------------------------------------------
//
// It is the only thing tying this screen to a line in the Worker's logs, and a
// person reading it off the page needs the other half to exist.
assert(/log\.error\(/.test(admin), "the admin boundary logs the error it caught");
assert(/digest/.test(admin), "and logs the digest, which is what ties the two together");

// --- the probe cannot exist in production ------------------------------------
//
// A page that always throws is how the boundary gets SEEN working, since the
// wiring is a file convention rather than code of ours and nothing else can
// prove Next still honours it. It must not be reachable on a live deployment.
const PROBE = join("src", "app", "admin", "boundary-probe", "page.tsx");
assert(existsSync(PROBE), "the probe that proves the boundary is reached exists");
const probe = readFileSync(PROBE, "utf8");
assert(
  /devPreviewEnabled\(\)/.test(probe) && /notFound\(\)/.test(probe),
  "the probe 404s outside development, through the same predicate /dev/preview uses",
);
assert(
  /throw new Error/.test(probe),
  "and it really throws, or it proves nothing about the boundary",
);
// The refusal has to come FIRST, or the throw happens before anything can 404.
assert(
  probe.indexOf("notFound()") < probe.indexOf("throw new Error"),
  "the production refusal is reached before the throw",
);

finish();
